import type { Model } from "@oh-my-pi/pi-catalog";
import { quotaTierFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { ThinkingLevelSchema } from "../../api/contracts.ts";
import { InventoryModelSchema, type InventoryModel } from "../../api/probe.ts";

/**
 * One SDK model as public inventory metadata, or null when it is not a chat model or does not fit
 * `InventoryModelSchema`.
 *
 * The build-time catalog projection and the gateway's listing both use this, so a model the
 * gateway learns from a provider's listing at runtime is described exactly as a bundled one is:
 * the same base prices, limits, effort ladder and `quotaTierFor` classification. Unknown or
 * sentinel prices and invalid limits fail the schema and are omitted, never relabeled.
 */
export function inventoryModelOf(model: Model): InventoryModel | null {
  // Inventory describes what a session can run, which is chat models only.
  if (modelKind(model) !== "chat") return null;
  const projected = InventoryModelSchema.safeParse({
    provider: model.provider, id: model.id, api: model.api,
    inputCostPerMillion: model.cost.input, outputCostPerMillion: model.cost.output,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning,
    thinkingLevels: [...getSupportedEfforts(model)].sort(
      (a, b) => ThinkingLevelSchema.options.indexOf(a) - ThinkingLevelSchema.options.indexOf(b),
    ),
    images: model.input.includes("image"),
    quotaTier: quotaTierFor(model.provider, model.id) ?? null,
  });
  return projected.success ? projected.data : null;
}
