import type { Readable, Writable } from "node:stream";
import type { WorkerContext } from "@manifold/sdk/worker";

export type ReportOmpProgress = WorkerContext["reportProgress"];
export const OMP_PROGRESS_FRAME_BYTES = 64 * 1024;

const stages = {
  model: { stage: "at the model", message: "Assistant stream started." },
  tools: { stage: "running tools", message: "Tool lifecycle observed." },
  running: { stage: "running", message: "OMP lifecycle continuing." },
  unknown: { stage: "running", message: "OMP stage unavailable." },
  finishing: { stage: "finishing", message: "Agent turn ended." },
  stopped: { stage: "stopped", message: "OMP output ended." },
} as const;
type Stage = keyof typeof stages;

/** An observation only: never forwards event fields or interprets usage as activity.
 * The published 18.1.14/18.2.7 print modes write one JSON event per line. Both
 * agent loops emit assistant message_start on provider stream start, but also
 * synthesize aborted/error boundaries without a stream. Exclude those starts.
 * Owner JobProgressCoalescer supplies observation time; repeated deltas must not
 * reset it. There is no dispatch timestamp or pre-first-event latency here.
 */
export class OmpProgressObserver {
  private readonly frame = Buffer.alloc(OMP_PROGRESS_FRAME_BYTES);
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private length = 0;
  private dropping = false;
  private stage: Stage | undefined;

  constructor(private readonly report: ReportOmpProgress) {}

  observe(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const count = end - offset;
      if (!this.dropping) {
        if (count > this.frame.length - this.length) {
          this.clear();
          this.dropping = true;
          this.unavailable();
        } else {
          chunk.copy(this.frame, this.length, offset, end);
          this.length += count;
        }
      }
      if (newline < 0) return;
      if (!this.dropping) this.event();
      this.clear();
      this.dropping = false;
      offset = end + 1;
    }
  }

  end(): void {
    // An unterminated line is not an authoritative event. Do not interpret it.
    this.clear();
    this.dropping = false;
    if (this.stage !== undefined) this.set("stopped");
  }

  private clear(): void {
    // Keep no transcript bytes between records or after overflow/EOF.
    this.frame.fill(0, 0, this.length);
    this.length = 0;
  }

  private unavailable(): void {
    // A skipped record could have ended the current model/tool activity.
    if (this.stage !== undefined) this.set("unknown");
  }

  private set(stage: Stage): void {
    if (this.stage === stage) return;
    this.stage = stage;
    // Progress is disposable; reporting failure cannot alter child execution.
    try { this.report(stages[stage]); } catch {}
  }

  private event(): void {
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(this.decoder.decode(this.frame.subarray(0, this.length)));
      if (value === null || typeof value !== "object" || Array.isArray(value)) { this.unavailable(); return; }
      event = value as Record<string, unknown>;
    } catch { this.unavailable(); return; }
    const message = event.message !== null && typeof event.message === "object" && !Array.isArray(event.message)
      ? event.message as Record<string, unknown> : undefined;
    switch (event.type) {
      case "message_start":
        if (message?.role === "assistant") {
          this.set(message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "skipped"
            ? "running" : "model");
        }
        break;
      case "message_end":
        if (message?.role === "assistant") this.set("running");
        break;
      case "message_update": {
        const update = event.assistantMessageEvent as { type?: unknown } | null | undefined;
        if (update?.type === "done" || update?.type === "error") this.set("running");
        break;
      }
      case "tool_execution_start":
        this.set("tools");
        break;
      case "tool_execution_end":
      case "turn_end":
      case "turn_start":
      case "agent_start":
        this.set("running");
        break;
      case "agent_end":
        this.set("finishing");
        break;
    }
  }
}

/** Relay original bytes, waiting for each write callback before reading more.
 * Never ends the parent's stdout. A broken destination closes the child's read
 * pipe, as a broken inherited stdout would, without a new cancellation policy.
 */
export async function forwardOmpOutput(source: Readable, destination: Writable, report: ReportOmpProgress, signal: AbortSignal): Promise<void> {
  const observer = new OmpProgressObserver(report);
  const stop = () => source.destroy();
  // Writable emits errors in addition to invoking the write callback.
  const outputError = () => source.destroy();
  destination.on("error", outputError);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    for await (const chunk of source) {
      const bytes = chunk as Buffer;
      observer.observe(bytes);
      await new Promise<void>((resolve, reject) => {
        // One listener per pending write, removed on either completion path.
        // Racing every write against one pending promise would retain handlers.
        const abortWrite = () => {
          signal.removeEventListener("abort", abortWrite);
          reject(new Error("harness_cancelled"));
        };
        signal.addEventListener("abort", abortWrite, { once: true });
        if (signal.aborted) { abortWrite(); return; }
        destination.write(bytes, error => {
          signal.removeEventListener("abort", abortWrite);
          if (error) reject(error);
          else resolve();
        });
      });
    }
    if (signal.aborted) throw new Error("harness_cancelled");
  } finally {
    signal.removeEventListener("abort", stop);
    destination.off("error", outputError);
    observer.end();
  }
}
