import { createHash } from "node:crypto";
import type { GuestCtx } from "@manifold/plugin-kit/server";
import {
  canonicalJobJson,
  formatManifoldUri,
  hasCap,
  InstanceServiceDescriptionSchema,
  InstanceServicesDescriptionSchema,
  JobDescriptionSchema,
  JobDeploymentDescriptionSchema,
  MAX_JOB_OUTPUT_PAGE_BYTES,
  PublicJobSchema,
  type PublicJob,
  type JobDescription,
  type Cap,
  type ManifoldRef,
  type MachineOperation,
  type MachineHalf,
} from "@manifold/protocol";
import {
  OMP_PLUGIN_ID,
  ACCOUNTS_PLUGIN_ID,
  GATEWAY_PLUGIN_ID,
  BROKER_SERVICE_ID,
  ResourcePinsSchema,
  type Target,
  type ActionResult,
} from "../api/index.ts";
import rootManifest from "./manifest.json";
import accountsManifest from "./accounts/manifest.json";
import gatewayManifest from "./gateway/manifest.json";

export type OmpContext = Pick<
  GuestCtx,
  | "pluginId"
  | "jobs"
  | "services"
  | "newId"
  | "now"
  | "storage"
  | "auth"
  | "outsideScope"
>;
export class OmpRefusal extends Error {
  constructor(readonly code: string) {
    super(`omp_${code}`);
  }
}
export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJobJson(value)).digest("hex");
}
/** The grant waterfall and the credential's carried capability ceiling are both required. */
export async function callerCapabilityRefusal(
  ctx: OmpContext,
  cap: Exclude<Cap, "*">,
  ref: ManifoldRef,
): Promise<string | null> {
  if (!hasCap(ctx.auth.caps, cap))
    return `caller_${cap.replace(":", "_")}_required`;
  try {
    return (await ctx.auth.allows(cap, ref))
      ? null
      : `caller_${cap.replace(":", "_")}_required`;
  } catch {
    return "caller_authority_unobserved";
  }
}
export async function authorizeContainer(
  ctx: OmpContext,
  containerId: string,
  write = false,
): Promise<void> {
  if (
    (await ctx.outsideScope(containerId)) ||
    (await callerCapabilityRefusal(
      ctx,
      write ? "containers:write" : "containers:read",
      { kind: "container", containerId },
    ))
  )
    throw new OmpRefusal("scope_refused");
}
export async function authorizeTarget(
  ctx: OmpContext,
  target: Target,
  write = false,
): Promise<void> {
  await authorizeContainer(ctx, target.containerId, write);
}
export async function authorizeTerminalSpawn(
  ctx: OmpContext,
  containerId: string,
): Promise<void> {
  const denied = await callerCapabilityRefusal(ctx, "terminals:spawn", {
    kind: "container",
    containerId,
  });
  if (denied) throw new OmpRefusal(denied);
}
export async function authorizeOwner(
  ctx: OmpContext,
  machineId: string,
): Promise<void> {
  if (!ctx.auth.isRoot) throw new OmpRefusal("service_owner_required");
  const denied = await callerCapabilityRefusal(ctx, "services:configure", {
    kind: "machine",
    machineId,
  });
  if (denied)
    throw new OmpRefusal(
      denied === "caller_authority_unobserved"
        ? denied
        : "service_owner_required",
    );
}
export function actor(ctx: OmpContext) {
  return {
    principal: ctx.auth.principal,
    caps: [...ctx.auth.caps].sort(),
    containerScope: ctx.auth.containerScope,
    isRoot: ctx.auth.isRoot,
  };
}
export async function observeNative(ctx: OmpContext, machineId: string) {
  // A part must use its own action/context namespace for every native jobs handle.
  if (
    ctx.pluginId !== OMP_PLUGIN_ID &&
    ctx.pluginId !== ACCOUNTS_PLUGIN_ID &&
    ctx.pluginId !== GATEWAY_PLUGIN_ID
  )
    throw new OmpRefusal("scope_refused");
  const denied = await callerCapabilityRefusal(ctx, "machines:run", {
    kind: "machine",
    machineId,
  });
  if (denied) throw new OmpRefusal(denied);
  const [description, deployment] = await Promise.all([
    ctx.jobs
      .describe({ machineId, pluginId: ctx.pluginId })
      .then((value) => JobDescriptionSchema.parse(value)),
    ctx.jobs
      .describeDeployment({ machineId, pluginId: ctx.pluginId })
      .then((value) => JobDeploymentDescriptionSchema.parse(value)),
  ]);
  if (
    description.machineId !== machineId ||
    description.pluginId !== ctx.pluginId ||
    (deployment.deployment &&
      (deployment.deployment.machineId !== machineId ||
        deployment.deployment.pluginId !== ctx.pluginId))
  )
    throw new OmpRefusal("resources_changed");
  const installation = description.installation;
  if (
    installation &&
    (!deployment.installation ||
      deployment.installation.revision !== installation.revision ||
      deployment.installation.artifactSha256 !== installation.artifactSha256)
  )
    throw new OmpRefusal("resources_changed");
  return { description, deployment };
}
type OperationDeclaration = Pick<
  MachineOperation,
  "network" | "locations" | "stdin" | "services"
>;
function operationDeclaration(pluginId: string, operationId: string) {
  if (
    pluginId !== OMP_PLUGIN_ID &&
    pluginId !== ACCOUNTS_PLUGIN_ID &&
    pluginId !== GATEWAY_PLUGIN_ID
  )
    return undefined;
  const machine =
    pluginId === ACCOUNTS_PLUGIN_ID
      ? accountsManifest.machine
      : pluginId === GATEWAY_PLUGIN_ID
        ? gatewayManifest.machine
        : rootManifest.machine;
  return (machine.operations as Record<string, OperationDeclaration>)[
    operationId
  ];
}
function operationRights(
  description: JobDescription,
  operationId: string,
  declaration: OperationDeclaration | undefined,
) {
  const node = {
    kind: "operation" as const,
    machineId: description.machineId,
    operationId,
  };
  const rights: { cap: Exclude<Cap, "*">; ref: ManifoldRef }[] = [
    { cap: "machines:run", ref: node },
  ];
  if (!declaration) return rights;
  if (declaration.stdin || description.pluginId === OMP_PLUGIN_ID)
    rights.push({ cap: "jobs:read", ref: node });
  if (declaration.stdin) rights.push({ cap: "jobs:input", ref: node });
  if (declaration.network === "host")
    rights.push({ cap: "network:host", ref: node });
  for (const location of declaration.locations)
    rights.push({
      cap: `locations:${location.access}`,
      ref: {
        kind: "location",
        machineId: description.machineId,
        locationId: location.locationId,
      },
    });
  for (const service of declaration.services ?? [])
    for (const operationId of service.operationIds)
      rights.push({
        cap: "services:invoke",
        ref: {
          kind: "service",
          machineId: description.machineId,
          serviceId: service.serviceId,
          operationId,
        },
      });
  return rights;
}
export async function operationReadiness(
  ctx: OmpContext,
  description: JobDescription,
  operationId: string,
  machine: MachineHalf | undefined,
): Promise<ActionResult<"describeDestination">["operations"][number]> {
  if (description.pluginId !== ctx.pluginId)
    throw new OmpRefusal("scope_refused");
  // The retained installation, not this server version's manifest, owns the
  // actual bound references. Authored declarations only classify absent installs.
  const declaration = machine
    ? machine.operations[operationId]
    : operationDeclaration(description.pluginId, operationId);
  const installation = description.installation,
    operation = description.operations?.[operationId];
  const rights = operationRights(description, operationId, declaration);
  let callerRefusal: string | null =
    declaration && machine ? null : "caller_authority_unobserved";
  for (const { cap, ref } of rights) {
    callerRefusal ??= await callerCapabilityRefusal(ctx, cap, ref);
    if (callerRefusal) break;
  }
  const result = (
    state: ActionResult<"describeDestination">["state"],
    reason: string | null,
  ) => ({
    operationId,
    state: state === "ready" && callerRefusal ? ("refused" as const) : state,
    reason: state === "ready" ? callerRefusal : reason,
    nativeReady: state === "ready",
    callerRefusal,
    pins:
      installation && operation
        ? ResourcePinsSchema.parse({
            installationRevision: installation.revision,
            artifactSha256: installation.artifactSha256,
            resourceBindingDigest: operation.resourceBindingDigest,
          })
        : null,
  });
  if (!description.connected) return result("offline", "machine_offline");
  if (!description.platforms.includes("linux-x64"))
    return result("unsupported", "platform_unsupported");
  if (!declaration) return result("unsupported", "operation_unsupported");
  if (!installation || !operation)
    return result("missing", "installation_missing");
  if (!installation.enabled || installation.purgeRequested)
    return result("refused", "installation_disabled");
  // Bound service consent/resource health is already graded by the native operation
  // description. The installation's consents describe only its own operation/locations.
  if (
    rights.some(
      ({ cap, ref }) =>
        ref.kind !== "service" &&
        !description.consents.some(
          (consent) =>
            consent.node === formatManifoldUri(ref) &&
            consent.cap === cap &&
            consent.enabled,
        ),
    )
  )
    return result("approval_required", "native_consent_required");
  if (!operation.ready) {
    const reason = operation.reason ?? "resources_incomplete";
    return result(
      reason.includes("unsupported")
        ? "unsupported"
        : reason.includes("missing") || reason.includes("unavailable")
          ? "missing"
          : "refused",
      reason,
    );
  }
  if (!installation.ready) return result("missing", "resources_incomplete");
  return result("ready", null);
}
export async function currentOperation(
  ctx: OmpContext,
  machineId: string,
  operationId: string,
) {
  const observation = await observeNative(ctx, machineId);
  const ready = await operationReadiness(
    ctx,
    observation.description,
    operationId,
    observation.deployment.installation?.machine,
  );
  if (ready.state !== "ready" || !ready.pins)
    throw new OmpRefusal(ready.reason ?? "resources_incomplete");
  // Consumed resources are bound by the operation digest. This fresh observation's
  // machine-wide inventory also includes unrelated services that may be quiesced.
  delete observation.description.resources;
  return { ...observation, pins: ready.pins };
}
export async function describeDestination(
  ctx: OmpContext,
  target: Target,
): Promise<ActionResult<"describeDestination">> {
  if (ctx.pluginId !== OMP_PLUGIN_ID) throw new OmpRefusal("scope_refused");
  await authorizeTarget(ctx, target);
  const observed = await observeNative(ctx, target.machineId);
  const operations = await Promise.all(
    Object.keys(rootManifest.machine.operations).map((operation) =>
      operationReadiness(
        ctx,
        observed.description,
        operation,
        observed.deployment.installation?.machine,
      ),
    ),
  );
  const [broker, gatewayDescription] = await Promise.all([
    // Instance discovery hides absent and unauthorized services from non-owners.
    // A hidden broker is not evidence about independent destination operations.
    ctx.auth.isRoot
      ? ctx.services
          .describeInstance({ serviceId: BROKER_SERVICE_ID })
          .then((value) => InstanceServiceDescriptionSchema.parse(value))
      : ctx.services
          .listInstances({})
          .then((value) =>
            InstanceServicesDescriptionSchema.parse(value).services.find(
              (service) => service.serviceId === BROKER_SERVICE_ID,
            ),
          ),
    ctx.services.describe({ machineId: target.machineId }),
  ]);
  if (
    broker &&
    (broker.serviceId !== BROKER_SERVICE_ID ||
      (broker.configuration &&
        broker.configuration.pluginId !== ACCOUNTS_PLUGIN_ID))
  )
    throw new OmpRefusal("resources_changed");
  const gateway = gatewayDescription.services.find(
    (service) => service.serviceId === "omp",
  );
  const gatewayReady =
    gateway &&
    ["models", "stream"].every((operationId) =>
      gateway.operations.some(
        (operation) => operation.operationId === operationId && operation.ready,
      ),
    );
  const brokerCallerRefusal = broker?.owner
    ? await callerCapabilityRefusal(ctx, "services:read", {
        kind: "service",
        machineId: broker.owner.machineId,
        serviceId: BROKER_SERVICE_ID,
        operationId: "metadata",
      })
    : "caller_authority_unobserved";
  const services: ActionResult<"describeDestination">["services"] = [
    {
      serviceId: BROKER_SERVICE_ID,
      state: !broker
        ? "refused"
        : !broker.configuration
          ? "missing"
          : !broker.configuration.enabled
            ? "refused"
            : !broker.connected || !broker.owner?.online
              ? "offline"
              : broker.state !== "ready"
                ? "missing"
                : brokerCallerRefusal
                  ? "refused"
                  : "ready",
      reason: !broker
        ? "caller_authority_unobserved"
        : !broker.configuration
          ? "broker_unconfigured"
          : !broker.configuration.enabled
            ? "broker_disabled"
            : !broker.connected || !broker.owner?.online
              ? "account_owner_unavailable"
              : broker.state !== "ready"
                ? "broker_unavailable"
                : brokerCallerRefusal,
    },
    {
      serviceId: "omp",
      state: !gatewayDescription.connected
        ? "offline"
        : !gateway
          ? "missing"
          : gatewayReady
            ? "ready"
            : "refused",
      reason: !gatewayDescription.connected
        ? "machine_offline"
        : !gateway
          ? "gateway_unconfigured"
          : gatewayReady
            ? null
            : "gateway_unavailable",
    },
  ];
  const failing =
    operations.find((operation) => operation.state !== "ready") ??
    services.find((service) => service.state !== "ready");
  return {
    ...target,
    pluginId: OMP_PLUGIN_ID,
    state: failing?.state ?? "ready",
    reason: failing?.reason ?? null,
    operations,
    services,
    deployment: observed.deployment.deployment,
  };
}
export async function requireCurrentJob(ctx: OmpContext, job: PublicJob) {
  const current = await currentOperation(ctx, job.machineId, job.operationId);
  if (
    job.pluginId !== ctx.pluginId ||
    job.installationRevision !== current.pins.installationRevision ||
    job.artifactSha256 !== current.pins.artifactSha256 ||
    job.resourceBindingDigest !== current.pins.resourceBindingDigest
  )
    throw new OmpRefusal("resources_changed");
  return current;
}
/** Identity and origin only: a job this door posted, in whatever state it now stands. */
async function postedJob(
  ctx: OmpContext,
  machineId: string,
  operationId: string,
  jobId: string,
  door?: string,
) {
  const job = PublicJobSchema.parse(
    await ctx.jobs.status({ kind: "job", machineId, operationId, jobId }),
  );
  if (
    job.machineId !== machineId ||
    job.pluginId !== OMP_PLUGIN_ID ||
    job.operationId !== operationId ||
    job.jobId !== jobId ||
    job.authority.origin.kind !== "action" ||
    (door !== undefined && job.authority.origin.door !== `${OMP_PLUGIN_ID}.${door}`)
  )
    throw new OmpRefusal("result_unavailable");
  return job;
}
/** A job this door posted, addressed by the operation it runs on. */
export async function jobOfDoor(
  ctx: OmpContext,
  machineId: string,
  operation: string,
  jobId: string,
  door: string,
) {
  return postedJob(ctx, machineId, `${OMP_PLUGIN_ID}.${operation}`, jobId, door);
}
async function settledJob(
  ctx: OmpContext,
  machineId: string,
  operationId: string,
  jobId: string,
  door?: string,
) {
  const job = await postedJob(ctx, machineId, operationId, jobId, door);
  if (job.state !== "exited" || job.result?.exitCode !== 0)
    throw new OmpRefusal("result_unavailable");
  return job;
}
/** Whole-output read: the sealed digest is the only proof the pages were not substituted. */
async function readNamedOutput(
  ctx: OmpContext,
  machineId: string,
  operationId: string,
  job: PublicJob,
  name: string,
  limit: number,
) {
  const output = job.result?.outputs.find((item) => item.name === name);
  if (!output || output.bytes < 1 || output.bytes > limit)
    throw new OmpRefusal("result_unavailable");
  const bytes = Buffer.alloc(output.bytes);
  let offset = 0;
  while (offset < bytes.length) {
    const maxBytes = Math.min(
      MAX_JOB_OUTPUT_PAGE_BYTES,
      bytes.length - offset,
    );
    const chunk = await ctx.jobs.output({
      node: {
        kind: "output",
        machineId,
        operationId,
        jobId: job.jobId,
        outputId: output.outputId,
      },
      offset,
      maxBytes,
    });
    const data = Buffer.from(chunk.data, "base64");
    if (
      chunk.jobId !== job.jobId ||
      chunk.outputId !== output.outputId ||
      chunk.seq !== offset ||
      data.length < 1 ||
      data.length > maxBytes ||
      data.toString("base64") !== chunk.data ||
      chunk.eof !== (offset + data.length === bytes.length)
    )
      throw new OmpRefusal("result_unavailable");
    data.copy(bytes, offset);
    offset += data.length;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== output.sha256)
    throw new OmpRefusal("result_unavailable");
  return bytes;
}
export async function readJobResult(
  ctx: OmpContext,
  machineId: string,
  operation: string,
  jobId: string,
  door?: string,
) {
  const operationId = `${OMP_PLUGIN_ID}.${operation}`;
  const job = await settledJob(ctx, machineId, operationId, jobId, door);
  const bytes = await readNamedOutput(
    ctx,
    machineId,
    operationId,
    job,
    "stdout",
    1 << 20,
  );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new OmpRefusal("result_unavailable");
  }
  await requireCurrentJob(ctx, job);
  return { job, value };
}
/**
 * The job as it stands, and its declared output sealed as one ustar archive when there is
 * one to read. A run still going, one that failed, and one whose output the owner could
 * not seal all answer the job with no archive: only a job this door never posted refuses,
 * because "not yet" and "never" are different answers and a caller must tell them apart.
 */
export async function readSealedArchive(
  ctx: OmpContext,
  machineId: string,
  operation: string,
  jobId: string,
  door: string,
  name: string,
  limit: number,
) {
  const operationId = `${OMP_PLUGIN_ID}.${operation}`;
  const job = await postedJob(ctx, machineId, operationId, jobId, door);
  if (
    job.state !== "exited" ||
    job.result?.exitCode !== 0 ||
    !job.result.outputs.some((item) => item.name === name)
  )
    return { job, archive: null };
  const archive = await readNamedOutput(
    ctx,
    machineId,
    operationId,
    job,
    name,
    limit,
  );
  await requireCurrentJob(ctx, job);
  return { job, archive };
}
