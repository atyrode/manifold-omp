import { AGENT_TOOL_MAX_CALLS, WORKER_MAX_PENDING, type AgentToolReply } from "@manifold/protocol";
import type { WorkerContext } from "@manifold/sdk/worker";
import { AgentToolChildMessageSchema, type AgentToolParentMessage } from "../../agent-tools-ipc.ts";

/** Relays only the already-open worker's authority. The caller owns child IPC and
 * must close the relay on disconnect; send must settle on the IPC callback. */
export function createAgentToolRelay(
  context: Pick<WorkerContext, "callAgent" | "signal">,
  send: (message: AgentToolParentMessage) => Promise<void>,
  fail: () => void,
): { receive(message: unknown): void; close(): void } {
  const remembered = new Set<string>();
  const active = new Map<string, AbortController>();
  let sending = 0;
  let closed = false;

  function close(): void {
    if (closed) return;
    closed = true;
    context.signal.removeEventListener("abort", terminate);
    for (const controller of active.values()) controller.abort();
    // No ID can be admitted again after closure. Active entries, however, remain
    // owned until their actual call/send completion, not merely cancellation.
    remembered.clear();
  }

  function terminate(): void {
    if (closed) return;
    close();
    fail();
  }

  async function reply(id: string, value: AgentToolReply): Promise<void> {
    if (closed) return;
    // Refusals also consume outbound capacity: an unresponsive child must not
    // accumulate promises by flooding calls while all worker slots are occupied.
    if (sending >= WORKER_MAX_PENDING) {
      terminate();
      return;
    }
    sending++;
    try {
      await send({ type: "agent_tool_result", id, reply: value });
    } catch {
      terminate();
    } finally {
      sending--;
    }
  }

  async function dispatch(
    id: string,
    request: Parameters<WorkerContext["callAgent"]>[0],
    controller: AbortController,
  ): Promise<void> {
    try {
      let value: AgentToolReply;
      try {
        value = await context.callAgent(request, { signal: controller.signal });
      } catch {
        // Admission has happened. Neither a thrown exception nor cancellation
        // proves that the host did not dispatch an effect; only its reply can.
        value = { type: "unknown", reason: controller.signal.aborted ? "cancelled" : "protocol_error", traceId: null };
      }
      await reply(id, value);
    } finally {
      active.delete(id);
    }
  }

  function receive(message: unknown): void {
    if (closed) return;
    const parsed = AgentToolChildMessageSchema.safeParse(message);
    if (!parsed.success) {
      terminate();
      return;
    }
    const frame = parsed.data;
    if (frame.type === "agent_tool_cancel") {
      // IPC preserves send order. An unknown cancellation is not a reservation
      // for a future ID; a known settled cancellation is a legitimate late race.
      if (!remembered.has(frame.id)) terminate();
      else active.get(frame.id)?.abort();
      return;
    }
    if (remembered.has(frame.id) || remembered.size >= AGENT_TOOL_MAX_CALLS) {
      // Never evict IDs or answer a replay with a refusal: the first call may
      // already have effected something, and both replies would share its ID.
      terminate();
      return;
    }
    remembered.add(frame.id);
    if (sending >= WORKER_MAX_PENDING) {
      terminate();
      return;
    }
    if (active.size >= WORKER_MAX_PENDING) {
      void reply(frame.id, { type: "refused", code: "saturated", traceId: null });
      return;
    }
    const controller = new AbortController();
    active.set(frame.id, controller);
    void dispatch(frame.id, frame.request, controller);
  }

  context.signal.addEventListener("abort", terminate, { once: true });
  if (context.signal.aborted) terminate();
  return { receive, close };
}
