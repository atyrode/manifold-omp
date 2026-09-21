import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { NativeBrokerHandle } from "../../workers/broker/server.ts";
import { runSdkScenario, type SdkScenarioContext } from "./isolated-sdk";

await runSdkScenario(async (ctx: SdkScenarioContext) => {
  // SDK evaluation must follow the harness's network and private-state isolation.
  const { NativeBrokerStorage } = await import("../../workers/broker/storage.ts");
  const { startNativeBroker } = await import("../../workers/broker/server.ts");
  const { registerOAuthProvider, unregisterOAuthProvider } = await import("@oh-my-pi/pi-ai/registry/oauth/index");

  for (const mode of ["automatic", "http"] as const) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const provider = `synthetic-shutdown-${mode}`;
    const bearer = "SYNTHETIC-SHUTDOWN-BEARER";
    const rotatedRefresh = "SYNTHETIC-SHUTDOWN-ROTATED-REFRESH";
    const rotatedAccess = "SYNTHETIC-SHUTDOWN-ROTATED-ACCESS";
    let refreshStarted = false;
    let released = false;
    let providerAborted = false;
    let refreshCalls = 0;
    registerOAuthProvider({
      id: provider,
      name: "Synthetic shutdown regression",
      async login() { throw new Error("synthetic-login-forbidden"); },
      async refreshToken(credential, signal) {
        refreshStarted = true;
        refreshCalls++;
        entered.resolve();
        await release.promise;
        providerAborted ||= signal?.aborted === true;
        return {
          ...credential,
          refresh: rotatedRefresh,
          access: rotatedAccess,
          expires: Date.now() + 3_600_000,
        };
      },
    });

    const database = join(ctx.root, `${mode}.db`);
    const storage = await NativeBrokerStorage.create(database, { refreshOAuthCredential: ctx.refreshOAuthCredential });
    let storageOpen = true;
    let broker: NativeBrokerHandle | undefined;
    let request: Promise<void> | undefined;
    const streamAbort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      storage.upsertCredential(provider, {
        type: "oauth",
        email: "shutdown@accounts.invalid",
        refresh: "SYNTHETIC-SHUTDOWN-ORIGINAL-REFRESH",
        access: "SYNTHETIC-SHUTDOWN-ORIGINAL-ACCESS",
        expires: mode === "automatic" ? Date.now() - 1_000 : Date.now() + 3_600_000,
      });
      const entry = storage.listStoredCredentials().find(row => row.provider === provider);
      ctx.check(entry !== undefined, "shutdown-credential-missing");
      broker = startNativeBroker({
        storage,
        bind: "127.0.0.1:0",
        bearerTokens: [bearer],
        disableRefresher: mode === "http",
        refreshIntervalMs: 10,
      });
      const fetch = ctx.fetchTo(broker.url);
      const headers = { authorization: `Bearer ${bearer}` };
      const stream = await fetch(`${broker.url}/v1/snapshot/stream`, { headers, signal: streamAbort.signal });
      ctx.check(stream.status === 200 && stream.body !== null, "shutdown-stream-open-failed");
      reader = stream.body.getReader();
      const initial = await reader.read();
      ctx.check(!initial.done, "shutdown-stream-ended-before-close");

      if (mode === "http") {
        // Observe the real HTTP handler. Forced transport closure may reject this
        // request, but must not detach its credential mutation from broker.close().
        request = fetch(`${broker.url}/v1/credential/${entry.id}/refresh`, { method: "POST", headers })
          .then(async response => { await response.body?.cancel(); }, () => {});
      }
      await entered.promise;
      let firstClosed = false;
      let secondClosed = false;
      const firstClose = broker.close().then(() => { firstClosed = true; });
      const secondClose = broker.close().then(() => { secondClosed = true; });
      // Give an incorrectly immediate close and several sweep intervals time to
      // settle while the provider response remains deliberately unavailable.
      await Bun.sleep(50);
      ctx.check(!firstClosed && !secondClosed, "shutdown-returned-before-refresh");
      release.resolve();
      released = true;
      // The SSE connection is intentionally still open on the client: shutdown
      // must terminate it rather than waiting indefinitely for client cleanup.
      await Promise.all([firstClose, secondClose]);
      ctx.check(!providerAborted, "shutdown-aborted-provider-refresh");
      ctx.check(refreshCalls === 1, "shutdown-started-extra-refresh");
      storage.close();
      storageOpen = false;

      const reopened = await NativeBrokerStorage.create(database, { refreshOAuthCredential: ctx.refreshOAuthCredential });
      try {
        await reopened.reload();
        const persisted = reopened.listStoredCredentials().find(row => row.provider === provider)?.credential;
        ctx.check(persisted?.type === "oauth" && persisted.refresh === rotatedRefresh
          && persisted.access === rotatedAccess, "shutdown-rotation-not-persisted");
      } finally {
        reopened.close();
      }
      await broker.close();
    } finally {
      // On the unfixed SDK, join its real single-flight before releasing the
      // provider so failure cleanup does not race storage closure as well.
      const drain = refreshStarted && !released && storageOpen
        ? storage.refreshCredentialById(storage.listStoredCredentials().find(row => row.provider === provider)!.id)
        : undefined;
      release.resolve();
      await drain?.catch(() => {});
      streamAbort.abort();
      await reader?.cancel().catch(() => {});
      await broker?.close();
      await request;
      if (storageOpen) storage.close();
      unregisterOAuthProvider(provider);
    }
  }

  // Native authentication is not SDK write admission. A partial upload must
  // receive an explicit refusal, while quiesce also stops new refresher ticks.
  const provider = "synthetic-handoff-refresher";
  const bearer = "SYNTHETIC-HANDOFF-BEARER";
  const entered = Promise.withResolvers<void>();
  let refreshCalls = 0;
  registerOAuthProvider({
    id: provider, name: "Synthetic handoff refresher",
    async login() { throw new Error("synthetic-login-forbidden"); },
    async refreshToken(credential) {
      refreshCalls++;
      entered.resolve();
      return { ...credential, access: "SYNTHETIC-HANDOFF-ROTATED", expires: Date.now() + 3_600_000 };
    },
  });
  const storage = await NativeBrokerStorage.create(join(ctx.root, "handoff.db"), {
    refreshOAuthCredential: ctx.refreshOAuthCredential,
  });
  let broker: NativeBrokerHandle | undefined;
  let upload: ReturnType<typeof httpRequest> | undefined;
  let draining: Promise<Response> | undefined;
  const received = Promise.withResolvers<number>();
  void received.promise.catch(() => {});
  try {
    const credential = {
      type: "oauth" as const, email: "handoff@accounts.invalid", expires: 0,
      access: "SYNTHETIC-HANDOFF-ORIGINAL", refresh: "SYNTHETIC-HANDOFF-REFRESH",
    };
    storage.upsertCredential(provider, credential);
    broker = startNativeBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [bearer],
      controlBearerToken: bearer, refreshIntervalMs: 10 });
    await entered.promise;
    const persistedDeadline = Date.now() + 3_000;
    const rotated = () => storage.listStoredCredentials().some(row =>
      row.provider === provider && row.credential.type === "oauth"
      && row.credential.access === "SYNTHETIC-HANDOFF-ROTATED");
    while (!rotated() && Date.now() < persistedDeadline) await Bun.sleep(5);
    ctx.check(rotated() && refreshCalls === 1, "handoff-initial-sweep-not-completed");

    const body = JSON.stringify({ provider: "synthetic-late-upload",
      credential: { type: "api_key", key: "SYNTHETIC-LATE-UPLOAD" } });
    const continued = Promise.withResolvers<void>();
    upload = httpRequest(`${broker.url}/v1/credential`, {
      method: "POST", agent: false,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json",
        "content-length": Buffer.byteLength(body), expect: "100-continue" },
    }, response => {
      response.resume();
      response.once("end", () => received.resolve(response.statusCode ?? 0));
      response.once("error", received.reject);
    });
    upload.once("continue", continued.resolve);
    upload.once("error", error => { continued.reject(error); received.reject(error); });
    upload.flushHeaders();
    await continued.promise;
    const fetch = ctx.fetchTo(broker.url);
    const headers = { authorization: `Bearer ${bearer}` };
    let completed = false;
    draining = fetch(`${broker.url}/v1/control/quiesce`, { method: "POST", headers })
      .then(response => { completed = true; return response; });
    let state = "active";
    const deadline = Date.now() + 3_000;
    while (state === "active" && Date.now() < deadline) {
      const response = await fetch(`${broker.url}/v1/control/state`, { headers });
      state = (await response.json() as { state: string }).state;
      if (state === "active") await Bun.sleep(5);
    }
    ctx.check(state === "draining" && !completed, "handoff-forward-not-retired");
    storage.upsertCredential(provider, credential);
    await Bun.sleep(50);
    ctx.check(refreshCalls === 1, "handoff-started-post-quiesce-refresh");
    upload.end(body);
    ctx.check(await received.promise === 503, "handoff-unadmitted-write-not-refused");
    const response = await draining;
    const result = await response.json() as { state: string };
    ctx.check(response.status === 200 && result.state === "drained", "handoff-drain-failed");
    ctx.check(!storage.listStoredCredentials().some(row => row.provider === "synthetic-late-upload"),
      "handoff-refused-write-was-applied");
  } finally {
    upload?.destroy();
    await draining?.catch(() => {});
    await broker?.close();
    storage.close();
    unregisterOAuthProvider(provider);
  }
});
