import { getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { ProbeIdentitySchema, type ProbeIdentity } from "../api/probe.ts";

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

/** Broker upload and AuthStorage API-key selection accept provider IDs generically.
 * Registry membership does not prove the upstream accepts a given key.
 */
export function bundledCredentialProviders(): string[] {
  return getBundledProviders();
}
