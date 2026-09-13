import { InstanceServiceDescriptionSchema } from "@manifold/protocol";
import { z } from "zod";
import { projectAccounts } from "../api/accounts.ts";
import { normalizeBrokerUsage } from "../api/usage.ts";
import { BROKER_SERVICE_ID, ACCOUNTS_PLUGIN_ID, RuntimeAccountPoolSchema, type BrokerReference, type AccountReference, type RuntimeAccountPool, type ServicePin } from "../api/index.ts";
import { digestOf, OmpRefusal, type OmpContext } from "./machine-server.ts";

export async function describeSharedBroker(ctx: OmpContext) {
  const description = InstanceServiceDescriptionSchema.parse(await ctx.services.describeInstance({ serviceId: BROKER_SERVICE_ID }));
  if (description.serviceId !== BROKER_SERVICE_ID || (description.configuration && description.configuration.pluginId !== ACCOUNTS_PLUGIN_ID)) throw new OmpRefusal("resources_changed");
  return description;
}
export async function sharedBrokerReference(ctx: OmpContext, expected?: BrokerReference): Promise<BrokerReference> {
  const description = await describeSharedBroker(ctx);
  if (!description.configuration?.enabled || !description.owner?.online || !description.connected || description.state !== "ready") throw new OmpRefusal("broker_unavailable");
  const reference: BrokerReference = { serviceId: BROKER_SERVICE_ID, revision: description.configuration.revision, machineId: description.owner.machineId };
  if (expected && digestOf(expected) !== digestOf(reference)) throw new OmpRefusal("resources_changed");
  return reference;
}
async function brokerRead(ctx: OmpContext, reference: BrokerReference, operationId: "metadata" | "usage") {
  const response = await ctx.services.readInstance({ serviceId: reference.serviceId, expectedRevision: reference.revision, operationId, input: {} });
  if (!response.ok) throw new OmpRefusal(response.refusal);
  await sharedBrokerReference(ctx, reference);
  return response.result;
}
export async function accountObservation(ctx: OmpContext, expected?: BrokerReference) {
  const reference = await sharedBrokerReference(ctx, expected);
  const metadata = await brokerRead(ctx, reference, "metadata");
  // The guest clock is the dispatch timestamp, not the arrival time of this read.
  const observedAt = Date.now();
  return projectAccounts(metadata, digestOf(reference), observedAt, observedAt);
}
export async function usageObservation(ctx: OmpContext) {
  const reference = await sharedBrokerReference(ctx);
  const accounts = await accountObservation(ctx, reference);
  let raw: unknown = null;
  let refreshStatus: "succeeded" | "failed" = "succeeded";
  try { raw = await brokerRead(ctx, reference, "usage"); } catch { refreshStatus = "failed"; }
  await sharedBrokerReference(ctx, reference);
  return { accounts, snapshot: normalizeBrokerUsage(raw, accounts, Date.now()), refreshStatus };
}
export async function checkedAccountPool(ctx: OmpContext, input: RuntimeAccountPool, expected?: BrokerReference) {
  const pool = RuntimeAccountPoolSchema.parse(input);
  const reference = await sharedBrokerReference(ctx, expected);
  const observation = await accountObservation(ctx, reference);
  let count = 0;
  const seen = new Set<number>();
  for (const [provider, selected] of Object.entries(pool)) {
    if (selected.length === 0) throw new OmpRefusal("account_unavailable");
    for (const slot of selected) {
      if (slot.scope !== observation.scope) throw new OmpRefusal("resources_changed");
      if (seen.has(slot.credentialId)) throw new OmpRefusal("invalid_accounts");
      seen.add(slot.credentialId);
      const match = observation.accounts.find(account => account.reference.provider === provider && account.credentialId === slot.credentialId && account.identityKey === slot.identityKey);
      if (!match || match.disabled) throw new OmpRefusal("account_unavailable");
      count++;
    }
  }
  // Empty means no credentials, never wildcard access to the broker.
  if (count === 0) throw new OmpRefusal("account_unavailable");
  return { pool, reference };
}
export async function mutateCredential(ctx: OmpContext, reference: AccountReference, credentialId: number, operationId: "clear-blocks" | "disable") {
  const broker = await sharedBrokerReference(ctx);
  const observation = await accountObservation(ctx, broker);
  const account = observation.accounts.find(account => digestOf(account.reference) === digestOf(reference));
  if (!account || account.credentialId !== credentialId) throw new OmpRefusal("account_unavailable");
  await sharedBrokerReference(ctx, broker);
  const response = await ctx.services.invokeInstance({ serviceId: broker.serviceId, expectedRevision: broker.revision, operationId, input: { credentialId: String(credentialId) } });
  if (!response.ok) throw new OmpRefusal(response.refusal);
  if (!z.strictObject({ ok: z.literal(true) }).safeParse(response.result).success) throw new OmpRefusal("invalid_service_result");
  return accountObservation(ctx, broker);
}
export async function currentGateway(ctx: OmpContext, machineId: string, expected?: ServicePin) {
  const description = await ctx.services.describe({ machineId });
  const service = description.services.find(value => value.serviceId === "omp");
  if (!description.connected || !service || !["models", "stream"].every(operationId => service.operations.some(operation => operation.operationId === operationId && operation.ready))) throw new OmpRefusal("gateway_unavailable");
  const pin = { serviceId: service.serviceId, revision: service.revision, policySha256: service.policySha256 };
  if (expected && digestOf(pin) !== digestOf(expected)) throw new OmpRefusal("resources_changed");
  return pin;
}
