import { ProbeError, parseBenchmarkObservation, parseInventoryObservation, parseOmpVersion, probeAddress, type BenchmarkInput, type BenchmarkReceipt, type InventoryReceipt, type ProbeIdentity } from "../../api/probe.ts";
import { PROBE_HOME, probeChildEnvironment, type GatewayListingAddress } from "./inputs.ts";
import { bundledQuotaTiers } from "../../atyrode.omp/sdk-metadata.macro.ts" with { type: "macro" };

// Literal build-time data from the same pinned SDK classification as the metadata projection.
const quotaTiers: Readonly<Record<string, string>> = bundledQuotaTiers();

export const PROBE_OUTPUT_LIMIT = 4 * 1024 * 1024;
const fixedBenchmarkArgs = ["--json", "--runs", "1", "--max-tokens", "4", "--profile", "chat", "--prompt", "Reply with the single word: ok"];
// Private implementation, never an argv/cwd/env API or caller-selected command.
async function capture(kind: "version" | "inventory" | "benchmark", signal: AbortSignal, input?: BenchmarkInput): Promise<string> {
  if (signal.aborted) throw new ProbeError("cancelled");
  const args = kind === "version" ? ["--version"] : kind === "inventory" ? ["models", "--json", "--no-extensions"] :
    ["bench", ...input!.candidates.map(probeAddress), ...fixedBenchmarkArgs];
  const child = Bun.spawn(["/runtime/bin/omp", ...args], {
    cwd: `${PROBE_HOME}/work`, env: probeChildEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true,
  });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let overflow = false;
  const stop = (): void => {
    // Known child-created session, not a caller-selected process. Kill descendants
    // that still own the private stdout pipe, as well as the CLI itself.
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const reader = child.stdout.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > PROBE_OUTPUT_LIMIT - bytes) { overflow = true; stop(); break; }
      chunks.push(chunk.value); bytes += chunk.value.byteLength;
    }
    const exit = await child.exited;
    if (signal.aborted) throw new ProbeError("cancelled");
    if (overflow) throw new ProbeError("output_limit");
    // Bench exits 1 for reported failed candidates; its strict report remains
    // useful. Signals, unknown exits, and non-benchmark failures are not receipts.
    if (exit !== 0 && !(kind === "benchmark" && exit === 1)) throw new ProbeError("target_failed");
    const buffer = Buffer.concat(chunks, bytes);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    finally { buffer.fill(0); }
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await child.exited;
    for (const chunk of chunks) chunk.fill(0);
  }
}
function json(raw: string): unknown {
  try { return JSON.parse(raw); } catch { throw new ProbeError("invalid_observation"); }
}
/**
 * The gateway's `models` listing, read as the CLI's proxy discovery reads it: one `models` call
 * through this job's service proxy, with the bearer the owner sealed into its models
 * configuration. Bounded like the CLI's output, and never followed elsewhere.
 */
async function gatewayListing(address: GatewayListingAddress, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(address.url, { headers: { authorization: `Bearer ${address.bearer}`, accept: "application/json" }, redirect: "error", signal });
  } catch {
    throw new ProbeError(signal.aborted ? "cancelled" : "target_failed");
  }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new ProbeError("target_failed"); }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > PROBE_OUTPUT_LIMIT) { await response.body.cancel().catch(() => {}); throw new ProbeError("output_limit"); }
    chunks.push(chunk);
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
  catch { throw new ProbeError("invalid_observation"); }
  return json(text);
}
export async function inventoryTarget(identities: ProbeIdentity[], listed: string[], listing: GatewayListingAddress | undefined,
  signal: AbortSignal): Promise<InventoryReceipt> {
  const version = parseOmpVersion(await capture("version", signal));
  const raw = await capture("inventory", signal);
  // A listed provider's rows are the gateway's projection of what it serves (`inventoryAdmits`).
  const gateway = listed.length > 0 && listing ? await gatewayListing(listing, signal) : null;
  return parseInventoryObservation(json(raw), identities, Date.now(), version, identity => {
    const address = probeAddress(identity);
    return Object.hasOwn(quotaTiers, address) ? quotaTiers[address]! : null;
  }, { providers: listed, listing: gateway });
}
export async function benchmarkTarget(input: BenchmarkInput, signal: AbortSignal): Promise<BenchmarkReceipt> {
  parseOmpVersion(await capture("version", signal));
  const startedAt = Date.now();
  const raw = await capture("benchmark", signal, input);
  return parseBenchmarkObservation(json(raw), input, startedAt, Date.now());
}
