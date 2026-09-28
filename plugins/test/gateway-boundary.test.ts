import { afterEach, expect, test } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamPiNative } from "@oh-my-pi/pi-ai/providers/pi-native-client";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { startPrivateBoundary, type PrivateBoundary } from "../workers/gateway/boundary.ts";
import { ABSENT_MODEL_ID, UNLISTED_MODEL_ID, UNLISTED_PUBLISHED_ID } from "./fixtures/models.ts";

const BEARER = "service-bearer-for-this-test";
const MODEL = UNLISTED_PUBLISHED_ID;
const models = new Map<string, Model<Api>>([
  [MODEL, { id: UNLISTED_MODEL_ID, provider: "openrouter", api: "openrouter" } as Model<Api>],
]);

let boundary: PrivateBoundary | undefined;
let upstream: { stop: (force?: boolean) => void; url: URL } | undefined;

afterEach(() => {
  boundary?.close();
  boundary = undefined;
  upstream?.stop(true);
  upstream = undefined;
});

/** A body `parseRequest` accepts, so the request reaches the upstream hop under test. */
const body = JSON.stringify({ modelId: MODEL, context: { messages: [] } });

const stream = async (status: number, headers: Record<string, string> = {}): Promise<Response> => {
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(JSON.stringify({ error: "upstream said so" }), { status, headers }),
  });
  boundary = startPrivateBoundary(
    { url: upstream.url.origin, bearer: "internal" },
    BEARER,
    models,
    AbortSignal.timeout(10_000),
  );
  return await fetch(`http://127.0.0.1:${boundary.port}/v1/pi/stream`, {
    method: "POST",
    headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
    body,
  });
};
test("a rate limit reaches the client as a rate limit, so it backs off instead of retrying blind", async () => {
  // The client distinguishes a usage limit from any other failure by the status it sees. A
  // boundary that answered one status for every upstream failure turned a 429 into an ordinary
  // error, and the retry that followed hammered the provider at full speed.
  const response = await stream(429, { "retry-after": "30" });
  expect(response.status).toBe(429);
  // The body stays one word on purpose: the caller learns the gateway would not serve it, and
  // the reason is written to this worker's stderr, where the machine reads it.
  expect(await response.json()).toEqual({ error: { type: "gateway_unavailable", message: "gateway_unavailable" } });
});

test("an upstream rejection of the gateway's own credential keeps its status", async () => {
  const response = await stream(401);
  expect(response.status).toBe(401);
});

test("a stream failure the upstream gave no status reaches the session as a 503 it retries", async () => {
  // What the gateway's SDK listener streams when its own call fails before any status exists,
  // such as the owner's authorization of that call timing out. The session saw one opaque word
  // and no status, omp did not retry it, and the session exited 0 on its first transient fault.
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(`data: ${JSON.stringify({ type: "error", reason: "error", error: {
      role: "assistant", content: [], stopReason: "error", errorMessage: "fixture-upstream-detail",
    } })}\n\n`, { headers: { "content-type": "text/event-stream" } }),
  });
  boundary = startPrivateBoundary({ url: upstream.url.origin, bearer: "internal" }, BEARER, models, new AbortController().signal);
  // The session's own provider transport, from the SDK release the one-shot CLI bundles.
  const client = { ...models.get(MODEL)!, baseUrl: `http://127.0.0.1:${boundary.port}` } as Model<Api>;
  const message = await streamPiNative(client, { messages: [] }, { apiKey: BEARER }).result();
  expect(message).toMatchObject({ stopReason: "error", errorMessage: "gateway_unavailable", errorStatus: 503, content: [] });
  expect(JSON.stringify(message)).not.toContain("fixture-upstream-detail");
  // omp's `TurnRecovery.isRetryableError`: a failed turn that emitted nothing is retried exactly
  // when the SDK classifies it retriable.
  expect(AIError.retriable(AIError.classifyMessage(message))).toBe(true);
});

test("an unpublished model is refused before any upstream hop", async () => {
  let reached = false;
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      reached = true;
      return new Response("should not be reached", { status: 200 });
    },
  });
  boundary = startPrivateBoundary(
    { url: upstream.url.origin, bearer: "internal" },
    BEARER,
    models,
    AbortSignal.timeout(10_000),
  );
  const response = await fetch(`http://127.0.0.1:${boundary.port}/v1/pi/stream`, {
    method: "POST",
    headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
    body: JSON.stringify({ modelId: `openrouter/${ABSENT_MODEL_ID}`, context: { messages: [] } }),
  });
  expect(response.status).toBe(404);
  expect(reached).toBe(false);
});

test("a model missing while the live listing was unreadable is not the caller's 404", async () => {
  // The difference a caller can act on: "the listing does not contain your model" is a 404 and
  // theirs to fix, while "I could not read the listing your model would be in" is this
  // gateway's and retryable. Answering the second as the first is what let an unreadable
  // catalog look like a working one for hours (atyrode/manifold#751).
  let reached = false;
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      reached = true;
      return Response.json({ ok: true });
    },
  });
  boundary = startPrivateBoundary(
    { url: upstream.url.origin, bearer: "internal" },
    BEARER,
    models,
    AbortSignal.timeout(10_000),
    "TimeoutError",
  );
  const response = await fetch(`http://127.0.0.1:${boundary.port}/v1/pi/stream`, {
    method: "POST",
    headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
    body: JSON.stringify({ modelId: `openrouter/${ABSENT_MODEL_ID}`, context: { messages: [] } }),
  });
  expect(response.status).toBe(503);
  // Refused before any upstream hop, like the 404 case: the status is the only thing that
  // changed, and it is the part a caller can act on.
  expect(reached).toBe(false);
  // A published model still resolves while the catalog is pinned-only, so the snapshot is not
  // discarded — only stopped from impersonating a complete answer. Reaching the upstream hop is
  // the proof; what that hop then answers is the upstream message contract, not this case.
  await fetch(`http://127.0.0.1:${boundary.port}/v1/pi/stream`, {
    method: "POST",
    headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
    body: JSON.stringify({ modelId: MODEL, context: { messages: [] } }),
  });
  expect(reached).toBe(true);
});

test("the service bearer is required", async () => {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unreachable", { status: 200 }) });
  boundary = startPrivateBoundary(
    { url: upstream.url.origin, bearer: "internal" },
    BEARER,
    models,
    AbortSignal.timeout(10_000),
  );
  const response = await fetch(`http://127.0.0.1:${boundary.port}/v1/pi/stream`, {
    method: "POST",
    headers: { authorization: "Bearer wrong", "content-type": "application/json" },
    body,
  });
  expect(response.status).toBe(401);
});
