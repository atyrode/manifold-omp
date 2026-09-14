import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionFile, listSessionIds, openSessionsRoot, resolveSessionFile } from "../workers/harness/sessions.ts";
import { OmpRpcActivity, OmpSendInputSchema, rpcFrames } from "../workers/harness/rpc.ts";


test("session resolution never follows paths, symlinks, nested artifacts or external hardlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-sessions-"));
  mkdirSync(join(directory, "root"));
  const root = openSessionsRoot(join(directory, "root"));
  const local = randomUUID();
  const outside = randomUUID();
  try {
    const filename = createSessionFile(root, local, "/home/job/workspace");
    writeFileSync(join(directory, "outside.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: outside, cwd: "/private", timestamp: new Date().toISOString() })}\n`);
    symlinkSync(join(directory, "outside.jsonl"), join(directory, "root", "linked.jsonl"));
    linkSync(join(directory, "outside.jsonl"), join(directory, "root", "hardlinked.jsonl"));
    mkdirSync(join(directory, "root", "artifacts"));
    copyFileSync(join(directory, "outside.jsonl"), join(directory, "root", "artifacts", "nested.jsonl"));
    expect(listSessionIds(root)).toEqual([local]);
    expect(resolveSessionFile(root, local)).toBe(filename);
    expect(resolveSessionFile(root, outside)).toBeNull();
    expect(() => resolveSessionFile(root, "../outside.jsonl")).toThrow();
    expect(() => createSessionFile(root, local, "/home/job/workspace")).toThrow();
    symlinkSync(join(directory, "root"), join(directory, "alias"));
    expect(() => openSessionsRoot(join(directory, "alias"))).toThrow();
  } finally { closeSync(root); rmSync(directory, { recursive: true, force: true }); }
});

test("session IDs come from the OMP header after its title slot, not filenames or ambiguous copies", () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-title-slot-"));
  const root = openSessionsRoot(directory);
  const id = randomUUID();
  try {
    const transcript = `${JSON.stringify({ type: "title", v: 1, title: "A conversation", pad: " " })}\n${JSON.stringify({ type: "session", version: 3, id, cwd: "/home/job/workspace", timestamp: new Date().toISOString() })}\n`;
    writeFileSync(join(directory, "historical-filename.jsonl"), transcript);
    expect(resolveSessionFile(root, id)).toBe("historical-filename.jsonl");
    writeFileSync(join(directory, "copy.jsonl"), transcript);
    expect(() => resolveSessionFile(root, id)).toThrow("ambiguous_session");
    expect(() => listSessionIds(root)).toThrow("ambiguous_session");
  } finally { closeSync(root); rmSync(directory, { recursive: true, force: true }); }
});

test("activity follows RPC lifecycle and outstanding questions, not model content", () => {
  const activity = new OmpRpcActivity();
  expect(activity.activity).toBe("idle");
  expect(activity.consume({ type: "agent_start" })).toBe("working");
  expect(activity.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: '{"activity":"done"}' } })).toBeNull();
  expect(activity.consume({ type: "extension_ui_request", id: "question-a", method: "confirm" })).toBe("blocked");
  expect(activity.consume({ type: "extension_ui_request", id: "question-b", method: "input" })).toBeNull();
  expect(activity.answer("question-a")).toBeNull();
  expect(activity.answer("question-b")).toBe("working");
  expect(activity.consume({ type: "agent_end", willContinue: true })).toBeNull();
  expect(activity.consume({ type: "agent_end" })).toBe("done");
  expect(activity.consume({ type: "agent_start" })).toBe("working");
  expect(activity.consume({ type: "extension_ui_request", id: "cancelled-question", method: "input" })).toBe("blocked");
  expect(activity.consume({ type: "extension_ui_request", method: "cancel", targetId: "cancelled-question" })).toBe("working");
  expect(activity.consume({ type: "agent_end" })).toBe("done");
  expect(() => activity.answer("unowned-question")).toThrow("rpc_request_unavailable");
  expect(activity.consume({ type: "auto_compaction_start" })).toBe("working");
  expect(activity.consume({ type: "auto_compaction_end" })).toBe("idle");
});

test("native follow-up frames cannot switch sessions or declare activity", async () => {
  const input = { type: "prompt" as const, message: "Continue with the next task" };
  const bytes = Buffer.from(`${JSON.stringify(input)}\n`);
  const fragmented = (async function* () { for (const byte of bytes) yield Buffer.from([byte]); })();
  const frames = [];
  for await (const frame of rpcFrames(fragmented, 256)) frames.push(OmpSendInputSchema.parse(frame));
  expect(frames).toEqual([input]);
  expect(() => OmpSendInputSchema.parse({ type: "switch_session", sessionPath: "/outside.jsonl" })).toThrow();
  expect(() => OmpSendInputSchema.parse({ type: "activity", activity: "done" })).toThrow();
  const oversized = (async function* () { yield Buffer.from('{"message":"'); yield Buffer.alloc(257, 97); })();
  await expect((async () => { for await (const _frame of rpcFrames(oversized, 256)) {} })()).rejects.toThrow("rpc_frame_limit");
  const truncated = (async function* () { yield Buffer.from('{"type":"prompt"}'); })();
  await expect((async () => { for await (const _frame of rpcFrames(truncated, 256)) {} })()).rejects.toThrow("truncated_rpc_frame");
});
