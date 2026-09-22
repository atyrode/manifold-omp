import { timingSafeEqual } from "node:crypto";
import { writeSync } from "node:fs";
import { z } from "zod";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { unavailable } from "./inputs.ts";
import { resolvePublished } from "./storage.ts";

const FRAME_LIMIT = 16 * 1024 * 1024;
const credentialHeader = /^(?:authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|x-amz-security-token|cookie)$/i;
const encoder = new TextEncoder();
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cost = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reportedUsage = z.object({
  input: tokenCount, output: tokenCount, cacheRead: tokenCount, cacheWrite: tokenCount, totalTokens: tokenCount,
  cost: z.object({ input: cost, output: cost, cacheRead: cost, cacheWrite: cost, total: cost }),
});
/**
 * The caller still learns only that the gateway would not serve it. The MACHINE learns which
 * check refused and what the upstream said, because one opaque word for unauthorized, unknown
 * route, unknown model, an upstream status and a malformed stream made a failure here
 * indistinguishable from a broken credential, a missing model or a rate limit (#36).
 *
 * Only a fixed label and a numeric status are written. No body, header, URL or bearer.
 */
export function safeFailure(status: number, reason = "unspecified"): Response {
  writeSync(2, `gateway_refused ${reason} ${String(status)}\n`);
  return Response.json({ error: { type: "gateway_unavailable", message: "gateway_unavailable" } }, { status, headers: { "Cache-Control": "no-store" } });
}

/** The SDK has no server error-projection hook. This service-local pi-native
 * boundary forwards only to its fixed SDK listener, never a caller-chosen URL.
 * Successful canonical events are unchanged; failed messages cannot expose SDK
 * exception bodies, bearer-bearing request diagnostics or partial error text. */
export function safeNativeStream(body: ReadableStream<Uint8Array>, model: Model<Api>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  const failure = { type: "error", reason: "error", error: {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: "error", errorMessage: "gateway_unavailable", timestamp: 0,
  } };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        if (end > FRAME_LIMIT) throw unavailable();
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (!frame.startsWith("data: ")) throw unavailable();
        const data = frame.slice(6);
        if (data === "[DONE]") { controller.enqueue(encoder.encode("data: [DONE]\n\n")); continue; }
        const event = JSON.parse(data);
        if (!event || typeof event !== "object" || typeof event.type !== "string") throw unavailable();
        if (event.type === "error" || event.message?.stopReason === "error" || event.message?.stopReason === "aborted" || event.partial?.stopReason === "error" || event.partial?.stopReason === "aborted") {
          // The MACHINE learns which check refused, on THIS path too. `safeFailure` writes its
          // fixed label and numeric status for a request the boundary itself rejects, and the
          // header above states that guarantee for the whole boundary — but an upstream error
          // arriving INSIDE the stream was substituted silently, so a broken credential, an
          // exhausted balance and a rate limit all reached the caller as one word and left the
          // owner nothing to read. Same rule as `safeFailure`: a fixed label and numbers only,
          // never a body, header, URL, bearer or upstream message.
          const reported = (event.error ?? event.message ?? event.partial ?? {}) as {
            stopReason?: unknown; errorStatus?: unknown; errorId?: unknown; status?: unknown; code?: unknown; usage?: unknown;
          };
          const numeric = (...values: unknown[]): string => {
            const found = values.find(value => typeof value === "number" && Number.isFinite(value));
            return found === undefined ? "none" : String(found);
          };
          // `errorStatus`/`errorId` FIRST, because those are the names the SDK's failed assistant
          // message actually carries; `status`/`code` are the shapes a bare error event uses. The
          // first version of this line read only the latter pair and printed `none none` against a
          // real upstream 404, which is a log that reports its own absence of information.
          const stop = reported.stopReason;
          writeSync(2, `gateway_stream_refused ${event.type} ${typeof stop === "string" ? stop : "none"} ${numeric(reported.errorStatus, reported.status)} ${numeric(reported.errorId, reported.code)}\n`);
          const usage = reportedUsage.safeParse(reported.usage);
          const status = [reported.errorStatus, reported.status].find(value =>
            typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
          // Missing usage stays missing: inventing zero would make a charged failure look free.
          const projected = { ...failure, error: { ...failure.error,
            ...(usage.success ? { usage: usage.data } : {}),
            ...(status === undefined ? {} : { errorStatus: status }),
          } };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(projected)}\n\ndata: [DONE]\n\n`));
          controller.terminate();
          return;
        }
        controller.enqueue(encoder.encode(frame + "\n\n"));
      }
      if (Buffer.byteLength(buffered) > FRAME_LIMIT) throw unavailable();
    },
    flush() { if (decoder.decode() || buffered.length) throw unavailable(); },
  }));
}

export interface PrivateBoundary { port: number; close(): void }
/**
 * `catalogUnreadable` is the reason the provider's live listing could not be read on this
 * start, or null. It exists so an unresolved model is refused by the right name: a gateway
 * serving only the SDK's bundled snapshot cannot tell a model that does not exist from one it
 * could not look up, and answering the caller 404 for the second case blames them for a name
 * this gateway simply never fetched (atyrode/manifold#751).
 */
export function startPrivateBoundary(target: { url: string; bearer: string }, bearer: string, models: ReadonlyMap<string, Model<Api>>, signal: AbortSignal, catalogUnreadable: string | null = null): PrivateBoundary {
  const expected = Buffer.from(`Bearer ${bearer}`);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 255, maxRequestBodySize: FRAME_LIMIT,
    error() { return safeFailure(503, "listener_error"); },
    async fetch(request) {
      try {
        signal.throwIfAborted();
        const supplied = Buffer.from(request.headers.get("authorization") ?? "");
        const authorized = supplied.length === expected.length && timingSafeEqual(supplied, expected);
        supplied.fill(0);
        if (!authorized) return safeFailure(401, "service_bearer_rejected");
        const url = new URL(request.url);
        if (url.search || url.hash) return safeFailure(404, "route_not_bare");
        const listing = request.method === "GET" && url.pathname === "/v1/models";
        if (!listing && !(request.method === "POST" && url.pathname === "/v1/pi/stream")) return safeFailure(404, "route_unknown");
        const payload = listing ? undefined : await request.arrayBuffer();
        let model: Model<Api> | undefined;
        if (payload) {
          const parsed = parseRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)));
          // Provider authentication belongs to the selected pool, never the caller.
          const callerHeaders = parsed.options.headers;
          if (callerHeaders !== undefined && (
            typeof callerHeaders !== "object" || callerHeaders === null || Array.isArray(callerHeaders) ||
            Object.keys(callerHeaders).some(name => credentialHeader.test(name))
          )) return safeFailure(400, "provider_credential_header_refused");
          model = resolvePublished(models, parsed.modelId);
          if (!model)
            return catalogUnreadable === null
              ? safeFailure(404, "model_not_published")
              // 503, not 404: the model may well be serveable and this gateway does not know.
              : safeFailure(503, `catalog_unreadable_${catalogUnreadable}`);
        }
        const requestSignal = AbortSignal.any([signal, request.signal]);
        const headers = new Headers(request.headers);
        headers.delete("host");
        headers.delete("content-length");
        // This capability protects only the fixed SDK listener. It is never a
        // provider credential and never returned to the native service caller.
        headers.set("authorization", `Bearer ${target.bearer}`);
        const response = await fetch(target.url + url.pathname, { method: request.method, headers, ...(payload ? { body: payload } : {}), redirect: "error", signal: requestSignal });
        if (!response.ok) { await response.body?.cancel(); return safeFailure(response.status, "upstream_status"); }
        if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
          if (!response.body || !model) { await response.body?.cancel(); return safeFailure(503, "stream_without_model"); }
          return new Response(safeNativeStream(response.body, model), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
        }
        const value = await response.json();
        if (!listing && (!value?.message || ["error", "aborted"].includes(value.message.stopReason))) return safeFailure(503, "upstream_message_error");
        return Response.json(value, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        // The class, never the message: a constructor name says which hop broke without
        // carrying a URL, a bearer, or any bytes from the request or the provider.
        const kind = error instanceof Error ? error.name : typeof error;
        return safeFailure(503, `boundary_exception_${kind}`);
      }
    },
  });
  return { port: server.port!, close() { server.stop(true); expected.fill(0); } };
}
