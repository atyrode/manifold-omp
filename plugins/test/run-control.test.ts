import { expect, jest, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { JOB_PROGRESS_INTERVAL_MS, PublicJobSchema, type JobFollowUpdate, type Principal } from "@manifold/protocol";
import { JobProgressCoalescer } from "../../../manifold/packages/agent/src/job-progress.ts";
import { OMP_PLUGIN_ID, RefusalSchema, RunDialsSchema } from "../api/index.ts";
import { handlers } from "../atyrode.omp/server.ts";
import type { OmpContext } from "../atyrode.omp/machine-server.ts";
import { controlProgress, controlReplies, readControlProgress, RunControlFrameSchema, sessionDials } from "../workers/harness/control.ts";
import { OmpSendInputSchema } from "../workers/harness/rpc.ts";

const controlRun = handlers.controlRun!;
const runId = "fixture-run";
const node = { kind: "job" as const, machineId: "fixture-machine", operationId: `${OMP_PLUGIN_ID}.harness`, jobId: "fixture-job" };
const human: Principal = { id: "fixture-sponsor", kind: "human", name: "Sponsor", color: "#336699" };

/** A started TUI harness job behind Manifold's real Run-input rule, played by `admitted`. The
 * harness answers each control frame on the job's progress the way the worker does. */
function doorFixture(options: {
  principal?: Principal;
  agentRun?: { runId: string; agentId: string } | null;
  admitted?: boolean;
  answer?: (frame: { id: string; model?: string; thinking?: string }) => JobFollowUpdate | null;
} = {}) {
  const writes: { seq: number; frame: unknown }[] = [];
  const reads: string[] = [];
  let receive: ((update: JobFollowUpdate) => void) | undefined;
  let following = 0;
  const ctx = {
    pluginId: OMP_PLUGIN_ID,
    agentRun: options.agentRun ?? null,
    auth: { principal: options.principal ?? human, caps: ["*"], containerScope: null, isRoot: false, allows: async () => true },
    newId: async () => randomUUID(),
    jobs: {
      runTerminal: async (id: string) => {
        reads.push(`runTerminal:${id}`);
        // Manifold's `authorizeRunInput`: a caller it does not admit learns only that there is no Run.
        if (options.admitted === false) throw new Error("forbidden: agent_unavailable");
        return node;
      },
      status: async () => PublicJobSchema.parse({
        jobId: node.jobId, machineId: node.machineId, operationId: node.operationId, pluginId: OMP_PLUGIN_ID, installationRevision: "fixture-installation", artifactSha256: "a".repeat(64),
        inputDigest: "b".repeat(64), resourceBindingDigest: "c".repeat(64), state: "started", nextInputSeq: 3, result: null,
        authority: { origin: { kind: "action", traceId: "fixture-trace", door: "core.terminals.create" },
          requester: human.id, executor: null, decision: null },
      }),
      follow: async (_node: unknown, listener: (update: JobFollowUpdate) => void) => {
        following++;
        receive = listener;
        return { snapshot: { jobId: node.jobId, state: "started", result: null, inferenceUsage: null, seq: 0, firstSeq: null,
          events: [], unavailable: null }, close: async () => { following--; } };
      },
      input: async ({ seq, data }: { seq: number; data: string }) => {
        const frame = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as { id: string };
        writes.push({ seq, frame });
        const update = options.answer?.(frame);
        if (update) receive?.(update);
        return { accepted: true };
      },
    },
  } as unknown as OmpContext;
  return { ctx, writes, reads, following: () => following };
}
const progress = (frame: { id: string }, message: string): JobFollowUpdate => ({
  type: "event", seq: 1, event: { type: "job_progress", jobId: node.jobId, requestDigest: "d".repeat(64), ownerId: "fixture-owner",
    ownerGeneration: 1, stage: `control ${frame.id}`, message, at: 1 },
});
/** The worker's answer for a frame it applied: the session now runs exactly what was asked. */
const applied = (frame: { id: string; model?: string; thinking?: string }) => progress(frame, controlProgress(frame.id,
  { ok: true, dials: RunDialsSchema.parse({ model: frame.model ?? "fixture/openai/gpt-5", thinking: frame.thinking ?? "low" }) }).message);

test("controlRun's human-sponsorship rule: only the Run's launcher or a sponsor turns its dials, never an Agent principal or its own Run", async () => {
  const change = { runId, model: "fixture/openai/o3", thinking: "high" as const };
  // The Run's own credential, so a session's model cannot choose its own model; any other Agent principal too.
  for (const caller of [
    { principal: { ...human, id: "run-principal", kind: "agent" as const }, agentRun: { runId, agentId: "fixture-agent" } },
    { principal: { ...human, id: "other-run-principal", kind: "agent" as const }, agentRun: { runId: "other-run", agentId: "fixture-agent" } },
    { principal: { ...human, id: "runner-principal", kind: "agent" as const } },
    { principal: { ...human, id: "service-principal", kind: "service" as const } },
  ]) {
    const f = doorFixture({ ...caller, answer: applied });
    expect(await controlRun(f.ctx, change)).toEqual({ refused: "omp_run_control_forbidden" });
    expect(f.reads).toEqual([]);
    expect(f.writes).toEqual([]);
  }
  // A human Manifold does not admit to the Run's terminal input finds no session and writes nothing.
  const outsider = doorFixture({ admitted: false, answer: applied });
  expect(await controlRun(outsider.ctx, change)).toEqual({ refused: "omp_session_unavailable" });
  expect(outsider.writes).toEqual([]);
  // The Run's launcher or a sponsor of its Agent: one frame, at the job's input cursor, answered by the session.
  const sponsor = doorFixture({ answer: applied });
  expect(await controlRun(sponsor.ctx, change)).toEqual({ model: "fixture/openai/o3", thinking: "high" });
  expect(sponsor.reads).toEqual([`runTerminal:${runId}`]);
  expect(sponsor.writes).toHaveLength(1);
  expect(sponsor.writes[0]!.seq).toBe(3);
  const frame = RunControlFrameSchema.parse(sponsor.writes[0]!.frame);
  expect(frame).toEqual({ type: "control", id: frame.id, model: "fixture/openai/o3", thinking: "high" });
  expect(sponsor.following()).toBe(0);
});

test("a refused change returns the session's reason, and no answer is never success", async () => {
  const unserved = doorFixture({ answer: frame => progress(frame, "refused model_unavailable") });
  expect(await controlRun(unserved.ctx, { runId, model: "fixture/openai/not-served" }))
    .toEqual({ refused: "omp_model_unavailable" });
  const headless = doorFixture({ answer: frame => progress(frame, "refused unsupported") });
  expect(await controlRun(headless.ctx, { runId, thinking: "low" })).toEqual({ refused: "omp_run_control_unsupported" });
  // Another frame's answer is not this one's; a closed subscription ends the wait unconfirmed.
  const elsewhere = doorFixture({ answer: () => ({ type: "closed", reason: "closed" }) });
  expect(await controlRun(elsewhere.ctx, { runId, thinking: "low" })).toEqual({ refused: "omp_run_control_unconfirmed" });
  const forged = doorFixture({ answer: frame => progress(frame, "applied high not a reference") });
  expect(await controlRun(forged.ctx, { runId, thinking: "high" })).toEqual({ refused: "omp_run_control_unconfirmed" });
  for (const f of [unserved, headless, elsewhere, forged]) expect(f.following()).toBe(0);
  // An empty change is not a change.
  expect(RefusalSchema.parse(await controlRun(doorFixture().ctx, { runId } as never))).toEqual({ refused: "omp_invalid_request" });
});

test("a dial reply fits one progress line and reads back exactly, never truncated", () => {
  const id = randomUUID();
  const longest = `p/${"m".repeat(238)}`;
  for (const dials of [{ model: "fixture/openai/o3", thinking: "auto" as const }, { model: longest, thinking: "minimal" as const }, { model: null, thinking: null }]) {
    const line = controlProgress(id, { ok: true, dials: RunDialsSchema.parse(dials) });
    expect(line.stage).toBe(`control ${id}`);
    expect(line.message.length).toBeLessThanOrEqual(256);
    expect(readControlProgress(line.message)).toEqual({ ok: true, dials });
  }
  // A reference the reply cannot carry reads null rather than a truncated name.
  expect(sessionDials({ provider: "p", id: "m".repeat(239) }, "inherit")).toEqual({ model: null, thinking: null });
  expect(readControlProgress(controlProgress(id, { ok: false, reason: "model_unavailable" }).message))
    .toEqual({ ok: false, reason: "model_unavailable" });
  for (const message of [undefined, "", "refused not_a_reason", "applied", "applied high fixture/x extra"]) expect(readControlProgress(message)).toBeNull();
});

test("each control reply opens its own progress window, so the owner never folds one into the next", async () => {
  jest.useFakeTimers();
  try {
    let now = 0;
    const advance = async (ms: number) => {
      now += ms;
      jest.advanceTimersByTime(ms);
      const settled = Promise.withResolvers<void>();
      setImmediate(settled.resolve);
      await settled.promise;
    };
    // The job owner's own coalescer on the test's clock: at most one line per window, the newest kept.
    const clock = { now: () => now, after(ms: number, fn: () => void) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
    const owner = () => {
      const published: string[] = [];
      const coalescer = new JobProgressCoalescer(line => published.push(line.stage), { clock });
      return { published, report: (line: { stage: string; message: string }) => coalescer.report({ type: "progress", ...line }) };
    };
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const outcome = { ok: true as const, dials: RunDialsSchema.parse({ model: "fixture/openai/o3", thinking: "high" }) };
    // Three changes answered back to back: the owner publishes the newest reply only.
    const direct = owner();
    for (const id of ids) direct.report(controlProgress(id, outcome));
    await advance(JOB_PROGRESS_INTERVAL_MS);
    expect(direct.published).toEqual([`control ${ids[2]}`]);
    // Paced, each reply waits out the previous one's window, so every door reads its own stage.
    const paced = owner();
    const reply = controlReplies(paced.report, () => now);
    const answering = (async () => { for (const id of ids) await reply(id, outcome); })();
    for (let step = 0; step < 3 * JOB_PROGRESS_INTERVAL_MS / 1_000; step++) await advance(1_000);
    await answering;
    expect(paced.published).toEqual(ids.map(id => `control ${id}`));
  } finally {
    jest.useRealTimers();
  }
});

test("a control frame names only reviewed dials under a lowercase id, on the descriptor both harness modes parse", () => {
  const id = randomUUID();
  expect(OmpSendInputSchema.parse({ type: "control", id, thinking: "off" })).toEqual({ type: "control", id, thinking: "off" });
  for (const frame of [
    { type: "control", id },
    { type: "control", id: id.toUpperCase(), thinking: "low" },
    { type: "control", id, thinking: "low", sessionId: randomUUID() },
    { type: "control", id, model: "no-provider" },
    { type: "control", id, model: `p/${"m".repeat(199)}` },
  ]) expect(OmpSendInputSchema.safeParse(frame).success).toBe(false);
});
