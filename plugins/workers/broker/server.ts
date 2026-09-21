import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { startAuthBroker, type AuthBrokerServerHandle, type AuthBrokerServerOptions } from "@oh-my-pi/pi-ai/auth-broker/server";
import { parseBind } from "@oh-my-pi/pi-ai/utils/parse-bind";
import type { NativeBrokerStorage } from "./storage.ts";

export interface NativeBrokerOptions extends Omit<AuthBrokerServerOptions, "storage"> {
  storage: NativeBrokerStorage;
  bearerTokenHashes?: readonly string[];
  controlBearerToken?: string;
}

export interface NativeBrokerHandle extends AuthBrokerServerHandle {
  quiesce(): Promise<void>;
}

/** Native authority/lifecycle boundary around an unmodified published broker. */
export function startNativeBroker(options: NativeBrokerOptions): NativeBrokerHandle {
  const { storage, bearerTokens, bearerTokenHashes, controlBearerToken, ...stockOptions } = options;
  if (!Array.isArray(bearerTokens) || Array.from(bearerTokens).some(token => typeof token !== "string" || !token.trim())) {
    throw new Error("Invalid broker bearer tokens");
  }
  if (bearerTokenHashes !== undefined && (!Array.isArray(bearerTokenHashes) || !bearerTokenHashes.length
    || Array.from(bearerTokenHashes).some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)))) {
    throw new Error("Invalid broker bearer hashes");
  }
  if (!bearerTokens.length && !bearerTokenHashes?.length) throw new Error("Broker authentication is required");
  if (controlBearerToken !== undefined && (typeof controlBearerToken !== "string" || !controlBearerToken
    || !bearerTokens.includes(controlBearerToken))) throw new Error("Invalid broker control bearer");
  const accepted = [
    ...bearerTokens.map(token => createHash("sha256").update(token).digest()),
    ...(bearerTokenHashes ?? []).map(hash => Buffer.from(hash, "hex")),
  ];
  const controlHash = controlBearerToken === undefined ? undefined : createHash("sha256").update(controlBearerToken).digest();
  const bind = parseBind(options.bind ?? "127.0.0.1:0");
  const internalToken = randomBytes(32).toString("hex");
  let upstream: AuthBrokerServerHandle;
  let state: "active" | "draining" | "drained" = "active";
  let draining: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const admitted = new Set<Promise<Response>>();
  const streams = new Set<() => void>();

  const quiesce = (): Promise<void> => {
    if (draining) return draining;
    state = "draining";
    storage.beginDrain();
    for (const close of streams) close();
    draining = (async () => {
      // Do not abort admitted writes (nor usage's detached rotation). The stock
      // listener remains private while those handlers finish their public work.
      await Promise.allSettled(admitted);
      storage.stopRefreshAdmission();
      await upstream.close();
      await storage.drainRefreshes();
      state = "drained";
    })();
    return draining;
  };

  const forward = async (request: Request, url: URL): Promise<Response> => {
    const isStream = request.method === "GET" && url.pathname === "/v1/snapshot/stream";
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${internalToken}`);
    headers.delete("host");
    // Never propagate the caller's disconnect into admitted mutable work.
    const response = await fetch(`${upstream.url}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(request.body ? { body: await request.arrayBuffer() } : {}),
      redirect: "error",
    });
    if (!isStream || !response.ok || !response.body) {
      // Consume the private response before it can be interrupted by stock close.
      return new Response(response.body ? await response.arrayBuffer() : null, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    }
    const reader = response.body.getReader();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      streams.delete(close);
      request.signal.removeEventListener("abort", close);
      controller.close();
      void reader.cancel().catch(() => {});
    };
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        streams.add(close);
        request.signal.addEventListener("abort", close, { once: true });
        if (state !== "active" || request.signal.aborted) close();
      },
      async pull(value) {
        try {
          const next = await reader.read();
          if (closed) return;
          if (next.done) close();
          else value.enqueue(next.value);
        } catch {
          close();
        }
      },
      cancel() {
        // The consumer has already closed its stream controller.
        if (closed) return;
        closed = true;
        streams.delete(close);
        request.signal.removeEventListener("abort", close);
        return reader.cancel();
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  // Acquire the reviewed endpoint FIRST: an occupied port must not start a
  // stock refresher, open a fallback endpoint, or rotate anybody's credential.
  const server = Bun.serve({
    hostname: bind.hostname,
    port: bind.port,
    idleTimeout: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
      const digest = bearer ? createHash("sha256").update(bearer).digest() : undefined;
      const isControl = url.pathname.startsWith("/v1/control/");
      // Published healthz is deliberately unauthenticated (the stock client's
      // health probe omits its bearer). It reveals no credential or control data.
      const publicHealth = request.method === "GET" && url.pathname === "/v1/healthz";
      const authorized = publicHealth || (digest && (isControl
        ? controlHash && timingSafeEqual(digest, controlHash)
        : accepted.some(hash => timingSafeEqual(digest, hash))));
      if (!authorized) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (isControl) {
        if (url.pathname === "/v1/control/state" && request.method === "GET") return Response.json({ state });
        if (url.pathname === "/v1/control/quiesce" && request.method === "POST") {
          try { await quiesce(); return Response.json({ state }); }
          catch { return Response.json({ state: "draining", error: "broker_unavailable" }, { status: 503 }); }
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      if (state !== "active") return Response.json({ error: "broker_draining" }, { status: 503 });
      const operation = forward(request, url);
      admitted.add(operation);
      try { return await operation; }
      catch { return Response.json({ error: "broker_unavailable" }, { status: 502 }); }
      finally { admitted.delete(operation); }
    },
  });
  try {
    storage.startRefreshAdmission();
    upstream = startAuthBroker({ ...stockOptions, storage, bind: "127.0.0.1:0", bearerTokens: [internalToken] });
  } catch (error) {
    storage.stopRefreshAdmission();
    server.stop(true);
    throw error;
  }
  const hostname = server.hostname ?? bind.hostname;
  const port = server.port ?? bind.port;
  return {
    hostname, port, url: `http://${hostname}:${port}`, quiesce,
    close() {
      closing ??= (async () => {
        try { await quiesce(); }
        finally { await server.stop(true); }
      })();
      return closing;
    },
  };
}
