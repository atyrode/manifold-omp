import { expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { streamPiNative } from "@oh-my-pi/pi-ai/providers/pi-native-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { startPrivateBoundary } from "../../workers/gateway/boundary.ts";
import { UNLISTED_MODEL_ID, UNLISTED_PUBLISHED_ID } from "../../test/fixtures/models.ts";

const BEARER = "service-bearer-for-this-test";

// The SDK host runs material-only, restricted, host-tool and skill-selecting one-shots on its own
// SDK release, so its retry reads the gateway's projection with a classifier the gateway was not
// built with.
test("the SDK host's session retries a stream failure the gateway could give no status", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(`data: ${JSON.stringify({ type: "error", reason: "error", error: {
      role: "assistant", content: [], stopReason: "error", errorMessage: "fixture-upstream-detail",
    } })}\n\n`, { headers: { "content-type": "text/event-stream" } }),
  });
  const published = { id: UNLISTED_MODEL_ID, provider: "openrouter", api: "openai-completions" } as Model<Api>;
  // The gateway is built on the CLI's SDK release, so its catalog is typed by that release.
  const catalog = new Map([[UNLISTED_PUBLISHED_ID, published]]) as unknown as Parameters<typeof startPrivateBoundary>[2];
  const boundary = startPrivateBoundary({ url: upstream.url.origin, bearer: "internal" }, BEARER, catalog, new AbortController().signal);
  try {
    const model = { ...published, baseUrl: `http://127.0.0.1:${boundary.port}` };
    const message = await streamPiNative(model, { messages: [] }, { apiKey: BEARER }).result();
    expect(message).toMatchObject({ stopReason: "error", errorMessage: "gateway_unavailable", errorStatus: 503 });
    // The decision an SDK-host session makes when its turn ends in that message.
    const recovery = new TurnRecovery({ settings: Settings.isolated(), configWarnings: [], model: () => model,
      modelRegistry: { isProviderDiscoveryPending: () => false } } as unknown as TurnRecoveryHost);
    expect(recovery.isRetryableError(message)).toBe(true);
  } finally {
    boundary.close();
    upstream.stop(true);
  }
});
