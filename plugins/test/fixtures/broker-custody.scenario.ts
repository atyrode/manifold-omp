import { Database } from "bun:sqlite";
import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SdkScenarioContext } from "./isolated-sdk.ts";
import { runSdkScenario } from "./isolated-sdk.ts";

await runSdkScenario(async (ctx: SdkScenarioContext) => {
  // SDK loading must follow the child's environment, logging, and fetch isolation.
  const { AuthStorage } = await import("@oh-my-pi/pi-ai/auth-storage");
  const { NativeBrokerStorage } = await import("../../workers/broker/storage.ts");
  const { startNativeBroker } = await import("../../workers/broker/server.ts");
  const bearer = "synthetic-custody-service-bearer";
  const headers = { authorization: `Bearer ${bearer}`, "omp-auth-broker-capabilities": "codex-meter-block-scopes" };
  const store = join(ctx.root, "state", "agent.db");
  const removeStore = (path: string) => Promise.all(["", "-wal", "-shm"].map(suffix => rm(`${path}${suffix}`, { force: true })));
  const custodyTable = (path: string) => {
    const db = new Database(path, { readonly: true });
    try { return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manifold_custody'").get() !== null; }
    finally { db.close(); }
  };
  // The fixture for a store that predates custody: the plain SDK persistence every earlier
  // broker and sign-in wrote, with credentials and no custody table.
  const legacyStore = async (path: string) => {
    const legacy = await AuthStorage.create(path);
    try {
      await legacy.credentials.upsert("synthetic-oauth", { type: "oauth", access: "synthetic-access", refresh: "synthetic-unused-refresh",
        expires: Date.now() + 3_600_000, email: "custody@accounts.invalid" });
      await legacy.credentials.upsert("synthetic-key", { type: "api_key", key: "synthetic-api-key" });
    } finally { legacy.close(); }
    ctx.check(!custodyTable(path), "legacy-fixture-has-custody");
  };
  // One broker process over the file: start, read the metadata route as the policy does, stop.
  const serve = async (path: string) => {
    const storage = await NativeBrokerStorage.create(path, { refreshOAuthCredential: ctx.refreshOAuthCredential });
    const broker = startNativeBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [bearer], disableRefresher: true });
    try {
      const fetchTo = ctx.fetchTo(broker.url);
      const anonymous = await fetchTo(`${broker.url}/v1/custody/snapshot`);
      ctx.check(anonymous.status === 401, "custody-route-unauthenticated");
      await anonymous.body?.cancel();
      // Gateway and existing clients keep the unchanged stock snapshot.
      const stock = await fetchTo(`${broker.url}/v1/snapshot`, { headers });
      ctx.check(stock.status === 200 && !Object.hasOwn(await stock.json() as object, "custodyId"), "stock-snapshot-changed");
      const response = await fetchTo(`${broker.url}/v1/custody/snapshot`, { headers });
      ctx.check(response.status === 200, "custody-snapshot-unavailable");
      const body = await response.json() as { custodyId?: unknown; credentials?: { id: number; provider: string; identityKey: string | null }[] };
      ctx.check(typeof body.custodyId === "string" && body.custodyId === storage.custodyId && Array.isArray(body.credentials), "custody-snapshot-invalid");
      return { custodyId: body.custodyId, credentials: JSON.stringify(body.credentials.map(({ id, provider, identityKey }) => [id, provider, identityKey])) };
    } finally {
      await broker.close();
      storage.close();
    }
  };

  await legacyStore(store);
  const upgraded = await serve(store);
  ctx.check(custodyTable(store), "custody-not-persisted");
  ctx.check(JSON.parse(upgraded.credentials).length === 2, "legacy-credentials-not-served");
  // Restart, disable/enable and promotion all start another broker over the same file.
  const restarted = await serve(store);
  ctx.check(restarted.custodyId === upgraded.custodyId, "restart-changed-custody");
  ctx.check(restarted.credentials === upgraded.credentials, "restart-changed-credential-ids");

  // Brokers racing over one new store agree on a single id.
  const raced = join(ctx.root, "state", "raced.db");
  const racers = await Promise.all([0, 1].map(() => NativeBrokerStorage.create(raced, { refreshOAuthCredential: ctx.refreshOAuthCredential })));
  ctx.check(racers[0]!.custodyId === racers[1]!.custodyId, "racing-opens-minted-two-ids");
  for (const racer of racers) racer.close();

  // A purge removes the store; the next broker creates a new one with new custody.
  await removeStore(store);
  const purged = await serve(store);
  ctx.check(purged.custodyId !== upgraded.custodyId && purged.credentials === "[]", "purge-kept-custody");
  // A replaced database brings its own custody, or none: the id travels with the file.
  await removeStore(store);
  await copyFile(raced, store);
  ctx.check((await serve(store)).custodyId === racers[0]!.custodyId, "replacement-kept-location-custody");
  await removeStore(store);
  await legacyStore(store);
  const replaced = await serve(store);
  ctx.check(![upgraded.custodyId, purged.custodyId, racers[0]!.custodyId].includes(replaced.custodyId), "replacement-reused-custody");
});
