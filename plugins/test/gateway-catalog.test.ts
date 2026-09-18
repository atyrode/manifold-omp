import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { poolModels, publishedModels, resolvePublished } from "../workers/gateway/storage.ts";
import { ABSENT_MODEL_ID, UNLISTED_MODEL_ID, UNLISTED_PUBLISHED_ID } from "./fixtures/models.ts";

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
    const models = await publishedModels(pool, AbortSignal.timeout(5_000), listing([{ id: UNLISTED_MODEL_ID }]));
    const published = models.get(UNLISTED_PUBLISHED_ID);
    expect(published?.id).toBe(UNLISTED_MODEL_ID);
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

  test("a transient refusal does not unpublish a model the credential serves", async () => {
    // One 429 used to cost that session its model: it got a named 404 while the next session
    // ran fine. The attempts are what make the catalog's absence mean absent, not unlucky.
    let calls = 0;
    const flaky = (() => {
      calls += 1;
      if (calls < 3) return Promise.resolve(Response.json({ error: "slow down" }, { status: 429 }));
      return Promise.resolve(Response.json({ data: [{ id: UNLISTED_MODEL_ID, pricing: { prompt: "0", completion: "0" }, context_length: 262_144 }] }));
    }) as unknown as typeof fetch;
    const models = await publishedModels(pool, AbortSignal.timeout(10_000), flaky);
    expect(calls).toBe(3);
    expect(models.get(UNLISTED_PUBLISHED_ID)?.id).toBe(UNLISTED_MODEL_ID);
  });
});

describe("a client's qualified name still resolves", () => {
  const models = new Map<string, Model<Api>>([
    [UNLISTED_PUBLISHED_ID, { id: UNLISTED_MODEL_ID, provider: "openrouter" } as Model<Api>],
    ["openai-codex/gpt-5.5", { id: "gpt-5.5", provider: "openai-codex" } as Model<Api>],
  ]);

  test("the published id resolves", () => {
    expect(resolvePublished(models, UNLISTED_PUBLISHED_ID)?.id).toBe(UNLISTED_MODEL_ID);
  });

  test("the id qualified twice resolves, because the gateway handed out that name", () => {
    expect(resolvePublished(models, `openrouter/${UNLISTED_PUBLISHED_ID}`)?.id).toBe(UNLISTED_MODEL_ID);
  });

  test("a pool provider's qualifier resolves the model it names, not the qualifier's", () => {
    // A session qualifies the configured id with the first account in its pool, which is not
    // the model's provider. The remainder carries the provider, so the model that comes back is
    // still served with its own credential.
    const resolved = resolvePublished(models, `openai-codex/${UNLISTED_PUBLISHED_ID}`);
    expect(resolved?.id).toBe(UNLISTED_MODEL_ID);
    expect(resolved?.provider).toBe("openrouter");
  });

  test("an unpublished model is refused, and no prefix reaches another provider's model", () => {
    expect(resolvePublished(models, `openrouter/${ABSENT_MODEL_ID}`)).toBeUndefined();
    expect(resolvePublished(models, UNLISTED_MODEL_ID)).toBeUndefined();
    // `gpt-5.5` is published under openai-codex; a qualifier cannot serve it as openrouter's.
    expect(resolvePublished(models, "openrouter/gpt-5.5")).toBeUndefined();
    expect(resolvePublished(models, "openrouter/openai-codex/gpt-5.5")?.provider).toBe("openai-codex");
  });
});
