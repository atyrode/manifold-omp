import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { poolModels, publishedModels, resolvePublished } from "../workers/gateway/storage.ts";

const pool = { openrouter: [{ scope: "scope", credentialId: 1, identityKey: null }] };

const listing = (models: { id: string; context_length?: number; supported_parameters?: string[] }[]) =>
  ((_input: unknown, _init?: unknown) =>
    Promise.resolve(
      Response.json({
        data: models.map((model) => ({
          pricing: { prompt: "0", completion: "0" },
          context_length: 262_144,
          ...model,
        })),
      }),
    )) as unknown as typeof fetch;

describe("the gateway publishes what its provider serves", () => {
  test("a model the pinned SDK never carried is published from the provider's listing", async () => {
    const models = await publishedModels(pool, AbortSignal.timeout(5_000), listing([{ id: "stealth/union-alpha" }]));
    const published = models.get("openrouter/stealth/union-alpha");
    expect(published?.id).toBe("stealth/union-alpha");
    expect(published?.provider).toBe("openrouter");
    // A model that accepts no reasoning parameter carries no thinking config: a level on a
    // model that has none is what made a configured id resolve to something else.
    expect(published?.thinking ?? null).toBeNull();
    expect(models.size).toBeGreaterThan(poolModels(pool).size);
  });

  test("a listing this gateway cannot read leaves the pinned catalog in place", async () => {
    const failing = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const models = await publishedModels(pool, AbortSignal.timeout(5_000), failing);
    expect(models.size).toBe(poolModels(pool).size);
    expect(models.size).toBeGreaterThan(0);
  });

  test("a bundled model is never replaced by its listed row", async () => {
    const [firstKey, bundled] = [...poolModels(pool).entries()][0] as [string, Model<Api>];
    const models = await publishedModels(
      pool,
      AbortSignal.timeout(5_000),
      listing([{ id: bundled.id, context_length: 7 }]),
    );
    expect(models.get(firstKey)?.contextWindow).toBe(bundled.contextWindow);
  });
});

describe("a client's round trip through the listing still resolves", () => {
  const models = new Map<string, Model<Api>>([["openrouter/stealth/union-alpha", { id: "stealth/union-alpha" } as Model<Api>]]);

  test("the published id resolves", () => {
    expect(resolvePublished(models, "openrouter/stealth/union-alpha")?.id).toBe("stealth/union-alpha");
  });

  test("the id qualified twice resolves, because the gateway handed out that name", () => {
    // The listing advertises `provider/id` as the row id and reports the provider separately,
    // so a client that discovers models through it asks for the provider twice. Refusing that
    // blamed the caller for a name this gateway produced.
    expect(resolvePublished(models, "openrouter/openrouter/stealth/union-alpha")?.id).toBe("stealth/union-alpha");
  });

  test("an unpublished model is still refused, and a different provider is never borrowed", () => {
    expect(resolvePublished(models, "openrouter/stealth/not-a-model")).toBeUndefined();
    expect(resolvePublished(models, "anthropic/openrouter/stealth/union-alpha")).toBeUndefined();
    expect(resolvePublished(models, "stealth/union-alpha")).toBeUndefined();
  });
});
