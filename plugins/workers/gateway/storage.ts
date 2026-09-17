import { z } from "zod";
import { AuthBrokerClient, type AuthBrokerClientOptions, type FetchSnapshotOptions, type FetchSnapshotResult } from "@oh-my-pi/pi-ai/auth-broker/client";
import { RemoteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-broker/remote-store";
import type { SnapshotResponse, SnapshotStreamEvent } from "@oh-my-pi/pi-ai/auth-broker/types";
import { AuthStorage, type AuthCredentialSnapshotEntry } from "@oh-my-pi/pi-ai/auth-storage";
import { getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import type { RuntimeAccountPool } from "../../api/contracts.ts";
import { unavailable } from "./inputs.ts";

/** The SDK's identity-only pool leaves API keys and missing providers unrestricted.
 * Enforce the native launch's concrete provider/id/identity tuples at every ingress
 * instead. A null identity admits only that selected API-key slot, never a wildcard. */
export class PoolBrokerClient extends AuthBrokerClient {
  readonly #slots = new Map<number, { readonly provider: string; readonly identityKey: string | null }>();
  #activeIds = new Set<number>();
  #revocation = 0;
  constructor(options: AuthBrokerClientOptions, pool: RuntimeAccountPool) {
    super(options);
    for (const [provider, slots] of Object.entries(pool)) {
      for (const slot of slots) {
        if (this.#slots.has(slot.credentialId)) throw unavailable();
        this.#slots.set(slot.credentialId, { provider, identityKey: slot.identityKey });
      }
    }
  }
  get revocation(): number { return this.#revocation; }
  admits(entry: AuthCredentialSnapshotEntry): boolean {
    const slot = this.#slots.get(entry.id);
    return slot !== undefined && slot.provider === entry.provider && slot.identityKey === entry.identityKey &&
      (entry.credential.type === "api_key" ? entry.identityKey === null : entry.identityKey !== null);
  }
  /** Only the remote store's accepted canonical snapshot may change revocation. */
  acceptSnapshot(snapshot: SnapshotResponse): void {
    const activeIds = new Set(snapshot.credentials.map(entry => entry.id));
    for (const id of this.#activeIds) if (!activeIds.has(id)) this.#revocation++;
    this.#activeIds = activeIds;
  }
  override async fetchSnapshot(options: FetchSnapshotOptions = {}): Promise<FetchSnapshotResult> {
    const result = await super.fetchSnapshot(options);
    if (result.status === 304) return result;
    return { ...result, snapshot: { ...result.snapshot, credentials: result.snapshot.credentials.filter(entry => this.admits(entry)) } };
  }
  override async *openSnapshotStream(options: { signal?: AbortSignal } = {}): AsyncGenerator<SnapshotStreamEvent> {
    for await (const event of super.openSnapshotStream(options)) {
      if (event.kind === "snapshot") {
        yield { ...event, credentials: event.credentials.filter(entry => this.admits(entry)) };
      } else if (event.kind === "entry") {
        if (this.admits(event.entry)) {
          yield event;
        } else {
          yield { kind: "removed", id: event.entry.id, generation: event.generation, serverNowMs: event.serverNowMs, refresher: event.refresher };
        }
      } else {
        yield event;
      }
    }
  }
  override async refreshCredential(id: number, signal?: AbortSignal) {
    if (!this.#activeIds.has(id) || this.#slots.get(id)?.identityKey === null) throw unavailable();
    const result = await super.refreshCredential(id, signal);
    if (!this.#activeIds.has(id) || result.entry.id !== id || !this.admits(result.entry)) {
      throw unavailable();
    }
    return result;
  }
}

class PoolRemoteStore extends RemoteAuthCredentialStore {
  get revocation(): number { return (this.client as PoolBrokerClient).revocation; }
}

/** Reload the SDK's in-memory selection view at request entry. A revocation while
 * SDK ranking/refresh awaits also prevents returning an already-selected bearer. */
export class PoolAuthStorage extends AuthStorage {
  readonly #providers: Set<string>;
  constructor(readonly remote: PoolRemoteStore, pool: RuntimeAccountPool, readonly signal: AbortSignal) {
    super(remote, {
      sourceLabel: "native account pool",
      // Broker-provided API keys are private literal bytes, never local config,
      // environment-variable names or commands to discover/execute on this host.
      configValueResolver: async key => remote.listAuthCredentials().some(entry =>
        entry.credential.type === "api_key" && entry.credential.key === key) ? key : undefined,
    });
    this.#providers = new Set(Object.keys(pool).filter(provider => pool[provider]!.length > 0));
  }
  override async getApiKey(...args: Parameters<AuthStorage["getApiKey"]>): Promise<string | undefined> {
    this.signal.throwIfAborted();
    if (!this.#providers.has(args[0])) return undefined;
    const revocation = this.remote.revocation;
    try {
      await this.remote.refreshSnapshot();
      await this.reload();
    } catch {
      throw unavailable();
    }
    if (this.remote.listAuthCredentials(args[0]).length === 0) return undefined;
    const key = await super.getApiKey(...args);
    this.signal.throwIfAborted();
    return this.remote.revocation === revocation ? key : undefined;
  }
}

export function poolModels(pool: RuntimeAccountPool): Map<string, Model<Api>> {
  const models = new Map<string, Model<Api>>();
  for (const provider of getBundledProviders()) {
    if (!Object.hasOwn(pool, provider) || !pool[provider]?.length) continue;
    for (const model of getBundledModels(provider)) models.set(`${model.provider}/${model.id}`, model);
  }
  return models;
}

/**
 * Resolves the model id a client sends, which is not always the id this gateway published.
 *
 * The listing advertises `${provider}/${model.id}` as the row id while reporting the provider
 * separately, and a client that discovers models through it qualifies that row id with the
 * provider again. So `openrouter/stealth/union-alpha` comes back asking for
 * `openrouter/openrouter/stealth/union-alpha`, and answering 404 blames the caller for a name
 * this gateway handed it. One duplicated leading segment is that round trip and nothing else:
 * an unpublished model still gets its named refusal.
 */
export function resolvePublished(models: ReadonlyMap<string, Model<Api>>, id: string): Model<Api> | undefined {
  const direct = models.get(id);
  if (direct) return direct;
  const separator = id.indexOf("/");
  if (separator <= 0) return undefined;
  const provider = id.slice(0, separator);
  const remainder = id.slice(separator + 1);
  return remainder.startsWith(`${provider}/`) ? models.get(remainder) : undefined;
}

/** OpenRouter's catalog endpoint. Public: it carries no credential and needs none. */
const OPENROUTER_CATALOG = "https://openrouter.ai/api/v1/models";
const ListedModelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1).max(256),
      name: z.string().max(256).optional(),
      context_length: z.number().int().positive().optional(),
      top_provider: z.object({ max_completion_tokens: z.number().int().positive().nullable() }).partial().optional(),
      pricing: z.object({ prompt: z.string(), completion: z.string() }).partial().optional(),
      supported_parameters: z.array(z.string()).optional(),
    }),
  ),
});

/** Per-million cost from a per-token price string; an unparseable price is not a free model. */
function perMillion(price: string | undefined): number | null {
  if (price === undefined) return null;
  const value = Number(price);
  return Number.isFinite(value) && value >= 0 ? value * 1_000_000 : null;
}

/**
 * The models this gateway publishes: the pinned SDK catalog, plus the ones the provider lists
 * that the SDK does not carry.
 *
 * The bundled catalog is a snapshot of the SDK release, so every model a provider added since
 * — including every unlisted id, which is how OpenRouter ships its stealth models — was
 * unreachable through the governed path while working normally in local omp. A session
 * discovers models through this gateway, so the absence was total.
 *
 * A listed model is admitted only when its provider is in the account pool, and it is built
 * from a bundled model of the SAME provider and api: the dialect flags belong to the provider,
 * not to the individual model, and the listing states only identity, size and price. A bundled
 * id always wins, so nothing the SDK pins is overridden by a fetched document.
 */
export async function publishedModels(
  pool: RuntimeAccountPool,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, Model<Api>>> {
  const models = poolModels(pool);
  if (!pool.openrouter?.length) return models;
  const template = getBundledModels("openrouter").find((model) => model.api === "openrouter");
  if (!template) return models;
  let listed: z.infer<typeof ListedModelsSchema>;
  try {
    const response = await fetchImpl(OPENROUTER_CATALOG, { redirect: "error", signal });
    if (!response.ok) return models;
    listed = ListedModelsSchema.parse(await response.json());
  } catch {
    // A catalog this gateway could not read leaves the pinned one in place; it never empties it.
    return models;
  }
  // A model that does not accept a reasoning parameter carries no thinking config at all,
  // rather than an empty one: a level on a model that has none is what made a configured id
  // resolve to something else.
  const { thinking: templateThinking, ...dialect } = template;
  for (const entry of listed.data) {
    const key = `openrouter/${entry.id}`;
    if (models.has(key)) continue;
    const input = perMillion(entry.pricing?.prompt);
    const output = perMillion(entry.pricing?.completion);
    if (input === null || output === null || !entry.context_length) continue;
    const reasoning = (entry.supported_parameters ?? []).includes("reasoning");
    models.set(key, {
      ...dialect,
      ...(reasoning && templateThinking ? { thinking: templateThinking } : {}),
      id: entry.id,
      name: entry.name ?? entry.id,
      contextWindow: entry.context_length,
      maxTokens: entry.top_provider?.max_completion_tokens ?? template.maxTokens,
      cost: { input, output, cacheRead: 0, cacheWrite: 0 },
      reasoning,
    });
  }
  return models;
}

export async function openPoolStorage(broker: { url: string; token: string }, pool: RuntimeAccountPool, signal: AbortSignal, fetchImpl: typeof fetch = fetch) {
  const scopedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    signal.throwIfAborted();
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return fetchImpl(input, { ...init, redirect: "error", signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal });
  }, { preconnect: fetchImpl.preconnect });
  const client = new PoolBrokerClient({ ...broker, fetchImpl: scopedFetch }, pool);
  const initial = await client.fetchSnapshot({ signal });
  if (initial.status !== 200) throw unavailable();
  signal.throwIfAborted();
  // Do not pass the SDK's weaker identity-only accountPool as native authority.
  const remote = new PoolRemoteStore({
    client, initialSnapshot: initial.snapshot,
    onSnapshot: snapshot => client.acceptSnapshot(snapshot),
  });
  // The constructor accepts its initial snapshot before registering onSnapshot.
  client.acceptSnapshot(remote.snapshot);
  const storage = new PoolAuthStorage(remote, pool, signal);
  try { await storage.reload(); signal.throwIfAborted(); return storage; }
  catch { storage.close(); throw unavailable(); }
}
