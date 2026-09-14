import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_RUNNER_MAX_FRAME_BYTES, ActionRunnerResponseSchema, type ActionRunnerRequest } from "@manifold/protocol";
import { ADMISSION_CONTEXT_BYTES, writeAdmissionContext } from "../workers/harness/admission.ts";
import { dispatchOmpModelRequest } from "../workers/harness/model.ts";

const discovery = (description: string) => ActionRunnerResponseSchema.parse({
  type: "discovery", id: null, runId: "root-run", protocolVersion: 1,
  actions: [{ name: "core.example", title: "Example", caps: [], scope: "workspace", input: { description }, result: {} }],
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
