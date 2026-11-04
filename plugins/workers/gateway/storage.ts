import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";
import { z } from "zod";
import { AuthBrokerClient, type AuthBrokerClientOptions, type FetchSnapshotOptions, type FetchSnapshotResult } from "@oh-my-pi/pi-ai/auth-broker/client";
import { RemoteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-broker/remote-store";
import type { SnapshotResponse, SnapshotStreamEvent } from "@oh-my-pi/pi-ai/auth-broker/types";
import { AuthStorage, type AuthCredentialSnapshotEntry, type KeysApi, type OAuthRefreshReason } from "@oh-my-pi/pi-ai/auth-storage";
import { getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { openaiCodexModelManagerOptions, type OpenAICodexAccount } from "@oh-my-pi/pi-catalog/provider-models/special";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import type { RuntimeAccountPool } from "../../api/contracts.ts";
import { unavailable } from "./inputs.ts";
import { OPENROUTER_LISTING_TEMPLATE } from "./template.ts";
import { NamespaceViews } from "../sdk-namespace.ts";

/**
 * The deadline of the listing read a broker snapshot read is made for, if any.
 *
 * The snapshot refresh that guards a listing's account resolution takes no signal of its own.
 * Scoped to the async context of that one read, the deadline reaches its broker request, so a
 * stalled snapshot ends with the listing's budget. It never reaches a credential refresh: the SDK
 * reads a cancelled refresh as an authentication failure and blocks the account on the shared
 * broker, while the broker finishes a rotation it started whether or not anyone still waits.
 */
const listingDeadline = new AsyncLocalStorage<AbortSignal>();

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
    const deadline = listingDeadline.getStore();
    const signal = deadline && options.signal ? AbortSignal.any([options.signal, deadline]) : deadline ?? options.signal;
    const result = await super.fetchSnapshot(signal ? { ...options, signal } : options);
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
  override async refreshCredential(id: number, signal?: AbortSignal, reason?: OAuthRefreshReason) {
    if (!this.#activeIds.has(id) || this.#slots.get(id)?.identityKey === null) throw unavailable();
    const result = await super.refreshCredential(id, signal, reason);
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
 * SDK ranking/refresh awaits also prevents returning an already-selected bearer.
 * The stock gateway resolves bearers through `keys.getWithCredential`, so the guard
 * sits on the `keys` namespace: every key it hands out passes the same check. */
export class PoolAuthStorage extends AuthStorage {
  readonly #providers: Set<string>;
  readonly #views = new NamespaceViews();
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
  override get keys(): KeysApi {
    return this.#views.view(super.keys, source => ({
      get: (provider, ...rest) => this.#guarded(provider, () => source.get(provider, ...rest)),
      getWithCredential: (provider, ...rest) => this.#guarded(provider, () => source.getWithCredential(provider, ...rest)),
    }));
  }
  /**
   * Every pooled OAuth account of `provider`, refreshed, for reading that provider's own model
   * listing; null when there is none or any one cannot be resolved. OMP abandons its own Codex
   * discovery the same way: a listing read for only some of the accounts would stand for the
   * provider's whole catalog and hide what the missing account is offered. It passes the guard
   * every key does, so an account outside this pool, or one revoked while it resolves, never
   * reaches the listing request.
   *
   * `deadline` is the listing's. It ends the guard's snapshot read. An expired token's refresh is
   * not cancelled: the listing stops waiting for it at the deadline (`withinBudget`), and the
   * broker completes the rotation as it would for any caller; cancelling it would have the SDK
   * record an authentication block on the shared broker for an account that is fine.
   */
  async listingAccounts(provider: string, deadline: AbortSignal): Promise<OpenAICodexAccount[] | null> {
    const accounts = await this.#guarded(provider, async () => {
      const resolved: OpenAICodexAccount[] = [];
      for (const access of await this.oauth.accessAll(provider)) {
        if (!access.ok) return undefined;
        resolved.push(access.accountId ? { accessToken: access.accessToken, accountId: access.accountId } : { accessToken: access.accessToken });
      }
      return resolved;
    }, deadline);
    // Accounts resolved after the listing gave up are not read with.
    deadline.throwIfAborted();
    return accounts && accounts.length > 0 ? accounts : null;
  }
  async #guarded<T>(provider: string, resolve: () => Promise<T | undefined>, snapshotDeadline?: AbortSignal): Promise<T | undefined> {
    this.signal.throwIfAborted();
    if (!this.#providers.has(provider)) return undefined;
    const revocation = this.remote.revocation;
    try {
      await (snapshotDeadline ? listingDeadline.run(snapshotDeadline, () => this.remote.refreshSnapshot()) : this.remote.refreshSnapshot());
      await this.credentials.reload();
    } catch {
      throw unavailable();
    }
    if (this.remote.listAuthCredentials(provider).length === 0) return undefined;
    const key = await resolve();
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
 * A published key is `${provider}/${model.id}`, and a client qualifies the id it was configured
 * with by a provider of its own choosing — the row's `owned_by` when it discovered the model
 * here, or the first account in its pool when it did not. So a session configured for
 * `openrouter/example.invalid/unlisted-alpha` — any id whose own vendor namespace the bundled
 * catalog does not carry — asks for `openrouter/openrouter/example.invalid/unlisted-alpha` or
 * `openai-codex/openrouter/example.invalid/unlisted-alpha`, and answering 404 blames the caller
 * for qualifying a name this gateway handed out.
 *
 * Dropping that one leading segment is name parsing, not authority: the remainder must itself
 * be a published key, so it carries its own provider, and the model that comes back is served
 * with ITS provider's credential. A prefix that is not a qualifier cannot reach another
 * provider's model, and an unpublished model still gets its named refusal.
 */
export function resolvePublished(models: ReadonlyMap<string, Model<Api>>, id: string): Model<Api> | undefined {
  const direct = models.get(id);
  if (direct) return direct;
  const separator = id.indexOf("/");
  if (separator <= 0) return undefined;
  const remainder = id.slice(separator + 1);
  const qualified = models.get(remainder);
  // The remainder is a key only when its own first segment is the model's provider, which is
  // what makes this unambiguous rather than a search for any model whose name ends this way.
  return qualified && remainder.startsWith(`${qualified.provider}/`) ? qualified : undefined;
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

/** A session is waiting on this call, so each listing either answers inside this budget or is skipped. */
const CATALOG_TIMEOUT_MS = 8_000;
/** Enough to ride out one transient refusal; the budget above still bounds the total. */
const CATALOG_ATTEMPTS = 3;
const CATALOG_RETRY_MS = 400;

/**
 * The published models, and WHY A LIVE LISTING IS NOT BEHIND THEM when it is not.
 *
 * `unreadable` names, per provider, the reason a listing read was attempted and failed. A
 * provider is absent from it when its listing was read, or when this pool holds no credential
 * it would be read for. The distinction is the point: "the listing does not contain your model"
 * and "I could not read the listing your model would be in" are different answers, and only one
 * of them is the caller's fault. It is per provider because the listings are: one provider's
 * unreadable listing says nothing about a model another provider's listing lacks.
 *
 * A fallback indistinguishable from success is how this stayed unnoticed. One line of stderr
 * said the catalog was pinned-only and nothing else did, so a preview served a stale model list
 * for hours while looking exactly like a working one, and it became visible only when a model
 * existed ONLY in the live listing (atyrode/manifold#751).
 */
export interface PublishedCatalog {
  readonly models: Map<string, Model<Api>>;
  readonly unreadable: Readonly<Record<string, string>>;
}

/** One provider's listing, or the reason this gateway could not read it. */
type Listing<T> = { readonly value: T } | { readonly reason: string };

/**
 * One provider's listing within its budget.
 *
 * One transient failure must not unpublish a model: a session that drew a 429 or a timeout here
 * got a named 404 for a model its credential serves, while the next session ran fine. The
 * attempts share the budget, so retrying never makes the gateway slower to start than a single
 * slow read would.
 */
async function withinBudget<T>(signal: AbortSignal, read: (deadline: AbortSignal) => Promise<Listing<T>>): Promise<Listing<T>> {
  let reason = "unattempted";
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]);
  // The wait ends at the deadline whatever a read is still doing. Reads end their own snapshot and
  // listing requests with it; a credential refresh is the broker's to finish (`listingAccounts`).
  const { promise: ended, reject: end } = Promise.withResolvers<never>();
  ended.catch(() => {});
  deadline.addEventListener("abort", () => end(deadline.reason), { once: true });
  for (let attempt = 0; attempt < CATALOG_ATTEMPTS && !deadline.aborted; attempt += 1) {
    if (attempt > 0) await Bun.sleep(CATALOG_RETRY_MS);
    try {
      const listing = await Promise.race([read(deadline), ended]);
      if ("value" in listing) return listing;
      reason = listing.reason;
    } catch (error) {
      reason = error instanceof Error ? error.name : typeof error;
    }
  }
  return { reason };
}

/**
 * Reports publishing less than the credential can reach for `provider`, whose pinned rows stay
 * published, and returns the reason.
 *
 * Silence here is what made an unlisted model look like a caller's mistake: the session gets a
 * named 404 for a model the provider serves, and nothing upstream says the catalog was the
 * reason. One line on this worker's stderr is where the machine reads it; the returned reason
 * is how the boundary refuses by the right name instead of blaming the caller.
 */
function degraded(models: ReadonlyMap<string, Model<Api>>, provider: string, reason: string): string {
  let pinned = 0;
  for (const model of models.values()) if (model.provider === provider) pinned += 1;
  writeSync(2, `catalog_pinned_only ${provider} ${reason} ${String(pinned)}\n`);
  return reason;
}

async function openRouterListing(deadline: AbortSignal, fetchImpl: typeof fetch): Promise<Listing<z.infer<typeof ListedModelsSchema>>> {
  const response = await fetchImpl(OPENROUTER_CATALOG, { redirect: "error", signal: deadline });
  if (!response.ok) {
    await response.body?.cancel();
    return { reason: `status_${response.status}` };
  }
  return { value: ListedModelsSchema.parse(await response.json()) };
}

/**
 * CODEX'S CATALOG AS OMP RESOLVES IT: the SDK's own Codex discovery, for every pooled account.
 *
 * The SDK sends `GET https://chatgpt.com/backend-api/codex/models?client_version=<its Codex client
 * version>` (then `/models` if that route fails) with each account's OAuth access token and
 * ChatGPT account id, and unions the accounts' listings. Its resolution makes the listing the
 * provider's whole catalog (`dynamic-models-authoritative`): a model the account is offered is
 * published with the prices, limits and effort ladder OMP gives it, before any SDK release
 * bundles it, and a bundled model the account is not offered is no longer published. Nothing is
 * cached across reads: the SDK's model cache is pointed at an in-memory database that is gone
 * when the read ends, so every gateway start reads the listing afresh and no file is written.
 *
 * The SDK's own requests carry no deadline, so each one is given this read's budget here, and
 * the last refusal or failure it met is kept as the reason when the listing was not read.
 */
async function codexListing(deadline: AbortSignal, fetchImpl: typeof fetch,
  accounts: (deadline: AbortSignal) => Promise<readonly OpenAICodexAccount[] | null>): Promise<Listing<Model<Api>[]>> {
  // A pool whose accounts cannot all be resolved within the budget, or holds no OAuth account,
  // has no listing to read.
  const resolved = await accounts(deadline).catch(() => null);
  if (!resolved) return { reason: "account_unavailable" };
  let observed = "listing_unreadable";
  const bounded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    try {
      const response = await fetchImpl(input, { ...init, redirect: "error", signal: deadline });
      if (!response.ok) observed = `status_${response.status}`;
      return response;
    } catch (error) {
      observed = error instanceof Error ? error.name : typeof error;
      throw error;
    }
  };
  const result = await resolveProviderModels({
    ...openaiCodexModelManagerOptions({ resolveAccounts: async () => resolved, fetch: bounded }),
    cacheDbPath: ":memory:",
  }, "online");
  return result.source === "provider" ? { value: result.models } : { reason: observed };
}

/** Per-million cost from a per-token price string; an unparseable price is not a free model. */
function perMillion(price: string | undefined): number | null {
  if (price === undefined) return null;
  const value = Number(price);
  return Number.isFinite(value) && value >= 0 ? value * 1_000_000 : null;
}

/**
 * The models this gateway publishes: the pinned SDK catalog, with each live-listed provider's
 * listing applied the way that provider's listing means.
 *
 * The bundled catalog is a snapshot of the SDK release, so every model a provider added since
 * — including every unlisted id, which is how OpenRouter ships its stealth models, and every
 * model Codex offers an account before an SDK release bundles it — was unreachable through the
 * governed path while working normally in local omp. A session discovers models through this
 * gateway, so the absence was total.
 *
 * A listing is read only for a provider the account pool holds a credential for, and the two
 * listings are read side by side, each within its own budget. A listing this gateway cannot read
 * leaves that provider's pinned rows in place; it never empties them.
 *
 * - **OpenRouter** lists publicly, without a credential, and adds to the pinned catalog. A listed
 *   model is built from a bundled model of the SAME provider and api: the dialect flags belong to
 *   the provider, not to the individual model, and the listing states only identity, size and
 *   price. A bundled id always wins, so nothing the SDK pins is overridden by a fetched document.
 * - **Codex** lists per account, and its listing replaces the pinned rows (`codexListing`).
 *   `accounts` supplies the pool's Codex accounts for it (`PoolAuthStorage.listingAccounts`).
 */
export async function publishedModels(
  pool: RuntimeAccountPool,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  accounts: (provider: string, deadline: AbortSignal) => Promise<readonly OpenAICodexAccount[] | null> = async () => null,
): Promise<PublishedCatalog> {
  const models = poolModels(pool);
  const unreadable: Record<string, string> = {};
  const template = OPENROUTER_LISTING_TEMPLATE;
  // No credential for a provider means no listing this pool would be served from: publishing
  // exactly what the credentials reach is the whole answer, not a degradation of one.
  const [openrouter, codex] = await Promise.all([
    pool.openrouter?.length && template ? withinBudget(signal, deadline => openRouterListing(deadline, fetchImpl)) : undefined,
    pool["openai-codex"]?.length
      ? withinBudget(signal, deadline => codexListing(deadline, fetchImpl, bound => accounts("openai-codex", bound)))
      : undefined,
  ]);
  if (codex && "reason" in codex) unreadable["openai-codex"] = degraded(models, "openai-codex", codex.reason);
  else if (codex) {
    for (const [key, model] of models) if (model.provider === "openai-codex") models.delete(key);
    for (const model of codex.value) models.set(`${model.provider}/${model.id}`, model);
  }
  if (openrouter && "reason" in openrouter) unreadable.openrouter = degraded(models, "openrouter", openrouter.reason);
  else if (openrouter && template) {
    // A model that does not accept a reasoning parameter carries no thinking config at all,
    // rather than an empty one: a level on a model that has none is what made a configured id
    // resolve to something else.
    const { thinking: templateThinking, ...dialect } = template;
    for (const entry of openrouter.value.data) {
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
  }
  return { models, unreadable };
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
  try { await storage.credentials.reload(); signal.throwIfAborted(); return storage; }
  catch { storage.close(); throw unavailable(); }
}
