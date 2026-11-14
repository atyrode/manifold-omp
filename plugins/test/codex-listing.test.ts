import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { bundledProbeModels } from "../atyrode.omp/sdk-metadata.macro.ts" with { type: "macro" };
import {
  inventoryAdmits, LISTED_PROVIDER_ROWS, OMP_VERSION, parseBenchmarkObservation, parseInventoryObservation, PROBE_MODEL_LIMIT, type InventoryModel,
} from "../api/probe.ts";
import { inventoryPermission } from "../atyrode.omp/execution.ts";
import { startPrivateBoundary, type PrivateBoundary } from "../workers/gateway/boundary.ts";
import { inventoryModelOf } from "../workers/gateway/projection.ts";
import { poolModels, publishedModels, resolvePublished } from "../workers/gateway/storage.ts";

/** The account's live Codex listing carries this model; the pinned SDK does not bundle it. */
const LISTED_ONLY = "gpt-6.1-terra";
/** A spark-class id no release ships, so its quota tier can only come from the SDK's classification. */
const SPARK = "gpt-fixture-codex-spark";
/** Bundled by the pinned SDK, but absent from this account's listing. */
const UNLISTED_BUNDLED = "gpt-6-astra";
const account = { accessToken: "fixture-codex-access-token", accountId: "fixture-codex-account" };
const codexPool = { "openai-codex": [{ scope: "scope", credentialId: 3, identityKey: "fixture-identity" }] };

/** One row of the Codex backend's `/codex/models` answer, in the shape the SDK's discovery parses. */
const entry = (slug: string, context_window: number) => ({ slug, display_name: slug, context_window, default_reasoning_level: "medium",
  supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }], input_modalities: ["text", "image"], visibility: "list" });
/** A Codex backend that answers every listing request, and the requests it saw. */
function backend(answer: () => Response = () => Response.json({ models: [entry(LISTED_ONLY, 500_000), entry("gpt-5.6-terra", 272_000), entry(SPARK, 128_000)] })) {
  const requests: Request[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push(new Request(input, init));
    return answer();
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}
const accounts = async (provider: string) => provider === "openai-codex" ? [account] : null;

describe("the gateway publishes the Codex models the account's listing carries", () => {
  test("a Codex model the pinned SDK lacks is published as OMP resolves it, and an unlisted bundled one is not", async () => {
    // The premise: no bundled row, so only the live listing can make it serveable.
    expect(bundledProbeModels()["openai-codex"]!.some(identity => identity.id === LISTED_ONLY)).toBe(false);
    expect(bundledProbeModels()["openai-codex"]!.some(identity => identity.id === UNLISTED_BUNDLED)).toBe(true);
    const { requests, fetchImpl } = backend();
    const { models, unreadable } = await publishedModels(codexPool, AbortSignal.timeout(5_000), fetchImpl, accounts);
    expect(unreadable).toEqual({});
    const published = models.get(`openai-codex/${LISTED_ONLY}`);
    // The SDK's own Codex rules price, size and ladder it, as `omp models --json` reports it locally.
    expect(published).toMatchObject({ provider: "openai-codex", id: LISTED_ONLY, api: "openai-codex-responses",
      cost: { input: 1, output: 5 }, contextWindow: 500_000 });
    expect(inventoryModelOf(published!)).toMatchObject({ thinkingLevels: ["low", "medium", "high", "xhigh", "max"], quotaTier: "chat" });
    expect(inventoryModelOf(models.get(`openai-codex/${SPARK}`)!)?.quotaTier).toBe("spark");
    // The listing is the account's whole catalog: a bundled model it does not carry is not served.
    expect(models.has(`openai-codex/${UNLISTED_BUNDLED}`)).toBe(false);
    expect(resolvePublished(models, `openai-codex/${UNLISTED_BUNDLED}`)).toBeUndefined();
    // One request, to Codex's own listing endpoint, with the pooled account's token and id.
    expect(requests.map(request => [request.method, request.url, request.headers.get("authorization"), request.headers.get("chatgpt-account-id")]))
      .toEqual([["GET", "https://chatgpt.com/backend-api/codex/models?client_version=0.159.0", `Bearer ${account.accessToken}`, account.accountId]]);
    expect(requests[0]!.redirect).toBe("error");
    // The SDK's model cache is in memory only: nothing is written where the worker runs.
    expect(existsSync(":memory:")).toBe(false);
  });

  test("a listing this gateway cannot read leaves the pinned Codex rows in place and says why", async () => {
    const pinned = [...poolModels(codexPool).keys()];
    const limited = backend(() => Response.json({ error: "slow down" }, { status: 429 }));
    const refused = await publishedModels(codexPool, AbortSignal.timeout(10_000), limited.fetchImpl, accounts);
    expect([...refused.models.keys()]).toEqual(pinned);
    expect(refused.unreadable).toEqual({ "openai-codex": "status_429" });
    // The SDK tries its second listing route; each of the three attempts reads both.
    expect(limited.requests.length).toBe(6);
    // No account to read it with is no listing either, and no request is made.
    const none = backend();
    const unaccounted = await publishedModels(codexPool, AbortSignal.timeout(10_000), none.fetchImpl, async () => null);
    expect([...unaccounted.models.keys()]).toEqual(pinned);
    expect(unaccounted.unreadable).toEqual({ "openai-codex": "account_unavailable" });
    expect(none.requests).toEqual([]);
  });

  test("providers other than OpenRouter and Codex are never listed live", async () => {
    const pool = { anthropic: codexPool["openai-codex"], openai: codexPool["openai-codex"], "openai-codex": [] };
    const forbidden = (() => { throw new Error("unexpected listing request"); }) as unknown as typeof fetch;
    const { models, unreadable } = await publishedModels(pool, AbortSignal.timeout(5_000), forbidden,
      () => { throw new Error("unexpected account resolution"); });
    expect([...models.keys()]).toEqual([...poolModels(pool).keys()]);
    expect(unreadable).toEqual({});
  });
});

describe("the boundary serves exactly the published Codex models", () => {
  const BEARER = "service-bearer-for-this-test";
  let boundary: PrivateBoundary | undefined;
  let upstream: { stop: (force?: boolean) => void; url: URL } | undefined;
  afterEach(() => {
    boundary?.close();
    boundary = undefined;
    upstream?.stop(true);
    upstream = undefined;
  });
  /** The boundary over `models`, before an upstream that records each request it is reached with. */
  const serve = (models: ReadonlyMap<string, Model<Api>>, unreadable: Readonly<Record<string, string>> = {}) => {
    const reached: string[] = [];
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      reached.push(path === "/v1/pi/stream" ? (await request.json() as { modelId: string }).modelId : path);
      // The rows the SDK gateway's `/v1/models` writes.
      if (path === "/v1/models") return Response.json({ object: "list", data: [...models.values()].map(model => ({
        id: `${model.provider}/${model.id}`, object: "model", owned_by: model.provider, api: model.api,
        display_name: model.name, input_modalities: model.input, context_length: model.contextWindow,
      })) });
      return Response.json({ message: { role: "assistant", content: [], stopReason: "stop" } });
    } });
    boundary = startPrivateBoundary({ url: upstream.url.origin, bearer: "internal" }, BEARER, models, AbortSignal.timeout(10_000), unreadable);
    const call = (path: string, modelId?: string) => fetch(`http://127.0.0.1:${boundary!.port}${path}`, {
      method: modelId ? "POST" : "GET", headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
      ...(modelId ? { body: JSON.stringify({ modelId, context: { messages: [] } }) } : {}),
    });
    return { reached, call };
  };
  const published = async () => {
    const { models } = await publishedModels({ ...codexPool, anthropic: codexPool["openai-codex"] }, AbortSignal.timeout(5_000), backend().fetchImpl, accounts);
    return models;
  };

  test("a listed Codex model is served, and one the listing lacks is refused by name without substitution", async () => {
    const { reached, call } = serve(await published());
    expect((await call("/v1/pi/stream", `openai-codex/${LISTED_ONLY}`)).status).toBe(200);
    expect(reached).toEqual([`openai-codex/${LISTED_ONLY}`]);
    for (const absent of [`openai-codex/${UNLISTED_BUNDLED}`, "openai-codex/gpt-5.3-codex-spark"])
      expect((await call("/v1/pi/stream", absent)).status).toBe(404);
    expect(reached).toEqual([`openai-codex/${LISTED_ONLY}`]);
  });

  test("an unreadable listing is retryable for its own provider's names only", async () => {
    const { reached, call } = serve(poolModels({ ...codexPool, anthropic: codexPool["openai-codex"] }), { "openai-codex": "status_429" });
    expect((await call("/v1/pi/stream", `openai-codex/${LISTED_ONLY}`)).status).toBe(503);
    // A client's second qualification still names the listing the model would be in.
    expect((await call("/v1/pi/stream", `anthropic/openai-codex/${LISTED_ONLY}`)).status).toBe(503);
    // Anthropic's catalog was never live, so a name it lacks is the caller's 404.
    expect((await call("/v1/pi/stream", "anthropic/claude-sonnet-9-9")).status).toBe(404);
    expect(reached).toEqual([]);
  });

  test("the listing carries the SDK's own facts for each Codex row, and nothing for any other provider", async () => {
    const { call } = serve(await published());
    const listed: { data: { id: string; inventory?: InventoryModel }[] } = await (await call("/v1/models")).json();
    const facts = new Map(listed.data.map(row => [row.id, row.inventory]));
    expect(facts.get(`openai-codex/${LISTED_ONLY}`)).toEqual({ provider: "openai-codex", id: LISTED_ONLY, api: "openai-codex-responses",
      inputCostPerMillion: 1, outputCostPerMillion: 5, contextWindow: 500_000, maxTokens: 128_000, reasoning: true,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"], images: true, quotaTier: "chat" });
    expect(facts.get(`openai-codex/${SPARK}`)?.quotaTier).toBe("spark");
    expect(facts.get("anthropic/claude-sonnet-4-5")).toBeUndefined();
    expect(facts.has("anthropic/claude-sonnet-4-5")).toBe(true);
  });
});

describe("inventory reports a listed provider from the gateway's listing", () => {
  const quotaTierOf = () => null;
  const fact = (id: string, provider = "openai-codex"): InventoryModel => ({ provider, id, api: "openai-codex-responses",
    inputCostPerMillion: 1, outputCostPerMillion: 5, contextWindow: 500_000, maxTokens: 128_000, reasoning: true,
    thinkingLevels: ["max", "low"], images: true, quotaTier: "chat" });
  const listing = (...facts: InventoryModel[]) => ({ object: "list", data: facts.map(model => ({ id: `${model.provider}/${model.id}`, inventory: model })) });
  /** A CLI listing-only row has a name but no gateway metadata; the gateway remains authoritative. */
  const cli = { models: [
    { provider: "openai-codex", id: `openai-codex/${LISTED_ONLY}`, selector: `openai-codex/openai-codex/${LISTED_ONLY}`, contextWindow: 500_000,
      maxTokens: 32_768, reasoning: false, thinking: null, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { provider: "openai-codex", id: "gpt-6-luna", selector: "openai-codex/gpt-6-luna", contextWindow: 872_000,
      maxTokens: 128_000, reasoning: true, thinking: ["low"], input: ["text", "image"], cost: { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 } },
    { provider: "anthropic", id: "claude-sonnet-4-5", selector: "anthropic/claude-sonnet-4-5", contextWindow: 200_000,
      maxTokens: 64_000, reasoning: true, thinking: ["low"], input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } },
  ] };
  const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages" };

  test("a default inventory takes the listed provider's rows from the listing, priced, laddered and classified", () => {
    const receipt = parseInventoryObservation(cli, [sonnet], 1, OMP_VERSION, quotaTierOf,
      { providers: ["openai-codex"], listing: listing(fact(LISTED_ONLY), { ...fact(SPARK), quotaTier: "spark" }) });
    expect(receipt.models.map(model => [`${model.provider}/${model.id}`, model.quotaTier, model.inputCostPerMillion])).toEqual([
      ["anthropic/claude-sonnet-4-5", null, 3],
      [`openai-codex/${LISTED_ONLY}`, "chat", 1],
      [`openai-codex/${SPARK}`, "spark", 1],
    ]);
    // The ladder is ordered as every receipt orders it, and the CLI's own Codex rows are not read:
    // a bundled model the listing lacks is not reported.
    expect(receipt.models.find(model => model.id === LISTED_ONLY)?.thinkingLevels).toEqual(["low", "max"]);
    expect(receipt.models.some(model => model.id === "gpt-6-luna")).toBe(false);
  });

  test("an explicit inventory reports exactly the named listed identities, and the listing must describe its own rows", () => {
    const named = [{ provider: "openai-codex", id: LISTED_ONLY, api: "openai-codex-responses" }];
    const receipt = parseInventoryObservation(cli, named, 1, OMP_VERSION, quotaTierOf,
      { providers: ["openai-codex"], listing: listing(fact(LISTED_ONLY), fact("gpt-5.6-terra")) });
    expect(receipt.models.map(model => model.id)).toEqual([LISTED_ONLY]);
    expect(inventoryAdmits(named, ["openai-codex"], fact("gpt-5.6-terra"))).toBe(false);
    expect(inventoryAdmits([], ["openai-codex"], fact("gpt-5.6-terra"))).toBe(true);
    expect(inventoryAdmits([], ["openai-codex"], fact("claude-sonnet-4-5", "anthropic"))).toBe(false);
    const mislabelled = { data: [{ id: `openai-codex/${LISTED_ONLY}`, inventory: fact("gpt-5.6-terra") }] };
    expect(() => parseInventoryObservation(cli, named, 1, OMP_VERSION, quotaTierOf, { providers: ["openai-codex"], listing: mislabelled }))
      .toThrow("probe_invalid_observation");
  });

  test("a listing too long for the receipt is refused by its bound, and a named model past any cutoff is kept", () => {
    const many = Array.from({ length: 300 }, (_, index) => fact(`gpt-fixture-${String(index).padStart(3, "0")}`));
    // Lexically last, so any truncation of the listing would have dropped it.
    const required = fact("gpt-fixture-299");
    expect(() => parseInventoryObservation(cli, [sonnet], 1, OMP_VERSION, quotaTierOf, { providers: ["openai-codex"], listing: listing(...many) }))
      .toThrow("probe_output_limit");
    const named = parseInventoryObservation(cli, [sonnet, { provider: required.provider, id: required.id, api: required.api }], 1, OMP_VERSION,
      quotaTierOf, { providers: ["openai-codex"], listing: listing(...many) });
    expect(named.models.map(model => `${model.provider}/${model.id}`)).toEqual(["anthropic/claude-sonnet-4-5", "openai-codex/gpt-fixture-299"]);
  });

  test("a default inventory leaves each listed provider its room in the receipt", () => {
    const slot = [{ scope: "scope", credentialId: 1, identityKey: null }];
    // OpenRouter alone bundles more chat rows than a receipt holds.
    const pool = { openrouter: slot, anthropic: slot, "openai-codex": slot };
    const { identities, listedProviders } = inventoryPermission(bundledProbeModels(), pool, undefined);
    expect(listedProviders).toEqual(["openai-codex"]);
    expect(identities).toHaveLength(PROBE_MODEL_LIMIT - LISTED_PROVIDER_ROWS);
    expect(identities.some(identity => identity.provider === "openai-codex")).toBe(false);
    expect(identities.some(identity => identity.provider === "anthropic")).toBe(true);
  });

  test("a benchmark of a listed model measures the gateway's row the CLI names by its listing id", () => {
    const candidate = { provider: "openai-codex", id: LISTED_ONLY, api: "openai-codex-responses", key: "terra" };
    const input = { schemaVersion: 1, inventoryObservedAt: 1, ompVersion: OMP_VERSION, candidates: [candidate] };
    const stats = { mean: 5, min: 5, p50: 5, p95: 5, max: 5 };
    const report = (model: string) => ({ runs: 1, maxTokens: 4, profile: "chat", failures: 0, models: [{
      selector: `openai-codex/${LISTED_ONLY}`, model,
      results: [{ ok: true, ttftMs: 5, generationTps: 5, tokensPerSecond: 5, challenge: "chat" }],
      stats: { ttftMs: stats, generationTps: stats, tokensPerSecond: stats },
    }] });
    expect(parseBenchmarkObservation(report(`openai-codex/openai-codex/${LISTED_ONLY}`), input, 2, 3).results[0]!.status).toBe("reachable");
    expect(parseBenchmarkObservation(report(`openai-codex/${LISTED_ONLY}`), input, 2, 3).results[0]!.status).toBe("reachable");
    // Another model answering the selector is still not this candidate.
    expect(parseBenchmarkObservation(report("openai-codex/openai-codex/gpt-5.6-terra"), input, 2, 3).results[0]!.status).toBe("unmatched");
  });
});
