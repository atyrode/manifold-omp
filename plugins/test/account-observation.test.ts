import { expect, test } from "bun:test";
import { checkedAccountPool, usageObservation } from "../atyrode.omp/broker.ts";
import { digestOf, type OmpContext } from "../atyrode.omp/machine-server.ts";
import { ACCOUNTS_PLUGIN_ID, BROKER_SERVICE_ID } from "../api/index.ts";

test("usage generated after dispatch is accepted at receipt time", async () => {
  const owner = { machineId: "fixture-owner", name: "Fixture", online: true };
  const ctx = {
    // A hardened action carries its dispatch timestamp throughout asynchronous calls.
    now: () => 1,
    services: {
      describeInstance: async () => ({
        serviceId: BROKER_SERVICE_ID, defaultOwner: owner, owner,
        configuration: { revision: "fixture-revision", pluginId: ACCOUNTS_PLUGIN_ID,
          enabled: true, policySha256: "a".repeat(64) },
        connected: true, state: "ready", reason: null,
      }),
      readInstance: async ({ operationId }: { operationId: string }) => ({
        ok: true,
        result: operationId === "metadata" ? { credentials: [] } : { generatedAt: 2, reports: [] },
      }),
    },
  } as unknown as OmpContext;
  const observation = await usageObservation(ctx);
  expect(observation.refreshStatus).toBe("succeeded");
  expect(observation.snapshot).toEqual({ scope: observation.accounts.scope, observedAt: 2, accounts: [] });
  expect(observation.accounts.status).toBe("fresh");
  expect(observation.accounts.observedAt).toBeGreaterThan(1);
});

test("runtime account selections are bound to the broker observation that produced them", async () => {
  const owner = { machineId: "fixture-owner", name: "Fixture", online: true };
  const reference = {
    serviceId: BROKER_SERVICE_ID,
    revision: "fixture-revision",
    machineId: owner.machineId,
  };
  const scope = digestOf(reference);
  const ctx = {
    services: {
      describeInstance: async () => ({
        serviceId: BROKER_SERVICE_ID,
        defaultOwner: owner,
        owner,
        configuration: {
          revision: reference.revision,
          pluginId: ACCOUNTS_PLUGIN_ID,
          enabled: true,
          policySha256: "a".repeat(64),
        },
        connected: true,
        state: "ready",
        reason: null,
      }),
      readInstance: async () => ({
        ok: true,
        result: {
          credentials: [{
            id: 7,
            provider: "anthropic",
            identityKey: "fixture-identity",
            credential: { type: "oauth", email: "fixture@example.invalid" },
          }],
        },
      }),
    },
  } as unknown as OmpContext;
  const current = {
    anthropic: [{ scope, credentialId: 7, identityKey: "fixture-identity" }],
  };

  await expect(checkedAccountPool(ctx, current)).resolves.toMatchObject({ pool: current });
  await expect(checkedAccountPool(ctx, {
    anthropic: [{
      ...current.anthropic[0]!,
      scope: "superseded-broker-observation",
    }],
  })).rejects.toThrow("omp_resources_changed");
});
