import { expect, test } from "bun:test";
import {
  PROBE_MODEL_LIMIT,
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
