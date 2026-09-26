import { describe, expect, test } from "bun:test";
import { setTransports } from "@oh-my-pi/pi-utils/logger";
import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
} from "@oh-my-pi/pi-ai/types";
import type {
  SnapshotEntry,
  SnapshotResponse,
} from "@oh-my-pi/pi-ai/auth-broker/types";
import type {
  GatewayRequestLimits,
  RuntimeAccountPool,
} from "../../api/contracts.ts";
import { parseInputs } from "./inputs.ts";

// Match the worker's logging barrier: SDK modules must load only after transports
// are disabled, so their import-time initialization cannot emit provider details.
setTransports({ file: false, console: false });
const { streamSimple, stream, getCustomApi } = await import("@oh-my-pi/pi-ai");
const { boundedTransport } = await import("./transport.ts");
const { startPoolGateway } = await import("./runtime.ts");
const { poolModels } = await import("./storage.ts");
const accountPool = {
  anthropic: [
    {
      scope: "fixture-scope",
      credentialId: 1,
      identityKey: "fixture-identity",
    },
  ],
};
const canonical = poolModels(accountPool).get("anthropic/claude-sonnet-4-5")!;
const bearer = "fixture-native-service-bearer-private-only";
const brokerToken = "fixture-native-broker-bearer-private-only";
const context = (): Context => ({
  messages: [{ role: "user", content: "Reply verified.", timestamp: 0 }],
});
const limits = { maxAttemptsPerCall: 1, maxOutputTokens: 4096 };

function completion(model: string): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "verified" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

class SyntheticProvider {
  readonly requests: {
    model: string;
    max_tokens: number;
    thinking?: { budget_tokens?: number };
  }[] = [];
  readonly headers: Headers[] = [];
  readonly entered = Promise.withResolvers<void>();
  readonly cancelled = Promise.withResolvers<void>();
  mode: "success" | "retry" | "auth" | "redirect" | "blocked" | "retry-once" =
    "success";
  readonly server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request: Request) => {
      const payload = (await request.json()) as (typeof this.requests)[number];
      this.requests.push(payload);
      this.headers.push(request.headers);
      this.entered.resolve();
      if (this.mode === "blocked") {
        return new Promise<Response>((resolve) => {
          const abort = () => {
            this.cancelled.resolve();
            resolve(new Response(null, { status: 499 }));
          };
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) abort();
        });
      }
      if (this.mode === "redirect")
        return new Response(null, {
          status: 307,
          headers: { location: this.url + "/redirected" },
        });
      if (
        this.mode === "auth" ||
        this.mode === "retry" ||
        (this.mode === "retry-once" && this.requests.length === 1)
      ) {
        const status = this.mode === "auth" ? 401 : 529;
        return Response.json(
          {
            type: "error",
            error: {
              type:
                status === 401 ? "authentication_error" : "overloaded_error",
              message: "fixture-private-provider-diagnostic",
            },
          },
          { status, headers: { "retry-after": "0" } },
        );
      }
      return completion(payload.model);
    },
  });
  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }
  close(): void {
    this.server.stop(true);
  }
}

class SyntheticBroker {
  refreshes = 0;
  readonly watches = new Set<ReadableStreamDefaultController<Uint8Array>>();
  entry: SnapshotEntry = {
    id: 1,
    provider: "anthropic",
    identityKey: "fixture-identity",
    rotatesInMs: null,
    credential: {
      type: "oauth",
      access: "sk-ant-oat01-fixture-initial",
      refresh: "__remote__",
      expires: Date.now() + 3600_000,
      accountId: "fixture-account",
      email: "fixture@example.invalid",
    },
  };
  snapshot(): SnapshotResponse {
    return {
      generation: this.refreshes + 1,
      generatedAt: Date.now(),
      serverNowMs: Date.now(),
      credentials: [this.entry],
      refresher: {
        enabled: false,
        intervalMs: 60000,
        skewMs: 60000,
        nextSweepInMs: 60000,
      },
    };
  }
  readonly server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request: Request) => {
      if (request.headers.get("authorization") !== `Bearer ${brokerToken}`)
        return new Response(null, { status: 401 });
      const path = new URL(request.url).pathname;
      if (path === "/v1/snapshot") return Response.json(this.snapshot());
      if (path === "/v1/snapshot/stream") {
        let watch: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              watch = controller;
              this.watches.add(controller);
              controller.enqueue(
                new TextEncoder().encode(
                  `event: snapshot\ndata: ${JSON.stringify({ ...this.snapshot(), kind: "snapshot" })}\n\n`,
                ),
              );
              request.signal.addEventListener(
                "abort",
                () => {
                  if (this.watches.delete(controller)) controller.close();
                },
                { once: true },
              );
            },
            cancel: () => {
              this.watches.delete(watch);
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (path === "/v1/credential/1/refresh") {
        this.refreshes++;
        if (this.entry.credential.type !== "oauth")
          throw new Error("fixture credential changed");
        this.entry = {
          ...this.entry,
          credential: {
            ...this.entry.credential,
            access: `sk-ant-oat01-fixture-rotated-${this.refreshes}`,
          },
        };
        const { rotatesInMs: _, ...entry } = this.entry;
        return Response.json({ entry });
      }
      if (path === "/v1/usage")
        return Response.json({ generatedAt: Date.now(), reports: [] });
      if (path === "/v1/usage/observed") return Response.json({ ok: true });
      return new Response(null, { status: 404 });
    },
  });
  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }
  close(): void {
    this.server.stop(true);
  }
}

async function gatewayFixture(
  provider: SyntheticProvider,
  policy: GatewayRequestLimits | null = limits,
  pool: RuntimeAccountPool = accountPool,
  credential?: SnapshotEntry["credential"],
) {
  const broker = new SyntheticBroker();
  if (credential)
    broker.entry = { ...broker.entry, identityKey: null, credential };
  const owner = new AbortController();
  // Route only the SDK's provider address to a real loopback HTTP server. Every
  // other allowed request is the real broker listener; no public provider runs.
  const localFetch: typeof fetch = Object.assign(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin === broker.url) return fetch(request);
      if (new URL(request.url).hostname !== "api.anthropic.com")
        throw new Error("unexpected fixture destination");
      return fetch(
        new Request(provider.url + new URL(request.url).pathname, request),
      );
    },
    { preconnect: fetch.preconnect },
  );
  try {
    const gateway = await startPoolGateway(
      parseInputs(
        { url: broker.url, token: brokerToken },
        pool,
        bearer,
        policy,
      ),
      owner.signal,
      localFetch,
    );
    return {
      gateway,
      broker,
      owner,
      request(
        options: Record<string, unknown> = {},
        signal?: AbortSignal,
        stream = true,
        modelId = `anthropic/${canonical.id}`,
      ) {
        return fetch(`http://127.0.0.1:${gateway.port}/v1/pi/stream`, {
          method: "POST",
          ...(signal ? { signal } : {}),
          headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
            "x-omp-install-id": "00000000-0000-4000-8000-000000000001",
          },
          body: JSON.stringify({
            modelId,
            context: context(),
            options,
            stream,
          }),
        });
      },
      async close() {
        owner.abort();
        await gateway.close();
        broker.close();
      },
    };
  } catch (error) {
    owner.abort();
    broker.close();
    throw error;
  }
}

function options(signal: AbortSignal): SimpleStreamOptions {
  return {
    signal,
    apiKey: "sk-ant-fixture-only",
    maxTokens: 100_000,
    loopGuard: { enabled: true },
  };
}

describe("bounded native provider admission", () => {
  test("caller credential headers cannot replace or poison the selected pool credential", async () => {
    const provider = new SyntheticProvider();
    const pool = {
      anthropic: [
        { scope: "fixture-scope", credentialId: 1, identityKey: null },
      ],
    };
    const fixture = await gatewayFixture(provider, limits, pool, {
      type: "api_key",
      key: "fixture-selected-key",
    });
    try {
      for (const name of ["aUtHoRiZaTiOn", "X-aPi-KeY"]) {
        const response = await fixture.request({
          headers: { [name]: "fixture-unselected-key" },
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: {
            type: "gateway_unavailable",
            message: "gateway_unavailable",
          },
        });
      }
      expect(provider.requests).toHaveLength(0);
      expect(fixture.broker.refreshes).toBe(0);
      const response = await fixture.request({
        headers: { "x-fixture-note": "metadata-is-not-authority" },
      });
      expect((await response.text()).includes('"type":"done"')).toBe(true);
      expect(
        provider.headers.map((headers) => headers.get("x-api-key")),
      ).toEqual(["fixture-selected-key"]);
      expect(provider.headers[0]!.get("x-fixture-note")).toBe(
        "metadata-is-not-authority",
      );
    } finally {
      await fixture.close();
      provider.close();
    }
  });

  test("actual gateway keeps canonical identity, progress and priced usage while capping thinking and output", async () => {
    const provider = new SyntheticProvider();
    const fixture = await gatewayFixture(provider);
    try {
      const response = await fixture.request({
        maxTokens: 100_000,
        reasoning: "high",
        thinkingBudgets: { high: 100_000 },
        loopGuard: { enabled: true },
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const events = text
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: {"))
        .map((frame) => JSON.parse(frame.slice(6)));
      expect(
        events.some(
          (event) => event.type === "text_delta" && event.delta === "verified",
        ),
      ).toBe(true);
      const done = events.find((event) => event.type === "done");
      expect(done.message).toMatchObject({
        api: canonical.api,
        provider: canonical.provider,
        model: canonical.id,
        stopReason: "stop",
        usage: { input: 5, output: 1 },
      });
      expect(done.message.usage.cost.total).toBeGreaterThan(0);
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]!.max_tokens).toBeLessThanOrEqual(
        limits.maxOutputTokens,
      );
      expect(provider.requests[0]!.thinking!.budget_tokens).toBeLessThan(
        provider.requests[0]!.max_tokens,
      );
      expect(text).not.toContain("native-gateway-");
    } finally {
      await fixture.close();
      provider.close();
    }
  });

  test("SDK hidden 529 retries cannot exceed one actual HTTP attempt", async () => {
    const provider = new SyntheticProvider();
    provider.mode = "retry";
    const fixture = await gatewayFixture(provider);
    try {
      const response = await fixture.request({ maxRetryDelayMs: 1000 });
      const body = await response.text();
      expect(provider.requests).toHaveLength(1);
      expect(body).toContain("gateway_unavailable");
      expect(body).not.toContain("fixture-private-provider-diagnostic");
    } finally {
      await fixture.close();
      provider.close();
    }
  }, 15000);

  test("an admitted SDK retry can succeed within a two-attempt budget", async () => {
    const provider = new SyntheticProvider();
    provider.mode = "retry-once";
    const fixture = await gatewayFixture(provider, {
      ...limits,
      maxAttemptsPerCall: 2,
    });
    try {
      const response = await fixture.request({}, undefined, false);
      expect(response.status).toBe(200);
      expect((await response.json()).message.content).toEqual([
        { type: "text", text: "verified" },
      ]);
      expect(provider.requests).toHaveLength(2);
    } finally {
      await fixture.close();
      provider.close();
    }
  }, 15000);

  test("actual gateway credential replay shares admission across fresh loop-guard signals", async () => {
    const provider = new SyntheticProvider();
    provider.mode = "auth";
    const fixture = await gatewayFixture(provider);
    try {
      const body = await (
        await fixture.request({
          reasoning: "high",
          loopGuard: { enabled: true },
          sessionId: "caller-cannot-reset-budget",
        })
      ).text();
      expect(fixture.broker.refreshes).toBeGreaterThan(0);
      expect(provider.requests).toHaveLength(1);
      expect(body).toContain("gateway_unavailable");
      expect(body).not.toContain("fixture-private-provider-diagnostic");
    } finally {
      await fixture.close();
      provider.close();
    }
  }, 15000);

  test("concurrent gateway calls with the same caller session get independent budgets", async () => {
    const provider = new SyntheticProvider();
    const fixture = await gatewayFixture(provider);
    try {
      const replies = await Promise.all([
        fixture.request({ sessionId: "same-caller-session" }, undefined, false),
        fixture.request({ sessionId: "same-caller-session" }, undefined, false),
      ]);
      const messages = await Promise.all(
        replies.map((response) => response.json()),
      );
      expect(messages.map((value) => value.message.content)).toEqual([
        [{ type: "text", text: "verified" }],
        [{ type: "text", text: "verified" }],
      ]);
      expect(provider.requests).toHaveLength(2);
    } finally {
      await fixture.close();
      provider.close();
    }
  });

  test("client cancellation reaches an in-flight local provider without replay", async () => {
    const provider = new SyntheticProvider();
    provider.mode = "blocked";
    const fixture = await gatewayFixture(provider, {
      ...limits,
      maxAttemptsPerCall: 3,
    });
    const caller = new AbortController();
    try {
      const response = fixture
        .request({}, caller.signal, false)
        .then((result) => result.text());
      // Attach a rejection handler before the cancellation crosses the HTTP hops.
      const settled = response.catch(() => "cancelled");
      await provider.entered.promise;
      caller.abort();
      await settled;
      await provider.cancelled.promise;
      expect(provider.requests).toHaveLength(1);
    } finally {
      caller.abort();
      await fixture.close();
      provider.close();
    }
  }, 15000);

  test("serialized payloads preserve trusted aliases and refuse model or output substitution", async () => {
    const provider = new SyntheticProvider();
    const owner = new AbortController();
    const transport = boundedTransport(
      { ...limits, maxOutputTokens: 100_000 },
      owner.signal,
    );
    const model = transport.resolve({
      ...canonical,
      id: "fixture-sonnet-alias",
      requestModelId: canonical.id,
      baseUrl: provider.url,
      maxTokens: 2048,
    });
    try {
      const success = await streamSimple(
        model,
        context(),
        options(owner.signal),
      ).result();
      expect(success.stopReason).toBe("stop");
      expect(success.model).toBe("fixture-sonnet-alias");
      expect(provider.requests[0]!.model).toBe(canonical.id);
      expect(provider.requests[0]!.max_tokens).toBe(2048);
      const rejected = await stream(model, context(), {
        signal: owner.signal,
        apiKey: "sk-ant-fixture-only",
        onPayload: (payload) => ({ ...(payload as object), max_tokens: 2049 }),
      }).result();
      expect(["error", "aborted"]).toContain(rejected.stopReason);
      expect(provider.requests).toHaveLength(1);
      const substituted = await stream(model, context(), {
        signal: owner.signal,
        apiKey: "sk-ant-fixture-only",
        onPayload: (payload) => ({
          ...(payload as object),
          model: "claude-opus-4-6",
        }),
      }).result();
      expect(["error", "aborted"]).toContain(substituted.stopReason);
      expect(provider.requests).toHaveLength(1);
    } finally {
      transport.close();
      provider.close();
    }
  });

  test("redirects are not additional unmetered HTTP attempts", async () => {
    const provider = new SyntheticProvider();
    provider.mode = "redirect";
    const owner = new AbortController();
    const transport = boundedTransport(limits, owner.signal);
    try {
      const result = await streamSimple(
        transport.resolve({ ...canonical, baseUrl: provider.url }),
        context(),
        options(owner.signal),
      ).result();
      expect(["error", "aborted"]).toContain(result.stopReason);
      expect(provider.requests).toHaveLength(1);
    } finally {
      transport.close();
      provider.close();
    }
  }, 15000);

  test("unsupported provider paths refuse and separate gateways retain their own registrations", async () => {
    const provider = new SyntheticProvider();
    const owner = new AbortController();
    const first = boundedTransport(limits, owner.signal);
    const second = boundedTransport(limits, owner.signal);
    const model = { ...canonical, baseUrl: provider.url };
    const alias = first.resolve(model);
    const other = second.resolve(model);
    try {
      expect(() =>
        first.resolve({ ...model, api: "openai-responses" } as Model<Api>),
      ).toThrow("gateway_unavailable");
      expect(() => first.resolve({ ...model, provider: "gitlab-duo" })).toThrow(
        "gateway_unavailable",
      );
      first.close();
      expect(getCustomApi(alias.api)).toBeUndefined();
      const result = await streamSimple(
        other,
        context(),
        options(owner.signal),
      ).result();
      expect(result.stopReason).toBe("stop");
      expect(provider.requests).toHaveLength(1);
    } finally {
      first.close();
      second.close();
      provider.close();
    }
  });

  test("configured gateways refuse unsupported APIs while null policy preserves ordinary credential handling", async () => {
    const provider = new SyntheticProvider();
    const pool = {
      openai: [{ scope: "fixture-scope", credentialId: 2, identityKey: null }],
    };
    const model = [...poolModels(pool).values()][0]!;
    try {
      for (const policy of [limits, null]) {
        const fixture = await gatewayFixture(provider, policy, pool);
        try {
          const response = await fixture.request(
            {},
            undefined,
            false,
            `${model.provider}/${model.id}`,
          );
          if (policy === null) expect(response.status).toBe(401);
          else expect(response.status).toBeGreaterThanOrEqual(500);
          expect(await response.json()).toEqual({
            error: {
              type: "gateway_unavailable",
              message: "gateway_unavailable",
            },
          });
        } finally {
          await fixture.close();
        }
      }
      expect(provider.requests).toHaveLength(0);
    } finally {
      provider.close();
    }
  });

  test("ordinary SDK dispatch without the policy keeps normal retries and output options", async () => {
    const provider = new SyntheticProvider();
    provider.mode = "retry-once";
    const owner = new AbortController();
    try {
      const result = await streamSimple(
        { ...canonical, baseUrl: provider.url },
        context(),
        { ...options(owner.signal), maxTokens: 8192 },
      ).result();
      expect(result.stopReason).toBe("stop");
      expect(provider.requests).toHaveLength(2);
      expect(
        provider.requests.every((request) => request.max_tokens === 8192),
      ).toBe(true);
    } finally {
      owner.abort();
      provider.close();
    }
  }, 15000);
});
