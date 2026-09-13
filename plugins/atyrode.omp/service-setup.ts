import {
  InstanceServiceDescriptionSchema,
  ServiceConfigurationReadSchema,
  ServiceConfigurationSchema,
  ServiceRuntimeSchema,
  TerminalRuntimeSchema,
  type ServicePolicy,
} from "@manifold/protocol";
import {
  ACCOUNTS_PLUGIN_ID,
  BROKER_SERVICE_ID,
  BROKER_OPERATION_ID,
  SIGN_IN_OPERATION_ID,
  GATEWAY_PLUGIN_ID,
  GATEWAY_OPERATION_ID,
  BrokerClientAccessSchema,
  type BrokerClientAccess,
  type ActionInput,
  type ActionResult,
} from "../api/index.ts";
import { describeSharedBroker } from "./broker.ts";
import {
  actor,
  authorizeContainer,
  authorizeOwner,
  authorizeTarget,
  authorizeTerminalSpawn,
  currentOperation,
  digestOf,
  OmpRefusal,
  type OmpContext,
} from "./machine-server.ts";
import {
  buildGatewayPolicy,
  buildSharedBrokerPolicy,
} from "./service-policies.ts";

const signInConfig = JSON.stringify({ startup: { setupWizard: false } });
function expectBrokerRevision(actual: string | null, expected: string | null) {
  if (actual !== expected) throw new OmpRefusal("broker_revision_changed");
}
export async function accountRuntimeReview(
  ctx: OmpContext,
  expectedBrokerRevision: string | null,
  requestedClientAccess?: BrokerClientAccess | null,
) {
  if (ctx.pluginId !== ACCOUNTS_PLUGIN_ID)
    throw new OmpRefusal("scope_refused");
  const description = await describeSharedBroker(ctx);
  expectBrokerRevision(
    description.configuration?.revision ?? null,
    expectedBrokerRevision,
  );
  const owner = description.configuration
    ? description.owner
    : description.defaultOwner;
  if (!owner?.online || !description.connected)
    throw new OmpRefusal("account_owner_unavailable");
  await authorizeOwner(ctx, owner.machineId);
  if (description.reason === "machine_draining")
    throw new OmpRefusal("machine_draining");
  const current = await ctx.services.readInstanceConfiguration({
    serviceId: BROKER_SERVICE_ID,
  });
  expectBrokerRevision(
    current.description.configuration?.revision ?? null,
    expectedBrokerRevision,
  );
  if (
    (current.description.configuration
      ? current.description.owner
      : current.description.defaultOwner
    )?.machineId !== owner.machineId
  )
    throw new OmpRefusal("resources_changed");
  let clientAccess = "{}";
  let resolvedClientAccess: BrokerClientAccess | null = null;
  if (requestedClientAccess !== undefined) {
    resolvedClientAccess = requestedClientAccess;
    clientAccess = JSON.stringify(requestedClientAccess ?? {});
  } else if (current.policy) {
    const access = current.policy.runtime?.input.clientAccess;
    if (!access || !("literal" in access) || typeof access.literal !== "string")
      throw new OmpRefusal("resources_changed");
    clientAccess = access.literal;
    let stored: unknown;
    try { stored = JSON.parse(clientAccess); } catch { throw new OmpRefusal("resources_changed"); }
    if (stored && typeof stored === "object" && !Array.isArray(stored) && Object.keys(stored).length === 0) {
      resolvedClientAccess = null;
    } else {
      const parsed = BrokerClientAccessSchema.safeParse(stored);
      if (!parsed.success) throw new OmpRefusal("resources_changed");
      resolvedClientAccess = parsed.data;
    }
  }
  const [broker, signIn] = await Promise.all([
    currentOperation(ctx, owner.machineId, BROKER_OPERATION_ID),
    currentOperation(ctx, owner.machineId, SIGN_IN_OPERATION_ID),
  ]);
  if (
    broker.pins.installationRevision !== signIn.pins.installationRevision ||
    broker.pins.artifactSha256 !== signIn.pins.artifactSha256
  )
    throw new OmpRefusal("resources_changed");
  const runtime = ServiceRuntimeSchema.parse({
    scope: "instance",
    pluginId: ACCOUNTS_PLUGIN_ID,
    operationId: BROKER_OPERATION_ID,
    ...broker.pins,
    input: { clientAccess: { literal: clientAccess } },
  });
  const installedPolicy = buildSharedBrokerPolicy(runtime);
  const matches =
    current.policy !== null &&
    digestOf({ ...current.policy, revision: installedPolicy.revision }) ===
      digestOf(installedPolicy);
  const recovering =
    ["stopped", "unavailable"].includes(description.state) && matches;
  const policy = recovering
    ? {
        ...installedPolicy,
        revision: digestOf({ expectedBrokerRevision, policy: installedPolicy }),
      }
    : installedPolicy;
  const review = {
    expectedBrokerRevision,
    ownerMachineId: owner.machineId,
    clientAccess: resolvedClientAccess,
    broker: broker.pins,
    signIn: signIn.pins,
    reviewDigest: digestOf({
      actor: actor(ctx),
      expectedBrokerRevision,
      owner,
      currentPolicy: current.policy,
      policy,
      broker: broker.description,
      signIn: signIn.description,
      deployment: broker.deployment,
    }),
  };
  return {
    review,
    policy,
    currentPolicy: current.policy,
    installedPolicy,
    matches,
    description,
  };
}
export async function reviewAccountRuntime(
  ctx: OmpContext,
  args: ActionInput<"reviewAccountRuntime">,
): Promise<ActionResult<"reviewAccountRuntime">> {
  return (await accountRuntimeReview(ctx, args.expectedBrokerRevision, args.clientAccess)).review;
}
export async function promoteAccountRuntime(
  ctx: OmpContext,
  args: ActionInput<"promoteAccountRuntime">,
): Promise<ActionResult<"promoteAccountRuntime">> {
  await authorizeContainer(ctx, args.containerId, true);
  const first = await accountRuntimeReview(ctx, args.expectedBrokerRevision, args.clientAccess);
  if (first.review.reviewDigest !== args.reviewDigest)
    throw new OmpRefusal("review_changed");
  const latest = await accountRuntimeReview(ctx, args.expectedBrokerRevision, args.clientAccess);
  if (latest.review.reviewDigest !== first.review.reviewDigest)
    throw new OmpRefusal("resources_changed");
  await authorizeOwner(ctx, latest.review.ownerMachineId);
  const configured = InstanceServiceDescriptionSchema.parse(
    await ctx.services.configureInstance({
      serviceId: BROKER_SERVICE_ID,
      machineId: latest.review.ownerMachineId,
      expectedRevision: args.expectedBrokerRevision,
      policy: latest.policy,
      enabled: true,
    }),
  );
  if (
    configured.serviceId !== BROKER_SERVICE_ID ||
    configured.configuration?.pluginId !== ACCOUNTS_PLUGIN_ID ||
    !configured.configuration.enabled ||
    configured.owner?.machineId !== latest.review.ownerMachineId
  )
    throw new OmpRefusal("resources_changed");
  return { revision: configured.configuration.revision };
}
export async function prepareSignIn(
  ctx: OmpContext,
  args: ActionInput<"prepareSignIn">,
): Promise<ActionResult<"prepareSignIn">> {
  await authorizeContainer(ctx, args.containerId, true);
  await authorizeTerminalSpawn(ctx, args.containerId);
  const first = await accountRuntimeReview(ctx, args.expectedBrokerRevision);
  if (
    !first.description.configuration?.enabled ||
    !first.matches ||
    !["ready", "starting"].includes(first.description.state)
  )
    throw new OmpRefusal("broker_unavailable");
  const latest = await accountRuntimeReview(ctx, args.expectedBrokerRevision);
  if (latest.review.reviewDigest !== first.review.reviewDigest)
    throw new OmpRefusal("resources_changed");
  // No implicit broker creation, migration, restart or credential handling here.
  return {
    machineId: latest.review.ownerMachineId,
    runtime: TerminalRuntimeSchema.parse({
      machineId: latest.review.ownerMachineId,
      pluginId: ACCOUNTS_PLUGIN_ID,
      operationId: SIGN_IN_OPERATION_ID,
      ...latest.review.signIn,
      input: { config: signInConfig },
    }),
  };
}
async function gatewayReview(
  ctx: OmpContext,
  args: ActionInput<"reviewGateway">,
) {
  if (ctx.pluginId !== GATEWAY_PLUGIN_ID) throw new OmpRefusal("scope_refused");
  await authorizeTarget(ctx, args);
  await authorizeOwner(ctx, args.machineId);
  const current = ServiceConfigurationReadSchema.parse(
    await ctx.services.readConfiguration({ machineId: args.machineId }),
  );
  if (current.configuration.revision !== args.expectedServiceRevision)
    throw new OmpRefusal("service_configuration_changed");
  const candidates = current.runtimeCandidates.filter(
    (candidate) =>
      candidate.runtime.pluginId === GATEWAY_PLUGIN_ID &&
      candidate.runtime.operationId === GATEWAY_OPERATION_ID &&
      candidate.runtime.scope !== "instance",
  );
  if (!current.connected) throw new OmpRefusal("machine_offline");
  if (candidates.length !== 1 || !candidates[0]?.ready)
    throw new OmpRefusal("gateway_resources_incomplete");
  const runtime = ServiceRuntimeSchema.parse({
    ...candidates[0].runtime,
    input: { accountPool: { input: "accountPool" } },
  });
  const replacement = buildGatewayPolicy(runtime);
  const policies: ServicePolicy[] = current.configuration.policies.map(
    (policy) => (policy.serviceId === "omp" ? replacement : policy),
  );
  if (!policies.some((policy) => policy.serviceId === "omp"))
    policies.push(replacement);
  const destination = {
    containerId: args.containerId,
    machineId: args.machineId,
  };
  const pins = {
    installationRevision: runtime.installationRevision,
    artifactSha256: runtime.artifactSha256,
    resourceBindingDigest: runtime.resourceBindingDigest,
  };
  const native = await currentOperation(
    ctx,
    args.machineId,
    GATEWAY_OPERATION_ID,
  );
  if (digestOf(native.pins) !== digestOf(pins))
    throw new OmpRefusal("resources_changed");
  return {
    policies,
    review: {
      destination,
      expectedServiceRevision: args.expectedServiceRevision,
      runtime: pins,
      reviewDigest: digestOf({
        actor: actor(ctx),
        destination,
        expectedServiceRevision: args.expectedServiceRevision,
        policies,
        candidates,
        native,
      }),
    },
  };
}
export async function reviewGateway(
  ctx: OmpContext,
  args: ActionInput<"reviewGateway">,
): Promise<ActionResult<"reviewGateway">> {
  return (await gatewayReview(ctx, args)).review;
}
export async function configureGateway(
  ctx: OmpContext,
  args: ActionInput<"configureGateway">,
): Promise<ActionResult<"configureGateway">> {
  await authorizeTarget(ctx, args, true);
  const first = await gatewayReview(ctx, args);
  if (first.review.reviewDigest !== args.reviewDigest)
    throw new OmpRefusal("review_changed");
  const latest = await gatewayReview(ctx, args);
  if (latest.review.reviewDigest !== first.review.reviewDigest)
    throw new OmpRefusal("resources_changed");
  await authorizeOwner(ctx, args.machineId);
  const configured = ServiceConfigurationSchema.parse(
    await ctx.services.configureConfiguration({
      machineId: args.machineId,
      expectedRevision: args.expectedServiceRevision,
      policies: latest.policies,
    }),
  );
  if (configured.revision === null) throw new OmpRefusal("resources_changed");
  return { revision: configured.revision };
}
