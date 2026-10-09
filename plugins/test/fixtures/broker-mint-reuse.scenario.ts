import { join } from "node:path";
import type { SdkScenarioContext } from "./isolated-sdk.ts";
import { runSdkScenario } from "./isolated-sdk.ts";

await runSdkScenario(async (ctx: SdkScenarioContext) => {
  // SDK loading must follow the child's environment, logging, and fetch isolation.
  const { NativeBrokerStorage } = await import("../../workers/broker/storage.ts");
  let mints = 0;
  // The broker's provider exchange, as the worker entry composes it: one call is one mint.
  const storage = await NativeBrokerStorage.create(join(ctx.root, "mint-reuse.db"), {
    refreshOAuthCredential: async (_provider, _id, credential) => {
      mints++;
      return { ...credential, access: `synthetic-minted-${mints}`, expires: Date.now() + 3_600_000 };
    },
  });
  try {
    await storage.credentials.upsert("anthropic", { type: "oauth", access: "synthetic-stale", refresh: "synthetic-unused-refresh",
      expires: Date.now() + 3_600_000, email: "mint-reuse@accounts.invalid" });
    const id = storage.credentials.list().find(row => row.provider === "anthropic")!.id;
    // Two clients recovering from the same 401 ask the broker for an auth-recovery refresh.
    const first = await storage.oauth.refresh(id, undefined, { reuseRecentMint: true });
    const second = await storage.oauth.refresh(id, undefined, { reuseRecentMint: true });
    ctx.check(mints === 1, `auth-recovery-minted-${mints}-times`);
    ctx.check(first.credential.type === "oauth" && second.credential.type === "oauth" &&
      first.credential.access === "synthetic-minted-1" && second.credential.access === "synthetic-minted-1", "auth-recovery-token-not-reused");
  } finally {
    await storage.drainRefreshes();
    storage.close();
  }
});
