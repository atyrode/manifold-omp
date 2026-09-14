import { z } from "zod";

export const RPC_FRAME_BYTES = 1024 * 1024;
export const OmpSendInputSchema = z.union([
  z.strictObject({ type: z.literal("prompt"), message: z.string().min(1).max(16384) }),
  z.strictObject({ type: z.literal("steer"), message: z.string().min(1).max(16384) }),
  z.strictObject({ type: z.literal("follow_up"), message: z.string().min(1).max(16384) }),
  z.strictObject({ type: z.literal("abort") }),
  z.strictObject({ type: z.literal("extension_ui_response"), id: z.string().min(1).max(128), value: z.string().max(16384) }),
  z.strictObject({ type: z.literal("extension_ui_response"), id: z.string().min(1).max(128), confirmed: z.boolean() }),
  z.strictObject({ type: z.literal("extension_ui_response"), id: z.string().min(1).max(128), cancelled: z.literal(true) }),
]);
export type OmpActivity = "working" | "blocked" | "done" | "idle";

/** Only the wrapper's dedicated child stdout is passed here, never terminal bytes
 * or a model-authored activity declaration. Content fields are not interpreted. */
export class OmpRpcActivity {
  #activity: OmpActivity = "idle";
  #working = false;
  #waiting = new Set<string>();
  #maintenance = new Set<string>();
  get activity(): OmpActivity { return this.#activity; }
  consume(frame: Record<string, unknown>): OmpActivity | null {
    let next = this.#activity;
    switch (frame.type) {
      case "agent_start":
        this.#working = true;
        next = this.#waiting.size ? "blocked" : "working";
        break;
      case "auto_compaction_start":
      case "auto_retry_start":
        this.#maintenance.add(frame.type.replace(/_start$/, ""));
        next = this.#waiting.size ? "blocked" : "working";
        break;
      case "agent_end":
        this.#working = frame.willContinue === true;
        if (!this.#working) this.#waiting.clear();
        next = this.#waiting.size ? "blocked" : this.#working || this.#maintenance.size ? "working" : "done";
        break;
      case "auto_retry_end":
      case "auto_compaction_end":
        this.#maintenance.delete(frame.type.replace(/_end$/, ""));
        next = this.#waiting.size ? "blocked" : this.#working || this.#maintenance.size ? "working" : "idle";
        break;
      case "extension_ui_request":
        if (["select", "confirm", "input", "editor"].includes(String(frame.method)) && typeof frame.id === "string") {
          if (this.#waiting.size >= 64) throw new Error("rpc_pending_limit");
          this.#waiting.add(frame.id);
          next = "blocked";
        } else if (frame.method === "cancel" && typeof frame.targetId === "string") {
          this.#waiting.delete(frame.targetId);
          next = this.#waiting.size ? "blocked" : this.#working || this.#maintenance.size ? "working" : "idle";
        }
        break;
    }
    if (next === this.#activity) return null;
    this.#activity = next;
    return next;
  }
  answer(id: string): OmpActivity | null {
    if (!this.#waiting.delete(id)) throw new Error("rpc_request_unavailable");
    const next = this.#waiting.size ? "blocked" : this.#working || this.#maintenance.size ? "working" : "idle";
    if (next === this.#activity) return null;
    this.#activity = next;
    return next;
  }
}

/** Byte-bounded JSONL: no unbounded readline allocation before enforcing a limit. */
export async function* rpcFrames(stream: AsyncIterable<Uint8Array>, maxBytes = RPC_FRAME_BYTES): AsyncGenerator<Record<string, unknown>> {
  const pending = Buffer.allocUnsafe(maxBytes);
  let pendingBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of stream) {
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      const bytes = chunk.subarray(start, index);
      if (pendingBytes + bytes.length > maxBytes) throw new Error("rpc_frame_limit");
      let complete = bytes;
      if (pendingBytes) {
        pending.set(bytes, pendingBytes);
        complete = pending.subarray(0, pendingBytes + bytes.length);
      }
      const value: unknown = JSON.parse(decoder.decode(complete));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_rpc_frame");
      yield value as Record<string, unknown>;
      pendingBytes = 0;
      start = index + 1;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      if (pendingBytes + rest.length > maxBytes) throw new Error("rpc_frame_limit");
      pending.set(rest, pendingBytes);
      pendingBytes += rest.length;
    }
  }
  if (pendingBytes) throw new Error("truncated_rpc_frame");
}
