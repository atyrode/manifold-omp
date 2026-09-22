import { randomUUID } from "node:crypto";
import { registerCustomApi, unregisterCustomApis, stream, streamSimple } from "@oh-my-pi/pi-ai";
import type { Api, Context, Model, StreamOptions } from "@oh-my-pi/pi-ai/types";
import type { GatewayRequestLimits } from "../../api/contracts.ts";
import { unavailable } from "./inputs.ts";

interface AttemptBudget { attempts: number; controller: AbortController }
export interface BoundedTransport { resolve(model: Model<Api>): Model<Api>; close(): void }

/** Admission only: provider shaping, retries and credential replay remain SDK-owned. */
export function boundedTransport(limits: GatewayRequestLimits, ownerSignal: AbortSignal, fetchImpl: typeof fetch = fetch): BoundedTransport {
  const source = `native-gateway-${randomUUID()}`;
  const api = `${source}-anthropic`;
  const controller = new AbortController();
  const lifetime = AbortSignal.any([ownerSignal, controller.signal]);
  const budgets = new WeakMap<Context, AttemptBudget>();
  const originals = new WeakMap<Model<Api>, Model<"anthropic-messages">>();
  const aliases = new WeakMap<Model<Api>, Model<Api>>();

  function prepare<T extends StreamOptions>(model: Model<Api>, context: Context, options?: T) {
    lifetime.throwIfAborted();
    // The SDK reuses the parsed Context object across credential replay, but its
    // loop guard creates a fresh child signal for each attempt. The HTTP server
    // creates this object per request; caller session/cache IDs cannot forge it.
    // Each attempt still must carry the SDK request's cancellation signal.
    if (!options?.signal) throw unavailable();
    options.signal.throwIfAborted();
    const original = originals.get(model);
    if (!original) throw unavailable();
    let budget = budgets.get(context);
    if (!budget) {
      budget = { attempts: 0, controller: new AbortController() };
      budgets.set(context, budget);
    }
    const current = budget;
    const signal = AbortSignal.any([lifetime, options.signal, current.controller.signal]);
    signal.throwIfAborted();
    const ceiling = original.maxTokens;
    const gatedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      signal.throwIfAborted();
      const incomingSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const requestSignal = incomingSignal ? AbortSignal.any([signal, incomingSignal]) : signal;
      const request = new Request(input, { ...init, redirect: "error", signal: requestSignal });
      // Inspect the serialized request AFTER every SDK payload/thinking transform.
      // Reuse these exact bytes at dispatch; no callback can enlarge the output later.
      const body = await request.text();
      const payload = JSON.parse(body) as { max_tokens?: unknown } | null;
      if (!payload || !Number.isSafeInteger(payload.max_tokens) || typeof payload.max_tokens !== "number" || payload.max_tokens < 1 || payload.max_tokens > ceiling) {
        current.controller.abort(unavailable());
        throw unavailable();
      }
      requestSignal.throwIfAborted();
      if (current.attempts >= limits.maxAttemptsPerCall) {
        current.controller.abort(unavailable());
        throw unavailable();
      }
      // No await between admission and dispatch: concurrent retries cannot overspend.
      current.attempts++;
      return fetchImpl(request, { body, redirect: "error", signal: requestSignal });
    }, { preconnect: fetchImpl.preconnect });
    return { model: original, options: { ...options, signal, fetch: gatedFetch,
      maxTokens: Math.min(options.maxTokens ?? ceiling, ceiling),
      // Custom dispatch already owns the SDK concurrency permit. An explicit empty
      // map disables only the inner acquisition (including global SDK defaults).
      maxInFlightRequests: {},
    } };
  }

  registerCustomApi(api, (model, context, options) => {
    const bounded = prepare(model, context, options);
    return streamSimple(bounded.model, context, bounded.options);
  }, source, (model, context, options) => {
    const bounded = prepare(model, context, options);
    return stream(bounded.model, context, bounded.options);
  });

  return {
    resolve(model: Model<Api>): Model<Api> {
      lifetime.throwIfAborted();
      if (model.api !== "anthropic-messages") throw unavailable();
      let alias = aliases.get(model);
      if (!alias) {
        const ceiling = Math.min(model.maxTokens, limits.maxOutputTokens);
        if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw unavailable();
        const original = { ...model, maxTokens: ceiling } as Model<"anthropic-messages">;
        alias = { ...model, api };
        originals.set(alias, original);
        aliases.set(model, alias);
      }
      return alias;
    },
    close(): void {
      controller.abort(unavailable());
      unregisterCustomApis(source);
    },
  };
}
