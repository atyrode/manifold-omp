import { getBundledModels } from "@oh-my-pi/pi-catalog/models";

/**
 * The bundled model a live-listed OpenRouter model is built from.
 *
 * The listing states only identity, size and price. The dialect, and the thinking ladder a
 * reasoning model gets, belong to the provider, so the gateway that serves a live-listed model
 * and the session that selects it both take them from this one pinned row.
 *
 * The row is named, not taken by position: since SDK 18.14 the bundled catalog lists a
 * provider's rows in id order, which made a model without a thinking ladder the first OpenRouter
 * row. This is the row 18.13.1 listed first.
 */
export const OPENROUTER_LISTING_TEMPLATE = getBundledModels("openrouter").find((model) =>
  model.api === "openrouter" && model.id === "~anthropic/claude-fable-latest");
