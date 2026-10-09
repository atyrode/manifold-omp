import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ServerHarness, GuestCtx, GuestJobNode } from "@manifold/plugin-kit/server";
import { AGENT_RUN_MAX_LIFETIME_MS, AGENT_RUN_MAX_RENEWALS, PublicJobSchema, type AgentRun } from "@manifold/protocol";
import {
  OMP_PLUGIN_ID, OmpHarnessProfileSchema, OmpSessionRefSchema, RuntimeAccountPoolSchema, SessionInputSchema, TargetSchema,
  OmpHarnessTargetSchema, type ActionInput, type ActionResult,
} from "../api/index.ts";
import { prepareHarnessSession, registeredProviders, servesModel } from "./execution.ts";
import { readDefaults } from "./state.ts";
import { sessionInventory } from "./sessions.ts";
import {
  authorizeTarget, OmpRefusal, type OmpContext,
} from "./machine-server.ts";
import { readControlProgress, type RunControlFrame, type RunControlOutcome } from "../workers/harness/control.ts";
import { HarnessLeaseSchema } from "../workers/harness/lifecycle.ts";

const operationId = `${OMP_PLUGIN_ID}.harness`;
/** A dial whose model the session must first rediscover, plus the owner's 5 s progress window. */
const CONTROL_REPLY_MS = 20_000;

/** The Run's started harness job. Manifold resolves it from the Run alone and admits the caller
 * by its Run-input rule; a session reference or job id from the caller never selects it. */
async function runHarnessJob(ctx: OmpContext, runId: string) {
  const node = await ctx.jobs.runTerminal(runId);
  if (!node || node.operationId !== operationId) throw new OmpRefusal("session_unavailable");
  const job = PublicJobSchema.parse(await ctx.jobs.status(node));
  if (job.jobId !== node.jobId || job.machineId !== node.machineId || job.operationId !== operationId ||
      job.pluginId !== OMP_PLUGIN_ID || job.state !== "started" || job.nextInputSeq === null)
    throw new OmpRefusal("session_unavailable");
  return { node, seq: job.nextInputSeq };
}

/** One JSONL frame on the Run's private control descriptor. */
async function writeControlFrame(ctx: OmpContext, node: GuestJobNode, seq: number, frame: object) {
  const data = Buffer.from(`${JSON.stringify(frame)}\n`);
  if (data.length > 65536) throw new OmpRefusal("input_too_large");
  await ctx.jobs.input({ node, requestId: await ctx.newId(), seq, data: data.toString("base64"), eof: false });
}

/**
 * What `resolveModel` reads of a launched Run, and all it reads: the session its reviewed launch
 * bound and the providers that launch's sealed account pool registers. Only `launch` writes it.
 */
const LaunchedRunSchema = z.strictObject({
  agentId: z.string().min(1).max(128),
  session: OmpSessionRefSchema,
  providers: z.array(z.string().min(1).max(128)).max(1024),
});
const LAUNCHES = "runs/";
/** No Run outlives its creation by more than its first lease and every renewal, each at most an hour. */
const RUN_SPAN_MS = (AGENT_RUN_MAX_RENEWALS + 1) * AGENT_RUN_MAX_LIFETIME_MS;
/** The key leads with the time past which the Run can report no model, so a later launch prunes it unread. */
const launchKey = (run: AgentRun) => `${LAUNCHES}${run.createdAt + RUN_SPAN_MS}/${run.id}`;

async function retainLaunch(ctx: GuestCtx, run: AgentRun, launched: z.infer<typeof LaunchedRunSchema>): Promise<void> {
  const now = ctx.now();
  for (const key of await ctx.storage.keys(LAUNCHES))
    if (Number(key.slice(LAUNCHES.length, key.indexOf("/", LAUNCHES.length))) <= now) await ctx.storage.delete(key);
  await ctx.storage.set(launchKey(run), JSON.stringify(LaunchedRunSchema.parse(launched)));
}

export const harness: ServerHarness<GuestCtx> = {
  profileSchema: OmpHarnessProfileSchema,
  async launch(ctx, run, agent, rawTarget) {
    if (agent.harness !== OMP_PLUGIN_ID || run.agentId !== agent.agentId) throw new OmpRefusal("harness_binding_changed");
    const target = OmpHarnessTargetSchema.parse(rawTarget);
    const { tui = false, ...profile } = OmpHarnessProfileSchema.parse(agent.context.profile);
    const defaults = await readDefaults(ctx);
    const session = run.session === null ? undefined : OmpSessionRefSchema.parse(run.session);
    if (session && (session.machineId !== target.machineId || !await harness.resolveSession(ctx, session)))
      throw new OmpRefusal("session_unavailable");
    // The Run's lease as created; renewal keeps that length within the Agent's grant.
    const lease = HarnessLeaseSchema.parse({ expiresAt: run.expiresAt,
      lifetimeMs: Math.max(60_000, Math.min(agent.grant.maxRunLifetimeMs, run.expiresAt - run.createdAt)) });
    const prepared = await prepareHarnessSession(ctx, SessionInputSchema.parse({
      ...target, ...profile, expectedDefaultsRevision: defaults.revision,
      prompt: agent.context.instructions ?? "",
    }), { tui, lease }, session);
    const pool = RuntimeAccountPoolSchema.parse(JSON.parse(String(prepared.runtime.input.accountPool)));
    await retainLaunch(ctx, run, { agentId: run.agentId, session: prepared.session, providers: registeredProviders(pool) });
    return { runtime: prepared.runtime, session: prepared.session, reviewDigest: prepared.reviewDigest };
  },
  async sessions(ctx, rawTarget) {
    const target = TargetSchema.parse(rawTarget);
    await authorizeTarget(ctx, target);
    return (await sessionInventory(ctx, target.machineId)).map(session => ({
      harness: OMP_PLUGIN_ID, sessionId: session.id, machineId: target.machineId,
    }));
  },
  async resolveSession(ctx, rawRef) {
    const ref = OmpSessionRefSchema.parse(rawRef);
    // Native operation/location admission independently checks machine-scoped read
    // authority. The reference deliberately carries no path or container bypass.
    return (await sessionInventory(ctx, ref.machineId)).some(session => session.id === ref.sessionId) ? ref : null;
  },
  async send(ctx, run, input) {
    const session = OmpSessionRefSchema.parse(run.session);
    const message = z.string().min(1).max(16384).parse(input);
    const { node, seq } = await runHarnessJob(ctx, run.id);
    if (node.machineId !== session.machineId) throw new OmpRefusal("session_unavailable");
    await writeControlFrame(ctx, node, seq, { type: "prompt", message });
  },
  /**
   * The reported model, exactly, when this Run's own reviewed launch serves it (`servesModel`), and
   * null otherwise: for another Agent's or session's launch, a Run launched by no retained launch,
   * or a model the launch's providers and the pinned catalog cannot establish. The answer depends
   * on the Run, its launch record and the model alone. It reads that one record: no job, write or emit.
   */
  async resolveModel(ctx, run, model) {
    const raw = await ctx.storage.get(launchKey(run));
    if (raw === null) return null;
    const launched = LaunchedRunSchema.parse(JSON.parse(raw));
    const session = OmpSessionRefSchema.safeParse(run.session);
    if (!session.success || launched.agentId !== run.agentId || launched.session.sessionId !== session.data.sessionId ||
        launched.session.machineId !== session.data.machineId) return null;
    return servesModel(launched.providers, model.provider, model.model) ? { provider: model.provider, model: model.model } : null;
  },
};

/**
 * `atyrode.omp.controlRun`, under the human-sponsorship rule (`ControlRunInputSchema`): only the
 * Run's launcher or a sponsor of its Agent, root included, turns its dials. Every Agent principal is
 * refused here, before anything is read; Manifold's Run-input rule then admits the human caller to
 * the Run's terminal input, exactly as for `sendRunInput`. The session alone decides whether it
 * serves the model and answers on its job's progress; no answer is never read as success.
 */
export async function controlRun(ctx: OmpContext, args: ActionInput<"controlRun">): Promise<ActionResult<"controlRun">> {
  if (ctx.agentRun || ctx.auth.principal.kind !== "human") throw new OmpRefusal("run_control_forbidden");
  const { node, seq } = await runHarnessJob(ctx, args.runId).catch((error: unknown) => {
    throw error instanceof OmpRefusal ? error : new OmpRefusal("session_unavailable");
  });
  const frame: RunControlFrame = { type: "control", id: randomUUID(),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.thinking === undefined ? {} : { thinking: args.thinking }) };
  const reply = Promise.withResolvers<RunControlOutcome | null>();
  const timer = setTimeout(() => reply.resolve(null), CONTROL_REPLY_MS);
  // Subscribe before writing, so the answer cannot pass between the write and the subscription.
  const follow = await ctx.jobs.follow(node, update => {
    if (update.type === "closed") reply.resolve(null);
    else if (update.type === "event" && update.event.type === "job_progress" && update.event.stage === `control ${frame.id}`)
      reply.resolve(readControlProgress(update.event.message));
  }).catch((error: unknown) => { clearTimeout(timer); throw error; });
  try {
    await writeControlFrame(ctx, node, seq, frame);
    const outcome = await reply.promise;
    if (outcome === null) throw new OmpRefusal("run_control_unconfirmed");
    if (!outcome.ok) throw new OmpRefusal(outcome.reason === "unsupported" ? "run_control_unsupported" : outcome.reason);
    return outcome.dials;
  } finally {
    clearTimeout(timer);
    await follow.close();
  }
}
