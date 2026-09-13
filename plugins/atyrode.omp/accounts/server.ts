import {
  defineServerAction,
  defineServerPlugin,
} from "@manifold/plugin-kit/server";
import { z } from "zod";
import { PluginManifestSchema, type Cap } from "@manifold/protocol";
import manifestJson from "./manifest.json";
import {
  accountActionSchemas,
  ACCOUNTS_PLUGIN_ID,
  BROKER_OPERATION_ID,
  BROKER_SERVICE_ID,
  SIGN_IN_OPERATION_ID,
  type AccountAction,
  type ActionInput,
  type ActionResult,
} from "../../api/index.ts";
import {
  accountObservation,
  describeSharedBroker,
  mutateCredential,
  usageObservation,
} from "../broker.ts";
import {
  authorizeContainer,
  authorizeOwner,
  digestOf,
  observeNative,
  operationReadiness,
  OmpRefusal,
  type OmpContext,
} from "../machine-server.ts";
import { refusal } from "../refusal.ts";
import {
  accountRuntimeReview,
  reviewAccountRuntime,
  promoteAccountRuntime,
  prepareSignIn,
} from "../service-setup.ts";

type AccountHandlers = {
  [K in AccountAction]: (
    ctx: OmpContext,
    args: ActionInput<K>,
  ) => Promise<ActionResult<K>>;
};
export async function readAccountSetup(
  ctx: OmpContext,
): Promise<ActionResult<"readAccountSetup">> {
  if (ctx.pluginId !== ACCOUNTS_PLUGIN_ID)
    throw new OmpRefusal("scope_refused");
  const description = await describeSharedBroker(ctx);
  const rawOwner = description.configuration
    ? description.owner
    : description.defaultOwner;
  const owner = rawOwner
    ? { machineId: rawOwner.machineId, online: rawOwner.online }
    : null;
  const base: Omit<ActionResult<"readAccountSetup">, "state" | "reason"> = {
    revision: description.configuration?.revision ?? null,
    owner,
    brokerState:
      description.configuration?.enabled === false
        ? "disabled"
        : description.state === "stopping"
          ? "unavailable"
          : description.state,
    nativeReady: false,
    callerRefusal: "caller_authority_unobserved",
    canSignIn: false,
    canReview: false,
    deployment: null,
  };
  if (!owner?.online || !description.connected)
    return { ...base, state: "offline", reason: "account_owner_unavailable" };
  try {
    const observed = await observeNative(ctx, owner.machineId);
    base.deployment = observed.deployment.deployment;
    const operations = await Promise.all(
      [BROKER_OPERATION_ID, SIGN_IN_OPERATION_ID].map((operation) =>
        operationReadiness(
          ctx,
          observed.description,
          operation,
          observed.deployment.installation?.machine,
        ),
      ),
    );
    base.nativeReady = operations.every((operation) => operation.nativeReady);
    base.callerRefusal =
      operations.find((operation) => operation.callerRefusal)?.callerRefusal ??
      null;
    const unavailable = operations.find(
      (operation) => operation.state !== "ready",
    );
    if (unavailable)
      return { ...base, state: unavailable.state, reason: unavailable.reason };
    try {
      await authorizeOwner(ctx, owner.machineId);
    } catch (error) {
      base.callerRefusal =
        error instanceof OmpRefusal
          ? error.code
          : "caller_authority_unobserved";
      return { ...base, state: "refused", reason: base.callerRefusal };
    }
    if (description.configuration?.enabled === false)
      return { ...base, state: "refused", reason: "broker_disabled" };
    const current = await accountRuntimeReview(ctx, base.revision);
    const ready =
      current.matches &&
      ["ready", "starting"].includes(current.description.state);
    return {
      ...base,
      state: ready ? "ready" : "missing",
      reason: ready ? null : "broker_runtime_review_required",
      canReview: true,
      canSignIn: ready,
    };
  } catch (error) {
    const reason =
      error instanceof OmpRefusal ? error.code : "operation_unavailable";
    if (reason.startsWith("caller_") || reason === "service_owner_required")
      base.callerRefusal = reason;
    else if (!(error instanceof OmpRefusal))
      base.callerRefusal = "caller_authority_unobserved";
    return { ...base, state: "refused", reason };
  }
}
async function observeAccounts(
  ctx: OmpContext,
): Promise<ActionResult<"accounts">> {
  const description = await describeSharedBroker(ctx);
  if (
    !description.configuration?.enabled ||
    !description.owner?.online ||
    !description.connected ||
    description.state !== "ready"
  ) {
    return {
      scope: digestOf({
        serviceId: BROKER_SERVICE_ID,
        revision: description.configuration?.revision ?? null,
        machineId: description.owner?.machineId ?? null,
      }),
      observedAt: null,
      status: "unavailable",
      accounts: [],
    };
  }
  return accountObservation(ctx);
}
const implementations: AccountHandlers = {
  accounts: observeAccounts,
  async usage(ctx) {
    const accounts = await observeAccounts(ctx);
    return accounts.status === "unavailable"
      ? { accounts, snapshot: null, refreshStatus: "failed" }
      : usageObservation(ctx);
  },
  async clearAccountBlocks(ctx, args) {
    await authorizeContainer(ctx, args.containerId, true);
    return mutateCredential(
      ctx,
      args.reference,
      args.credentialId,
      "clear-blocks",
    );
  },
  async disableCredential(ctx, args) {
    await authorizeContainer(ctx, args.containerId, true);
    return mutateCredential(ctx, args.reference, args.credentialId, "disable");
  },
  readAccountSetup,
  reviewAccountRuntime,
  promoteAccountRuntime,
  prepareSignIn,
};
const serviceObservationCaps: readonly Cap[] = ["services:read"];
// Comparing the retained policy is an owner-only configuration read, even when
// the action returns only a review or terminal descriptor.
const runtimeReviewCaps: readonly Cap[] = [
  "machines:run",
  "jobs:read",
  "services:read",
  "services:configure",
];
const delegates: Record<AccountAction, readonly Cap[]> = {
  accounts: serviceObservationCaps,
  usage: ["services:read", "services:invoke"],
  clearAccountBlocks: ["services:read", "services:invoke"],
  disableCredential: ["services:read", "services:invoke"],
  readAccountSetup: runtimeReviewCaps,
  reviewAccountRuntime: runtimeReviewCaps,
  promoteAccountRuntime: runtimeReviewCaps,
  prepareSignIn: runtimeReviewCaps,
};
const writes: Partial<Record<AccountAction, true>> = {
  clearAccountBlocks: true,
  disableCredential: true,
  promoteAccountRuntime: true,
  prepareSignIn: true,
};
export const handlers = Object.fromEntries(
  (Object.keys(accountActionSchemas) as AccountAction[]).map((name) => [
    name,
    async (ctx: OmpContext, raw: unknown) => {
      try {
        const args = accountActionSchemas[name].input.parse(raw);
        const handler = implementations[name] as (
          context: OmpContext,
          input: typeof args,
        ) => Promise<unknown>;
        return accountActionSchemas[name].result.parse(
          await handler(ctx, args),
        );
      } catch (error) {
        return refusal(error);
      }
    },
  ]),
);
const plugin = {
  manifest: PluginManifestSchema.parse(manifestJson),
  actions: (Object.keys(accountActionSchemas) as AccountAction[]).map((name) =>
    defineServerAction({
      name,
      title: name.replace(/([A-Z])/g, " $1"),
      caps: [
        writes[name]
          ? "containers:write"
          : name === "reviewAccountRuntime"
            ? "services:configure"
            : "services:read",
      ],
      delegates: delegates[name],
      scope: writes[name] ? "container" : "workspace",
      trace: "opaque",
      input: accountActionSchemas[name].input as z.ZodType<unknown>,
      result: accountActionSchemas[name].result as z.ZodType<unknown>,
    }),
  ),
  handlers,
};
defineServerPlugin(plugin);
export default plugin;
