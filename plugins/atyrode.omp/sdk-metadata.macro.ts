import type { ThinkingConfig } from "@oh-my-pi/pi-catalog";
import { getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { ProbeIdentitySchema, type ProbeIdentity } from "../api/probe.ts";
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
