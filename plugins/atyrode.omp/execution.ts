import { randomUUID } from "node:crypto";
import type { ThinkingConfig } from "@oh-my-pi/pi-catalog";
import { z } from "zod";
import {
  PublicJobSchema,
  TerminalRuntimeSchema,
  type PublicJob,
  type MachineHalf,
  type NativeAgentRunBinding,
} from "@manifold/protocol";
import type { JobFollowSnapshot, JobProgressEvent } from "@manifold/protocol";
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
  JobInputBindingSchema,
  JobLimitsSchema,
  SESSION_ARCHIVE_LIMIT,
  SESSION_GUEST_PATH,
  SESSION_OPERATION_ID,
  RESUME_OPERATION_ID,
  SESSION_OUTPUT_NAME,
  RUNS_LOCATION_ID,
  EXHAUSTED_DESTINATION,
  parseSessionArchive,
  type SessionSilence,
  ProbeIdentitiesSchema,
  ThinkingLevelSchema,
  GATEWAY_DISCOVERY_TIMEOUT_MS,
  exactModelScope,
  pinnedModelRoles,
  modelId,
  PreparedHarnessSessionSchema,
  PreparedResumeSessionSchema,
  skillInputBindings,
  OmpSessionRefSchema,
  type OmpSessionRef,
  type ActionInput,
  type ActionResult,
  type Overlay,
  type RuntimeAccountPool,
  type ProbeIdentity,
  type Target,
  type ThinkingLevel,
} from "../api/index.ts";
import { parseBenchmarkInput, probeAddress } from "../api/probe.ts";
import { checkedAccountPool, currentGateway, enabledAccountPool } from "./broker.ts";
import {
  actor,
  authorizeTarget,
  authorizeTerminalSpawn,
  currentOperation,
  digestOf,
  OmpRefusal,
  readJobResult,
  readNamedOutput,
  jobOfDoor,
  readSealedArchive,
  type OmpContext,
} from "./machine-server.ts";
import { effectiveOverlay, expectedDefaults, readDefaults } from "./state.ts";
import { resolveSkills } from "./skills.ts";
import { bundledProbeModels, liveListingThinking } from "./sdk-metadata.macro.ts" with { type: "macro" };
import sdkRuntimeArtifacts from "../sdk-host/runtime-artifacts.json";

const registry = bundledProbeModels();
const providers = Object.keys(registry);
const listingThinking = liveListingThinking();

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
  modelIdentities: ProbeIdentitiesSchema.nullable(),
  inventoryJobId: z.string().nullable(),
  candidates: BenchmarkInputSchema.nullable(),
  // Absent in provenance retained before bound inputs existed, which is no bindings at all.
  inputs: z.array(JobInputBindingSchema).max(16).default([]),
  limits: JobLimitsSchema.optional(),
});
type Provenance = z.infer<typeof provenanceSchema>;
/**
 * The part of a retained job's own `config` input this plugin reads back: the model the
 * session was configured with, and whether substituting one was permitted.
 *
 * Deliberately tolerant about everything else. The config is the effective overlay merged with
 * the native runtime configuration, it grows with the agent's own settings, and a receipt read
 * must not start refusing old jobs because a key it never looks at appeared or went away.
 */
const RetainedSessionConfigSchema = z.object({
  modelRoles: z.object({ default: modelId }).catchall(z.unknown()),
  retry: z.object({ modelFallback: z.boolean().optional() }).catchall(z.unknown()).optional(),
}).catchall(z.unknown());

/**
 * A reference's model id and its thinking level. A colon is ambiguous: it ends an OpenRouter
 * model id (`deepseek/x:free`) and it also introduces a thinking level (`anthropic/y:high`). So
 * only a suffix that is actually a level is split off; anything else stays part of the id.
 */
function splitThinking(reference: string): { bare: string; level: ThinkingLevel | undefined } {
  const colon = reference.lastIndexOf(":");
  const level = ThinkingLevelSchema.safeParse(colon > 0 ? reference.slice(colon + 1) : undefined);
  return level.success ? { bare: reference.slice(0, colon), level: level.data } : { bare: reference, level: undefined };
}

export function nativeModelConfiguration(pool: RuntimeAccountPool, overlay?: Overlay) {
  const selected = Object.keys(pool).filter(
    (provider) => pool[provider]!.length > 0,
  );
  if (
    selected.length === 0 ||
    selected.some((provider) => !providers.includes(provider))
  )
    throw new OmpRefusal("account_unavailable");
  const modelOverrides = overlay ? pinnedThinking(overlay) : {};
  return {
    models: {
      providers: Object.fromEntries(
        selected.map((provider) => [
          provider,
          {
            baseUrl: "",
            apiKey: "",
            transport: "pi-native",
            discovery: { type: "proxy", timeoutMs: GATEWAY_DISCOVERY_TIMEOUT_MS },
            ...(Object.keys(modelOverrides).length > 0 ? { modelOverrides } : {}),
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
function configuredModels(overlay: Overlay): string[] {
  const roles = overlay.modelRoles ?? {};
  return [
    ...Object.values(roles),
    ...Object.values(overlay.retry?.fallbackChains ?? {}).flat(),
    ...Object.values(overlay.task?.agentModelOverrides ?? {}).map(ref => ref.startsWith("@") ? roles[ref.slice(1)] ?? "" : ref),
  ];
}
/**
 * WHAT A ONE-SHOT DISCOVERS, AND WHAT ITS GATEWAY CAN SERVE IT (#49).
 *
 * Every provider a session registers makes its own `models` call through the service proxy, and
 * the gateway answers each with every model its credential pool reaches. So a pool of four
 * providers cost a one-shot four authorized calls per discovery pass, and it put every pool
 * provider's models under each registered one, where a qualified id reaches the gateway and is
 * served with its own provider's credential. A one-shot runs only the models its configuration
 * names, so it registers only their providers and hands its gateway only their credentials: for a
 * configuration that names just a default, the default's provider alone. The selections OMP makes
 * outside the model roles (a task agent whose own definition names a model, an image question the
 * configured model cannot take, compaction's largest-context candidate) then resolve within those
 * providers or not at all. Terminals and harnesses keep the whole reviewed pool and its providers.
 */
export function oneShotModelConfiguration(pool: RuntimeAccountPool, overlay: Overlay) {
  const named = configuredModels(overlay).map(reference => reference.slice(0, reference.indexOf("/")));
  const accountPool: RuntimeAccountPool = Object.fromEntries(
    Object.entries(pool).filter(([provider]) => named.includes(provider)));
  return { accountPool, ...nativeModelConfiguration(accountPool, overlay) };
}
/**
 * THE THINKING A CONFIGURED LIVE-LISTED MODEL WAS ASKED FOR, AS METADATA THE SESSION CAN APPLY.
 *
 * A session learns a live-listed model from the gateway's listing, which names it and says
 * nothing of how it reasons, so OMP builds it as a model that does not and quietly runs a
 * configured `:medium` with thinking off. The gateway serves that model with its provider's
 * pinned thinking ladder when it reasons; this hands the session the same ladder, for exactly
 * the configured models that name a level. It patches a model the listing supplies and never
 * creates one, so it cannot make an unpublished id resolve.
 *
 * The gateway lists every model it publishes under each provider a session discovers through it,
 * as `<provider>/<id>`, so every provider in the pool carries the same entries.
 */
function pinnedThinking(overlay: Overlay): Record<string, { reasoning: true; thinking: ThinkingConfig }> {
  const overrides: Record<string, { reasoning: true; thinking: ThinkingConfig }> = {};
  for (const reference of configuredModels(overlay)) {
    const separator = reference.indexOf("/");
    const provider = reference.slice(0, separator);
    const written = reference.slice(separator + 1);
    const { bare, level } = splitThinking(written);
    const thinking = listingThinking[provider];
    if (LIVE_CATALOG_PROVIDERS[provider] !== true || !thinking || level === undefined ||
      registry[provider]?.some(identity => identity.id === written || identity.id === bare)) continue;
    overrides[`${provider}/${bare}`] = { reasoning: true, thinking };
  }
  return overrides;
}

/**
 * Providers whose catalog the gateway resolves from the provider itself rather than from the
 * pinned SDK snapshot, so the machine rather than this build decides what can be served.
 */
const LIVE_CATALOG_PROVIDERS: Readonly<Record<string, true>> = { openrouter: true };
/**
 * A configured model this machine cannot serve REFUSES; it is never quietly replaced.
 *
 * The gateway publishes `poolModels`, and a session discovers models through it
 * (`discovery: { type: "proxy" }`). An id absent from that catalog used to reach the session
 * anyway, where the agent resolved some other model and recorded it as a non-fallback
 * resolution — so a receipt could name a model the operator never configured, and the spend
 * went to whatever ran. Refusing here says which model and why, before anything starts.
 *
 * Both the review and the launch pass through here, so neither admits a substitute.
 */
function checkOverlay(overlay: Overlay, pool: RuntimeAccountPool) {
  const roles = overlay.modelRoles ?? {};
  if (!roles.default) throw new OmpRefusal("model_configuration_missing");
  const models = configuredModels(overlay);
  for (let index = 0; index < models.length; index++) {
    const concrete = models[index]!;
    const separator = concrete.indexOf("/");
    if (!concrete || separator <= 0) throw new OmpRefusal("model_configuration_missing");
    const provider = concrete.slice(0, separator);
    if (!pool[provider]?.length) throw new OmpRefusal("account_unavailable");
    const written = concrete.slice(separator + 1);
    const { bare } = splitThinking(written);
    // The bundled registry is a snapshot of the pinned SDK, so it is authoritative only for a
    // provider whose catalog the gateway does NOT resolve live. For one it does, the machine
    // holds the real catalog and refuses an id it cannot serve by name
    // (`model_not_published`); refusing here on a stale snapshot would reject every model the
    // provider added since the SDK release, which is the same wrongness inverted. A one-shot
    // cannot run a substitute for such an id either: `oneShotPreparation` scopes its startup to
    // exactly the configured model, so an id the listing lacks stops the run before any call.
    if (LIVE_CATALOG_PROVIDERS[provider] === true) continue;
    const serveable = registry[provider] ?? [];
    const resolved = serveable.find(identity => identity.id === written) ??
      serveable.find(identity => identity.id === bare);
    if (!resolved) throw new OmpRefusal("model_unavailable");
    models[index] = `${provider}/${resolved.id}`;
  }
  return models;
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
      inputs: [],
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
    | "target"
    | "operationId"
    | "door"
    | "requester"
    | "pins"
    | "inputDigest"
    | "inputs"
    | "limits"
  >,
  jobId: string,
  requireLimits = true,
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
    // What the hub says it bound must be what was asked for, in the order it was asked.
    digestOf(job.inputs ?? []) !== digestOf(provenance.inputs) ||
    (requireLimits && provenance.limits !== undefined &&
      (digestOf(job.limits?.inference ?? null) !== digestOf(provenance.limits.inference ?? null) ||
        (job.result !== null &&
          digestOf(job.result.limits.inference ?? null) !== digestOf(provenance.limits.inference ?? null)))) ||
    job.authority.requester !== provenance.requester ||
    job.authority.origin.kind !== "action" ||
    job.authority.origin.door !== `${OMP_PLUGIN_ID}.${provenance.door}`
  )
    throw new OmpRefusal("provenance_changed");
}
type OutputBinding = { name: string; locationId: string; components: string[] };
async function execute(
  ctx: OmpContext,
  jobId: string,
  provenance: Provenance,
  outputs: OutputBinding[] = [],
  agentRun?: NativeAgentRunBinding,
) {
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
      outputs,
      ...(provenance.inputs.length === 0 ? {} : { inputs: provenance.inputs }),
      ...(provenance.limits === undefined ? {} : { limits: provenance.limits }),
      ...(agentRun === undefined ? {} : { agentRun }),
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
    provenance.modelIdentities === null ||
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
function requireSkillRuntime(machine: MachineHalf | undefined, operationId: string) {
  const operation = machine?.operations[operationId];
  if (!supportsSdkRuntime(machine, operationId) ||
    !operation?.input.skillRuntime || !operation.input.disableSkills ||
    !operation.runtimeTools?.includes("harness") ||
    !Array.from({ length: 15 }, (_, index) => `optionalSkill${index}`).every(name => operation.inputs?.includes(name)))
    throw new OmpRefusal("skills_runtime_unsupported");
}

function supportsSdkRuntime(machine: MachineHalf | undefined, operationId: string): boolean {
  const operation = machine?.operations[operationId];
  for (const platform of ["linux-x64", "linux-arm64"] as const) {
    const addon = machine?.tools?.["sdk-pi-natives"]?.[platform];
    const bun = machine?.tools?.bun?.[platform];
    if (addon?.sha256 !== sdkRuntimeArtifacts.tools["pi-natives"][platform].sha256 ||
      addon.entrySha256 !== sdkRuntimeArtifacts.tools["pi-natives"][platform].entrySha256 ||
      bun?.sha256 !== sdkRuntimeArtifacts.tools.bun[platform].sha256 ||
      bun.entrySha256 !== sdkRuntimeArtifacts.tools.bun[platform].entrySha256) return false;
  }
  return sdkRuntimeArtifacts.sdkVersion === "18.2.7" &&
    operation?.executable?.runtimeTool === "bun" &&
    operation?.input.automation !== undefined && operation.input.resumeOverrides !== undefined &&
    operation.runtimeTools?.includes("sdkHost") === true && operation.runtimeTools.includes("sdk-pi-natives");
}
function requireSdkRuntime(machine: MachineHalf | undefined, operationId: string) {
  if (!supportsSdkRuntime(machine, operationId)) throw new OmpRefusal("sdk_runtime_unsupported");
}
function requireAgentToolsRuntime(machine: MachineHalf | undefined, operationId: string) {
  const operation = machine?.operations[operationId];
  if (!supportsSdkRuntime(machine, operationId) ||
    operation?.input.agentTools?.type !== "boolean" ||
    !operation.runtimeTools?.includes("harness") ||
    !operation.argv.some(argument => "literal" in argument && argument.literal === "--agent-tools" &&
      argument.when?.input === "agentTools" && argument.when.equals === true))
    throw new OmpRefusal("agent_tools_runtime_unsupported");
}
/** Runtime preparation is machine-scoped. Container and terminal authorization
 * belongs to reviewed launch or, for operator resume, independent placement. */
async function sessionRuntimePreparation(
  ctx: OmpContext,
  args: Omit<ActionInput<"reviewSession">, "containerId" | "accountPool"> & { accountPool: RuntimeAccountPool | undefined },
  operationId: string,
  sessionId?: string,
  resume = false,
  overrides?: ActionInput<"resumeSession">["overrides"],
) {
  const defaults = await expectedDefaults(ctx, args.expectedDefaultsRevision);
  const overlay = effectiveOverlay(defaults, args.overlay);
  if (args.agentTools && (args.automation || args.planYolo || resume || operationId !== SESSION_OPERATION_ID))
    throw new OmpRefusal("agent_tools_mode_unsupported");
  if (args.automation && (args.planYolo || overlay.task?.agentAdvisor?.task === "on" || overlay.task?.prewalk === true ||
    overlay.advisor?.enabled === true || overlay.prewalk?.enabled === true ||
    overlay.retry?.modelFallback === true)) throw new OmpRefusal("restricted_delegation_unsupported");
  if (args.automation && operationId === `${OMP_PLUGIN_ID}.harness`)
    throw new OmpRefusal("restricted_harness_unsupported");
  if (resume && args.planYolo) throw new OmpRefusal("resume_plan_unsupported");
  const requestedPool = args.accountPool ?? await enabledAccountPool(ctx,
    configuredModels(overlay).map(ref => ref.slice(0, ref.indexOf("/"))));
  const { pool, reference } = await checkedAccountPool(ctx, requestedPool);
  const models = checkOverlay(overlay, pool);
  const gateway = await currentGateway(ctx, args.machineId, undefined,
    args.inferenceLimits === undefined ? undefined : { limits: args.inferenceLimits, models });
  const current = await currentOperation(
    ctx,
    args.machineId,
    operationId,
  );
  const automation = args.automation ?? { mode: "ordinary" as const };
  if (args.automation || resume) requireSdkRuntime(current.deployment.installation?.machine, operationId);
  if (args.agentTools) requireAgentToolsRuntime(current.deployment.installation?.machine, operationId);
  const skills = await resolveSkills(ctx, args.machineId, args.skills ?? (args.automation ? { mode: "disabled" } : undefined));
  if (args.planYolo && skills.mode !== "preserve") throw new OmpRefusal("skills_plan_unsupported");
  if (skills.mode !== "preserve") requireSkillRuntime(current.deployment.installation?.machine, operationId);
  const inputs = skillInputBindings(skills);
  const skillConfig = skills.mode === "disabled" ? { skills: { enabled: false } }
    : skills.mode === "selected" ? { skills: { customDirectories: inputs.map(binding => `/inputs/${binding.name}`) } }
    : {};
  const native = nativeModelConfiguration(pool, overlay);
  const config = { ...overlay, ...native.config, ...skillConfig };
  const input = boundedInput({
    models: JSON.stringify(native.models),
    config: JSON.stringify(config),
    accountPool: JSON.stringify(pool),
    prompt: args.prompt,
    hasPrompt: args.prompt.length > 0,
    planYolo: args.planYolo,
    skillRuntime: JSON.stringify({ mode: skills.mode, names: skills.selected.map(skill => skill.name) }),
    disableSkills: skills.mode === "disabled",
    automation: JSON.stringify(automation),
    resumeOverrides: JSON.stringify(overrides ?? {}),
    ...(sessionId ? { sessionId, resume } : {}),
    ...(args.agentTools === undefined ? {} : { agentTools: true }),
  });
  return { defaults, overlay, pool, reference, gateway, current, input, config, skills, inputs, automation };
}

async function sessionPreparation(
  ctx: OmpContext,
  args: ActionInput<"reviewSession">,
  sessionId?: string,
  resume = false,
) {
  await authorizeTarget(ctx, args);
  const operationId = sessionId ? `${OMP_PLUGIN_ID}.harness`
    : args.agentTools ? SESSION_OPERATION_ID : `${OMP_PLUGIN_ID}.launch`;
  const { defaults, overlay, pool, reference, gateway, current, input, config, skills, inputs, automation } =
    await sessionRuntimePreparation(ctx, args, operationId, sessionId, resume);
  const destination = {
    containerId: args.containerId,
    machineId: args.machineId,
  };
  const review = {
    destination,
    operationId,
    pins: current.pins,
    defaultsRevision: defaults.revision,
    effectiveOverlay: overlay,
    accountPool: pool,
    skills,
    automation,
    ...(args.inferenceLimits === undefined ? {} : { inferenceLimits: args.inferenceLimits }),
    ...(args.agentTools === undefined ? {} : { agentTools: args.agentTools }),
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
      skills,
      inputs,
      inferenceLimits: args.inferenceLimits ?? null,
      ...(args.agentTools === undefined ? {} : { agentTools: args.agentTools }),
    }),
  };
  return { review, input, config, inputs, broker: reference, gateway, current };
}
export async function reviewSession(
  ctx: OmpContext,
  args: ActionInput<"reviewSession">,
): Promise<ActionResult<"reviewSession">> {
  return (await sessionPreparation(ctx, args)).review;
}
async function prepareReviewedSession(
  ctx: OmpContext,
  args: ActionInput<"prepareSession">,
  sessionId?: string,
  resume = false,
): Promise<ActionResult<"prepareSession">> {
  if (args.inferenceLimits !== undefined) throw new OmpRefusal("inference_limits_unsupported");
  await authorizeTarget(ctx, args, true);
  await authorizeTerminalSpawn(ctx, args.containerId);
  const first = await sessionPreparation(ctx, args, sessionId, resume);
  if (first.review.reviewDigest !== args.reviewDigest)
    throw new OmpRefusal("review_changed");
  const latest = await sessionPreparation(ctx, args, sessionId, resume);
  if (latest.review.reviewDigest !== first.review.reviewDigest)
    throw new OmpRefusal("resources_changed");
  const placedSessionId = sessionId ?? randomUUID();
  return {
    destination: latest.review.destination,
    reviewDigest: latest.review.reviewDigest,
    runtime: TerminalRuntimeSchema.parse({
      machineId: latest.review.destination.machineId,
      pluginId: OMP_PLUGIN_ID,
      operationId: latest.review.operationId,
      ...latest.review.pins,
      input: sessionId ? latest.input : boundedInput({ ...latest.input, sessionId: placedSessionId }),
      session: { harness: OMP_PLUGIN_ID, machineId: args.machineId, sessionId: placedSessionId },
      ...(latest.inputs.length > 0 ? { inputs: latest.inputs } : {}),
    }),
  };
}
/** The reviewed session's content as a one-shot runs it, plus the pins of the operation that will run it. */
async function oneShotPreparation(
  ctx: OmpContext,
  args: ActionInput<"runSession">,
) {
  const prepared = await sessionPreparation(ctx, args);
  const current = prepared.review.operationId === SESSION_OPERATION_ID ? prepared.current
    : await currentOperation(ctx, args.machineId, SESSION_OPERATION_ID);
  const declared = current.deployment.installation?.machine?.operations[SESSION_OPERATION_ID]?.limits;
  let limits: PublicJob["limits"] | undefined;
  if (args.inferenceLimits !== undefined) {
    if (!declared) throw new OmpRefusal("inference_limits_unsupported");
    for (const key of ["calls", "inputTokens", "outputTokens", "costMicros"] as const) {
      const requested = args.inferenceLimits[key];
      const ceiling = declared.inference?.[key];
      if (requested !== undefined && ceiling !== undefined && requested > ceiling)
        throw new OmpRefusal("inference_limit_exceeded");
    }
    limits = { ...JobLimitsSchema.strip().parse(declared), inference: { ...declared.inference, ...args.inferenceLimits } };
  }
  if (prepared.review.skills.mode !== "preserve") requireSkillRuntime(current.deployment.installation?.machine, SESSION_OPERATION_ID);
  if (args.automation) requireSdkRuntime(current.deployment.installation?.machine, SESSION_OPERATION_ID);
  // OMP BINDS A ONE-SHOT'S MODEL ONCE, AT STARTUP, WITH NOBODY THERE TO SEE WHICH (#49). When the
  // configured model was not in the session's catalog at that moment — the gateway listed it too
  // slowly, or the provider withdrew it — OMP took a model whose id merely resembled it, or the
  // machine's default, and ran it: `modelFallback` governs retries, not startup. Scoped to
  // exactly the configured model, startup has nothing else to choose, and a print session that
  // resolves no model exits before its first call. An operator's terminal keeps its full `/model`
  // picker, so the scope is placed here, not in the reviewed content.
  //
  // Startup is not the one-shot's last selection. Task agents, the advisor, the plan hand-off and
  // compaction resolve a role later, against the whole catalog, where an unset role reaches OMP's
  // own priority lists and a workspace's `.omp/config.yml` may name any model; so every chat role
  // the configuration leaves unset names the configured model as well.
  //
  // Pinned roles do not reach the selections OMP makes outside them, and every provider a session
  // registers lists the gateway's whole pool, so the one-shot also registers, and hands its
  // gateway, only the providers its configuration names (`oneShotModelConfiguration`).
  const configured = prepared.config.modelRoles?.default;
  if (!configured) throw new OmpRefusal("model_configuration_missing");
  const modelRoles = pinnedModelRoles({ ...prepared.config.modelRoles, default: configured });
  const scoped = oneShotModelConfiguration(prepared.review.accountPool, prepared.review.effectiveOverlay);
  return {
    prepared,
    accountPool: scoped.accountPool,
    input: boundedInput({
      ...prepared.input,
      models: JSON.stringify(scoped.models),
      accountPool: JSON.stringify(scoped.accountPool),
      config: JSON.stringify({ ...prepared.config, ...scoped.config, modelRoles, enabledModels: [exactModelScope(configured)] }),
    }),
    pins: current.pins,
    limits,
    digest: digestOf({ review: prepared.review.reviewDigest, current }),
  };
}
/**
 * The reviewed session, placed as a governed job instead of a terminal. It runs on
 * `atyrode.omp.session`, the one-shot sibling of `atyrode.omp.launch`: the same reviewed
 * input, with startup and every unset model role held to the configured model and only the
 * providers its configuration names registered and credentialed, and the same
 * executable, but no stdin — so `omp -p` reads its prompt from argv and never waits on a pipe —
 * and a bounded `session` output lease, which the owner mounts at `SESSION_GUEST_PATH`, that omp
 * writes its transcript straight into.
 *
 * Ordinary review remains placement-agnostic; tool-selected calls review the
 * one-shot operation directly. Both pin the actual operation across preparation
 * and record the exact submitted input in retained provenance.
 */
export async function runSession(
  ctx: OmpContext,
  args: ActionInput<"runSession">,
): Promise<ActionResult<"runSession">> {
  await authorizeTarget(ctx, args, true);
  if (args.prompt.length === 0) throw new OmpRefusal("prompt_required");
  if ((args.inputs ?? []).some(binding => binding.name !== "material") || (args.inputs?.length ?? 0) > 1)
    throw new OmpRefusal("invalid_material_input");
  const first = await oneShotPreparation(ctx, args);
  if (first.prepared.review.reviewDigest !== args.reviewDigest)
    throw new OmpRefusal("review_changed");
  const jobId = await ctx.newId();
  const latest = await oneShotPreparation(ctx, args);
  if (latest.digest !== first.digest) throw new OmpRefusal("resources_changed");
  const agentRun: NativeAgentRunBinding | undefined = args.agentTools === undefined ? undefined : {
    runId: args.agentTools.runId,
    sessionId: randomUUID(),
    target: { machineId: args.machineId, containerId: args.containerId },
  };
  const input = agentRun === undefined ? latest.input : boundedInput({
    ...latest.input,
    automation: JSON.stringify({
      ...latest.prepared.review.automation,
      agentTools: { runId: agentRun.runId, sessionId: agentRun.sessionId },
    }),
  });
  const provenance = provenanceSchema.parse({
    target: latest.prepared.review.destination,
    operationId: SESSION_OPERATION_ID,
    door: "runSession",
    requester: ctx.auth.principal.id,
    pins: latest.pins,
    input,
    inputDigest: digestOf(input),
    defaultsRevision: latest.prepared.review.defaultsRevision,
    accountPool: latest.accountPool,
    broker: latest.prepared.broker,
    gateway: latest.prepared.gateway,
    modelIdentities: null,
    inventoryJobId: null,
    candidates: null,
    inputs: [...(args.inputs ?? []), ...latest.prepared.inputs],
    ...(latest.limits === undefined ? {} : { limits: latest.limits }),
  });
  return execute(ctx, jobId, provenance, [
    { name: SESSION_OUTPUT_NAME, locationId: RUNS_LOCATION_ID, components: [jobId] },
  ], agentRun);
}
/** The retained provenance of a session this door posted, or a refusal naming why not. */
async function sessionProvenance(ctx: OmpContext, target: Target, jobId: string) {
  await authorizeTarget(ctx, target);
  const provenance = await retainedProvenance(ctx, target, jobId);
  if (
    provenance.door !== "runSession" ||
    provenance.modelIdentities !== null ||
    provenance.inventoryJobId !== null ||
    provenance.candidates !== null
  )
    throw new OmpRefusal("provenance_changed");
  return provenance;
}
/**
 * HOW MUCH OF A SESSION'S STANDARD ERROR IS READ TO FIND THE WORD IT DIED WITH.
 *
 * The whole output is read and its sealed digest checked, because a substituted page is not
 * evidence; a stderr larger than this is a run that had plenty to say, and the generic
 * `omp_session_failed` is then the honest answer rather than a guess from a fragment.
 */
const SESSION_STDERR_LIMIT = 1 << 16;
/**
 * WHICH FACT STOPPED A SESSION THAT HAS NO RECEIPT — one word, never an absence (#43).
 *
 * Every one-shot on a machine writes its transcript into the same bounded run location. A
 * session whose siblings filled it dies on ENOSPC mid-transcript and the owner reports a
 * plain non-zero exit with no reason of its own, so `exited`/`exitCode: 1`/no output read
 * identically to an agent that failed on its own account. The session said which it was on
 * its stderr, and this reads it there rather than leaving the caller to guess.
 *
 * A stderr this cannot read leaves `omp_session_failed`: a diagnostic read must never turn
 * an answerable poll into a refusal.
 */
async function sessionSilence(
  ctx: OmpContext,
  machineId: string,
  job: PublicJob,
): Promise<SessionSilence> {
  if (job.state === "refused") return "omp_session_refused";
  if (job.state === "cancelled") return "omp_session_cancelled";
  if (job.state === "interrupted") return "omp_session_interrupted";
  if (job.state !== "exited") return "omp_session_running";
  if (job.result?.exitCode === 0) return "omp_session_unsealed";
  const stderr = job.result?.outputs.find((output) => output.name === "stderr");
  if (!stderr || stderr.bytes < 1 || stderr.bytes > SESSION_STDERR_LIMIT)
    return "omp_session_failed";
  let said: Uint8Array;
  try {
    said = await readNamedOutput(
      ctx,
      machineId,
      SESSION_OPERATION_ID,
      job,
      "stderr",
      SESSION_STDERR_LIMIT,
    );
  } catch {
    return "omp_session_failed";
  }
  return EXHAUSTED_DESTINATION.test(new TextDecoder("utf-8").decode(said))
    ? "omp_session_destination_full"
    : "omp_session_failed";
}
/**
 * The run, and its receipt once there is one. A caller polling a session has to tell "not
 * yet" from "never", so a job that is still going, that failed, or whose transcript the
 * owner could not seal is answered with a null receipt AND the word for which of those it
 * is; only a job this door never posted is refused.
 *
 * The `session` lease is created beneath `atyrode.omp.runs`, which every one-shot mounts
 * writable, and the owner withholds a seal until every overlapping writer exits: a
 * finished one-shot therefore reads back without a receipt while another one-shot that
 * was alive when this lease was created is still running. Only one-shots hold that
 * location — an operator's interactive terminal runs `atyrode.omp.launch`, which never
 * mounts it, so a day-long terminal cannot withhold a receipt.
 *
 * That location is also BOUNDED and SHARED, and this door carries what that costs: a
 * session whose siblings filled it never wrote a transcript, and says so as
 * `omp_session_destination_full` instead of as an empty success (#43).
 */
export async function readSession(
  ctx: OmpContext,
  args: ActionInput<"readSession">,
): Promise<ActionResult<"readSession">> {
  const target = { containerId: args.containerId, machineId: args.machineId };
  const provenance = await sessionProvenance(ctx, target, args.jobId);
  const result = await readSealedArchive(
    ctx,
    args.machineId,
    "session",
    args.jobId,
    "runSession",
    SESSION_OUTPUT_NAME,
    SESSION_ARCHIVE_LIMIT,
  );
  checkJob(result.job, provenance, args.jobId);
  if (result.archive === null)
    return {
      job: result.job,
      session: null,
      silence: await sessionSilence(ctx, args.machineId, result.job),
    };
  // THE CONFIGURED MODEL COMES FROM THE PROVENANCE OF THE JOB THIS DOOR POSTED, never from the
  // transcript, so the receipt's two models have independent origins and a substitution cannot
  // present itself as agreement. A withdrawn id was answered by a published PAID model and the
  // receipt named only the substitute, which makes the one artifact anyone audits able to
  // attest to a run nobody configured (#49).
  const retained = RetainedSessionConfigSchema.parse(JSON.parse(String(provenance.input.config)));
  const configuredModel = retained.modelRoles.default;
  const session = parseSessionArchive(
    result.archive,
    SESSION_GUEST_PATH,
    result.job.result?.exitCode ?? 0,
    configuredModel,
  );
  // A trailing thinking level is not part of the id, and the transcript never carries one, so
  // comparing the written form would report every levelled model as substituted.
  const asked = splitThinking(configuredModel).bare;
  // `modelFallback: false` means no path may resolve to another model, so a receipt naming one
  // is refused rather than recorded. With fallback permitted the receipt keeps both names and
  // the caller decides; it is never reduced to the substitute alone.
  //
  // ONLY A SUBSTITUTION THAT SERVED IS REFUSED. A last turn that ended in an error names
  // whatever model the agent was about to use when the gateway would not serve it, and
  // refusing there would throw away `failure` — the one word that says what stopped the run —
  // and replace a named fact with a less informative refusal, which is the defect #43 and #46
  // exist to prevent. That case keeps its ending, with both model names in the receipt so the
  // mismatch is still auditable.
  if (session.model !== asked && session.failure === null && retained.retry?.modelFallback !== true)
    throw new OmpRefusal("model_substituted");
  return { job: result.job, session, silence: null };
}

/** Observe the retained job through its native owner, closing the temporary follow lease. */
export async function followSession(
  ctx: OmpContext,
  args: ActionInput<"followSession">,
): Promise<ActionResult<"followSession">> {
  const target = { containerId: args.containerId, machineId: args.machineId };
  const provenance = await sessionProvenance(ctx, target, args.jobId);
  const posted = await jobOfDoor(ctx, args.machineId, "session", args.jobId, "runSession");
  checkJob(posted, provenance, args.jobId);
  const node = { kind: "job" as const, machineId: args.machineId,
    operationId: posted.operationId, jobId: args.jobId };
  const follow = await ctx.jobs.follow(node, () => {});
  let snapshot: JobFollowSnapshot;
  try {
    snapshot = follow.snapshot;
  } finally {
    await follow.close();
  }
  if (snapshot.jobId !== args.jobId ||
    (snapshot.result !== null &&
      (snapshot.result.jobId !== args.jobId || snapshot.result.state !== snapshot.state)))
    throw new OmpRefusal("provenance_changed");
  const job = PublicJobSchema.parse({ ...posted, state: snapshot.state, result: snapshot.result });
  checkJob(job, provenance, args.jobId);
  // The durable journal outlives the live ring; neither projection includes output bytes.
  const observed = job.result === null ? snapshot : await ctx.jobs.journal({ node, limit: 128 });
  if (observed.jobId !== args.jobId) throw new OmpRefusal("provenance_changed");
  let progress: JobProgressEvent | null = null;
  const inferenceCalls: ActionResult<"followSession">["inferenceCalls"] = [];
  for (const { seq, event } of observed.events) {
    if ("jobId" in event && event.jobId !== args.jobId)
      throw new OmpRefusal("provenance_changed");
    if (event.type === "job_progress") progress = event;
    if (event.type === "inference_call") {
      const { model, inputTokens, outputTokens, cachedInputTokens, costMicros, elapsedMs, status } = event;
      inferenceCalls.push({ seq, model, inputTokens, outputTokens, cachedInputTokens, costMicros, elapsedMs, status });
    }
  }
  return {
    job,
    inferenceUsage: observed.inferenceUsage,
    progress: progress === null ? null : {
      stage: progress.stage, at: progress.at,
      ...(progress.message === undefined ? {} : { message: progress.message }),
      ...(progress.fraction === undefined ? {} : { fraction: progress.fraction }),
    },
    inferenceCalls,
    seq: snapshot.seq,
    firstSeq: observed.firstSeq,
    unavailable: job.result === null ? snapshot.unavailable :
      (observed.firstSeq === null ? snapshot.seq : observed.firstSeq - 1) > 0
        ? { fromSeq: 1, toSeq: observed.firstSeq === null ? snapshot.seq : observed.firstSeq - 1 } : null,
  };
}
/**
 * Ends a session this door posted. The hub already treats cancelling a settled job as a
 * no-op, so the request is unconditional and the answer is the job as it stands after it:
 * cancellation is asked for, not observed, and a caller reads the outcome from `state`.
 */
export async function cancelSession(
  ctx: OmpContext,
  args: ActionInput<"cancelSession">,
): Promise<ActionResult<"cancelSession">> {
  const target = { containerId: args.containerId, machineId: args.machineId };
  const provenance = await sessionProvenance(ctx, target, args.jobId);
  const posted = await jobOfDoor(
    ctx,
    args.machineId,
    "session",
    args.jobId,
    "runSession",
  );
  // A changed ceiling invalidates receipt attestation, not authority to stop this exact job.
  checkJob(posted, provenance, args.jobId, false);
  const node = {
    kind: "job" as const,
    machineId: args.machineId,
    operationId: posted.operationId,
    jobId: args.jobId,
  };
  await ctx.jobs.cancel(node);
  const job = PublicJobSchema.parse(await ctx.jobs.status(node));
  checkJob(job, provenance, args.jobId, false);
  return { job };
}

export async function prepareSession(
  ctx: OmpContext,
  args: ActionInput<"prepareSession">,
): Promise<ActionResult<"prepareSession">> {
  return prepareReviewedSession(ctx, args);
}

/** Trusted harness entry, never an action argument. The UUID is reviewed as native
 * operation input and the worker writes that exact ID into its OMP transcript. */
export async function prepareHarnessSession(
  ctx: OmpContext,
  args: ActionInput<"reviewSession">,
  existingSession?: OmpSessionRef,
) {
  const session = existingSession ? OmpSessionRefSchema.parse(existingSession) : undefined;
  if (session && session.machineId !== args.machineId) throw new OmpRefusal("session_binding_changed");
  const sessionId = session?.sessionId ?? randomUUID();
  const resume = session !== undefined;
  const review = await sessionPreparation(ctx, args, sessionId, resume);
  const prepared = await prepareReviewedSession(
    ctx, { ...args, reviewDigest: review.review.reviewDigest }, sessionId, resume,
  );
  return PreparedHarnessSessionSchema.parse({
    ...prepared,
    session: { harness: OMP_PLUGIN_ID, sessionId, machineId: prepared.destination.machineId },
  });
}

export async function prepareInteractiveResume(
  ctx: OmpContext,
  args: ActionInput<"resumeSession">,
): Promise<ActionResult<"resumeSession">> {
  // An optional destination is checked when supplied, but never bound into the
  // descriptor. The native terminal placement door must authorize its own target.
  if (args.containerId !== undefined)
    await authorizeTarget(ctx, { containerId: args.containerId, machineId: args.machineId }, true);
  const defaults = await readDefaults(ctx);
  const operationId = RESUME_OPERATION_ID;
  const input = {
    machineId: args.machineId, expectedDefaultsRevision: defaults.revision,
    accountPool: args.accountPool, overlay: args.overlay ?? {}, prompt: "", planYolo: false,
    skills: args.skills,
    automation: args.automation,
  };
  const first = await sessionRuntimePreparation(ctx, input, operationId, args.sessionId, true, args.overrides);
  const latest = await sessionRuntimePreparation(ctx, input, operationId, args.sessionId, true, args.overrides);
  if (digestOf(first) !== digestOf(latest)) throw new OmpRefusal("resources_changed");
  return PreparedResumeSessionSchema.parse({
    machineId: args.machineId,
    sessionId: args.sessionId,
    runtime: {
      machineId: args.machineId, pluginId: OMP_PLUGIN_ID, operationId,
      ...latest.current.pins, input: latest.input,
      session: { harness: OMP_PLUGIN_ID, machineId: args.machineId, sessionId: args.sessionId },
      ...(latest.inputs.length > 0 ? { inputs: latest.inputs } : {}),
    },
  });
}
