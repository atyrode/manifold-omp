import { getBundledModels } from "@oh-my-pi/pi-catalog/models";

/**
 * The bundled model a live-listed OpenRouter model is built from.
 *
 * The listing states only identity, size and price. The dialect, and the thinking ladder a
 * reasoning model gets, belong to the provider, so the gateway that serves a live-listed model
 * and the session that selects it both take them from this one pinned row.
 */
export const OPENROUTER_LISTING_TEMPLATE = getBundledModels("openrouter").find((model) => model.api === "openrouter");
