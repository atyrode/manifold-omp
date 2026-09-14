import { randomUUID } from "node:crypto";
import type { ActionRunner } from "@manifold/sdk";
import { ACTION_RUNNER_MAX_FRAME_BYTES, ActionRunnerRequestSchema } from "@manifold/protocol";
import { z } from "zod";

const request = z.union(ActionRunnerRequestSchema.options.map(option =>
  z.strictObject({ ...option.shape, runId: option.shape.runId.optional() }).omit({ id: true }),
));
export const OmpModelToolInputSchema = z.strictObject({ request });
export type OmpModelDispatchOutcome = "running" | "completed" | "failed";

/** The model's owned child handle is optional, but its request id and root binding
 * are launcher-owned. Enforce the runner's own byte boundary after adding them.
 * A settled root is authoritative even if its cleanup closes the RPC reply pipe. */
export async function dispatchOmpModelRequest(
  runner: Pick<ActionRunner, "accept" | "closed" | "successful">,
  raw: unknown,
  rootRunId: string,
  reply: (refused: boolean) => Promise<void>,
): Promise<OmpModelDispatchOutcome> {
  const parsed = OmpModelToolInputSchema.safeParse(raw);
  if (!parsed.success) {
    await reply(true);
    return "failed";
  }
  const frame = { ...parsed.data.request, id: randomUUID(), runId: parsed.data.request.runId ?? rootRunId };
  if (Buffer.byteLength(JSON.stringify(frame)) > ACTION_RUNNER_MAX_FRAME_BYTES) {
    await reply(true);
    return "failed";
  }
  let refused = false;
  try { await runner.accept(frame); }
  catch { refused = true; }
  try { await reply(refused); }
  catch { if (!runner.successful) throw new Error("omp_rpc_reply_failed"); }
  if (runner.closed) return runner.successful ? "completed" : "failed";
  return refused ? "failed" : "running";
}
