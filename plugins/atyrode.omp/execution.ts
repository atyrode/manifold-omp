import { z } from "zod";
import {
  PublicJobSchema,
  TerminalRuntimeSchema,
  type PublicJob,
} from "@manifold/protocol";
import {
  OMP_PLUGIN_ID,
  TargetSchema,
  ResourcePinsSchema,
  RuntimeAccountPoolSchema,
  BrokerReferenceSchema,
  ServicePinSchema,
  InventoryReceiptSchema,
  BenchmarkReceiptSchema,
  PROBE_MODEL_LIMIT,
  BenchmarkInputSchema,
  ProbeIdentitiesSchema,
  type ActionInput,
  type ActionResult,
  type Overlay,
  type RuntimeAccountPool,
  type ProbeIdentity,
  type Target,
} from "../api/index.ts";
import { parseBenchmarkInput, probeAddress } from "../api/probe.ts";
import { checkedAccountPool, currentGateway } from "./broker.ts";
import {
  actor,
  authorizeTarget,
  authorizeTerminalSpawn,
  currentOperation,
  digestOf,
  OmpRefusal,
  readJobResult,
  type OmpContext,
} from "./machine-server.ts";
import { effectiveOverlay, expectedDefaults } from "./state.ts";
import { bundledProbeModels } from "./sdk-metadata.macro.ts" with { type: "macro" };

const registry = bundledProbeModels();
const providers = Object.keys(registry);

export function defaultInventoryIdentities(
  catalog: Readonly<Record<string, readonly ProbeIdentity[]>>,
  pool: RuntimeAccountPool,
): ProbeIdentity[] {
  // Smaller provider catalogs go first so one large aggregator cannot crowd every direct provider out.
  const providers = Object.keys(pool).sort((left, right) => {
    const bySize =
      (catalog[left]?.length ?? 0) - (catalog[right]?.length ?? 0);
    return bySize || (left < right ? -1 : left > right ? 1 : 0);
  });
  const identities: ProbeIdentity[] = [];
  for (const provider of providers) {
    for (const identity of catalog[provider] ?? []) {
      identities.push(identity);
      if (identities.length === PROBE_MODEL_LIMIT) return identities;
    }
  }
  return identities;
}
const provenanceSchema = z.strictObject({
  target: TargetSchema,
  operationId: z.string(),
  door: z.string(),
  requester: z.string(),
  pins: ResourcePinsSchema,
  input: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  inputDigest: z.string(),
  defaultsRevision: z.number(),
  accountPool: RuntimeAccountPoolSchema,
  broker: BrokerReferenceSchema,
  gateway: ServicePinSchema,
  modelIdentities: ProbeIdentitiesSchema,
  inventoryJobId: z.string().nullable(),
  candidates: BenchmarkInputSchema.nullable(),
});
type Provenance = z.infer<typeof provenanceSchema>;

export function nativeModelConfiguration(pool: RuntimeAccountPool) {
  const selected = Object.keys(pool).filter(
    (provider) => pool[provider]!.length > 0,
  );
  if (
    selected.length === 0 ||
    selected.some((provider) => !providers.includes(provider))
  )
    throw new OmpRefusal("account_unavailable");
  return {
    models: {
      providers: Object.fromEntries(
        selected.map((provider) => [
          provider,
          {
            baseUrl: "",
            apiKey: "",
            transport: "pi-native",
            discovery: { type: "proxy" },
          },
        ]),
      ),
    },
    config: {
      extensions: [],
      disabledProviders: providers.filter(
        (provider) => !selected.includes(provider),
      ),
      extendedContext: true,
      startup: { setupWizard: false },
    },
  };
}
function checkOverlay(overlay: Overlay, pool: RuntimeAccountPool) {
  const roles = overlay.modelRoles ?? {};
  if (!roles.default) throw new OmpRefusal("model_configuration_missing");
  const refs = [
    ...Object.values(roles),
    ...Object.values(overlay.retry?.fallbackChains ?? {}).flat(),
    ...Object.values(overlay.task?.agentModelOverrides ?? {}),
  ];
  for (const ref of refs) {
    const concrete = ref.startsWith("@") ? roles[ref.slice(1)] : ref;
    if (!concrete || !pool[concrete.slice(0, concrete.indexOf("/"))]?.length)
      throw new OmpRefusal("account_unavailable");
  }
}
function boundedInput(input: Record<string, string | number | boolean>) {
  if (Buffer.byteLength(JSON.stringify(input)) > 65536)
    throw new OmpRefusal("input_too_large");
  return input;
}
async function workspaceReview(
  ctx: OmpContext,
  args: ActionInput<"reviewWorkspace">,
) {
  await authorizeTarget(ctx, args);
  const operationId = `${OMP_PLUGIN_ID}.${args.mode === "create" ? "prepare-workspace" : "validate-workspace"}`;
  const current = await currentOperation(ctx, args.machineId, operationId);
  const destination = {
    containerId: args.containerId,
    machineId: args.machineId,
  };
  return {
    destination,
    operationId,
    pins: current.pins,
    reviewDigest: digestOf({
      actor: actor(ctx),
      destination,
      operationId,
      current,
    }),
  };
}
export async function reviewWorkspace(
  ctx: OmpContext,
  args: ActionInput<"reviewWorkspace">,
): Promise<ActionResult<"reviewWorkspace">> {
  return workspaceReview(ctx, args);
}
export async function prepareWorkspace(
  ctx: OmpContext,
  args: ActionInput<"prepareWorkspace">,
): Promise<ActionResult<"prepareWorkspace">> {
  await authorizeTarget(ctx, args, true);
  const first = await workspaceReview(ctx, args);
  if (first.reviewDigest !== args.reviewDigest)
    throw new OmpRefusal("review_changed");
  const jobId = await ctx.newId();
  const latest = await workspaceReview(ctx, args);
  if (latest.reviewDigest !== first.reviewDigest)
    throw new OmpRefusal("resources_changed");
  const job = PublicJobSchema.parse(
    await ctx.jobs.execute({
      jobId,
      machineId: args.machineId,
      operationId: latest.operationId,
      ...latest.pins,
      input: {},
      outputs: [],
    }),
  );
  checkJob(
    job,
    {
      target: latest.destination,
      operationId: latest.operationId,
      door: "prepareWorkspace",
      requester: ctx.auth.principal.id,
      pins: latest.pins,
      inputDigest: digestOf({}),
    },
    jobId,
  );
  return job;
}
async function inventoryPreparation(
  ctx: OmpContext,
  args: ActionInput<"startInventory">,
) {
  await authorizeTarget(ctx, args);
  await expectedDefaults(ctx, args.expectedDefaultsRevision);
  const { pool, reference } = await checkedAccountPool(ctx, args.accountPool);
  const operationId = `${OMP_PLUGIN_ID}.inventory`;
  const current = await currentOperation(ctx, args.machineId, operationId);
  const gateway = await currentGateway(ctx, args.machineId);
  const identities = ProbeIdentitiesSchema.parse(
    args.modelIdentities ?? defaultInventoryIdentities(registry, pool),
  );
  const seen = new Set<string>();
  for (const identity of identities) {
    const key = probeAddress(identity).toLowerCase();
    if (
      seen.has(key) ||
      !pool[identity.provider]?.length ||
      !(registry[identity.provider] ?? []).some(
        (value) => digestOf(value) === digestOf(identity),
      )
    )
      throw new OmpRefusal("invalid_model_identity");
    seen.add(key);
  }
  const native = nativeModelConfiguration(pool);
  const input = boundedInput({
    models: JSON.stringify(native.models),
    config: JSON.stringify(native.config),
    modelIdentities: JSON.stringify(identities),
    accountPool: JSON.stringify(pool),
  });
  const provenance = provenanceSchema.parse({
    target: { containerId: args.containerId, machineId: args.machineId },
    operationId,
    door: "startInventory",
    requester: ctx.auth.principal.id,
    pins: current.pins,
    input,
    inputDigest: digestOf(input),
    defaultsRevision: args.expectedDefaultsRevision,
    accountPool: pool,
    broker: reference,
    gateway,
    modelIdentities: identities,
    inventoryJobId: null,
    candidates: null,
  });
  return {
    provenance,
    digest: digestOf({ actor: actor(ctx), current, provenance }),
  };
}
function checkJob(
  job: PublicJob,
  provenance: Pick<
    Provenance,
    "target" | "operationId" | "door" | "requester" | "pins" | "inputDigest"
  >,
  jobId: string,
) {
  if (
    job.jobId !== jobId ||
    job.machineId !== provenance.target.machineId ||
    job.pluginId !== OMP_PLUGIN_ID ||
    job.operationId !== provenance.operationId ||
    job.inputDigest !== provenance.inputDigest ||
    job.installationRevision !== provenance.pins.installationRevision ||
    job.artifactSha256 !== provenance.pins.artifactSha256 ||
    job.resourceBindingDigest !== provenance.pins.resourceBindingDigest ||
    job.authority.requester !== provenance.requester ||
    job.authority.origin.kind !== "action" ||
    job.authority.origin.door !== `${OMP_PLUGIN_ID}.${provenance.door}`
  )
    throw new OmpRefusal("provenance_changed");
}
async function execute(ctx: OmpContext, jobId: string, provenance: Provenance) {
  // Retain the exact intended request before dispatch. A failed native dispatch cannot grant receipt access.
  if (
    !(await ctx.storage.compareAndSet(
      `jobs/${jobId}`,
      null,
      JSON.stringify(provenance),
    ))
  )
    throw new OmpRefusal("job_conflict");
  const job = PublicJobSchema.parse(
    await ctx.jobs.execute({
      jobId,
      machineId: provenance.target.machineId,
      operationId: provenance.operationId,
      ...provenance.pins,
      input: provenance.input,
      outputs: [],
    }),
  );
  checkJob(job, provenance, jobId);
  return job;
}
async function retainedProvenance(
  ctx: OmpContext,
  target: Target,
  jobId: string,
) {
  const raw = await ctx.storage.get(`jobs/${jobId}`);
  if (raw === null) throw new OmpRefusal("result_unavailable");
  const provenance = provenanceSchema.parse(JSON.parse(raw));
  if (digestOf(target) !== digestOf(provenance.target))
    throw new OmpRefusal("provenance_changed");
  return provenance;
}
export async function startInventory(
  ctx: OmpContext,
  args: ActionInput<"startInventory">,
): Promise<ActionResult<"startInventory">> {
  const first = await inventoryPreparation(ctx, args);
  const jobId = await ctx.newId();
  const latest = await inventoryPreparation(ctx, args);
  if (latest.digest !== first.digest) throw new OmpRefusal("resources_changed");
  return execute(ctx, jobId, latest.provenance);
}
export async function readInventory(
  ctx: OmpContext,
  args: ActionInput<"readInventory">,
): Promise<ActionResult<"readInventory">> {
  const target = { containerId: args.containerId, machineId: args.machineId };
  await authorizeTarget(ctx, target);
  const provenance = await retainedProvenance(ctx, target, args.jobId);
  if (
    provenance.door !== "startInventory" ||
    provenance.inventoryJobId !== null ||
    provenance.candidates !== null
  )
    throw new OmpRefusal("provenance_changed");
  const result = await readJobResult(
    ctx,
    args.machineId,
    "inventory",
    args.jobId,
    "startInventory",
  );
  checkJob(result.job, provenance, args.jobId);
  const inventory = InventoryReceiptSchema.parse(result.value);
  const seen = new Set<string>();
  for (const model of inventory.models) {
    const address = probeAddress(model).toLowerCase();
    if (
      seen.has(address) ||
      !provenance.modelIdentities.some(
        (identity) =>
          identity.provider === model.provider &&
          identity.id === model.id &&
          identity.api === model.api,
      )
    )
      throw new OmpRefusal("invalid_observation");
    seen.add(address);
  }
  return { job: result.job, inventory };
}
async function benchmarkPreparation(
  ctx: OmpContext,
  args: ActionInput<"startBenchmark">,
) {
  const source = await readInventory(ctx, {
    containerId: args.containerId,
    machineId: args.machineId,
    jobId: args.inventoryJobId,
  });
  const target = { containerId: args.containerId, machineId: args.machineId };
  const retained = await retainedProvenance(ctx, target, args.inventoryJobId);
  await expectedDefaults(ctx, retained.defaultsRevision);
  const candidates = parseBenchmarkInput(args.candidates);
  if (
    candidates.inventoryObservedAt !== source.inventory.observedAt ||
    candidates.ompVersion !== source.inventory.ompVersion ||
    candidates.candidates.some(
      (candidate) =>
        !source.inventory.models.some(
          (model) =>
            model.provider === candidate.provider &&
            model.id === candidate.id &&
            model.api === candidate.api,
        ),
    )
  )
    throw new OmpRefusal("invalid_probe_input");
  await checkedAccountPool(ctx, retained.accountPool, retained.broker);
  await currentGateway(ctx, args.machineId, retained.gateway);
  const current = await currentOperation(
    ctx,
    args.machineId,
    `${OMP_PLUGIN_ID}.benchmark`,
  );
  if (
    current.pins.installationRevision !== source.job.installationRevision ||
    current.pins.artifactSha256 !== source.job.artifactSha256
  )
    throw new OmpRefusal("resources_changed");
  const input = boundedInput({
    ...retained.input,
    candidates: JSON.stringify(candidates),
  });
  const provenance: Provenance = {
    ...retained,
    operationId: `${OMP_PLUGIN_ID}.benchmark`,
    requester: ctx.auth.principal.id,
    door: "startBenchmark",
    pins: current.pins,
    input,
    inputDigest: digestOf(input),
    inventoryJobId: args.inventoryJobId,
    candidates,
  };
  return {
    provenance,
    digest: digestOf({ actor: actor(ctx), current, provenance }),
  };
}
export async function startBenchmark(
  ctx: OmpContext,
  args: ActionInput<"startBenchmark">,
): Promise<ActionResult<"startBenchmark">> {
  const first = await benchmarkPreparation(ctx, args);
  const jobId = await ctx.newId();
  const latest = await benchmarkPreparation(ctx, args);
  if (latest.digest !== first.digest) throw new OmpRefusal("resources_changed");
  return execute(ctx, jobId, latest.provenance);
}
export async function readBenchmark(
  ctx: OmpContext,
  args: ActionInput<"readBenchmark">,
): Promise<ActionResult<"readBenchmark">> {
  const source = await readInventory(ctx, {
    containerId: args.containerId,
    machineId: args.machineId,
    jobId: args.inventoryJobId,
  });
  const provenance = await retainedProvenance(
    ctx,
    { containerId: args.containerId, machineId: args.machineId },
    args.jobId,
  );
  if (
    provenance.door !== "startBenchmark" ||
    provenance.inventoryJobId !== args.inventoryJobId ||
    !provenance.candidates
  )
    throw new OmpRefusal("provenance_changed");
  const result = await readJobResult(
    ctx,
    args.machineId,
    "benchmark",
    args.jobId,
    "startBenchmark",
  );
  checkJob(result.job, provenance, args.jobId);
  const benchmark = BenchmarkReceiptSchema.parse(result.value);
  if (
    result.job.installationRevision !== source.job.installationRevision ||
    result.job.artifactSha256 !== source.job.artifactSha256 ||
    benchmark.inventoryObservedAt !== source.inventory.observedAt ||
    digestOf(
      benchmark.results.map(({ key, provider, id, api }) => ({
        key,
        provider,
        id,
        api,
      })),
    ) !== digestOf(provenance.candidates.candidates)
  )
    throw new OmpRefusal("provenance_changed");
  return { job: result.job, benchmark };
}
async function sessionPreparation(
  ctx: OmpContext,
  args: ActionInput<"reviewSession">,
) {
  await authorizeTarget(ctx, args);
  const defaults = await expectedDefaults(ctx, args.expectedDefaultsRevision);
  const overlay = effectiveOverlay(defaults, args.overlay);
  const { pool, reference } = await checkedAccountPool(ctx, args.accountPool);
  checkOverlay(overlay, pool);
  const gateway = await currentGateway(ctx, args.machineId);
  const current = await currentOperation(
    ctx,
    args.machineId,
    `${OMP_PLUGIN_ID}.launch`,
  );
  const native = nativeModelConfiguration(pool);
  const input = boundedInput({
    models: JSON.stringify(native.models),
    config: JSON.stringify({ ...overlay, ...native.config }),
    accountPool: JSON.stringify(pool),
    prompt: args.prompt,
    hasPrompt: args.prompt.length > 0,
    planYolo: args.planYolo,
  });
  const destination = {
    containerId: args.containerId,
    machineId: args.machineId,
  };
  const review = {
    destination,
    operationId: `${OMP_PLUGIN_ID}.launch`,
    pins: current.pins,
    defaultsRevision: defaults.revision,
    effectiveOverlay: overlay,
    accountPool: pool,
    reviewDigest: digestOf({
      actor: actor(ctx),
      destination,
      defaults,
      overlay,
      pool,
      broker: reference,
      gateway,
      current,
      input,
    }),
  };
  return { review, input };
}
export async function reviewSession(
  ctx: OmpContext,
  args: ActionInput<"reviewSession">,
): Promise<ActionResult<"reviewSession">> {
  return (await sessionPreparation(ctx, args)).review;
}
export async function prepareSession(
  ctx: OmpContext,
  args: ActionInput<"prepareSession">,
): Promise<ActionResult<"prepareSession">> {
  await authorizeTarget(ctx, args, true);
  await authorizeTerminalSpawn(ctx, args.containerId);
  const first = await sessionPreparation(ctx, args);
  if (first.review.reviewDigest !== args.reviewDigest)
    throw new OmpRefusal("review_changed");
  const latest = await sessionPreparation(ctx, args);
  if (latest.review.reviewDigest !== first.review.reviewDigest)
    throw new OmpRefusal("resources_changed");
  return {
    destination: latest.review.destination,
    reviewDigest: latest.review.reviewDigest,
    runtime: TerminalRuntimeSchema.parse({
      machineId: latest.review.destination.machineId,
      pluginId: OMP_PLUGIN_ID,
      operationId: latest.review.operationId,
      ...latest.review.pins,
      input: latest.input,
    }),
  };
}
