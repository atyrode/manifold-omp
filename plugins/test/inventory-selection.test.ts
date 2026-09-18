import { expect, test } from "bun:test";
import {
  OMP_VERSION,
  PROBE_MODEL_LIMIT,
  parseBenchmarkInput,
  parseBenchmarkObservation,
  ProbeIdentitiesSchema,
  type ProbeIdentity,
  type RuntimeAccountPool,
} from "../api/index.ts";
import { defaultInventoryIdentities } from "../atyrode.omp/execution.ts";
import { bundledProbeModels } from "../atyrode.omp/sdk-metadata.macro.ts" with { type: "macro" };

function models(provider: string, count: number): ProbeIdentity[] {
  return Array.from({ length: count }, (_, index) => ({
    provider,
    id: `${provider}-${index}`,
    api: "fixture",
  }));
}

const slot = (credentialId: number) => [
  { scope: "fixture-room", credentialId, identityKey: null },
];

test("default inventory remains representative when one provider exceeds the receipt limit", () => {
  const catalog = {
    aggregator: models("aggregator", PROBE_MODEL_LIMIT * 2),
    "direct-a": models("direct-a", 2),
    "direct-b": models("direct-b", 1),
  };
  const firstPool: RuntimeAccountPool = {
    aggregator: slot(1),
    "direct-b": slot(2),
    "direct-a": slot(3),
  };
  const reorderedPool: RuntimeAccountPool = {
    "direct-a": slot(3),
    aggregator: slot(1),
    "direct-b": slot(2),
  };

  const selected = defaultInventoryIdentities(catalog, firstPool);

  expect(selected).toHaveLength(PROBE_MODEL_LIMIT);
  expect(selected.slice(0, 3).map(({ provider }) => provider)).toEqual([
    "direct-b",
    "direct-a",
    "direct-a",
  ]);
  expect(defaultInventoryIdentities(catalog, reorderedPool)).toEqual(selected);
});

test("bundled inventory defaults satisfy the public identity contract", () => {
  const catalog = bundledProbeModels();
  const pool: RuntimeAccountPool = Object.fromEntries(
    ["openai-codex", "deepseek", "openrouter", "anthropic"].map(
      (provider, index) => [provider, slot(index + 1)],
    ),
  );

  const selected = defaultInventoryIdentities(catalog, pool);

  expect(selected).toHaveLength(PROBE_MODEL_LIMIT);
  expect(ProbeIdentitiesSchema.safeParse(selected).success).toBe(true);
});

/**
 * The rule under test is agreement with the RUN path: `atyrode.omp/execution.ts` strips a
 * trailing `:suffix` only when it parses as a thinking level, so an id whose suffix is not a
 * level resolves as written and is benchmarkable. A blanket colon rejection here disagreed with
 * that and silently barred every variant-addressed model from any derived catalog.
 */
const candidate = (id: string) => ({
  schemaVersion: 1 as const,
  inventoryObservedAt: 1_700_000_000_000,
  ompVersion: OMP_VERSION,
  candidates: [{ provider: "openrouter", id, api: "chat", key: `openrouter.${id.replace(/[^A-Za-z0-9._-]/g, "_")}` }],
});

test("a variant suffix is benchmarkable and a thinking suffix is not", () => {
  expect(parseBenchmarkInput(candidate("deepseek/deepseek-v4:free")).candidates[0]!.id).toBe("deepseek/deepseek-v4:free");
  expect(parseBenchmarkInput(candidate("vendor/model:nitro")).candidates[0]!.id).toBe("vendor/model:nitro");

  // `high` IS a level, so this selector names a model and a level at once: still refused.
  expect(() => parseBenchmarkInput(candidate("anthropic/claude-sonnet-4-5:high"))).toThrow("invalid_input");
  expect(() => parseBenchmarkInput(candidate("vendor/model:minimal"))).toThrow("invalid_input");
});

/**
 * A candidate the provider will not serve THIS account is a settled answer, and reporting it as
 * inconclusive costs every model measured beside it: one `unresolved` row makes a catalog
 * derivation refuse `inconclusive_probe` for the whole set.
 */
function reportFor(id: string, error: string) {
  const input = parseBenchmarkInput(candidate(id));
  const selector = `openrouter/${id}`;
  return {
    raw: { runs: 1, maxTokens: 4, profile: "chat", failures: 1,
      models: [{ selector, model: selector, results: [{ ok: false, challenge: "chat", error }], stats: null }] },
    input,
  };
}

test("an endpoint excluded by the account's data policy is settled, not inconclusive", () => {
  // The provider's own sentence, which carries no `not_found` token and so used to land in
  // `unresolved`. Observed live on a free tier where two of four endpoints served.
  const excluded = reportFor("minimax/minimax-m3:free",
    "404 0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons: Free model training violation");
  expect(parseBenchmarkObservation(excluded.raw, excluded.input, 1_700_000_000_001, 1_700_000_000_002).results[0]!.status).toBe("client_blocked");

  // A genuinely unexplained failure stays inconclusive: this widens no other case.
  const puzzling = reportFor("vendor/model:free", "socket hang up");
  expect(parseBenchmarkObservation(puzzling.raw, puzzling.input, 1_700_000_000_001, 1_700_000_000_002).results[0]!.status).toBe("unresolved");

  // And the upstream's words reach no receipt, on either path.
  for (const built of [excluded, puzzling]) {
    const receipt = parseBenchmarkObservation(built.raw, built.input, 1_700_000_000_001, 1_700_000_000_002);
    expect(JSON.stringify(receipt)).not.toContain("guardrail");
    expect(JSON.stringify(receipt)).not.toContain("socket hang up");
  }
});
