import { expect, test } from "bun:test";
import type { GuestStorage, ServerMigration } from "@manifold/plugin-kit/server";
import { openDatabase } from "../../../manifold/packages/server/src/db.ts";
import { ServerStore } from "../../../manifold/packages/server/src/stores.ts";
import { DefaultsSchema, OMP_PLUGIN_ID, OverlaySchema, type ActionInput, type Defaults } from "../api/index.ts";
import type { OmpContext } from "../atyrode.omp/machine-server.ts";
import plugin from "../atyrode.omp/server.ts";

const defaultsKey = "defaults/v1";
const migrationName = "2026-11-14-defaults-native-shared-roles";
const registered = plugin.migrations.find(migration => migration.name === migrationName);
if (!registered) throw new Error("registered defaults migration missing");
const migration: ServerMigration = registered;
const retainedRows = new Map([
  ["skills/v1/fixture-machine", ' { "revision": 9, "skills": [], "sets": [], "updatedAt": 7, "updatedBy": "catalog-owner" }\n'],
  ["runs/9999999/fixture-run", '\n{"agentId":"fixture-agent","session":{"harness":"atyrode.omp","sessionId":"1ed3d5a7-b9c1-4e3f-8a5b-7c9d1e3f5a7b","machineId":"fixture-machine"},"providers":["fixture"]}\n'],
  ["jobs/fixture-session", ' { "retained": "session custody and provenance" }\n'],
  ["unrelated/future-row", "opaque retained bytes\u0000\n"],
]);
const retainedDefaults: Defaults = {
  revision: 42,
  overlay: {
    modelRoles: { default: "fixture/main", smol: "fixture/fast", slow: "fixture/review", advisor: "fixture/fast" },
    retry: { enabled: true, modelFallback: true, fallbackRevertPolicy: "cooldown-expiry",
      fallbackChains: { default: ["fixture/main", "fixture/fallback"], smol: [] } },
    prewalk: { enabled: false },
    defaultThinkingLevel: "high",
    advisor: { enabled: false },
    tier: { default: "balanced" },
  },
  updatedAt: 1234567,
  updatedBy: "previous-owner",
};
const legacyOverrides = { scout: "fixture/retired-agent", reviewer: "@slow", librarian: "@smol" };
const reviewInput: ActionInput<"reviewSession"> = {
  containerId: "fixture-room", machineId: "fixture-machine", expectedDefaultsRevision: retainedDefaults.revision,
  accountPool: {}, overlay: {}, prompt: "", planYolo: false,
  automation: { mode: "restricted", toolNames: [], delegation: "disabled" },
};

function fixture(raw?: string, initial: ReadonlyMap<string, string> = retainedRows) {
  const rows = new Map(initial);
  if (raw !== undefined) rows.set(defaultsKey, raw);
  const calls: string[] = [];
  const comparisons: { key: string; expected: string | null; value: string }[] = [];
  const state = { compare: true };
  const storage: GuestStorage = {
    pluginId: OMP_PLUGIN_ID,
    async get(key) { calls.push(`get:${key}`); return rows.get(key) ?? null; },
    async set(key, value) { calls.push(`set:${key}`); rows.set(key, value); },
    async compareAndSet(key, expected, value) {
      calls.push(`cas:${key}`);
      comparisons.push({ key, expected, value });
      if (!state.compare || (rows.get(key) ?? null) !== expected) return false;
      rows.set(key, value);
      return true;
    },
    async delete(key) { calls.push(`delete:${key}`); rows.delete(key); },
    async keys(prefix = "") { calls.push(`keys:${prefix}`); return [...rows.keys()].filter(key => key.startsWith(prefix)).sort(); },
  };
  const context = {
    pluginId: OMP_PLUGIN_ID, storage, now: () => 2345678, outsideScope: async () => null,
    auth: { principal: { id: "current-owner", kind: "human", name: "Fixture owner", color: "#336699" },
      caps: ["*"], isRoot: true, containerScope: null, allows: async () => true },
  } satisfies Pick<OmpContext, "pluginId" | "storage" | "now" | "outsideScope" | "auth">;
  return { ctx: context as OmpContext, storage, rows, calls, comparisons, state };
}

function expectUnrelatedRows(rows: ReadonlyMap<string, string>) {
  for (const [key, value] of retainedRows) expect(rows.get(key)).toBe(value);
  expect(rows.size).toBe(retainedRows.size + 1);
}

test("registered native-shared-role migration retains audit metadata and advances revision once for CAS", async () => {
  expect(plugin.manifest.dataVersion).toEqual({ major: 2, minor: 0 });
  expect(migration.to).toEqual(plugin.manifest.dataVersion);
  for (const { task, overrides } of [
    { task: undefined, overrides: legacyOverrides },
    { task: { agentAdvisor: { task: "on" as const }, prewalk: false }, overrides: legacyOverrides },
    { task: undefined, overrides: {} },
  ]) {
    const original: Defaults = { ...retainedDefaults,
      overlay: { ...retainedDefaults.overlay, ...(task === undefined ? {} : { task }) } };
    const expected: Defaults = { ...original, revision: original.revision + 1 };
    const legacy = { ...original, overlay: { ...original.overlay, task: { ...task, agentModelOverrides: overrides } } };
    const f = fixture(JSON.stringify(legacy));
    const before = new Map(f.rows);
    // Reads and writes do not admit legacy overlays as a compatibility path.
    expect(await plugin.handlers.readDefaults!(f.ctx, {})).toEqual({ refused: "omp_defaults_incompatible" });
    expect(await plugin.handlers.writeDefaults!(f.ctx, { expectedRevision: original.revision, overlay: {} }))
      .toEqual({ refused: "omp_defaults_incompatible" });
    expect(f.rows).toEqual(before);
    f.calls.length = 0;

    await migration.migrate(f.storage);
    expect(f.calls).toEqual([`get:${defaultsKey}`, `set:${defaultsKey}`]);
    expect(DefaultsSchema.parse(JSON.parse(f.rows.get(defaultsKey)!))).toEqual(expected);
    expect(await plugin.handlers.readDefaults!(f.ctx, {})).toEqual(expected);
    expectUnrelatedRows(f.rows);
    const migratedRaw = f.rows.get(defaultsKey)!;
    f.calls.length = 0;
    await migration.migrate(f.storage);
    expect(f.calls).toEqual([`get:${defaultsKey}`]);
    expect(f.rows.get(defaultsKey)).toBe(migratedRaw);

    expect(await plugin.handlers.writeDefaults!(f.ctx, { expectedRevision: original.revision, overlay: {} }))
      .toEqual({ refused: "omp_stale_defaults" });
    expect(f.comparisons).toEqual([]);
    f.state.compare = false;
    expect(await plugin.handlers.writeDefaults!(f.ctx, { expectedRevision: expected.revision, overlay: {} }))
      .toEqual({ refused: "omp_stale_defaults" });
    expect(f.comparisons[0]).toEqual({ key: defaultsKey, expected: migratedRaw,
      value: JSON.stringify({ revision: expected.revision + 1, overlay: {}, updatedAt: f.ctx.now(), updatedBy: "current-owner" }) });
    expect(f.rows.get(defaultsKey)).toBe(migratedRaw);

    f.state.compare = true;
    const overlay = { modelRoles: { default: "fixture/replacement", smol: "fixture/fast" } };
    const next: Defaults = { revision: expected.revision + 1, overlay, updatedAt: f.ctx.now(), updatedBy: "current-owner" };
    expect(await plugin.handlers.writeDefaults!(f.ctx, { expectedRevision: expected.revision, overlay })).toEqual(next);
    expect(f.comparisons[1]!.expected).toBe(migratedRaw);
    expect(await plugin.handlers.readDefaults!(f.ctx, {})).toEqual(next);
    expect(await plugin.handlers.writeDefaults!(f.ctx, { expectedRevision: expected.revision, overlay: {} }))
      .toEqual({ refused: "omp_stale_defaults" });
    expect(await plugin.handlers.readDefaults!(f.ctx, {})).toEqual(next);
    expectUnrelatedRows(f.rows);
  }
});

test("session review rejects the old revision and consumes retained task controls at the migrated revision", async () => {
  const current: Defaults = { ...retainedDefaults, overlay: { ...retainedDefaults.overlay,
    retry: { enabled: false, modelFallback: false }, task: { agentAdvisor: { task: "on" }, prewalk: false } } };
  const f = fixture(JSON.stringify({ ...current,
    overlay: { ...current.overlay, task: { ...current.overlay.task, agentModelOverrides: legacyOverrides } } }));
  expect(await plugin.handlers.reviewSession!(f.ctx, reviewInput)).toEqual({ refused: "omp_defaults_incompatible" });
  await migration.migrate(f.storage);
  expect(await plugin.handlers.reviewSession!(f.ctx, reviewInput)).toEqual({ refused: "omp_stale_defaults" });
  // This production review check follows expectedDefaults/effectiveOverlay and precedes any service/account call.
  expect(await plugin.handlers.reviewSession!(f.ctx, { ...reviewInput, expectedDefaultsRevision: current.revision + 1 }))
    .toEqual({ refused: "omp_restricted_delegation_unsupported" });
  expect(await plugin.handlers.readDefaults!(f.ctx, {})).toEqual({ ...current, revision: current.revision + 1 });
  expectUnrelatedRows(f.rows);
});

test("empty, absent-default and already-current stores migrate without changing any bytes", async () => {
  for (const initial of [new Map<string, string>(), retainedRows]) {
    const f = fixture(undefined, initial);
    await migration.migrate(f.storage);
    expect(f.calls).toEqual([`get:${defaultsKey}`]);
    expect(f.rows).toEqual(initial);
    expect(await plugin.handlers.readDefaults!(f.ctx, {})).toEqual({ revision: 0, overlay: {}, updatedAt: null, updatedBy: null });
  }
  for (const current of [retainedDefaults,
    { ...retainedDefaults, overlay: { ...retainedDefaults.overlay, task: {} } },
    { ...retainedDefaults, revision: Number.MAX_SAFE_INTEGER }]) {
    const raw = `\n${JSON.stringify(current, null, 2)}\n`;
    const f = fixture(raw);
    const before = new Map(f.rows);
    await migration.migrate(f.storage);
    expect(f.calls).toEqual([`get:${defaultsKey}`]);
    expect(f.rows).toEqual(before);
    expect(await plugin.handlers.readDefaults!(f.ctx, {})).toEqual(current);
  }
});

test("malformed retained defaults fail closed before migration or replacement can write", async () => {
  const legacy = { ...retainedDefaults, overlay: { ...retainedDefaults.overlay, task: { agentModelOverrides: legacyOverrides } } };
  const invalid = [
    '{"private-fixture-marker":',
    "null",
    "[]",
    JSON.stringify({ ...legacy, revision: Number.MAX_SAFE_INTEGER }),
    JSON.stringify({ ...legacy, revision: -1 }),
    JSON.stringify({ ...legacy, overlay: { ...legacy.overlay, task: { ...legacy.overlay.task, prewalk: "private-fixture-marker" } } }),
    JSON.stringify({ ...legacy, overlay: { ...legacy.overlay, task: { ...legacy.overlay.task, unknownControl: true } } }),
    JSON.stringify({ ...legacy, overlay: { ...legacy.overlay, environment: { PRIVATE_FIXTURE_MARKER: "not-public" } } }),
    JSON.stringify({ ...retainedDefaults, updatedBy: 123 }),
  ];
  for (const raw of invalid) {
    const f = fixture(raw);
    const before = new Map(f.rows);
    await expect(migration.migrate(f.storage)).rejects.toThrow(/^omp_defaults_incompatible$/);
    expect(f.calls).toEqual([`get:${defaultsKey}`]);
    expect(await plugin.handlers.readDefaults!(f.ctx, {})).toEqual({ refused: "omp_defaults_incompatible" });
    expect(await plugin.handlers.writeDefaults!(f.ctx, { expectedRevision: retainedDefaults.revision, overlay: {} }))
      .toEqual({ refused: "omp_defaults_incompatible" });
    expect(await plugin.handlers.reviewSession!(f.ctx, reviewInput)).toEqual({ refused: "omp_defaults_incompatible" });
    expect(f.calls.every(call => call === `get:${defaultsKey}`)).toBe(true);
    expect(f.rows).toEqual(before);
  }
});

test("native migration drafts retain legacy bytes on write-reply or publication failure and permit a clean retry", async () => {
  for (const failure of ["write-reply", "publication"]) {
    const store = new ServerStore(openDatabase(":memory:"));
    try {
      const live = store.pluginStorage(OMP_PLUGIN_ID);
      const legacyRaw = JSON.stringify({ ...retainedDefaults,
        overlay: { ...retainedDefaults.overlay, task: { agentModelOverrides: legacyOverrides } } });
      for (const [key, value] of retainedRows) await live.set(key, value);
      await live.set(defaultsKey, legacyRaw);
      await live.stampDataVersion({ major: 1, minor: 0 });
      const keys = await live.keys();
      const draft = store.beginPluginMigration(OMP_PLUGIN_ID);
      if (failure === "write-reply") {
        // The real private draft changes before its proxy reports failure; it must never publish.
        const failingStorage: GuestStorage = { ...draft.storage, async set(key, value) {
          await draft.storage.set(key, value);
          throw new Error("fixture storage write reply failed");
        } };
        await expect(migration.migrate(failingStorage)).rejects.toThrow("fixture storage write reply failed");
        expect(DefaultsSchema.parse(JSON.parse((await draft.storage.get(defaultsKey))!)).revision)
          .toBe(retainedDefaults.revision + 1);
        draft.discard();
      } else {
        await migration.migrate(draft.storage);
        await draft.storage.recordMigration(migration.name, 2345678);
        await draft.storage.stampDataVersion(migration.to);
        // This native publication callback runs after the KV writes, inside the same transaction.
        expect(() => draft.commit(() => { throw new Error("fixture publication failed"); }))
          .toThrow("fixture publication failed");
      }
      expect(await live.get(defaultsKey)).toBe(legacyRaw);
      expect(await live.keys()).toEqual(keys);
      expect(await live.dataVersion()).toEqual({ major: 1, minor: 0 });
      expect(await live.appliedMigrations()).toEqual([]);
      for (const [key, value] of retainedRows) expect(await live.get(key)).toBe(value);
      await expect(draft.storage.get(defaultsKey)).rejects.toThrow("closed");

      const retry = store.beginPluginMigration(OMP_PLUGIN_ID);
      await migration.migrate(retry.storage);
      await retry.storage.recordMigration(migration.name, 2345678);
      await retry.storage.stampDataVersion(migration.to);
      retry.commit();
      expect(await live.dataVersion()).toEqual(migration.to);
      expect(await live.appliedMigrations()).toEqual([migration.name]);
      const ctx = { ...fixture().ctx, storage: live };
      const migrated = { ...retainedDefaults, revision: retainedDefaults.revision + 1 };
      expect(await plugin.handlers.readDefaults!(ctx, {})).toEqual(migrated);
      expect(await plugin.handlers.writeDefaults!(ctx, { expectedRevision: retainedDefaults.revision, overlay: {} }))
        .toEqual({ refused: "omp_stale_defaults" });
      expect(await plugin.handlers.writeDefaults!(ctx, { expectedRevision: migrated.revision, overlay: {} }))
        .toEqual({ revision: migrated.revision + 1, overlay: {}, updatedAt: ctx.now(), updatedBy: "current-owner" });
      expect(await live.keys()).toEqual(keys);
      for (const [key, value] of retainedRows) expect(await live.get(key)).toBe(value);
    } finally {
      store.close();
    }
  }
});

test("migration does not expose legacy agent overrides through the current public overlay or write door", async () => {
  const overlay = { task: { agentModelOverrides: legacyOverrides } };
  expect(OverlaySchema.safeParse(overlay).success).toBe(false);
  const f = fixture(JSON.stringify(retainedDefaults));
  const before = new Map(f.rows);
  expect(await plugin.handlers.writeDefaults!(f.ctx, { expectedRevision: retainedDefaults.revision, overlay }))
    .toEqual({ refused: "omp_invalid_request" });
  expect(f.calls).toEqual([]);
  expect(f.rows).toEqual(before);
});
