import { z } from "zod";
import { AGENT_RUN_MAX_LIFETIME_MS, type ActionRunnerResponse } from "@manifold/protocol";
import { OmpRpcActivity, type OmpActivity } from "./rpc.ts";
import type { TuiActivityFrame } from "../../tui-control-ipc.ts";

/**
 * The Run's lease, as `harness.launch` reads it from the Run it launches and seals it beside the
 * session. A declared input because an adopted `ActionRunner` does not expose its Run's expiry
 * (atyrode/manifold#1071); a renewal's result does, so only the first expiry is declared.
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
 * the justification, and activity reports. Both run on the Run's own credential from launch, with
 * no policy assent: atyrode/manifold#1070 admits exactly these two doors while a Run awaits its
 * model's acknowledgement. Frames are sequential, as `ActionRunner` requires. A refused renewal or
 * report, an expiry, the runner's activity budget or more open dialogs than `OmpRpcActivity`
 * tracks stops that loop, never the session.
 */
export class RunLifecycle {
  #activity = new OmpRpcActivity();
  #result: ResultFrame | undefined;
  #tail = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #renewals = 0;
  #renewing = true;
  #reporting = true;
  constructor(
    private readonly runner: LifecycleRunner,
    private readonly runId: string,
    private readonly lease: HarnessLease,
    private readonly now: () => number = Date.now,
  ) {}

  /** The runner's `emit`: lifecycle doors answer with result frames, the only ones read here. */
  observe(frame: ActionRunnerResponse): void {
    if (frame.type === "result") this.#result = frame;
  }

  start(): void {
    this.#schedule(this.lease.expiresAt);
  }

  report(activity: OmpActivity): void {
    this.#tail = this.#tail.then(async () => {
      if (!this.#reporting || this.runner.closed) return;
      this.#result = undefined;
      await this.runner.reportActivity({ runId: this.runId, activity });
      if ((this.#result as ResultFrame | undefined)?.outcome.ok !== true) this.#reporting = false;
    }).catch(() => { this.#reporting = false; });
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
        if (result?.outcome.ok === true && result.expiresAt !== undefined) this.#schedule(result.expiresAt);
        else this.#renewing = false;
      }).catch(() => { this.#renewing = false; });
    }, delay);
  }
}
