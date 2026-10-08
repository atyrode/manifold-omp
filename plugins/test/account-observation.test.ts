import { expect, test } from "bun:test";
import { accountObservation, accountsScope, checkedAccountPool, mutateCredential, sharedBrokerReference, usageObservation } from "../atyrode.omp/broker.ts";
import type { OmpContext } from "../atyrode.omp/machine-server.ts";
import { ACCOUNTS_PLUGIN_ID, BROKER_SERVICE_ID } from "../api/index.ts";

const custodyId = "0b5f7c62-5b1e-4c39-9a51-3d0f1e7a2c44";

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
        result: operationId === "metadata" ? { custodyId, credentials: [] } : { generatedAt: 2, reports: [] },
      }),
    },
  } as unknown as OmpContext;
  const observation = await usageObservation(ctx);
  expect(observation.refreshStatus).toBe("succeeded");
  expect(observation.snapshot).toEqual({ scope: observation.accounts.scope, observedAt: 2, accounts: [] });
  expect(observation.accounts.status).toBe("fresh");
  expect(observation.accounts.observedAt).toBeGreaterThan(1);
});

/** One broker whose configuration revision, owner and store custody a test can move. */
function brokerFixture() {
  const state = { revision: "fixture-revision", machineId: "fixture-owner", metadata: { custodyId } as Record<string, unknown>, mutations: 0 };
  const ctx = {
    services: {
      describeInstance: async () => {
        const owner = { machineId: state.machineId, name: "Fixture", online: true };
        return {
          serviceId: BROKER_SERVICE_ID,
          defaultOwner: owner,
          owner,
          configuration: {
            revision: state.revision,
            pluginId: ACCOUNTS_PLUGIN_ID,
            enabled: true,
            policySha256: "a".repeat(64),
          },
          connected: true,
          state: "ready",
          reason: null,
        };
      },
      readInstance: async () => ({
        ok: true,
        result: {
          ...state.metadata,
          credentials: [{
            id: 7,
            provider: "anthropic",
            identityKey: "fixture-identity",
            credential: { type: "oauth", email: "fixture@example.invalid" },
          }],
        },
      }),
      invokeInstance: async () => { state.mutations++; return { ok: true, result: { ok: true } }; },
    },
  } as unknown as OmpContext;
  return { ctx, state };
}

test("runtime account selections are bound to the broker observation that produced them", async () => {
  const { ctx } = brokerFixture();
  const current = {
    anthropic: [{ scope: accountsScope("fixture-owner", custodyId), credentialId: 7, identityKey: "fixture-identity" }],
  };

  await expect(checkedAccountPool(ctx, current)).resolves.toMatchObject({ pool: current });
  await expect(checkedAccountPool(ctx, {
    anthropic: [{
      ...current.anthropic[0]!,
      scope: "superseded-broker-observation",
    }],
  })).rejects.toThrow("omp_resources_changed");
});

test("promotion over the same store keeps the accounts scope; a new store or owner changes it", async () => {
  const { ctx, state } = brokerFixture();
  const before = await accountObservation(ctx);
  const saved = before.accounts[0]!.reference;
  const pool = { anthropic: [{ scope: before.scope, credentialId: 7, identityKey: "fixture-identity" }] };
  const reviewed = await sharedBrokerReference(ctx);

  // promoteAccountRuntime replaces the configuration revision, never the store.
  state.revision = "promoted-revision";
  const promoted = await accountObservation(ctx);
  expect(promoted.scope).toBe(before.scope);
  expect(promoted.accounts[0]!.reference).toEqual(saved);
  await expect(checkedAccountPool(ctx, pool)).resolves.toMatchObject({ pool });
  expect((await mutateCredential(ctx, saved, 7, "clear-blocks")).scope).toBe(before.scope);
  expect(state.mutations).toBe(1);
  // Reads bound to the earlier configuration still refuse rather than mix two brokers.
  await expect(checkedAccountPool(ctx, pool, reviewed)).rejects.toThrow("omp_resources_changed");

  // A purged or replaced store carries other custody, even with identical credential ids.
  state.metadata = { custodyId: "8d4e2f19-77a0-4b6e-8c3d-5e9f0a1b2c3d" };
  const replaced = await accountObservation(ctx);
  expect(replaced.scope).not.toBe(before.scope);
  await expect(checkedAccountPool(ctx, pool)).rejects.toThrow("omp_resources_changed");
  await expect(mutateCredential(ctx, saved, 7, "clear-blocks")).rejects.toThrow("omp_account_unavailable");
  expect(state.mutations).toBe(1);

  // The same custody id on another owner is another store.
  state.metadata = { custodyId };
  state.machineId = "another-owner";
  expect((await accountObservation(ctx)).scope).not.toBe(before.scope);
  // An observation without a readable broker names no store.
  expect(accountsScope("fixture-owner", null)).not.toBe(before.scope);
});

test("a broker without a custody id must be promoted; a malformed one is invalid", async () => {
  const { ctx, state } = brokerFixture();
  // A policy promoted by an earlier version projects no custody leaf.
  state.metadata = {};
  await expect(accountObservation(ctx)).rejects.toThrow("omp_account_runtime_outdated");
  await expect(checkedAccountPool(ctx, { anthropic: [{ scope: accountsScope("fixture-owner", custodyId), credentialId: 7, identityKey: "fixture-identity" }] }))
    .rejects.toThrow("omp_account_runtime_outdated");
  // A version-1 UUID is not the v4 id a broker mints.
  for (const malformed of [null, "", "fixture-custody", "0b5f7c62-5b1e-1c39-9a51-3d0f1e7a2c44"]) {
    state.metadata = { custodyId: malformed };
    await expect(accountObservation(ctx)).rejects.toThrow("omp_invalid_accounts");
  }
});
