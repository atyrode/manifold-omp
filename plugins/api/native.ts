import { z } from "zod";

const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const component = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine(value => ![".", "..", "__proto__", "constructor", "prototype"].includes(value));
const input = z
  .record(component, z.union([z.string().max(65536), z.number().finite(), z.boolean()]))
  .refine(value => Object.keys(value).length <= 64 &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= 65536);
const terminal = z.strictObject({ terminalId: id, terminalHostId: id, containerId: id, runId: id.optional() }).optional();
const service = z.strictObject({ serviceId: component, revision: component, policySha256: hash }).optional();
const boundOutputName = component.refine(
  value => value !== "stdout" && value !== "stderr",
);
/** The outputs primitive inverted: a declared input of this operation, mounted read-only
 * at `/inputs/<name>`, reading the sealed output of a settled job on the same machine. */
export const JobInputBindingSchema = z.strictObject({
  name: boundOutputName,
  from: z.strictObject({ jobId: id, output: boundOutputName }),
});
export type JobInputBinding = z.infer<typeof JobInputBindingSchema>;
const jobInputs = z.array(JobInputBindingSchema).max(16).optional();

/** The native terminal descriptor OMP returns to a Manifold client. */
export const TerminalRuntimeSchema = z.strictObject({
  machineId: id,
  pluginId: id,
  operationId: id,
  installationRevision: id,
  artifactSha256: hash,
  input,
  inputs: jobInputs,
  resourceBindingDigest: hash,
  session: z.strictObject({ harness: id, machineId: id, sessionId: id }).optional(),
}).refine(value => value.session === undefined || value.session.machineId === value.machineId,
  "session machine does not match runtime");
export type TerminalRuntime = z.infer<typeof TerminalRuntimeSchema>;

export const JobInferenceLimitsSchema = z.strictObject({
  calls: z.number().int().positive().max(1_000_000).optional(),
  inputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  outputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  costMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type JobInferenceLimits = z.infer<typeof JobInferenceLimitsSchema>;
const JobInferenceUsageSchema = z.strictObject({
  calls: count,
  inputTokens: count,
  outputTokens: count,
  cachedInputTokens: count,
  costMicros: count,
});
export const JobLimitsSchema = z.strictObject({
  timeoutMs: z.number().int().nonnegative().max(86400000),
  memoryBytes: z.number().int().positive().max(1099511627776),
  processes: z.number().int().positive().max(4096),
  outputBytes: z.number().int().positive().max(1073741824),
  inputBytes: z.number().int().positive().max(1073741824).optional(),
  inference: JobInferenceLimitsSchema.optional(),
});
const JobStateSchema = z.enum([
  "queued",
  "admitted",
  "start-committed",
  "started",
  "exited",
  "interrupted",
  "cancelled",
  "refused",
]);
const JobResultSchema = z.strictObject({
  jobId: id,
  requestDigest: hash,
  ownerId: id,
  ownerGeneration: count,
  state: JobStateSchema,
  exitCode: z.number().int().nullable(),
  reason: id.nullable(),
  startedAt: count.nullable(),
  finishedAt: count.nullable(),
  usage: z.strictObject({
    elapsedMs: count,
    memoryBytes: count,
    processes: count,
    outputBytes: count,
    inference: JobInferenceUsageSchema.optional(),
  }).nullable(),
  limits: JobLimitsSchema,
  outputs: z.array(z.strictObject({
    outputId: id,
    name: component,
    sha256: hash,
    bytes: count,
    files: count,
  })).max(32),
});
const CapSchema = z.enum([
  "*",
  "containers:read",
  "containers:write",
  "scenes:write",
  "terminals:spawn",
  "terminals:write",
  "tokens:mint",
  "machines:mint",
  "agents:delegate",
  "agents:run",
  "machines:read",
  "machines:run",
  "jobs:read",
  "jobs:input",
  "jobs:cancel",
  "locations:read",
  "locations:write",
  "locations:create",
  "operations:invoke",
  "services:read",
  "services:invoke",
  "services:configure",
  "network:host",
  "plugins:manage",
]);
const JobAuthoritySchema = z.strictObject({
  origin: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("action"), traceId: id, door: id.nullable() }),
    z.strictObject({
      kind: z.literal("service"),
      traceId: id,
      door: id.nullable(),
      serviceId: component,
      revision: component,
    }),
    z.strictObject({
      kind: z.literal("schedule"),
      traceId: id,
      door: id.nullable(),
      scheduleId: id,
      revision: id,
      nominalAt: count,
    }),
    z.strictObject({
      kind: z.literal("invocation"),
      traceId: id,
      door: id.nullable(),
      parentJobId: id,
      invocationId: id,
    }),
  ]),
  requester: id,
  executor: z.strictObject({ machineId: id, ownerId: id, ownerGeneration: count }).nullable(),
  decision: z.strictObject({
    decisionId: id,
    policyRevision: id,
    allowed: z.boolean(),
    refusal: id.nullable(),
    grants: z.array(z.strictObject({
      node: z.string(),
      cap: CapSchema,
      allowed: z.boolean(),
      grantId: id.nullable(),
      authorizer: id.nullable(),
      revision: count,
    })),
    consents: z.array(z.strictObject({ node: z.string(), revision: id, artifactSha256: hash })),
  }).nullable(),
});

/** Complete public job receipt needed to fence OMP reads and continuations. */
export const PublicJobSchema = z.strictObject({
  jobId: id,
  machineId: id,
  operationId: id,
  pluginId: id,
  installationRevision: id,
  artifactSha256: hash,
  inputDigest: hash,
  resourceBindingDigest: hash,
  /** The bound inputs the hub admitted, echoed so a reader sees what this job was handed. */
  inputs: jobInputs,
  limits: JobLimitsSchema.optional(),
  state: JobStateSchema,
  nextInputSeq: count.nullable(),
  result: JobResultSchema.nullable(),
  authority: JobAuthoritySchema,
  terminal,
  service,
  /** The admitted native Run correlation; not a credential or selectable tool grant. */
  agentRunId: id.optional(),
});
export type PublicJob = z.infer<typeof PublicJobSchema>;

/** A bounded native observation, never a transcript or an output-channel replay. */
export const SessionActivitySchema = z.strictObject({
  job: PublicJobSchema,
  inferenceUsage: JobInferenceUsageSchema.extend({
    lastModel: z.string().min(1).max(256).nullable(),
  }).nullable(),
  progress: z.strictObject({
    stage: z.string().regex(/^[a-z0-9](?:[a-z0-9 ._-]{0,62}[a-z0-9])?$/),
    at: count,
    message: z.string().max(256).regex(/^\P{Cc}*$/u).optional(),
    fraction: z.number().min(0).max(1).optional(),
  }).nullable(),
  inferenceCalls: z.array(z.strictObject({
    seq: count,
    model: z.string().min(1).max(256),
    inputTokens: count,
    outputTokens: count,
    cachedInputTokens: count,
    costMicros: count,
    elapsedMs: count,
    status: z.number().int().min(100).max(599),
  })).max(128),
  seq: count,
  firstSeq: count.nullable(),
  unavailable: z.strictObject({ fromSeq: count, toSeq: count }).nullable(),
});
export type SessionActivity = z.infer<typeof SessionActivitySchema>;

/** Destination-scoped native deployment progress exposed by OMP. */
export const DeploymentProgressSchema = z.strictObject({
  deploymentId: id,
  machineId: id,
  pluginId: id,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum([
    "pending",
    "installing",
    "ready",
    "needs_review",
    "refused",
    "cancelled",
    "superseded",
  ]),
  reason: z.string().min(1).max(2048).nullable(),
}).nullable();
