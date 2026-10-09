import { expect, test } from "bun:test";
import { sealedToolResult, type SealedJournalEntry } from "../scripts/sealed-journal.ts";

// Journal shapes as OMP 18.8.6 seals them for the native tool proof.
const head: SealedJournalEntry[] = [
  { type: "session", id: "session" }, { type: "model_change" }, { type: "thinking_level_change" },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "NATIVE-TOOL-COMPOSITION-PROOF" }] } },
];
const call = (id: string): SealedJournalEntry[] => [
  { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "manifold_fixture_omp_tools_commit" }] } },
  { type: "custom", customType: "tool_execution_start", data: { toolCallId: id, toolName: "manifold_fixture_omp_tools_commit" } },
];
const result = (id: string, reason = "cancelled"): SealedJournalEntry =>
  ({ type: "message", message: { role: "toolResult", toolCallId: id, details: { type: "unknown", reason, traceId: null } } });
const turn: SealedJournalEntry = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } };

test("a completed call has exactly one sealed result", () => {
  const sealed = [...head, ...call("selected"), result("selected"), turn];
  expect(sealedToolResult(sealed, "selected")).toEqual({ ok: true, result: result("selected") });
  expect(sealedToolResult([...head, ...call("selected"), turn], "selected"))
    .toEqual({ ok: false, code: "journal-tool-result-missing-selected-asaz" });
  expect(sealedToolResult([...head, ...call("selected"), result("selected"), result("selected", "interrupted")], "selected"))
    .toEqual({ ok: false, code: "journal-tool-result-replayed-2-selected-asrrz" });
  expect(sealedToolResult([...head, turn], "selected")).toEqual({ ok: false, code: "journal-tool-result-missing-selected-uncalled" });
});

test("a cancelled call is sealed unknown, or left pending when the job's kill lands first", () => {
  // Manifold cancels a native job with an immediate cgroup kill. The in-flight reply's
  // `unknown` result reaches the journal only if the SDK child writes it first.
  expect(sealedToolResult([...head, ...call("uncertain"), result("uncertain")], "uncertain", true))
    .toEqual({ ok: true, result: result("uncertain") });
  expect(sealedToolResult([...head, ...call("uncertain")], "uncertain", true)).toEqual({ ok: true });
  // Pending is OMP's own record only while nothing follows the started call.
  expect(sealedToolResult([...head, ...call("uncertain"), turn], "uncertain", true))
    .toEqual({ ok: false, code: "journal-tool-result-missing-uncertain-asaz" });
  expect(sealedToolResult([...head, ...call("uncertain").slice(0, 1)], "uncertain", true))
    .toEqual({ ok: false, code: "journal-tool-result-missing-uncertain-az" });
  const exit: SealedJournalEntry = { type: "custom", customType: "session_exit", data: { reason: "SIGTERM", kind: "signal" } };
  expect(sealedToolResult([...head, ...call("uncertain"), exit], "uncertain", true)).toEqual({ ok: true });
  expect(sealedToolResult([...head, ...call("other"), ...call("uncertain").slice(0, 1)], "uncertain", true))
    .toEqual({ ok: false, code: "journal-tool-result-missing-uncertain-az" });
  expect(sealedToolResult([...head, ...call("uncertain"), result("uncertain"), result("uncertain", "interrupted")], "uncertain", true))
    .toEqual({ ok: false, code: "journal-tool-result-replayed-2-uncertain-asrrz" });
  // A completed call is never excused by a start marker.
  expect(sealedToolResult([...head, ...call("selected")], "selected"))
    .toEqual({ ok: false, code: "journal-tool-result-missing-selected-asz" });
});
