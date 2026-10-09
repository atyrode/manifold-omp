import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ActionRunnerRequestSchema, ActionRunnerResponseSchema, MANIFOLD_ROOT_URI, ReportRunActivityRequestSchema, ReportRunActivityV2RequestSchema,
} from "@manifold/protocol";
import { RENEWAL_JUSTIFICATION, RunLifecycle } from "../workers/harness/lifecycle.ts";

const runId = "fixture-run";
const LEASE_MS = 60_000;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

/** What the hub answers one call: a result frame, refused under a rule (`forbidden` unless named), no
 * result frame at all, or a thrown runner error. */
type Answer = { ok: true; expiresAt?: number } | { ok: false; rule?: "refused" | "unavailable" | "forbidden" } | "silent" | "throw";

/**
 * An adopted `ActionRunner` as the lifecycle drives it: each call emits its result frame before it
 * resolves, and the hub's clock is the lifecycle's. `hold` keeps the next call in flight.
 */
function lifecycleFixture(options: {
  renew?: (now: number) => Answer;
  /** `model` is the `provider/model` the report carried, if any. */
  activity?: (count: number, model: string | undefined) => Answer;
  lease?: { expiresAt: number; lifetimeMs: number };
} = {}) {
  let now = 0;
  let activities = 0;
  let hold: Promise<void> | undefined;
  const sent: string[] = [];
  const runner = {
    closed: false,
    async accept(frame: unknown) {
      const request = ActionRunnerRequestSchema.parse(frame);
      if (request.type !== "renew") throw new Error("unexpected runner frame");
      sent.push(`${request.id} ${request.lifetimeMs} ${request.justification}`);
      await hold;
      answer(request.id, "core.access.renewAgentRunV2", options.renew?.(now) ?? { ok: true, expiresAt: now + LEASE_MS });
    },
    async reportActivity(input: unknown) {
      const report = ReportRunActivityV2RequestSchema.parse(input);
      if (report.runId !== runId) throw new Error("activity for another Run");
      const model = report.model && `${report.model.provider}/${report.model.model}`;
      sent.push(model ? `${report.activity} ${model}` : report.activity);
      await hold;
      answer(null, "core.access.reportRunActivityV2", options.activity?.(++activities, model) ?? { ok: true });
    },
  };
  const lifecycle = new RunLifecycle(runner, runId, options.lease ?? { expiresAt: LEASE_MS, lifetimeMs: LEASE_MS }, () => now);
  function answer(id: string | null, door: string, value: Answer) {
    if (value === "throw") throw new Error("fixture-transport-failed");
    if (value === "silent") return;
    lifecycle.observe(ActionRunnerResponseSchema.parse({ type: "result", id, runId, door, target: MANIFOLD_ROOT_URI, traceId: 1,
      outcome: value.ok ? { ok: true } : { ok: false, denial: { rule: value.rule ?? "forbidden" } },
      ...("expiresAt" in value && value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}) }));
  }
  return {
    lifecycle, runner, sent,
    async advance(ms: number) { now += ms; jest.advanceTimersByTime(ms); await settle(); },
    hold(gate: Promise<void> | undefined) { hold = gate; },
    /** Bind's discovery, from a hub whose activity door takes a `model` or from one that predates it. */
    discover(takesModel: boolean) {
      const input = z.toJSONSchema(takesModel ? ReportRunActivityV2RequestSchema : ReportRunActivityRequestSchema, { io: "input" });
      lifecycle.observe(ActionRunnerResponseSchema.parse({ type: "discovery", id: null, runId: null, protocolVersion: 57, actions: [
        { name: "core.access.reportRunActivityV2", title: "Report Run activity", caps: [], input, result: {} },
      ] }));
    },
  };
}
const renewal = (index: number) => `renew-${index} ${LEASE_MS} ${RENEWAL_JUSTIFICATION}`;

test("renews at half of each lease with its justification, then from each renewal's own expiry", async () => {
  const f = lifecycleFixture();
  f.lifecycle.start();
  await f.advance(LEASE_MS / 2 - 1);
  expect(f.sent).toEqual([]);
  await f.advance(1);
  expect(f.sent).toEqual([renewal(1)]);
  // Renewed at 30 s to 90 s: the next renewal is due at 60 s, not 30 s after the first expiry.
  await f.advance(LEASE_MS / 2 - 1);
  expect(f.sent).toEqual([renewal(1)]);
  await f.advance(1);
  expect(f.sent).toEqual([renewal(1), renewal(2)]);
});

test("a lease already past its half renews a second later, never in a tight loop", async () => {
  const f = lifecycleFixture({ lease: { expiresAt: 10_000, lifetimeMs: LEASE_MS }, renew: now => ({ ok: true, expiresAt: now + 10_000 }) });
  f.lifecycle.start();
  await f.advance(999);
  expect(f.sent).toEqual([]);
  await f.advance(1);
  expect(f.sent).toEqual([renewal(1)]);
  await f.advance(1_000);
  expect(f.sent).toEqual([renewal(1), renewal(2)]);
});

test.each([
  ["refused", { ok: false }],
  ["answered without an expiry", { ok: true }],
  ["unanswered", "silent"],
  ["failed", "throw"],
] as const)("a %s renewal ends renewal, never the activity reports", async (_, answer) => {
  const f = lifecycleFixture({ renew: () => answer });
  f.lifecycle.start();
  await f.advance(LEASE_MS / 2);
  await f.advance(10 * LEASE_MS);
  expect(f.sent).toEqual([renewal(1)]);
  f.lifecycle.report("working");
  await settle();
  expect(f.sent).toEqual([renewal(1), "working"]);
});

test.each([
  ["refused", { ok: false }],
  ["unanswered", "silent"],
  ["failed", "throw"],
] as const)("a %s activity report ends reporting, never renewal", async (_, answer) => {
  const f = lifecycleFixture({ activity: count => count === 1 ? answer : { ok: true } });
  f.lifecycle.start();
  f.lifecycle.report("idle");
  f.lifecycle.report("working");
  await settle();
  expect(f.sent).toEqual(["idle"]);
  await f.advance(LEASE_MS / 2);
  expect(f.sent).toEqual(["idle", renewal(1)]);
});

test("past 64 open dialogs reporting ends on blocked, never the session and never renewal", async () => {
  const f = lifecycleFixture();
  f.lifecycle.start();
  f.lifecycle.track({ type: "agent_start" });
  const dialogs = Array.from({ length: 65 }, () => randomUUID());
  // The child's message listener calls this directly: a throw would reach the operator's terminal.
  for (const id of dialogs) expect(() => f.lifecycle.track({ type: "extension_ui_request", method: "select", id })).not.toThrow();
  for (const id of dialogs) f.lifecycle.track({ type: "extension_ui_request", method: "cancel", targetId: id });
  f.lifecycle.track({ type: "agent_end", willContinue: false });
  await settle();
  expect(f.sent).toEqual(["working", "blocked"]);
  await f.advance(LEASE_MS / 2);
  expect(f.sent).toEqual(["working", "blocked", renewal(1)]);
});

test("frames never overlap: a report waits for the renewal in flight, then applies in order", async () => {
  const f = lifecycleFixture();
  const gate = Promise.withResolvers<void>();
  f.lifecycle.start();
  f.hold(gate.promise);
  await f.advance(LEASE_MS / 2);
  f.lifecycle.report("working");
  f.lifecycle.report("done");
  await settle();
  expect(f.sent).toEqual([renewal(1)]);
  f.hold(undefined);
  gate.resolve();
  await settle();
  expect(f.sent).toEqual([renewal(1), "working", "done"]);
});

test("stop cancels the pending renewal and settles every queued report before the runner closes", async () => {
  const f = lifecycleFixture();
  const gate = Promise.withResolvers<void>();
  f.lifecycle.start();
  f.hold(gate.promise);
  f.lifecycle.report("done");
  let stopped = false;
  const stopping = f.lifecycle.stop().then(() => { stopped = true; });
  await settle();
  expect(stopped).toBe(false);
  gate.resolve();
  await stopping;
  expect(f.sent).toEqual(["done"]);
  await f.advance(10 * LEASE_MS);
  expect(f.sent).toEqual(["done"]);
});

test("stop during a renewal in flight arms no further renewal once it is answered", async () => {
  const f = lifecycleFixture();
  const gate = Promise.withResolvers<void>();
  f.lifecycle.start();
  f.hold(gate.promise);
  await f.advance(LEASE_MS / 2);
  expect(f.sent).toEqual([renewal(1)]);
  const stopping = f.lifecycle.stop();
  // The hub renews the Run after stop: its new expiry must not schedule the next renewal.
  gate.resolve();
  await stopping;
  expect(jest.getTimerCount()).toBe(0);
});

test("a closed runner is sent nothing", async () => {
  const f = lifecycleFixture();
  f.runner.closed = true;
  f.lifecycle.start();
  f.lifecycle.report("idle");
  await f.advance(10 * LEASE_MS);
  expect(f.sent).toEqual([]);
});

const gpt5 = { provider: "openai", model: "gpt-5" };
const o3 = { provider: "openai", model: "o3" };

test("the session's model rides one report per change: the first after launch, then each switch", async () => {
  const f = lifecycleFixture();
  f.discover(true);
  f.lifecycle.start();
  // `idle` at bind, before the session exists.
  f.lifecycle.report("idle");
  await settle();
  // The child's model at ready: no report is pending, so the current activity carries it.
  f.lifecycle.serve(gpt5);
  await settle();
  expect(f.sent).toEqual(["idle", "idle openai/gpt-5"]);
  // The same model again, or activity alone, carries nothing.
  f.lifecycle.serve(gpt5);
  f.lifecycle.track({ type: "agent_start" });
  await settle();
  expect(f.sent.slice(2)).toEqual(["working"]);
  // A switch rides the next report once; the report the switch queued then finds it sent.
  f.lifecycle.track({ type: "agent_end", willContinue: false });
  f.lifecycle.serve(o3);
  await settle();
  expect(f.sent.slice(3)).toEqual(["done openai/o3"]);
  // Switching back is a change too.
  f.lifecycle.serve(gpt5);
  await settle();
  expect(f.sent.slice(4)).toEqual(["done openai/gpt-5"]);
});

test("a model the Run's harness refuses is not sent again, its activity is reported alone, and reporting and renewal go on", async () => {
  // `refused` is the harness's own answer, as `run_model_unavailable` reaches the runner.
  const f = lifecycleFixture({ activity: (_, model) => model === "openai/o3" ? { ok: false, rule: "refused" } : { ok: true } });
  f.discover(true);
  f.lifecycle.start();
  f.lifecycle.report("idle");
  await settle();
  f.lifecycle.serve(o3);
  f.lifecycle.serve(o3);
  f.lifecycle.report("working");
  await settle();
  expect(f.sent).toEqual(["idle", "idle openai/o3", "idle", "working"]);
  // The next change is sent, and renewal never noticed.
  f.lifecycle.serve(gpt5);
  await f.advance(LEASE_MS / 2);
  expect(f.sent.slice(4)).toEqual(["working openai/gpt-5", renewal(1)]);
});

test("a refused model whose activity is refused alone too ends reporting, as any refused report does", async () => {
  const f = lifecycleFixture({ activity: count => count === 1 ? { ok: true } : { ok: false } });
  f.discover(true);
  f.lifecycle.report("idle");
  await settle();
  f.lifecycle.serve(o3);
  f.lifecycle.report("working");
  await settle();
  expect(f.sent).toEqual(["idle", "idle openai/o3", "idle"]);
});

test.each([
  ["an unavailable guest", { ok: false, rule: "unavailable" }],
  ["a refusal under another rule", { ok: false, rule: "forbidden" }],
  ["no answer", "silent"],
] as const)("a model met by %s rides the next report again, the first one at ready included", async (_, answer) => {
  const f = lifecycleFixture({ activity: count => count === 2 ? answer : { ok: true } });
  f.discover(true);
  f.lifecycle.report("idle");
  await settle();
  f.lifecycle.serve(gpt5);
  await settle();
  // Its activity still goes, alone.
  expect(f.sent).toEqual(["idle", "idle openai/gpt-5", "idle"]);
  f.lifecycle.track({ type: "agent_start" });
  f.lifecycle.track({ type: "agent_end", willContinue: false });
  await settle();
  // Accepted on the next report, then settled.
  expect(f.sent.slice(3)).toEqual(["working openai/gpt-5", "done"]);
});

test("a hub whose discovered activity door takes no model is never sent one", async () => {
  for (const discovered of [false, undefined]) {
    const f = lifecycleFixture();
    if (discovered !== undefined) f.discover(discovered);
    f.lifecycle.report("idle");
    f.lifecycle.serve(gpt5);
    f.lifecycle.report("working");
    await settle();
    expect(f.sent).toEqual(["idle", "working"]);
  }
  // A later discovery is the one that counts.
  const f = lifecycleFixture();
  f.discover(true);
  f.discover(false);
  f.lifecycle.serve(gpt5);
  f.lifecycle.report("idle");
  await settle();
  expect(f.sent).toEqual(["idle"]);
});
