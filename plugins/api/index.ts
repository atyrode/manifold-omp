import { z } from "zod";
import {
  DeploymentProgressSchema,
  PublicJobSchema,
  TerminalRuntimeSchema,
} from "./native.ts";
import {
  identifier,
  epochMilliseconds,
  ThinkingLevelSchema,
  RuntimeAccountPoolSchema,
  AccountReferenceSchema,
  AccountsObservationSchema,
  BrokerClientAccessSchema,
} from "./contracts.ts";
import {
  ProbeIdentitiesSchema,
  BenchmarkInputSchema,
  InventoryReceiptSchema,
  BenchmarkReceiptSchema,
} from "./probe.ts";
import { PermittedUsageSnapshotSchema } from "./usage.ts";
import { SessionReceiptSchema } from "./session.ts";
export * from "./contracts.ts";
export * from "./probe.ts";
export * from "./session.ts";
export {
  DeploymentProgressSchema,
  PublicJobSchema,
  TerminalRuntimeSchema,
  type PublicJob,
  type TerminalRuntime,
} from "./native.ts";
export {
  PermittedUsageSnapshotSchema,
  type PermittedUsageSnapshot,
} from "./usage.ts";

export const OMP_PLUGIN_ID = "atyrode.omp";
export const ACCOUNTS_PLUGIN_ID = "atyrode.omp.accounts";
export const GATEWAY_PLUGIN_ID = "atyrode.omp.gateway";
export const BROKER_SERVICE_ID = `${ACCOUNTS_PLUGIN_ID}.broker`;
export const BROKER_OPERATION_ID = BROKER_SERVICE_ID;
export const SIGN_IN_OPERATION_ID = `${ACCOUNTS_PLUGIN_ID}.sign-in`;
export const GATEWAY_OPERATION_ID = `${GATEWAY_PLUGIN_ID}.serve`;
export const PREPARE_WORKSPACE_OPERATION_ID = `${OMP_PLUGIN_ID}.prepare-workspace`;
export const VALIDATE_WORKSPACE_OPERATION_ID = `${OMP_PLUGIN_ID}.validate-workspace`;
export const INVENTORY_OPERATION_ID = `${OMP_PLUGIN_ID}.inventory`;
export const BENCHMARK_OPERATION_ID = `${OMP_PLUGIN_ID}.benchmark`;
export const LAUNCH_OPERATION_ID = `${OMP_PLUGIN_ID}.launch`;
/** The one-shot sibling of `launch`: no stdin, its own bounded output lease. */
export const SESSION_OPERATION_ID = `${OMP_PLUGIN_ID}.session`;
/** A bound output name, never the implicit `stdout`/`stderr` streams. */
export const SESSION_OUTPUT_NAME = "session";
/** Named outputs lease a bounded tmpfs, which only the runtime anchor provides. */
export const RUNS_LOCATION_ID = `${OMP_PLUGIN_ID}.runs`;
/** Where the owner mounts this job's `session` lease, as the manifest's argv spells it. */
export const SESSION_GUEST_PATH = `/outputs/${SESSION_OUTPUT_NAME}`;
/** The launch operation's persistent sessions location: the interactive path's own. */
export const SESSIONS_GUEST_PATH = "/home/job/omp-sessions";
export const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(128);
const empty = z.strictObject({});
export const TargetSchema = z.strictObject({ containerId: id, machineId: id });
export type Target = z.infer<typeof TargetSchema>;
export const OmpSessionRefSchema = z.strictObject({
  harness: z.literal(OMP_PLUGIN_ID),
  sessionId: z.uuid(),
  machineId: id,
});
export type OmpSessionRef = z.infer<typeof OmpSessionRefSchema>;
export const ResourcePinsSchema = z.strictObject({
  installationRevision: id,
  artifactSha256: digest,
  resourceBindingDigest: digest,
});
export const ServicePinSchema = z.strictObject({
  serviceId: identifier,
  revision: id,
  policySha256: digest,
});
export type ServicePin = z.infer<typeof ServicePinSchema>;
export const BrokerReferenceSchema = z.strictObject({
  serviceId: z.literal(BROKER_SERVICE_ID),
  revision: id,
  machineId: id,
});
export type BrokerReference = z.infer<typeof BrokerReferenceSchema>;

// Only OMP settings with no filesystem, extension, shell, environment or credential authority.
const modelReference = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/:-]{0,511}$/);
const references = z
  .record(identifier, modelReference)
  .refine((value) => Object.keys(value).length <= 128);
export const OverlaySchema = z.strictObject({
  modelRoles: references.optional(),
  retry: z
    .strictObject({
      enabled: z.boolean(),
      modelFallback: z.boolean(),
      fallbackRevertPolicy: z.literal("cooldown-expiry").optional(),
      fallbackChains: z
        .record(identifier, z.array(modelReference).max(64))
        .refine((value) => Object.keys(value).length <= 128)
        .optional(),
    })
    .optional(),
  task: z
    .strictObject({
      agentModelOverrides: z
        .record(
          identifier,
          z.union([
            modelReference,
            z.string().regex(/^@[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
          ]),
        )
        .refine((value) => Object.keys(value).length <= 128)
        .optional(),
      agentAdvisor: z.strictObject({ task: z.enum(["on", "off"]) }).optional(),
      prewalk: z.boolean().optional(),
    })
    .optional(),
  prewalk: z.strictObject({ enabled: z.boolean() }).optional(),
  defaultThinkingLevel: ThinkingLevelSchema.optional(),
  advisor: z.strictObject({ enabled: z.boolean() }).optional(),
  tier: z
    .record(identifier, identifier)
    .refine((value) => Object.keys(value).length <= 64)
    .optional(),
});
export type Overlay = z.infer<typeof OverlaySchema>;
/** Top-level one-shot keys replace whole default values, including maps and arrays.
 * Omission inherits; empty maps replace. Sealed security settings always win last.
 * Every defaults change invalidates every outstanding review, even if effective values match.
 * Neither defaults nor overlays read or mutate personal OMP configuration. */
export const DEFAULTS_PRECEDENCE = [
  "plugin-defaults",
  "one-shot-top-level-replacement",
  "sealed-native-security",
] as const;
export const DefaultsSchema = z.strictObject({
  revision,
  overlay: OverlaySchema,
  updatedAt: epochMilliseconds.nullable(),
  updatedBy: id.nullable(),
});
export type Defaults = z.infer<typeof DefaultsSchema>;
export const RefusalSchema = z.strictObject({
  refused: z.string().regex(/^omp_[a-z0-9_]+$/),
});
export const ReadinessStateSchema = z.enum([
  "ready",
  "missing",
  "unsupported",
  "offline",
  "approval_required",
  "refused",
]);
/** Native approval and resource health do not confer the dispatching caller's authority.
 * Observations cover this operation's owner only, not transitive owners or terminal placement. */
export const OperationReadinessSchema = z.strictObject({
  operationId: identifier,
  state: ReadinessStateSchema,
  reason: identifier.nullable(),
  pins: ResourcePinsSchema.nullable(),
  nativeReady: z.boolean(),
  callerRefusal: identifier.nullable(),
});
export const ServiceReadinessSchema = z.strictObject({
  serviceId: identifier,
  state: ReadinessStateSchema,
  reason: identifier.nullable(),
});
// Native deployment progress only: the retained machine declaration is not a product API.
/** Root-owned operations and visible service dependencies, not whole-session readiness.
 * Clients must independently observe accounts and gateway through their own action doors. */
export const DestinationSchema = TargetSchema.extend({
  pluginId: identifier,
  state: ReadinessStateSchema,
  reason: identifier.nullable(),
  operations: z.array(OperationReadinessSchema),
  services: z.array(ServiceReadinessSchema),
  deployment: DeploymentProgressSchema,
});
export const ReviewSchema = z.strictObject({
  reviewDigest: digest,
  destination: TargetSchema,
  operationId: identifier,
  pins: ResourcePinsSchema,
});
const workspaceInput = TargetSchema.extend({
  mode: z.enum(["create", "validate"]),
});
const executionInput = TargetSchema.extend({
  expectedDefaultsRevision: revision,
  accountPool: RuntimeAccountPoolSchema,
});
export const InventoryInputSchema = executionInput.extend({
  modelIdentities: ProbeIdentitiesSchema.optional(),
});
export const SessionInputSchema = executionInput.extend({
  overlay: OverlaySchema,
  prompt: z.string().max(16384),
  planYolo: z.boolean(),
});
/** Durable dials share the exact validated launch settings; paths and credentials
 * are deliberately not part of a profile. Defaults are reviewed at each launch. */
export const OmpHarnessProfileSchema = SessionInputSchema.omit({
  containerId: true,
  machineId: true,
  expectedDefaultsRevision: true,
  prompt: true,
});
export type OmpHarnessProfile = z.infer<typeof OmpHarnessProfileSchema>;
export const SessionReviewSchema = ReviewSchema.extend({
  defaultsRevision: revision,
  effectiveOverlay: OverlaySchema,
  accountPool: RuntimeAccountPoolSchema,
});
export const PreparedSessionSchema = z
  .strictObject({
    destination: TargetSchema,
    runtime: TerminalRuntimeSchema,
    reviewDigest: digest,
  })
  .refine((value) => value.runtime.machineId === value.destination.machineId, {
    message: "runtime destination does not match review",
  });
export const PreparedHarnessSessionSchema = PreparedSessionSchema.safeExtend({
  session: OmpSessionRefSchema,
}).refine(value =>
  value.session.machineId === value.destination.machineId &&
  value.runtime.input.sessionId === value.session.sessionId,
  { message: "harness session does not match admitted runtime" },
);
export const PreparedSignInSchema = z
  .strictObject({ machineId: id, runtime: TerminalRuntimeSchema })
  .refine((value) => value.runtime.machineId === value.machineId, {
    message: "runtime destination does not match owner",
  });
/** Accounts-owned runtime availability. Terminal placement still requires its own
 * destination/container authorization; this observation neither chooses nor opens one. */
export const AccountSetupSchema = z.strictObject({
  revision: id.nullable(),
  owner: z.strictObject({ machineId: id, online: z.boolean() }).nullable(),
  state: ReadinessStateSchema,
  reason: identifier.nullable(),
  brokerState: z.enum([
    "unconfigured",
    "starting",
    "ready",
    "stopped",
    "unavailable",
    "disabled",
  ]),
  nativeReady: z.boolean(),
  callerRefusal: identifier.nullable(),
  canSignIn: z.boolean(),
  canReview: z.boolean(),
  deployment: DeploymentProgressSchema,
});
const accountReviewInput = z.strictObject({
  expectedBrokerRevision: id.nullable(),
  // Omission retains working clients; null explicitly reviews removing their listener.
  clientAccess: BrokerClientAccessSchema.nullable().optional(),
});
export const AccountRuntimeReviewSchema = z.strictObject({
  expectedBrokerRevision: id.nullable(),
  ownerMachineId: id,
  clientAccess: BrokerClientAccessSchema.nullable(),
  broker: ResourcePinsSchema,
  signIn: ResourcePinsSchema,
  reviewDigest: digest,
});
const gatewayReviewInput = TargetSchema.extend({
  expectedServiceRevision: id.nullable(),
});
export const GatewayReviewSchema = z.strictObject({
  destination: TargetSchema,
  expectedServiceRevision: id.nullable(),
  runtime: ResourcePinsSchema,
  reviewDigest: digest,
});
export const GatewaySetupSchema = z.strictObject({
  destination: TargetSchema,
  revision: id.nullable(),
  operation: OperationReadinessSchema,
  nativeReady: z.boolean(),
  callerRefusal: identifier.nullable(),
  canReview: z.boolean(),
  deployment: DeploymentProgressSchema,
});
const accountControl = z.strictObject({
  containerId: id,
  reference: AccountReferenceSchema,
  credentialId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const rootActionSchemas = {
  readDefaults: { input: empty, result: DefaultsSchema },
  writeDefaults: {
    input: z.strictObject({
      expectedRevision: revision,
      overlay: OverlaySchema,
    }),
    result: DefaultsSchema,
  },
  describeDestination: { input: TargetSchema, result: DestinationSchema },
  reviewWorkspace: { input: workspaceInput, result: ReviewSchema },
  prepareWorkspace: {
    input: workspaceInput.extend({ reviewDigest: digest }),
    result: PublicJobSchema,
  },
  startInventory: { input: InventoryInputSchema, result: PublicJobSchema },
  readInventory: {
    input: TargetSchema.extend({ jobId: id }),
    result: z.strictObject({
      job: PublicJobSchema,
      inventory: InventoryReceiptSchema,
    }),
  },
  startBenchmark: {
    input: TargetSchema.extend({
      inventoryJobId: id,
      candidates: BenchmarkInputSchema,
    }),
    result: PublicJobSchema,
  },
  readBenchmark: {
    input: TargetSchema.extend({ inventoryJobId: id, jobId: id }),
    result: z.strictObject({
      job: PublicJobSchema,
      benchmark: BenchmarkReceiptSchema,
    }),
  },
  reviewSession: { input: SessionInputSchema, result: SessionReviewSchema },
  prepareSession: {
    input: SessionInputSchema.extend({ reviewDigest: digest }),
    result: PreparedSessionSchema,
  },
  /** The same reviewed session, placed as a governed one-shot job instead of a terminal. */
  runSession: {
    input: SessionInputSchema.extend({ reviewDigest: digest }),
    result: PublicJobSchema,
  },
  /** The job always, for a session this door posted; the receipt only once it is sealed. */
  readSession: {
    input: TargetSchema.extend({ jobId: id }),
    result: z.strictObject({
      job: PublicJobSchema,
      session: SessionReceiptSchema.nullable(),
    }),
  },
  /** Ends a session this door posted. Idempotent: a settled run is answered, not refused. */
  cancelSession: {
    input: TargetSchema.extend({ jobId: id }),
    result: z.strictObject({ job: PublicJobSchema }),
  },
} as const;
export const accountActionSchemas = {
  accounts: { input: empty, result: AccountsObservationSchema },
  usage: {
    input: empty,
    result: z.strictObject({
      accounts: AccountsObservationSchema,
      snapshot: PermittedUsageSnapshotSchema.nullable(),
      refreshStatus: z.enum(["succeeded", "failed"]),
    }),
  },
  clearAccountBlocks: {
    input: accountControl,
    result: AccountsObservationSchema,
  },
  disableCredential: {
    input: accountControl,
    result: AccountsObservationSchema,
  },
  readAccountSetup: { input: empty, result: AccountSetupSchema },
  reviewAccountRuntime: {
    input: accountReviewInput,
    result: AccountRuntimeReviewSchema,
  },
  promoteAccountRuntime: {
    input: accountReviewInput.extend({ containerId: id, reviewDigest: digest }),
    result: z.strictObject({ revision: id }),
  },
  prepareSignIn: {
    input: z.strictObject({ containerId: id, expectedBrokerRevision: id }),
    result: PreparedSignInSchema,
  },
} as const;
export const gatewayActionSchemas = {
  readGatewaySetup: { input: TargetSchema, result: GatewaySetupSchema },
  reviewGateway: { input: gatewayReviewInput, result: GatewayReviewSchema },
  configureGateway: {
    input: gatewayReviewInput.extend({ reviewDigest: digest }),
    result: z.strictObject({ revision: id }),
  },
} as const;
export const actionSchemas = {
  ...rootActionSchemas,
  ...accountActionSchemas,
  ...gatewayActionSchemas,
} as const;
export type RootAction = keyof typeof rootActionSchemas;
export type AccountAction = keyof typeof accountActionSchemas;
export type GatewayAction = keyof typeof gatewayActionSchemas;
export type OmpAction = keyof typeof actionSchemas;
export type ActionInput<K extends OmpAction> = z.infer<
  (typeof actionSchemas)[K]["input"]
>;
export type ActionResult<K extends OmpAction> = z.infer<
  (typeof actionSchemas)[K]["result"]
>;
export type ActionReply<K extends OmpAction> =
  ActionResult<K> | z.infer<typeof RefusalSchema>;
export function actionDoor(name: OmpAction): string {
  const pluginId = Object.hasOwn(accountActionSchemas, name)
    ? ACCOUNTS_PLUGIN_ID
    : Object.hasOwn(gatewayActionSchemas, name)
      ? GATEWAY_PLUGIN_ID
      : OMP_PLUGIN_ID;
  return `${pluginId}.${name}`;
}
/** Supply the caller's ordinary native dispatch transport; this adapter grants no authority. */
export function createOmpClient(
  dispatch: (door: string, input: unknown) => Promise<unknown>,
) {
  return {
    async call<K extends OmpAction>(
      name: K,
      input: ActionInput<K>,
    ): Promise<ActionReply<K>> {
      const args = actionSchemas[name].input.parse(input);
      const raw = await dispatch(actionDoor(name), args);
      const refused = RefusalSchema.safeParse(raw);
      return (
        refused.success ? refused.data : actionSchemas[name].result.parse(raw)
      ) as ActionReply<K>;
    },
  };
}
