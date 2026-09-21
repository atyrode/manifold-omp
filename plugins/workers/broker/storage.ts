import { AsyncLocalStorage } from "node:async_hooks";
import {
  AuthStorage,
  SqliteAuthCredentialStore,
  type AuthStorageOptions,
  type OAuthCredential,
  type StoredOAuthRefreshOptions,
  type StoredOAuthRefreshResult,
} from "@oh-my-pi/pi-ai/auth-storage";

interface OperationScope {
  pending: number;
  failed: boolean;
}

/** Lifecycle accounting only: the published SDK still owns refresh, leases and persistence. */
export class NativeBrokerStorage extends AuthStorage {
  readonly #pending = new Map<Promise<void>, OperationScope>();
  readonly #scope = new AsyncLocalStorage<OperationScope>();
  #failed = false;
  #refreshAdmission = true;
  #drainStarted = false;

  constructor(store: SqliteAuthCredentialStore, options: AuthStorageOptions = {}) {
    const refresh = options.refreshOAuthCredential;
    if (!refresh) throw new Error("Native broker requires an SDK OAuth refresh callback");
    super(store, {
      ...options,
      // A caller supplies the SDK operation, not a native copy of provider
      // dispatch. Retain its raw lifetime beyond the SDK's request deadline.
      refreshOAuthCredential: (...args) => this.#own(() => refresh(...args), true),
    });
  }

  static override async create(dbPath: string, options: AuthStorageOptions = {}): Promise<NativeBrokerStorage> {
    const store = await SqliteAuthCredentialStore.open(dbPath);
    try { return new NativeBrokerStorage(store, options); }
    catch (error) { store.close(); throw error; }
  }

  #own<T>(run: () => Promise<T>, rawProvider = false): Promise<T> {
    const inherited = rawProvider ? this.#scope.getStore() : undefined;
    const scope = inherited?.pending ? inherited : { pending: 0, failed: false };
    scope.pending++;
    let operation: Promise<T>;
    try { operation = this.#scope.run(scope, run); }
    catch (error) { operation = Promise.reject(error); }
    const finish = (failed: boolean): void => {
      // Raw rejection may be handled by the SDK. Its enclosing public
      // operation determines failure; the raw child only extends its lifetime.
      scope.failed ||= failed && !rawProvider;
      if (this.#drainStarted && scope.failed) this.#failed = true;
      scope.pending--;
      this.#pending.delete(settled);
    };
    const settled = operation.then(() => finish(false), () => finish(true));
    this.#pending.set(settled, scope);
    return operation;
  }

  // Caller cancellation never cancels a shared owned write. Track the complete
  // public operation, returning a separately cancellable wait to the caller.
  #waitForCaller<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return operation;
    const wait = Promise.withResolvers<T>();
    const abort = () => wait.reject(new DOMException("Broker caller aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation.then(wait.resolve, wait.reject).finally(() => signal.removeEventListener("abort", abort));
    return wait.promise;
  }

  override refreshStoredOAuthCredential<T extends OAuthCredential = OAuthCredential>(
    provider: string,
    options: StoredOAuthRefreshOptions<T>,
  ): Promise<StoredOAuthRefreshResult<T>> {
    // The SDK's durable path includes usage refresh detached by its caller's
    // deadline. Resolution follows CAS persistence and lease release, not just
    // provider completion.
    return this.#own(() => super.refreshStoredOAuthCredential(provider, options));
  }

  override refreshCredentialById(id: number, signal?: AbortSignal) {
    // A stock refresher tick already awaiting reload may arrive after stop().
    // Reject it before starting a new refresh; admitted operations remain live.
    if (!this.#refreshAdmission) return Promise.reject(new Error("Broker is draining"));
    return this.#waitForCaller(this.#own(() => super.refreshCredentialById(id)), signal);
  }

  override fetchUsageReports(options?: Parameters<AuthStorage["fetchUsageReports"]>[0]) {
    const { signal, ...operationOptions } = options ?? {};
    return this.#waitForCaller(this.#own(() => super.fetchUsageReports(operationOptions)), signal);
  }

  override reload(): Promise<void> { return this.#own(() => super.reload()); }
  override pollExternalChanges(): Promise<boolean> { return this.#own(() => super.pollExternalChanges()); }

  startRefreshAdmission(): void {
    if (this.#pending.size === 0 && !this.#failed) this.#drainStarted = false;
    this.#refreshAdmission = true;
  }
  stopRefreshAdmission(): void { this.#refreshAdmission = false; }

  // Freeze failures at admission closure, not after admitted HTTP work settles.
  // An earlier completed failure is harmless; a timed-out logical write whose
  // raw provider still runs must remain a failure when this drain starts.
  beginDrain(): void {
    this.#drainStarted = true;
    for (const scope of this.#pending.values()) this.#failed ||= scope.failed;
  }

  override async drainRefreshes(): Promise<void> {
    this.beginDrain();
    // An existing SDK drain failure must remain a native drain failure.
    try { await super.drainRefreshes(); }
    catch { this.#failed = true; }
    // Nested public work can be registered while an earlier operation settles.
    while (this.#pending.size) await Promise.all(this.#pending.keys());
    if (this.#failed) throw new Error("Broker storage drain failed");
  }

  override close(): void {
    if (this.#pending.size) throw new Error("Broker storage still has owned operations");
    super.close();
  }
}
