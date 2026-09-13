import { accessSync, constants, closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { BrokerClientAccessSchema, type BrokerClientAccess } from "../../api/contracts.ts";

const INPUT_LIMIT = 128 * 1024;
const unavailable = (): Error => new Error("broker_unavailable");

export interface BrokerInputs { serviceBearer: string; clientAccess: BrokerClientAccess | undefined }

export function parseClientAccess(value: unknown): BrokerClientAccess | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const fields = Object.keys(value);
  if (fields.length === 0) return undefined;
  const parsed = BrokerClientAccessSchema.safeParse(value);
  if (!parsed.success) throw unavailable();
  return parsed.data;
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

/** Match the native sealed-input boundary used by the gateway worker. */
export function readBrokerInputs(): BrokerInputs {
  const names = readdirSync("/inputs");
  if (names.length !== 2
    || names.some(name => name !== "serviceBearer" && name !== "clientAccess")) throw unavailable();
  let writable = false;
  try { accessSync("/inputs", constants.W_OK); writable = true; } catch {}
  if (writable) throw unavailable();
  const serviceBearer = readSealedJSON("/inputs/serviceBearer");
  if (typeof serviceBearer !== "string" || serviceBearer.trim() !== serviceBearer
    || !/^[A-Za-z0-9._~-]{32,4096}$/.test(serviceBearer)) throw unavailable();
  // Native inputFiles.input writes the required string as-is, not JSON-encoded again.
  const clientAccess = parseClientAccess(readSealedJSON("/inputs/clientAccess"));
  return { serviceBearer, clientAccess };
}

/** Import upstream with no ambient credentials, broker, profile, dotenv or debug configuration. */
export function isolateEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) {
    if (!["PATH", "LANG", "LC_ALL", "TZ", "MANIFOLD_JOB_CONTEXT_FD"].includes(key)) delete environment[key];
  }
  environment.HOME = "/inputs";
}
