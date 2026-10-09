import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { Database } from "bun:sqlite";
import {
  AuthStorage,
  SqliteAuthCredentialStore,
  type AuthStorageOptions,
  type CredentialsApi,
  type OAuthApi,
  type UsageApi,
} from "@oh-my-pi/pi-ai/auth-storage";
import { openSqliteDatabase } from "@oh-my-pi/pi-utils/sqlite";
import { NamespaceViews } from "../sdk-namespace.ts";

interface OperationScope {
  pending: number;
  failed: boolean;
}

const CUSTODY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The custody id lives inside the credential database: a new store gets one when a broker
 * first opens it, every later broker over that file keeps it, and it goes with the file.
 * A store that predates it gets one on its first open here. Credential ids are unique only
 * within one store, so this id is what keeps a reference from aliasing another store's slot.
 * The SDK neither reads nor migrates this table.
 */
function storeCustody(db: Database): string {
  return db.transaction(() => {
    db.run("CREATE TABLE IF NOT EXISTS manifold_custody (id INTEGER PRIMARY KEY CHECK (id = 1), custody_id TEXT NOT NULL)");
    db.run("INSERT OR IGNORE INTO manifold_custody (id, custody_id) VALUES (1, ?)", [randomUUID()]);
    const row = db.query<{ custody_id: unknown }, []>("SELECT custody_id FROM manifold_custody WHERE id = 1").get();
    if (typeof row?.custody_id !== "string" || !CUSTODY_ID.test(row.custody_id)) throw new Error("Invalid broker store custody");
    return row.custody_id;
  }).immediate();
}

/** The identity the SDK's SQLite recovery compares; birth time because an unlinked file's inode number can be reused. */
function fileIdentity(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Lifecycle accounting and store custody only: the published SDK still owns refresh, leases and persistence. */
export class NativeBrokerStorage extends AuthStorage {
  readonly #pending = new Map<Promise<void>, OperationScope>();
  readonly #scope = new AsyncLocalStorage<OperationScope>();
  readonly #views = new NamespaceViews();
  #failed = false;
  #refreshAdmission = true;
  #drainStarted = false;

  /** Stable across broker restarts, disable/enable and promotion over this same store file. */
  readonly custodyId: string;

  constructor(store: SqliteAuthCredentialStore, custodyId: string, options: AuthStorageOptions = {}) {
    const refresh = options.refreshOAuthCredential;
    if (!refresh) throw new Error("Native broker requires an SDK OAuth refresh callback");
    super(store, {
      ...options,
      // A caller supplies the SDK operation, not a native copy of provider
      // dispatch. Retain its raw lifetime beyond the SDK's request deadline.
      refreshOAuthCredential: (...args) => this.#own(() => refresh(...args), true),
    });
    this.custodyId = custodyId;
  }

  static override async create(dbPath: string, options: AuthStorageOptions = {}): Promise<NativeBrokerStorage> {
    // The SDK opens, migrates or recovers the file first; custody is then read through a
    // second connection by path. OMP sign-in shares this store and may quarantine and recreate
    // it in between, which would serve one file's credentials under another's custody. Both
    // connections must see one file: the same identity before the SDK open and after the
    // custody read. A new store has no file before its first open and an SDK recovery replaces
    // the file, so one reopen is allowed; a file that changes again refuses to start.
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = fileIdentity(dbPath);
      const store = await SqliteAuthCredentialStore.open(dbPath);
      try {
        const custodyId = await openSqliteDatabase(dbPath, db => {
          try { return storeCustody(db); } finally { db.close(); }
        });
        if (before !== null && before === fileIdentity(dbPath)) return new NativeBrokerStorage(store, custodyId, options);
      } catch (error) { store.close(); throw error; }
      store.close();
    }
    throw new Error("Broker store changed while opening");
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

  // The stock broker server and refresher reach storage only through these
  // namespaces. Their public operations are owned; the SDK's internal module
  // calls stay inside those operations and the patched drain's refresh maps.
  override get credentials(): CredentialsApi {
    return this.#views.view(super.credentials, source => ({
      reload: () => this.#own(() => source.reload()),
      poll: () => this.#own(() => source.poll()),
    }));
  }

  override get oauth(): OAuthApi {
    return this.#views.view(super.oauth, source => ({
      refresh: (id, signal, options) => {
        // A stock refresher tick already awaiting reload may arrive after stop().
        // Reject it before starting a new refresh; admitted operations remain live.
        if (!this.#refreshAdmission) return Promise.reject(new Error("Broker is draining"));
        return this.#waitForCaller(this.#own(() => source.refresh(id, undefined, options)), signal);
      },
    }));
  }

  override get usage(): UsageApi {
    return this.#views.view(super.usage, source => ({
      reports: options => {
        const { signal, ...operationOptions } = options ?? {};
        return this.#waitForCaller(this.#own(() => source.reports(operationOptions)), signal);
      },
    }));
  }

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
