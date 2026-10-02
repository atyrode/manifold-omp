import { createHash } from "node:crypto";
import { canonicalJobJson, ISOLATE_MAX_FRAME_BYTES } from "@manifold/protocol";
import type { Model, ThinkingConfig } from "@oh-my-pi/pi-catalog";
import { quotaTierFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import {
  ModelCatalogModelSchema, ModelCatalogSnapshotSchema, OMP_VERSION, ProbeIdentitySchema, ThinkingLevelSchema,
  type ModelCatalogModel, type ModelCatalogSnapshot, type ProbeIdentity,
} from "../api/index.ts";
import { OPENROUTER_LISTING_TEMPLATE } from "../workers/gateway/template.ts";

/** Bun evaluates this against the package-pinned SDK in development and production.
 * Only schema-valid probe triples cross into the server; the SDK also carries
 * routing aliases that cannot cross the public action and receipt boundary.
 * Keep every provider, even empty registries, so disabledProviders has the same
 * scope as the machine gateway.
 */
export function bundledProbeModels(): Record<string, ProbeIdentity[]> {
  return Object.fromEntries(getBundledProviders().map(provider => [provider,
    getBundledModels(provider)
      .map(({ provider, id, api }) => ({ provider, id, api }))
      .filter(identity => ProbeIdentitySchema.safeParse(identity).success),
  ]));
}

/** Build-time projection only. Unsupported SDK aliases and unknown/sentinel prices cannot
 * become public inventory facts. In particular, missing thinking metadata is not a ladder. */
export function projectModelCatalog(
  source: readonly Model[],
  ompVersion: string,
): ModelCatalogSnapshot {
  const byAddress = new Map<string, ModelCatalogModel | null>();
  for (const model of source) {
    const projected = ModelCatalogModelSchema.safeParse({
      provider: model.provider, id: model.id, api: model.api,
      inputCostPerMillion: model.cost.input, outputCostPerMillion: model.cost.output,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning,
      thinkingLevels: [...getSupportedEfforts(model)].sort(
        (a, b) => ThinkingLevelSchema.options.indexOf(a) - ThinkingLevelSchema.options.indexOf(b),
      ),
      images: model.input.includes("image"),
      quotaTier: quotaTierFor(model.provider, model.id) ?? null,
    });
    if (!projected.success) continue;
    const value = projected.data;
    const address = `${value.provider}/${value.id}`.toLowerCase();
    if (new Set(value.thinkingLevels).size !== value.thinkingLevels.length)
      throw new Error(`Duplicate bundled thinking levels: ${value.provider}/${value.id}`);
    // OMP resolution folds case. Every member of an ambiguous group is ineligible;
    // keeping the first or last would silently choose an SDK routing alias.
    byAddress.set(address, byAddress.has(address) ? null : value);
  }
  const models: ModelCatalogModel[] = [];
  for (const model of byAddress.values()) if (model !== null) models.push(model);
  models.sort((a, b) => {
    const left = `${a.provider}/${a.id}`;
    const right = `${b.provider}/${b.id}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const snapshot = { schemaVersion: 1 as const, source: "bundled" as const, ompVersion, models };
  const revision = createHash("sha256").update(canonicalJobJson(snapshot)).digest("hex");
  const catalog = ModelCatalogSnapshotSchema.parse({ ...snapshot, revision });
  // Leave transport-envelope headroom even when every provider is requested. Never truncate.
  if (Buffer.byteLength(JSON.stringify(catalog)) > ISOLATE_MAX_FRAME_BYTES / 2)
    throw new Error("Bundled model catalog exceeds the passive metadata byte budget");
  return catalog;
}

/** The package-pinned static registry becomes literal data in the server bundle.
 * No SDK import, cache, credential, file or network read survives into the action. */
export function bundledModelCatalog(): ModelCatalogSnapshot {
  return projectModelCatalog(getBundledProviders().flatMap(provider => getBundledModels(provider)), OMP_VERSION);
}

/** The thinking ladder the gateway gives a live-listed model that reasons, per provider whose
 * catalog it lists live. Same pinned row as the gateway's, never a second choice of template. */
export function liveListingThinking(): Readonly<Record<string, ThinkingConfig | undefined>> {
  return { openrouter: OPENROUTER_LISTING_TEMPLATE?.thinking };
}

/** Broker upload and AuthStorage API-key selection accept provider IDs generically.
 * Registry membership does not prove the upstream accepts a given key.
 */
export function bundledCredentialProviders(): string[] {
  return getBundledProviders();
}
