import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/types";
import { OMP_VERSION, parseBenchmarkObservation, type BenchmarkReceipt, type ProbeCandidate } from "../../api/probe.ts";

/**
 * What `omp bench` reports of one failed run: the error event's `errorMessage`, or a thrown
 * failure's message, and nothing else. Status, `errorId` and provider never reach the report,
 * so this one string is all the probe can classify. Mirrors `runOnce` in OMP v18.4.12
 * `packages/coding-agent/src/cli/bench-cli.ts`, the probe's pinned binary; that function, the
 * pi-native client and its event stream are byte-identical through 18.8.0, the SDK these tests
 * load, so `streamPiNative` here is the client the binary runs.
 */
export async function benchFailure(stream: AssistantMessageEventStream): Promise<string | null> {
  try {
    for await (const event of stream) if (event.type === "error") return event.error.errorMessage ?? "request failed";
    const message = await stream.result();
    return message.stopReason === "error" || message.errorMessage ? message.errorMessage ?? "request failed" : null;
  } catch (error) {
    return error instanceof Error && error.message ? error.message : String(error);
  }
}

/** The probe's receipt for the `omp bench --json --runs 1 --max-tokens 4 --profile chat` report of that failed run. */
export function benchReceipt(model: Pick<ProbeCandidate, "provider" | "id" | "api">, error: string): BenchmarkReceipt {
  const selector = `${model.provider}/${model.id}`;
  const candidate: ProbeCandidate = { provider: model.provider, id: model.id, api: model.api, key: selector.replace(/[^A-Za-z0-9._-]/g, "_") };
  return parseBenchmarkObservation(
    { runs: 1, maxTokens: 4, profile: "chat", failures: 1,
      models: [{ selector, model: selector, results: [{ ok: false, challenge: "chat", error }], stats: null }] },
    { schemaVersion: 1, inventoryObservedAt: 1_700_000_000_000, ompVersion: OMP_VERSION, candidates: [candidate] },
    1_700_000_000_001, 1_700_000_000_002,
  );
}
