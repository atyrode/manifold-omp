import { accessSync, constants, closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { RuntimeAccountPoolSchema, type RuntimeAccountPool } from "../../api/contracts.ts";

export const INPUT_LIMIT = 128 * 1024;
export interface GatewayInputs { broker: { url: string; token: string }; accountPool: RuntimeAccountPool; serviceBearer: string }
export const unavailable = (): Error => new Error("gateway_unavailable");

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function bearer(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{32,4096}$/.test(value);
}
export function parseInputs(broker: unknown, pool: unknown, serviceBearer: unknown): GatewayInputs {
  if (!record(broker) || Object.keys(broker).length !== 2 || typeof broker.url !== "string" || !bearer(broker.token) || !bearer(serviceBearer)) throw unavailable();
  // Native proxy is an exact numeric IPv4 loopback origin, not a URL selected by a provider or environment.
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(broker.url)) throw unavailable();
  const url = new URL(broker.url);
  if (Number(url.port) < 1 || Number(url.port) > 65535) throw unavailable();
  const parsed = RuntimeAccountPoolSchema.safeParse(pool);
  if (!parsed.success) throw unavailable();
  const accountPool = parsed.data;
  const slots = new Set<number>();
  let scope: string | undefined;
  for (const selected of Object.values(accountPool)) {
    for (const slot of selected) {
      if (scope !== undefined && slot.scope !== scope) throw unavailable();
      scope = slot.scope;
      if (slots.has(slot.credentialId) || slots.size >= 1024) throw unavailable();
      slots.add(slot.credentialId);
      Object.freeze(slot);
    }
    // Empty is deliberately retained. It NEVER means all accounts.
    Object.freeze(selected);
  }
  Object.freeze(accountPool);
  return { broker: { url: broker.url, token: broker.token }, accountPool, serviceBearer };
}

export function readSealedJSON(path: string): unknown {
  let fd: number | undefined;
  let bytes: Buffer | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > INPUT_LIMIT || (stat.mode & 0o222) !== 0) throw unavailable();
    bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) throw unavailable();
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } catch { throw unavailable(); }
  finally {
    bytes?.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}

export function requirePrivateInputRoot(): void {
  const names = readdirSync("/inputs");
  if (names.length !== 3 || names.some(name => !["broker", "accountPool", "serviceBearer"].includes(name))) throw unavailable();
  let writable = false;
  try { accessSync("/inputs", constants.W_OK); writable = true; } catch {}
  if (writable) throw unavailable();
}

/** No ambient SDK credential, debug, proxy, discovery or local-store configuration. */
export function isolateEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) {
    if (!["PATH", "LANG", "LC_ALL", "TZ", "MANIFOLD_JOB_CONTEXT_FD"].includes(key)) delete environment[key];
  }
  // getInstallId has no public memory-only setter in SDK18.1.14. Its supported
  // read-only-filesystem path caches an ephemeral UUID in memory. The verified
  // sealed input root is empty apart from inputs and cannot acquire ~/.omp.
  environment.HOME = "/inputs";
}
