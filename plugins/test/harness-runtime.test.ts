import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_RUNNER_MAX_FRAME_BYTES, ActionRunnerResponseSchema, WORKER_MAX_PENDING, type ActionRunnerRequest, type AgentToolReply } from "@manifold/protocol";
import { ADMISSION_CONTEXT_BYTES, writeAdmissionContext } from "../workers/harness/admission.ts";
import { dispatchOmpModelRequest } from "../workers/harness/model.ts";
import { createSessionFile, openSessionsRoot, prepareSessionFile } from "../workers/harness/sessions.ts";
import { createAgentToolRelay } from "../workers/harness/agent-tools.ts";

const discovery = (description: string) => ActionRunnerResponseSchema.parse({
  type: "discovery", id: null, runId: "root-run", protocolVersion: 1,
  actions: [{ name: "core.example", title: "Example", caps: [], scope: "workspace", input: { description }, result: {} }],
});

test("operator resume rejects missing UUIDs without creating or changing transcripts", () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-resume-missing-"));
  const root = openSessionsRoot(directory);
  const id = randomUUID();
  const missing = randomUUID();
  try {
    const filename = createSessionFile(root, id, "/home/job/workspace");
    const transcript = readFileSync(join(directory, filename));
    expect(() => prepareSessionFile(root, missing, "/home/job/workspace", true)).toThrow("session_unavailable");
    expect(existsSync(join(directory, `${missing}.jsonl`))).toBe(false);
    expect(readFileSync(join(directory, filename))).toEqual(transcript);
  } finally { closeSync(root); rmSync(directory, { recursive: true, force: true }); }
});


test("admission carries live schemas larger than an RPC frame and exact policy in a private ephemeral file", () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-admission-"));
  const path = join(directory, "admission.txt");
  const frames = [discovery("schema".repeat(200_000)), ActionRunnerResponseSchema.parse({
    type: "policy", id: null, runId: "root-run", door: "core.access.policy", target: "manifold://", traceId: 1,
    policy: { runId: "root-run", revision: "a".repeat(64), issuedAt: 1,
      required: [{ id: "operator", source: "operator", digest: "b".repeat(64), body: "Read and explicitly acknowledge this exact policy." }] },
  })];
  try {
    const file = writeAdmissionContext(frames, path);
    try {
      const contents = readFileSync(file.path, "utf8");
      expect(Buffer.byteLength(contents)).toBeGreaterThan(1024 * 1024);
      expect(contents.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line))).toEqual(frames);
      expect(statSync(file.path).mode & 0o777).toBe(0o600);
    } finally { file.close(); }
    expect(existsSync(path)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("oversized admission and preexisting symlinks leave no truncated or overwritten context", () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-admission-refusal-"));
  const path = join(directory, "admission.txt");
  const protectedPath = join(directory, "protected");
  try {
    expect(() => writeAdmissionContext([discovery("x".repeat(ADMISSION_CONTEXT_BYTES))], path)).toThrow("harness_admission_limit");
    expect(existsSync(path)).toBe(false);
    writeFileSync(protectedPath, "unchanged");
    symlinkSync(protectedPath, path);
    expect(() => writeAdmissionContext([discovery("small")], path)).toThrow();
    expect(readFileSync(protectedPath, "utf8")).toBe("unchanged");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the full model request byte limit includes generated id, default root handle, and UTF-8 bytes", async () => {
  const accepted: ActionRunnerRequest[] = [];
  const runner = { closed: false, successful: false, async accept(frame: ActionRunnerRequest) { accepted.push(frame); } };
  const replies: boolean[] = [];
  const reply = async (refused: boolean) => { replies.push(refused); };
  const request = { type: "invoke" as const, door: "core.example", target: "manifold://", args: "" };
  const runId = "r".repeat(128);
  expect(await dispatchOmpModelRequest(runner, { request }, runId, reply)).toBe("running");
  request.args = "é".repeat(Math.floor((ACTION_RUNNER_MAX_FRAME_BYTES - Buffer.byteLength(JSON.stringify(request)) - 32) / 2));
  expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(ACTION_RUNNER_MAX_FRAME_BYTES);
  expect(await dispatchOmpModelRequest(runner, { request }, runId, reply)).toBe("failed");
  expect(accepted).toHaveLength(1);
  expect(replies).toEqual([false, true]);
});

test("a successful root finish replies before returning terminal success, even when cleanup closes the reply pipe", async () => {
  const events: string[] = [];
  const runner = { closed: false, successful: false, async accept(_frame: ActionRunnerRequest) {
    events.push("finish"); this.closed = true; this.successful = true;
  } };
  const request = { type: "finish", outcome: "completed" };
  expect(await dispatchOmpModelRequest(runner, { request }, "root-run", async refused => {
    expect(refused).toBe(false); events.push("reply");
  })).toBe("completed");
  expect(events).toEqual(["finish", "reply"]);
  expect(await dispatchOmpModelRequest(runner, { request }, "root-run", async () => {
    throw new Error("closed pipe");
  })).toBe("completed");
});

test("a failed root finish is not mistaken for successful shutdown", async () => {
  const runner = { closed: false, successful: false, async accept(_frame: ActionRunnerRequest) { this.closed = true; } };
  expect(await dispatchOmpModelRequest(runner, { request: { type: "finish", outcome: "failed" } }, "root-run", async () => {})).toBe("failed");
});

const effectReply: AgentToolReply = { type: "result", door: "fixture.proof.record", traceId: 1, outcome: { ok: true } };
const toolCall = (id = randomUUID()) => ({
  type: "agent_tool_call", id, request: { type: "invoke", door: "fixture.proof.record", args: {} },
});
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("replaying a settled child request terminates the relay without repeating its effect", async () => {
  let effects = 0;
  let failures = 0;
  const delivered = Promise.withResolvers<void>();
  const relay = createAgentToolRelay({
    signal: new AbortController().signal,
    async callAgent() { effects++; return effectReply; },
  }, async () => { delivered.resolve(); }, () => { failures++; });
  const call = toolCall();
  try {
    relay.receive(call);
    await delivered.promise;
    await settle();
    relay.receive(call);
    relay.receive(toolCall());
    expect(effects).toBe(1);
    expect(failures).toBe(1);
  } finally { relay.close(); }
});

test("cancelling an unanswered call cannot free its slot for another host effect", async () => {
  let effects = 0;
  let failures = 0;
  const outstanding = Promise.withResolvers<AgentToolReply>();
  const overflow = toolCall();
  const refused = Promise.withResolvers<AgentToolReply>();
  const relay = createAgentToolRelay({
    signal: new AbortController().signal,
    async callAgent() { effects++; return outstanding.promise; },
  }, async message => { if (message.id === overflow.id) refused.resolve(message.reply); }, () => { failures++; });
  const first = toolCall();
  try {
    relay.receive(first);
    for (let index = 1; index < WORKER_MAX_PENDING; index++) relay.receive(toolCall());
    relay.receive({ type: "agent_tool_cancel", id: first.id });
    relay.receive(overflow);
    expect(await refused.promise).toEqual({ type: "refused", code: "saturated", traceId: null });
    expect(effects).toBe(WORKER_MAX_PENDING);
    expect(failures).toBe(0);
  } finally {
    relay.close();
    outstanding.resolve(effectReply);
    await settle();
  }
});

test("unconfirmed child delivery bounds further host effects and fails closed", async () => {
  let effects = 0;
  let failures = 0;
  let sends = 0;
  const blocked = Promise.withResolvers<void>();
  const full = Promise.withResolvers<void>();
  const relay = createAgentToolRelay({
    signal: new AbortController().signal,
    async callAgent() { effects++; return effectReply; },
  }, async () => {
    if (++sends === WORKER_MAX_PENDING) full.resolve();
    await blocked.promise;
  }, () => { failures++; });
  try {
    for (let index = 0; index < WORKER_MAX_PENDING; index++) relay.receive(toolCall());
    await full.promise;
    relay.receive(toolCall());
    expect(effects).toBe(WORKER_MAX_PENDING);
    expect(failures).toBe(1);
  } finally {
    relay.close();
    blocked.resolve();
    await settle();
  }
});

test("cancellation after a host effect remains unknown rather than a non-effect refusal", async () => {
  let effects = 0;
  let failures = 0;
  const delivered = Promise.withResolvers<AgentToolReply>();
  const relay = createAgentToolRelay({
    signal: new AbortController().signal,
    async callAgent(_request, options) {
      effects++;
      return new Promise<AgentToolReply>((_resolve, reject) => {
        if (!options?.signal) throw new Error("fixture requires cancellable host admission");
        options.signal.addEventListener("abort", () => reject(new Error("effect already admitted")), { once: true });
      });
    },
  }, async message => { delivered.resolve(message.reply); }, () => { failures++; });
  const call = toolCall();
  try {
    relay.receive(call);
    relay.receive({ type: "agent_tool_cancel", id: call.id });
    expect(await delivered.promise).toEqual({ type: "unknown", reason: "cancelled", traceId: null });
    expect(effects).toBe(1);
    expect(failures).toBe(0);
  } finally { relay.close(); }
});
