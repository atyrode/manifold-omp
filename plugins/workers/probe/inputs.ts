import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync, readdirSync, symlinkSync } from "node:fs";
import { z } from "zod";
import { identifier, modelId, ThinkingLevelSchema } from "../../api/contracts.ts";
import {
  GATEWAY_DISCOVERY_TIMEOUT_MS, PROBE_MODEL_LIMIT, ProbeError, ListedProvidersSchema, SealedIdentitiesSchema, inventoryAdmits, parseBenchmarkInput,
  type BenchmarkInput, type ProbeIdentity,
} from "../../api/probe.ts";

export const PROBE_HOME = "/home/job";
export const PROBE_AGENT = `${PROBE_HOME}/.omp/agent`;
export const PROBE_INPUT_LIMIT = 1024 * 1024;
const loopbackUrl = z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}(?:\/v1)?$/)
  .refine(value => { try { return Number(new URL(value).port) <= 65535; } catch { return false; } });
// This is a deliberately narrow native OMP models configuration, not a consumer
// catalog. No !command api keys, headers, environment references, custom models or code.
// A model override only lets a configured live-listed model reason at its configured level:
// it carries no identity, transport, endpoint or price.
const PinnedThinkingSchema = z.strictObject({
  reasoning: z.literal(true),
  thinking: z.strictObject({
    mode: z.enum(["effort", "budget", "google-level", "anthropic-adaptive", "anthropic-budget-effort"]),
    efforts: z.array(ThinkingLevelSchema).min(1).max(ThinkingLevelSchema.options.length),
    defaultLevel: ThinkingLevelSchema.optional(),
    requiresEffort: z.boolean().optional(),
  }),
});
export const ProbeModelsConfigSchema = z.strictObject({ providers: z.record(identifier, z.strictObject({
  baseUrl: loopbackUrl, apiKey: z.string().regex(/^[A-Za-z0-9._~-]{32,4096}$/),
  transport: z.literal("pi-native"),
  discovery: z.strictObject({ type: z.literal("proxy"), timeoutMs: z.literal(GATEWAY_DISCOVERY_TIMEOUT_MS).optional() }),
  modelOverrides: z.record(modelId, PinnedThinkingSchema)
    .refine(value => Object.keys(value).length <= PROBE_MODEL_LIMIT).optional(),
})).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 16) });
export const ProbeConfigSchema = z.strictObject({
  extensions: z.array(z.never()).length(0),
  disabledProviders: z.array(identifier).max(256),
  extendedContext: z.boolean(),
  startup: z.strictObject({ setupWizard: z.literal(false) }),
});

export function readProbeInput(name: "models" | "config" | "modelIdentities" | "listedProviders" | "candidates"): unknown {
  const path = name === "models" || name === "config" ? `${PROBE_AGENT}/${name}.yml` : `/inputs/${name}`;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer | undefined;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > PROBE_INPUT_LIMIT || (stat.mode & 0o222) !== 0) throw new ProbeError("invalid_input");
    bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) throw new ProbeError("invalid_input");
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } catch { throw new ProbeError("invalid_input"); }
  finally { bytes?.fill(0); closeSync(fd); }
}
/**
 * Where the job reaches its gateway's `models` listing: the service endpoint and bearer the owner
 * sealed into its models configuration for every registered provider, addressed as the CLI's own
 * proxy discovery addresses it.
 */
export interface GatewayListingAddress { readonly url: string; readonly bearer: string }
export interface ProbeInputs {
  identities: ProbeIdentity[];
  /** The providers inventory reports from the gateway's listing (`inventoryAdmits`). */
  listed: string[];
  /** Present exactly when `listed` is not empty. */
  listing?: GatewayListingAddress;
  benchmark?: BenchmarkInput;
}
export function prepareProbeInputs(kind: "inventory" | "benchmark"): ProbeInputs {
  const expected = kind === "benchmark" ? ["modelIdentities", "listedProviders", "candidates"] : ["modelIdentities", "listedProviders"];
  const names = readdirSync("/inputs");
  if (names.length !== expected.length || names.some(name => !expected.includes(name))) throw new ProbeError("invalid_input");
  let writable = false;
  try { accessSync("/inputs", constants.W_OK); writable = true; } catch {}
  if (writable) throw new ProbeError("invalid_input");
  const models = ProbeModelsConfigSchema.safeParse(readProbeInput("models"));
  const config = ProbeConfigSchema.safeParse(readProbeInput("config"));
  const identities = SealedIdentitiesSchema.safeParse(readProbeInput("modelIdentities"));
  const listed = ListedProvidersSchema.safeParse(readProbeInput("listedProviders"));
  if (!models.success || !config.success || !identities.success || !listed.success ||
    identities.data.length + listed.data.length === 0) throw new ProbeError("invalid_input");
  const registered = (provider: string) => Object.hasOwn(models.data.providers, provider) && !config.data.disabledProviders.includes(provider);
  if (!listed.data.every(registered)) throw new ProbeError("invalid_input");
  const addresses = new Set<string>();
  for (const identity of identities.data) {
    const address = `${identity.provider}/${identity.id}`.toLowerCase();
    if (addresses.has(address)) throw new ProbeError("ambiguous_identity");
    if (!registered(identity.provider)) throw new ProbeError("invalid_input");
    addresses.add(address);
  }
  const benchmark = kind === "benchmark" ? parseBenchmarkInput(readProbeInput("candidates")) : undefined;
  for (const candidate of benchmark?.candidates ?? []) {
    if (!inventoryAdmits(identities.data, listed.data, candidate)) throw new ProbeError("invalid_input");
  }
  // Native Manifold owns this fresh private home. Config capabilities stay in
  // their sealed homePath mounts; the worker never copies or rewrites them.
  const agentNames = readdirSync(PROBE_AGENT);
  if (agentNames.length !== 2 || agentNames.some(name => !["models.yml", "config.yml"].includes(name))) throw new ProbeError("invalid_input");
  for (const directory of ["tmp", "work"]) {
    mkdirSync(`${PROBE_HOME}/${directory}`, { mode: 0o700, recursive: true });
  }
  const gateway = listed.data.length > 0 ? models.data.providers[listed.data[0]!]! : undefined;
  return {
    identities: identities.data, listed: listed.data,
    ...(gateway ? { listing: { url: `${gateway.baseUrl.endsWith("/v1") ? gateway.baseUrl : `${gateway.baseUrl}/v1`}/models`, bearer: gateway.apiKey } } : {}),
    ...(benchmark ? { benchmark } : {}),
  };
}

export function isolateProbeEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) if (key !== "MANIFOLD_JOB_CONTEXT_FD") delete environment[key];
  Object.assign(environment, probeChildEnvironment());
}
export function probeChildEnvironment(): Record<string, string> {
  return { HOME: PROBE_HOME, XDG_CONFIG_HOME: `${PROBE_HOME}/.config`, XDG_CACHE_HOME: `${PROBE_HOME}/.cache`,
    XDG_DATA_HOME: `${PROBE_HOME}/.local/share`, XDG_STATE_HOME: `${PROBE_HOME}/.local/state`,
    PI_CODING_AGENT_DIR: PROBE_AGENT, PI_CONFIG_DIR: ".omp", PI_NATIVES_DIR: "/tmp/omp-native", TMPDIR: `${PROBE_HOME}/tmp`,
    PATH: "/runtime/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", NO_COLOR: "1" };
}
/** Only the stock CLI's embedded addon uses this private writable directory.
 * Grammar bytes remain the owner's verified, read-only managed artifact files. */
export function prepareOmpNativeDirectory(): void {
  const directory = "/tmp/omp-native";
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error("omp_native_directory_invalid");
  const grammars = `${directory}/grammars`;
  try { symlinkSync("/runtime/bin/omp-grammars", grammars); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !lstatSync(grammars).isSymbolicLink() ||
      readlinkSync(grammars) !== "/runtime/bin/omp-grammars") throw new Error("omp_native_directory_invalid");
  }
}
