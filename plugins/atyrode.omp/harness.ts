import { z } from "zod";
import type { ServerHarness, GuestCtx } from "@manifold/plugin-kit/server";
import { PublicJobSchema } from "@manifold/protocol";
import {
  OMP_PLUGIN_ID, OmpHarnessProfileSchema, OmpSessionRefSchema, SessionInputSchema, TargetSchema,
  type OmpSessionRef,
} from "../api/index.ts";
import { prepareHarnessSession } from "./execution.ts";
import { readDefaults } from "./state.ts";
import {
  authorizeTarget, currentOperation, digestOf, OmpRefusal, readJobResult,
  type OmpContext,
} from "./machine-server.ts";

const operationId = `${OMP_PLUGIN_ID}.harness`;
const sessionsOperationId = `${OMP_PLUGIN_ID}.harness-sessions`;
const sessionIdsSchema = z.array(z.uuid()).max(4096).refine(ids => new Set(ids).size === ids.length);

/** Enumeration is a read-only governed job on the owner. Neither the hub filesystem
 * nor caller-supplied paths can resolve an OMP conversation. */
async function sessionInventory(ctx: OmpContext, machineId: string): Promise<OmpSessionRef[]> {
  const first = await currentOperation(ctx, machineId, sessionsOperationId);
  const jobId = await ctx.newId();
  const latest = await currentOperation(ctx, machineId, sessionsOperationId);
  if (digestOf(first.pins) !== digestOf(latest.pins)) throw new OmpRefusal("resources_changed");
  const job = PublicJobSchema.parse(await ctx.jobs.execute({
    jobId, machineId, operationId: sessionsOperationId, ...latest.pins, input: {}, outputs: [],
  }));
  if (job.jobId !== jobId || job.machineId !== machineId || job.pluginId !== OMP_PLUGIN_ID ||
      job.operationId !== sessionsOperationId || job.inputDigest !== digestOf({}) ||
      job.installationRevision !== latest.pins.installationRevision || job.artifactSha256 !== latest.pins.artifactSha256 ||
      job.resourceBindingDigest !== latest.pins.resourceBindingDigest || job.authority.requester !== ctx.auth.principal.id)
    throw new OmpRefusal("provenance_changed");
  const node = { kind: "job" as const, machineId, operationId: sessionsOperationId, jobId };
  const settled = Promise.withResolvers<void>();
  void settled.promise.catch(() => {});
  const timeout = setTimeout(() => settled.reject(new OmpRefusal("session_inventory_timeout")), 30000);
  // A synchronous initial event may arrive before follow() resolves; the resolver
  // is already installed, and the atomic snapshot closes the completion race.
  const follow = await ctx.jobs.follow(node, update => {
    if (update.type === "closed") settled.reject(new OmpRefusal("session_inventory_unavailable"));
    else if (update.event.type === "result" || update.event.type === "refusal") settled.resolve();
  }).catch(error => { clearTimeout(timeout); throw error; });
  try {
    if (["exited", "interrupted", "cancelled", "refused"].includes(follow.snapshot.state)) settled.resolve();
    await settled.promise;
    const result = await readJobResult(ctx, machineId, "harness-sessions", jobId);
    if (result.job.authority.requester !== job.authority.requester ||
        digestOf(result.job.authority.origin) !== digestOf(job.authority.origin))
      throw new OmpRefusal("provenance_changed");
    return sessionIdsSchema.parse(result.value).map(sessionId => ({ harness: OMP_PLUGIN_ID, sessionId, machineId }));
  } catch (error) {
    await ctx.jobs.cancel(node).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
    await follow.close();
  }
}

export const harness: ServerHarness<GuestCtx> = {
  profileSchema: OmpHarnessProfileSchema,
  async launch(ctx, run, agent, rawTarget) {
    if (agent.harness !== OMP_PLUGIN_ID || run.agentId !== agent.agentId) throw new OmpRefusal("harness_binding_changed");
    const target = TargetSchema.parse(rawTarget);
    const profile = OmpHarnessProfileSchema.parse(agent.context.profile);
    const defaults = await readDefaults(ctx);
    const session = run.session === null ? undefined : OmpSessionRefSchema.parse(run.session);
    if (session && (session.machineId !== target.machineId || !await harness.resolveSession(ctx, session)))
      throw new OmpRefusal("session_unavailable");
    const prepared = await prepareHarnessSession(ctx, SessionInputSchema.parse({
      ...target, ...profile, expectedDefaultsRevision: defaults.revision,
      prompt: agent.context.instructions ?? "",
    }), session);
    return { runtime: prepared.runtime, session: prepared.session, reviewDigest: prepared.reviewDigest };
  },
  async sessions(ctx, rawTarget) {
    const target = TargetSchema.parse(rawTarget);
    await authorizeTarget(ctx, target);
    return sessionInventory(ctx, target.machineId);
  },
  async resolveSession(ctx, rawRef) {
    const ref = OmpSessionRefSchema.parse(rawRef);
    // Native operation/location admission independently checks machine-scoped read
    // authority. The reference deliberately carries no path or container bypass.
    return (await sessionInventory(ctx, ref.machineId)).find(session => session.sessionId === ref.sessionId) ?? null;
  },
  async send(ctx, run, input) {
    const session = OmpSessionRefSchema.parse(run.session);
    const message = z.string().min(1).max(16384).parse(input);
    const node = await ctx.jobs.runTerminal(run.id);
    if (!node || node.machineId !== session.machineId || node.operationId !== operationId) throw new OmpRefusal("session_unavailable");
    const job = PublicJobSchema.parse(await ctx.jobs.status(node));
    if (job.jobId !== node.jobId || job.machineId !== node.machineId || job.operationId !== operationId ||
        job.pluginId !== OMP_PLUGIN_ID || job.state !== "started" || job.nextInputSeq === null)
      throw new OmpRefusal("session_unavailable");
    const data = Buffer.from(`${JSON.stringify({ type: "prompt", message })}\n`);
    if (data.length > 65536) throw new OmpRefusal("input_too_large");
    await ctx.jobs.input({ node, requestId: await ctx.newId(), seq: job.nextInputSeq, data: data.toString("base64"), eof: false });
  },
};
