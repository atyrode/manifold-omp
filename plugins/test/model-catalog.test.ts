import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJobJson } from "@manifold/protocol";
import type { Model } from "@oh-my-pi/pi-catalog";
import { THINKING_EFFORTS, type Effort } from "@oh-my-pi/pi-catalog/effort";
import { quotaTierFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
  createOmpClient, MODEL_CATALOG_MODEL_LIMIT, MODEL_CATALOG_PROVIDER_LIMIT,
  ModelCatalogSnapshotSchema, OMP_VERSION, type ModelCatalogSnapshot,
} from "../api/index.ts";
import type { OmpContext } from "../atyrode.omp/machine-server.ts";
import { handlers } from "../atyrode.omp/server.ts";
import { projectModelCatalog } from "../atyrode.omp/sdk-metadata.macro.ts";
import { bundledModelCatalog } from "../atyrode.omp/sdk-metadata.macro.ts" with { type: "macro" };

const bundled = bundledModelCatalog();
const effort: Record<"low" | "medium" | "high", Effort> = {
  low: THINKING_EFFORTS.find(value => value === "low")!,
  medium: THINKING_EFFORTS.find(value => value === "medium")!,
  high: THINKING_EFFORTS.find(value => value === "high")!,
};
const passiveContext = new Proxy({} as OmpContext, {
  get(_target, name) { throw new Error(`Passive metadata attempted context access: ${String(name)}`); },
});
const client = createOmpClient(async (_door, input) => handlers.readModelCatalog!(passiveContext, input));

function fixture(overrides: Partial<Model> = {}): Model {
  return {
    ...getBundledModels("anthropic")[0]!,
    provider: "fixture", id: "reasoner", api: "anthropic-messages",
    cost: { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5 },
    contextWindow: 200_000, maxTokens: 8192, reasoning: true, input: ["text", "image"],
    thinking: { mode: "effort", efforts: [effort.high, effort.low] },
    ...overrides,
  };
}

async function catalog(providers: string[]): Promise<ModelCatalogSnapshot> {
  const result = await client.call("readModelCatalog", { providers });
  if ("refused" in result) throw new Error(result.refused);
  return result;
}

test("projection preserves inventory facts without inferring a thinking ladder or unknown limits", () => {
  const uncontrolled = fixture({ id: "uncontrolled", contextWindow: null, maxTokens: null });
  const plain = fixture({ id: "plain", reasoning: false, input: ["text"] });
  delete uncontrolled.thinking;
  delete plain.thinking;
  const result = projectModelCatalog([fixture(), uncontrolled, plain], OMP_VERSION);
  expect(result.models).toEqual([
    { provider: "fixture", id: "plain", api: "anthropic-messages", inputCostPerMillion: 1.25,
      outputCostPerMillion: 5, contextWindow: 200_000, maxTokens: 8192, reasoning: false,
      thinkingLevels: [], images: false, quotaTier: null },
    { provider: "fixture", id: "reasoner", api: "anthropic-messages", inputCostPerMillion: 1.25,
      outputCostPerMillion: 5, contextWindow: 200_000, maxTokens: 8192, reasoning: true,
      thinkingLevels: ["low", "high"], images: true, quotaTier: null },
    { provider: "fixture", id: "uncontrolled", api: "anthropic-messages", inputCostPerMillion: 1.25,
      outputCostPerMillion: 5, contextWindow: null, maxTokens: null, reasoning: true,
      thinkingLevels: [], images: true, quotaTier: null },
  ]);
});

test("unrepresentable aliases and sentinel prices are omitted rather than relabeled or made free", () => {
  const result = projectModelCatalog([
    fixture({ id: "alias*" }),
    fixture({ id: "unknown-price", cost: { input: -1, output: -1, cacheRead: -1, cacheWrite: -1 } }),
    fixture({ id: "unknown-limit", maxTokens: 0 }),
    fixture({ id: "free", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ], OMP_VERSION);
  expect(result.models.map(model => model.id)).toEqual(["free"]);
  expect(result.models[0]!.inputCostPerMillion).toBe(0);
});

test("quota tiers preserve SDK special-lane membership without classifying another provider by its model name", () => {
  const result = projectModelCatalog([
    fixture({ provider: "openai-codex", id: "gpt-5.3-codex-spark" }),
    fixture({ provider: "openai-codex", id: "gpt-5.3-codex" }),
    fixture({ provider: "other-provider", id: "gpt-5.3-codex-spark" }),
  ], OMP_VERSION);
  expect(result.models.map(({ provider, id, quotaTier }) => ({ provider, id, quotaTier }))).toEqual([
    { provider: "openai-codex", id: "gpt-5.3-codex", quotaTier: "chat" },
    { provider: "openai-codex", id: "gpt-5.3-codex-spark", quotaTier: "spark" },
    { provider: "other-provider", id: "gpt-5.3-codex-spark", quotaTier: null },
  ]);
  const { revision, ...snapshot } = result;
  expect(revision).toBe(createHash("sha256").update(canonicalJobJson(snapshot)).digest("hex"));
  const erasedSpecialLane = {
    ...snapshot,
    models: snapshot.models.map(model => ({ ...model, quotaTier: model.quotaTier === "spark" ? "chat" : model.quotaTier })),
  };
  expect(createHash("sha256").update(canonicalJobJson(erasedSpecialLane)).digest("hex")).not.toBe(revision);
});

test("ambiguous address groups are omitted completely, never resolved by source order or API", () => {
  const source = [
    fixture(), fixture({ id: "REASONER" }), fixture({ api: "openai-responses" }),
    fixture({ id: "unambiguous" }),
  ];
  const result = projectModelCatalog(source, OMP_VERSION);
  expect(result.models.map(({ provider, id }) => ({ provider, id })))
    .toEqual([{ provider: "fixture", id: "unambiguous" }]);
  expect(projectModelCatalog([...source].reverse(), OMP_VERSION)).toEqual(result);
});

test("duplicate thinking levels refuse packaging instead of inventing a supported ladder", () => {
  expect(() => projectModelCatalog([fixture({ thinking: { mode: "effort", efforts: [effort.low, effort.low] } })], OMP_VERSION))
    .toThrow("Duplicate bundled thinking levels: fixture/reasoner");
});

test("revision canonically binds projected content and OMP version, not source enumeration order", () => {
  const first = fixture();
  const second = fixture({ id: "another" });
  const original = projectModelCatalog([first, second], OMP_VERSION);
  expect(projectModelCatalog([second, first], OMP_VERSION)).toEqual(original);
  const { revision, ...snapshot } = original;
  expect(revision).toBe(createHash("sha256").update(canonicalJobJson(snapshot)).digest("hex"));
  expect(projectModelCatalog([first, second], "different-version").revision).not.toBe(revision);
  const changes: Partial<Model>[] = [
    { provider: "other" }, { id: "other" }, { api: "openai-responses" },
    { cost: { ...first.cost, input: 2 } }, { cost: { ...first.cost, output: 6 } },
    { contextWindow: null }, { maxTokens: null }, { reasoning: false },
    { thinking: { mode: "effort", efforts: [effort.low, effort.medium, effort.high] } }, { input: ["text"] },
  ];
  for (const change of changes)
    expect(projectModelCatalog([{ ...first, ...change }, second], OMP_VERSION).revision).not.toBe(revision);
});

test("typed root metadata reads are passive and return the actual pinned SDK facts", async () => {
  const result = await catalog(["anthropic", "openai-codex", "deepseek"]);
  const source = getBundledModels("anthropic").find(model => result.models.some(row => row.provider === model.provider && row.id === model.id));
  if (!source) throw new Error("Pinned Anthropic metadata is absent from the passive catalog");
  const row = result.models.find(model => model.provider === source.provider && model.id === source.id)!;
  expect(row).toMatchObject({ api: source.api, inputCostPerMillion: source.cost.input,
    outputCostPerMillion: source.cost.output, contextWindow: source.contextWindow,
    maxTokens: source.maxTokens, reasoning: source.reasoning, images: source.input.includes("image"),
    quotaTier: quotaTierFor(source.provider, source.id) ?? null });
  expect(new Set(result.models.map(model => model.provider))).toEqual(new Set(["anthropic", "openai-codex", "deepseek"]));
  expect(result.ompVersion).toBe(OMP_VERSION);
  expect(result.source).toBe("bundled");
  expect(result.revision).toBe(bundled.revision);
  const { revision, ...snapshot } = bundled;
  expect(revision).toBe(createHash("sha256").update(canonicalJobJson(snapshot)).digest("hex"));
  expect(ModelCatalogSnapshotSchema.safeParse({ ...result, observedAt: 1 }).success).toBe(false);
  expect(ModelCatalogSnapshotSchema.safeParse({ ...result, schemaVersion: 2 }).success).toBe(false);
  expect(ModelCatalogSnapshotSchema.safeParse({ ...result, source: "inventory" }).success).toBe(false);
  expect(ModelCatalogSnapshotSchema.safeParse({ ...result, models: [{ ...row, tokensPerSecond: 100 }] }).success).toBe(false);

  // A caller mutating its decoded reply cannot corrupt later reads or the bundle revision.
  row.inputCostPerMillion = 999;
  row.thinkingLevels.push("max");
  const reread = await catalog(["anthropic"]);
  expect(reread.models.find(model => model.id === source.id)).toEqual(
    bundled.models.find(model => model.provider === source.provider && model.id === source.id),
  );
});

test("provider selection is exact, order-independent and never aliases an unsupported provider", async () => {
  const selected = await catalog(["deepseek", "anthropic", "deepseek"]);
  expect(selected).toEqual(await catalog(["anthropic", "deepseek"]));
  expect(selected.models.map(model => `${model.provider}/${model.id}`)).toEqual(
    selected.models.map(model => `${model.provider}/${model.id}`).sort(),
  );
  for (const providers of [[], ["unsupported-provider"], ["Anthropic"], ["toString"]]) {
    const empty = await catalog(providers);
    expect(empty.models).toEqual([]);
    expect(empty.revision).toBe(selected.revision);
  }
  expect(await catalog(["anthropic", "unsupported-provider", "toString"]))
    .toEqual(await catalog(["anthropic"]));
  for (const provider of ["constructor", "prototype", "__proto__"])
    expect(await handlers.readModelCatalog!(passiveContext, { providers: [provider] })).toHaveProperty("refused");
});

test("oversized requests and bundles refuse rather than silently truncate", async () => {
  expect(await catalog(Array.from({ length: MODEL_CATALOG_PROVIDER_LIMIT }, () => "anthropic")))
    .toEqual(await catalog(["anthropic"]));
  expect(await handlers.readModelCatalog!(passiveContext, {
    providers: Array.from({ length: MODEL_CATALOG_PROVIDER_LIMIT + 1 }, () => "anthropic"),
  })).toHaveProperty("refused");
  expect(await handlers.readModelCatalog!(passiveContext, {})).toHaveProperty("refused");
  expect(await handlers.readModelCatalog!(passiveContext, { providers: ["anthropic"], machineId: "unused" }))
    .toHaveProperty("refused");
  const model = fixture();
  expect(() => projectModelCatalog(Array.from({ length: MODEL_CATALOG_MODEL_LIMIT + 1 }, (_, index) =>
    ({ ...model, id: `model-${index}` })), OMP_VERSION)).toThrow();
  expect(() => projectModelCatalog(Array.from({ length: 8192 }, (_, index) =>
    ({ ...model, id: `${index}-${"x".repeat(490)}` })), OMP_VERSION))
    .toThrow("Bundled model catalog exceeds the passive metadata byte budget");
});
