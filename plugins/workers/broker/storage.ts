import {
  AuthStorage,
  SqliteAuthCredentialStore,
  type AuthStorageOptions,
  type OAuthCredential,
  type StoredOAuthRefreshOptions,
  type StoredOAuthRefreshResult,
} from "@oh-my-pi/pi-ai/auth-storage";
import { getOAuthProvider, refreshOAuthToken, type OAuthProvider } from "@oh-my-pi/pi-ai/registry/oauth";

/** Lifecycle accounting only: the published SDK still owns refresh, leases and persistence. */
export class NativeBrokerStorage extends AuthStorage {
  readonly #pending = new Set<Promise<void>>();
  #failed = false;
  #refreshAdmission = true;

  constructor(store: SqliteAuthCredentialStore, options: AuthStorageOptions = {}) {
    super(store, {
      ...options,
      // The public durable method below covers persistence, but the SDK can time
      // out its await of a provider which ignores cancellation. Keep that raw
      // provider lifetime too: a timeout must never authorize early store close.
      refreshOAuthCredential: (provider, id, credential, signal) => this.#track((async () => {
        if (options.refreshOAuthCredential) return options.refreshOAuthCredential(provider, id, credential, signal);
        const custom = getOAuthProvider(provider);
        if (custom) {
          if (!custom.refreshToken) throw new Error("OAuth provider does not support token refresh");
          return custom.refreshToken(credential, signal);
        }
        return refreshOAuthToken(provider as OAuthProvider, credential, signal);
      })()),
    });
  }

  static override async create(dbPath: string, options: AuthStorageOptions = {}): Promise<NativeBrokerStorage> {
    const store = await SqliteAuthCredentialStore.open(dbPath);
    try { return new NativeBrokerStorage(store, options); }
    catch (error) { store.close(); throw error; }
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(
      () => { this.#pending.delete(settled); },
      () => { this.#failed = true; this.#pending.delete(settled); },
    );
    this.#pending.add(settled);
    return operation;
  }

  // Caller cancellation never cancels a shared owned write. Track the complete
  // public operation, returning a separately cancellable wait to the caller.
  #waitForCaller<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return operation;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new DOMException("Broker caller aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  override refreshStoredOAuthCredential<T extends OAuthCredential = OAuthCredential>(
    provider: string,
    options: StoredOAuthRefreshOptions<T>,
  ): Promise<StoredOAuthRefreshResult<T>> {
    // All local durable private refresh paths in published 18.2.7 dispatch here,
    // including usage refresh detached by the usage caller's deadline. Resolution
    // is after CAS persistence and lease release, not just provider completion.
    return this.#track(super.refreshStoredOAuthCredential(provider, options));
  }

  override refreshCredentialById(id: number, signal?: AbortSignal) {
    // A stock refresher tick already awaiting reload may arrive after stop().
    // Reject it before starting a new refresh; admitted operations remain live.
    if (!this.#refreshAdmission) return Promise.reject(new Error("Broker is draining"));
    return this.#waitForCaller(this.#track(super.refreshCredentialById(id)), signal);
  }

  override fetchUsageReports(options?: Parameters<AuthStorage["fetchUsageReports"]>[0]) {
    return this.#waitForCaller(this.#track(super.fetchUsageReports({ ...options, signal: undefined })), options?.signal);
  }

  override reload(): Promise<void> { return this.#track(super.reload()); }
  override pollExternalChanges(): Promise<boolean> { return this.#track(super.pollExternalChanges()); }

  startRefreshAdmission(): void { this.#refreshAdmission = true; }
  stopRefreshAdmission(): void { this.#refreshAdmission = false; }

  async drainRefreshes(): Promise<void> {
    // Nested public work can be registered while an earlier operation settles.
    while (this.#pending.size) await Promise.all(this.#pending);
    if (this.#failed) throw new Error("Broker storage drain failed");
  }

  override close(): void {
    if (this.#pending.size) throw new Error("Broker storage still has owned operations");
    super.close();
  }
}
