import { z } from "zod";
import { AGENT_RUN_MAX_LIFETIME_MS, type ActionRunnerResponse, type RunModel } from "@manifold/protocol";
import { OmpRpcActivity, type OmpActivity } from "./rpc.ts";
import type { TuiActivityFrame } from "../../tui-control-ipc.ts";

/**
 * The Run's lease, as `harness.launch` reads it from the Run it launches and seals it beside the
 * session. The lease length is the Agent grant's to bound, so only this input carries it; a
 * renewal's result carries each next expiry.
 */
export const HarnessLeaseSchema = z.strictObject({
  expiresAt: z.number().int().positive(),
  lifetimeMs: z.number().int().min(60_000).max(AGENT_RUN_MAX_LIFETIME_MS),
});
export type HarnessLease = z.infer<typeof HarnessLeaseSchema>;

/** `core.access.renewAgentRunV2` declares `agentJustification: "required"`; this is the harness's own claim. */
export const RENEWAL_JUSTIFICATION = "Keep the operator's open interactive OMP session attributed to its Run.";

type ResultFrame = Extract<ActionRunnerResponse, { type: "result" }>;
interface LifecycleRunner {
  readonly closed: boolean;
  accept(frame: unknown): Promise<void>;
  reportActivity(input: unknown): Promise<void>;
}

/**
 * Keeps an adopted Run attributed while its operator works: renewal at half of each lease, with
 * the justification, and activity reports that carry the session's model when it changes. Both run
 * on the Run's own credential from launch, with no policy assent: atyrode/manifold#1070 admits
 * exactly these two doors while a Run awaits its model's acknowledgement. Frames are sequential, as
 * `ActionRunner` requires. A refused renewal or report, an expiry, the runner's per-lease activity
 * budget or more open dialogs than `OmpRpcActivity` tracks stops that loop, never the session. A
 * refused model stops neither.
 */
export class RunLifecycle {
  #activity = new OmpRpcActivity();
  #result: ResultFrame | undefined;
  #tail = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #renewals = 0;
  #renewing = true;
  #reporting = true;
  /** Whether the hub's discovered activity door takes a `model`; an older hub refuses one as `invalid_args`. */
  #modelReports = false;
  /** The latest activity reported, which a model change reports again to carry the model. */
  #current: OmpActivity = "idle";
  /** The model the session serves now, and the last one a report settled: accepted, or refused by the Run's harness. */
  #served: RunModel | undefined;
  #settled: string | undefined;
  constructor(
    private readonly runner: LifecycleRunner,
    private readonly runId: string,
    private readonly lease: HarnessLease,
    private readonly now: () => number = Date.now,
  ) {}

  /** The runner's `emit`: lifecycle doors answer with result frames, and bind discovers the doors. */
  observe(frame: ActionRunnerResponse): void {
    if (frame.type === "result") this.#result = frame;
    else if (frame.type === "discovery") this.#modelReports = frame.actions.some(action => {
      const properties = action.input.properties;
      return action.name === "core.access.reportRunActivityV2" &&
        typeof properties === "object" && properties !== null && Object.hasOwn(properties, "model");
    });
  }

  start(): void {
    this.#schedule(this.lease.expiresAt);
  }

  report(activity: OmpActivity): void {
    this.#current = activity;
    this.#enqueue(activity, false);
  }

  /**
   * The model the session serves now, which the next report carries once. A change with no report
   * behind it reports the current activity again to carry it. Never sent to an older hub.
   */
  serve(model: RunModel): void {
    if (!this.#modelReports) return;
    this.#served = model;
    this.#enqueue(this.#current, true);
  }

  /** The SDK child's activity events. Past the 64 open dialogs `OmpRpcActivity` tracks, the activity
   * is unknown: reporting ends after the reports already queued, so the Run reads `blocked`. */
  track(frame: TuiActivityFrame): void {
    let next: OmpActivity | null;
    try { next = this.#activity.consume(frame); }
    catch {
      this.#tail = this.#tail.then(() => { this.#reporting = false; });
      return;
    }
    if (next) this.report(next);
  }

  /** Cancels the pending renewal and settles every queued frame before the runner closes. */
  async stop(): Promise<void> {
    this.#renewing = false;
    clearTimeout(this.#timer);
    await this.#tail;
  }

  #enqueue(activity: OmpActivity, onlyWithModel: boolean): void {
    this.#tail = this.#tail.then(async () => {
      if (!this.#reporting || this.runner.closed) return;
      const key = this.#served === undefined ? undefined : JSON.stringify(this.#served);
      const model = key !== this.#settled ? this.#served : undefined;
      if (model === undefined && onlyWithModel) return;
      if (model !== undefined) {
        const outcome = await this.#reported({ runId: this.runId, activity, model });
        if (outcome?.ok === true) {
          this.#settled = key;
          return;
        }
        // A refused model refuses the whole report, so the activity goes again alone and `Run.model`
        // keeps its last accepted value. The runner reports only the denial's rule: `refused` is the
        // Run's harness answering this model (`run_model_unavailable` and the other deterministic
        // answers), so it is not sent again until the session changes model. Any other outcome, such
        // as an `unavailable` guest that was busy or past its deadline, leaves it to the next report.
        if (outcome?.denial.rule === "refused") this.#settled = key;
      }
      if ((await this.#reported({ runId: this.runId, activity }))?.ok !== true) this.#reporting = false;
    }).catch(() => { this.#reporting = false; });
  }

  async #reported(input: { runId: string; activity: OmpActivity; model?: RunModel }): Promise<ResultFrame["outcome"] | undefined> {
    this.#result = undefined;
    await this.runner.reportActivity(input);
    return (this.#result as ResultFrame | undefined)?.outcome;
  }

  #schedule(expiresAt: number): void {
    // Half of the lease, measured back from its end: a lease renewed on time never runs below half.
    const delay = Math.max(1_000, expiresAt - this.now() - this.lease.lifetimeMs / 2);
    this.#timer = setTimeout(() => {
      this.#tail = this.#tail.then(async () => {
        if (!this.#renewing || this.runner.closed) return;
        this.#result = undefined;
        await this.runner.accept({ type: "renew", id: `renew-${++this.#renewals}`, runId: this.runId,
          lifetimeMs: this.lease.lifetimeMs, justification: RENEWAL_JUSTIFICATION });
        const result = this.#result as ResultFrame | undefined;
        // A renewal answered after `stop()` arms nothing: renewal is over even when this one succeeded.
        if (this.#renewing && result?.outcome.ok === true && result.expiresAt !== undefined) this.#schedule(result.expiresAt);
        else this.#renewing = false;
      }).catch(() => { this.#renewing = false; });
    }, delay);
  }
}
