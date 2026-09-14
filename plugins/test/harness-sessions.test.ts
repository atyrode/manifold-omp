import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionFile, listSessionSummaries, openSessionsRoot, resolveSessionFile, SESSION_INVENTORY_BYTES } from "../workers/harness/sessions.ts";
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
    expect(listSessionSummaries(root)).toEqual([{
      id: local, title: null, cwd: "/home/job/workspace", updatedAt: Math.floor(statSync(join(directory, "root", filename)).mtimeMs),
    }]);
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
    const updatedAt = "2026-01-01T00:00:00.000Z";
    const title = { type: "title", v: 1, title: "A conversation", updatedAt, pad: "" };
    title.pad = " ".repeat(256 - Buffer.byteLength(`${JSON.stringify(title)}\n`));
    const transcript = `${JSON.stringify(title)}\n${JSON.stringify({ type: "session", version: 3, id, cwd: "/home/job/workspace", timestamp: updatedAt })}\n`;
    writeFileSync(join(directory, "historical-filename.jsonl"), transcript);
    expect(resolveSessionFile(root, id)).toBe("historical-filename.jsonl");
    writeFileSync(join(directory, "copy.jsonl"), transcript);
    expect(() => resolveSessionFile(root, id)).toThrow("ambiguous_session");
    expect(() => listSessionSummaries(root)).toThrow("ambiguous_session");
  } finally { closeSync(root); rmSync(directory, { recursive: true, force: true }); }
});

test("inventory uses only title/header metadata and no-follow file time, independent of message bodies", () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-session-metadata-"));
  const root = openSessionsRoot(directory);
  const updatedAt = 1767225600000;
  const timestamp = "2025-01-01T00:00:00.000Z";
  const current = randomUUID();
  const legacy = randomUUID();
  const cleared = randomUUID();
  try {
    for (const [name, id, title] of [
      ["a-current.jsonl", current, "Current title"],
      ["b-legacy.jsonl", legacy, undefined],
      ["c-cleared.jsonl", cleared, ""],
    ] as const) {
      const path = join(directory, name);
      let prefix = "";
      if (title !== undefined) {
        const slot = { type: "title", v: 1, title, updatedAt: timestamp, pad: "" };
        slot.pad = " ".repeat(256 - Buffer.byteLength(`${JSON.stringify(slot)}\n`));
        prefix = `${JSON.stringify(slot)}\n`;
      }
      writeFileSync(path, `${prefix}${JSON.stringify({
        type: "session", version: 3, id, cwd: "/home/job/workspace", timestamp, title: "Legacy title",
      })}\n${JSON.stringify({
        type: "message", message: { role: "user", content: "Private message, never a title or inventory field." },
      })}\n`);
      // Malformed UTF-8 in a large body must not invalidate the bounded metadata.
      appendFileSync(path, Buffer.alloc(SESSION_INVENTORY_BYTES + 1, 0xff));
      utimesSync(path, updatedAt / 1000, updatedAt / 1000);
    }
    expect(listSessionSummaries(root)).toEqual([
      { id: current, title: "Current title", cwd: "/home/job/workspace", updatedAt },
      { id: legacy, title: "Legacy title", cwd: "/home/job/workspace", updatedAt },
      { id: cleared, title: null, cwd: "/home/job/workspace", updatedAt },
    ]);
  } finally { closeSync(root); rmSync(directory, { recursive: true, force: true }); }
});

test("inventory refuses oversized metadata instead of shortening titles, paths or identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-session-metadata-limit-"));
  const root = openSessionsRoot(directory);
  const path = join(directory, "session.jsonl");
  const header = { type: "session", version: 3, id: randomUUID(), cwd: "/home/job/workspace", timestamp: "2026-01-01T00:00:00.000Z" };
  try {
    writeFileSync(path, `${JSON.stringify({ ...header, title: "t".repeat(257) })}\n`);
    expect(() => listSessionSummaries(root)).toThrow();
    writeFileSync(path, `${JSON.stringify({ ...header, cwd: "/".repeat(1025) })}\n`);
    expect(() => listSessionSummaries(root)).toThrow();
    writeFileSync(path, `${JSON.stringify({ ...header, padding: "x".repeat(16384) })}\n`);
    expect(() => listSessionSummaries(root)).toThrow("session_metadata_limit");
    expect(() => resolveSessionFile(root, header.id)).toThrow("session_metadata_limit");
  } finally { closeSync(root); rmSync(directory, { recursive: true, force: true }); }
});

test("inventory byte bound includes UTF-8 metadata, separators and the output newline without truncation", () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-session-inventory-limit-"));
  const root = openSessionsRoot(directory);
  const updatedAt = 1767225600000;
  const metadata = { title: "é".repeat(256), cwd: "é".repeat(1024), updatedAt };
  const rowBytes = Buffer.byteLength(JSON.stringify({ id: randomUUID(), ...metadata }));
  const count = Math.floor((SESSION_INVENTORY_BYTES - 2) / (rowBytes + 1));
  const expected = [];
  try {
    for (let index = 0; index < count; index++) {
      const id = randomUUID();
      const path = join(directory, `${String(index).padStart(4, "0")}.jsonl`);
      writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, ...metadata, timestamp: "2026-01-01T00:00:00.000Z" })}\n`);
      utimesSync(path, updatedAt / 1000, updatedAt / 1000);
      expected.push({ id, ...metadata });
    }
    const inventory = listSessionSummaries(root);
    expect(inventory).toEqual(expected);
    expect(Buffer.byteLength(`${JSON.stringify(inventory)}\n`)).toBe(2 + count * (rowBytes + 1));
    const path = join(directory, "overflow.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), ...metadata, timestamp: "2026-01-01T00:00:00.000Z" })}\n`);
    utimesSync(path, updatedAt / 1000, updatedAt / 1000);
    expect(() => listSessionSummaries(root)).toThrow("session_inventory_limit");
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
