import { defineServerAction, defineServerPlugin } from "@manifold/plugin-kit/server";
import { z } from "zod";
import { PluginManifestSchema, ServiceConfigurationReadSchema, type Cap } from "@manifold/protocol";
import manifestJson from "./manifest.json";
import { gatewayActionSchemas, GATEWAY_PLUGIN_ID, GATEWAY_OPERATION_ID, type GatewayAction, type ActionInput, type ActionResult } from "../../api/index.ts";
import { reviewGateway, configureGateway } from "../service-setup.ts";
import { authorizeOwner, authorizeTarget, observeNative, operationReadiness, OmpRefusal, type OmpContext } from "../machine-server.ts";
import { refusal } from "../refusal.ts";

type GatewayHandlers = { [K in GatewayAction]: (ctx: OmpContext, args: ActionInput<K>) => Promise<ActionResult<K>> };
export async function readGatewaySetup(ctx: OmpContext, destination: ActionInput<"readGatewaySetup">): Promise<ActionResult<"readGatewaySetup">> {
  if (ctx.pluginId !== GATEWAY_PLUGIN_ID) throw new OmpRefusal("scope_refused");
  await authorizeTarget(ctx, destination);
  const setup: ActionResult<"readGatewaySetup"> = { destination, revision: null,
    operation: { operationId: GATEWAY_OPERATION_ID, state: "refused", reason: "native_observation_unavailable",
      pins: null, nativeReady: false, callerRefusal: "caller_authority_unobserved" },
    nativeReady: false, callerRefusal: "caller_authority_unobserved", canReview: false, deployment: null };
  try {
    const native = await observeNative(ctx, destination.machineId);
    setup.operation = await operationReadiness(ctx, native.description, GATEWAY_OPERATION_ID, native.deployment.installation?.machine);
    setup.nativeReady = setup.operation.nativeReady;
    setup.callerRefusal = setup.operation.callerRefusal;
    setup.deployment = native.deployment.deployment;
    try { await authorizeOwner(ctx, destination.machineId); }
    catch (error) {
      setup.callerRefusal ??= error instanceof OmpRefusal ? error.code : "caller_authority_unobserved";
      return setup;
    }
    // This is the destination configuration CAS revision, not the "omp" policy's
    // revision or the accounts owner's instance-service revision. Never expose policy.
    const current = ServiceConfigurationReadSchema.parse(await ctx.services.readConfiguration({ machineId: destination.machineId }));
    setup.revision = current.configuration.revision;
    if (setup.operation.state !== "ready") return setup;
    // Reuse the authoritative, read-only review: candidate uniqueness, current
    // binding pins and configuration revision must agree before offering review.
    await reviewGateway(ctx, { ...destination, expectedServiceRevision: setup.revision });
    setup.canReview = true;
    return setup;
  } catch (error) {
    const reason = error instanceof OmpRefusal ? error.code : "operation_unavailable";
    if (reason.startsWith("caller_") || reason === "service_owner_required") setup.callerRefusal = reason;
    else if (!(error instanceof OmpRefusal)) setup.callerRefusal = "caller_authority_unobserved";
    setup.operation = { ...setup.operation,
      ...(setup.operation.state === "ready" || setup.operation.reason === "native_observation_unavailable" ? { state: "refused" as const, reason } : {}),
      callerRefusal: setup.callerRefusal };
    return setup;
  }
}
const implementations: GatewayHandlers = { readGatewaySetup, reviewGateway, configureGateway };
// All three reach `ctx.jobs.describe` through `observeNative` — `readGatewaySetup` here,
// the other two through `currentOperation` — and that read takes `machines:read` in the
// calling plugin's capabilities, separate from running there (#45).
const gatewaySetupCaps: readonly Cap[] = ["machines:read", "machines:run", "jobs:read", "services:read", "services:configure"];
const delegates: Record<GatewayAction, readonly Cap[]> = {
  readGatewaySetup: gatewaySetupCaps,
  reviewGateway: gatewaySetupCaps,
  configureGateway: gatewaySetupCaps,
};
export const handlers = Object.fromEntries((Object.keys(gatewayActionSchemas) as GatewayAction[]).map(name => [name,
  async (ctx: OmpContext, raw: unknown) => {
    try {
      const args = gatewayActionSchemas[name].input.parse(raw);
      const handler = implementations[name] as (context: OmpContext, input: typeof args) => Promise<unknown>;
      return gatewayActionSchemas[name].result.parse(await handler(ctx, args));
    } catch (error) { return refusal(error); }
  },
]));
const plugin = { manifest: PluginManifestSchema.parse(manifestJson), actions: (Object.keys(gatewayActionSchemas) as GatewayAction[]).map(name => defineServerAction({
  name, title: name.replace(/([A-Z])/g, " $1"), caps: [name === "configureGateway" ? "containers:write" : "containers:read"],
  delegates: delegates[name], scope: "container", trace: "opaque",
  input: gatewayActionSchemas[name].input as z.ZodType<unknown>, result: gatewayActionSchemas[name].result as z.ZodType<unknown>,
})), handlers };
defineServerPlugin(plugin);
export default plugin;
