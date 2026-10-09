import { z } from "zod";

/** The fields of an OMP session journal line the native proof judges. */
export const SealedJournalEntrySchema = z.object({
  type: z.string(), id: z.string().optional(), customType: z.string().optional(), data: z.unknown().optional(),
  message: z.object({
    role: z.string(), toolCallId: z.string().optional(), details: z.unknown().optional(), isError: z.boolean().optional(),
    content: z.unknown().optional(),
  }).optional(),
});
export type SealedJournalEntry = z.infer<typeof SealedJournalEntrySchema>;

type SealedToolResult = { ok: true; result?: SealedJournalEntry } | { ok: false; code: string };

/**
 * Exactly one sealed result per completed model tool call. A `cancelled` call has at most
 * one, and may have none: Manifold cancels a native job with an immediate cgroup kill
 * (agent `job-linux.ts` `terminate`), racing delivery of the in-flight call's `unknown`
 * reply into the SDK child's journal. When the kill lands first, the journal ends at OMP's
 * own durable record of a call whose result the process never wrote: the call's
 * `tool_execution_start` marker with no message after it. That claims no outcome.
 * A failure names the call, what was found and the journal from the call's assistant turn
 * onward, in verifier vocabulary only.
 */
export function sealedToolResult(entries: readonly SealedJournalEntry[], id: string, cancelled = false): SealedToolResult {
  const results = entries.filter(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === id);
  if (results.length === 1) return { ok: true, result: results[0]! };
  const call = entries.findIndex(entry => entry.type === "message" && entry.message?.role === "assistant"
    && Array.isArray(entry.message.content) && entry.message.content.some(part =>
      typeof part === "object" && part !== null && "type" in part && part.type === "toolCall" && "id" in part && part.id === id));
  const after = call < 0 ? [] : entries.slice(call + 1);
  if (cancelled && results.length === 0 && call >= 0 && after.every(entry => entry.type !== "message")
    && after.some(entry => entry.type === "custom" && entry.customType === "tool_execution_start"
      && typeof entry.data === "object" && entry.data !== null && "toolCallId" in entry.data && entry.data.toolCallId === id))
    return { ok: true };
  const found = results.length === 0 ? "missing" : `replayed-${results.length}`;
  return { ok: false, code: `journal-tool-result-${found}-${id}-${call < 0 ? "uncalled" : journalWindow(entries, call)}` };
}

/** a, r, u, m = assistant, toolResult, user, other message; s = OMP's tool_execution_start
 * marker; e = any other entry; z = the journal ends. Five entries from `start`. */
function journalWindow(entries: readonly SealedJournalEntry[], start: number): string {
  let window = "";
  for (const entry of entries.slice(start, start + 5)) {
    const role = entry.type === "message" ? entry.message?.role : undefined;
    window += entry.type === "custom" && entry.customType === "tool_execution_start" ? "s"
      : entry.type !== "message" ? "e"
      : role === "assistant" ? "a" : role === "toolResult" ? "r" : role === "user" ? "u" : "m";
  }
  return start + 5 >= entries.length ? `${window}z` : window;
}
