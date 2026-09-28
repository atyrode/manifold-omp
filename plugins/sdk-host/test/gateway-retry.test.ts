import { expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { streamPiNative } from "@oh-my-pi/pi-ai/providers/pi-native-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { startPrivateBoundary } from "../../workers/gateway/boundary.ts";
import { UNLISTED_MODEL_ID, UNLISTED_PUBLISHED_ID } from "../../test/fixtures/models.ts";

const BEARER = "service-bearer-for-this-test";
const published = { id: UNLISTED_MODEL_ID, provider: "openrouter", api: "openai-completions" } as Model<Api>;
const turn = { role: "assistant", api: published.api, provider: published.provider, model: published.id, stopReason: "stop", timestamp: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
/** What the gateway's SDK listener streams when its own call fails before any status exists. */
const failed = (content: object[]) =>
  event({ type: "error", reason: "error", error: { ...turn, content, stopReason: "error", errorMessage: "fixture-upstream-detail" } });
const committed = [{ type: "text", text: "ALREADY-COMMITTED" }];

// The SDK host runs material-only, restricted, host-tool and skill-selecting one-shots on its own
// SDK release, so its retry reads the gateway's projection with a classifier the gateway was not
// built with. The projection carries no content, so what the turn already produced must decide
// the classification the gateway sends: a retry would produce it again.
test.each([
  ["retries it when the turn produced nothing", failed([]), true],
  ["does not retry it after text reached the reader", event({ type: "start", partial: { ...turn, content: [] } }) +
    event({ type: "text_delta", contentIndex: 0, delta: committed[0]!.text, partial: { ...turn, content: committed } }) + failed([]), false],
  // A server tool runs at the provider, and only the failed turn records it.
  ["does not retry it after a server tool ran", failed([{ type: "anthropicServerTool",
    block: { type: "server_tool_use", id: "srvtoolu_fixture", name: "web_search", input: { query: "fixture" } } }]), false],
])("given a stream failure the gateway could give no status, the SDK host's session %s", async (_, frames, retried) => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(frames, { headers: { "content-type": "text/event-stream" } }),
  });
  // The gateway is built on the CLI's SDK release, so its catalog is typed by that release.
  const catalog = new Map([[UNLISTED_PUBLISHED_ID, published]]) as unknown as Parameters<typeof startPrivateBoundary>[2];
  const boundary = startPrivateBoundary({ url: upstream.url.origin, bearer: "internal" }, BEARER, catalog, new AbortController().signal);
  try {
    const model = { ...published, baseUrl: `http://127.0.0.1:${boundary.port}` };
    const message = await streamPiNative(model, { messages: [] }, { apiKey: BEARER }).result();
    expect(message).toMatchObject({ stopReason: "error", errorMessage: "gateway_unavailable", errorStatus: 503, content: [] });
    expect(JSON.stringify(message)).not.toContain("fixture-upstream-detail");
    // The decision an SDK-host session makes when its turn ends in that message.
    const recovery = new TurnRecovery({ settings: Settings.isolated(), configWarnings: [], model: () => model,
      textOutputCommitted: () => true, modelRegistry: { isProviderDiscoveryPending: () => false } } as unknown as TurnRecoveryHost);
    expect(recovery.isRetryableError(message)).toBe(retried);
  } finally {
    boundary.close();
    upstream.stop(true);
  }
});
