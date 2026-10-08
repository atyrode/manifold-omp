import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ActionRunnerRequestSchema, ActionRunnerResponseSchema, MANIFOLD_ROOT_URI, ReportRunActivityV2RequestSchema } from "@manifold/protocol";
import { RENEWAL_JUSTIFICATION, RunLifecycle } from "../workers/harness/lifecycle.ts";

const runId = "fixture-run";
const LEASE_MS = 60_000;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

/** What the hub answers one call: a result frame, no result frame at all, or a thrown runner error. */
type Answer = { ok: true; expiresAt?: number } | { ok: false } | "silent" | "throw";

/**
 * An adopted `ActionRunner` as the lifecycle drives it: each call emits its result frame before it
 * resolves, and the hub's clock is the lifecycle's. `hold` keeps the next call in flight.
 */
function lifecycleFixture(options: {
  renew?: (now: number) => Answer;
  activity?: (count: number) => Answer;
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
      sent.push(report.activity);
      await hold;
      answer(null, "core.access.reportRunActivityV2", options.activity?.(++activities) ?? { ok: true });
    },
  };
  const lifecycle = new RunLifecycle(runner, runId, options.lease ?? { expiresAt: LEASE_MS, lifetimeMs: LEASE_MS }, () => now);
  function answer(id: string | null, door: string, value: Answer) {
    if (value === "throw") throw new Error("fixture-transport-failed");
    if (value === "silent") return;
    lifecycle.observe(ActionRunnerResponseSchema.parse({ type: "result", id, runId, door, target: MANIFOLD_ROOT_URI, traceId: 1,
      outcome: value.ok ? { ok: true } : { ok: false, denial: { rule: "forbidden" } },
      ...("expiresAt" in value && value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}) }));
  }
  return {
    lifecycle, runner, sent,
    async advance(ms: number) { now += ms; jest.advanceTimersByTime(ms); await settle(); },
    hold(gate: Promise<void> | undefined) { hold = gate; },
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

test("a closed runner is sent nothing", async () => {
  const f = lifecycleFixture();
  f.runner.closed = true;
  f.lifecycle.start();
  f.lifecycle.report("idle");
  await f.advance(10 * LEASE_MS);
  expect(f.sent).toEqual([]);
});
