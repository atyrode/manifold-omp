import { PublicJobSchema } from "@manifold/protocol";
import {
  OMP_PLUGIN_ID, OmpSessionInventorySchema,
  type ActionInput, type ActionResult, type OmpSessionSummary,
} from "../api/index.ts";
import { prepareInteractiveResume } from "./execution.ts";
import {
  currentOperation, digestOf, OmpRefusal, readJobResult, type OmpContext,
} from "./machine-server.ts";

const sessionsOperationId = `${OMP_PLUGIN_ID}.harness-sessions`;
/** Enumeration is a read-only governed job on the owner. Neither the hub filesystem
 * nor caller-supplied paths can resolve an OMP conversation. */
export async function sessionInventory(ctx: OmpContext, machineId: string): Promise<OmpSessionSummary[]> {
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
    return OmpSessionInventorySchema.parse(result.value);
  } catch (error) {
    await ctx.jobs.cancel(node).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
    await follow.close();
  }
}

/** Standalone doors require an operator, not an Agent or container-scoped token.
 * Native operation and location admission still enforce machine authority. */
function authorizeOperator(ctx: OmpContext): void {
  if (!ctx.auth.isRoot || ctx.auth.containerScope !== null) throw new OmpRefusal("session_owner_required");
}

export async function listSessions(ctx: OmpContext, args: ActionInput<"sessions.list">): Promise<ActionResult<"sessions.list">> {
  authorizeOperator(ctx);
  return sessionInventory(ctx, args.machineId);
}

export async function resumeSession(ctx: OmpContext, args: ActionInput<"sessions.resume">): Promise<ActionResult<"sessions.resume">> {
  authorizeOperator(ctx);
  if (!(await sessionInventory(ctx, args.machineId)).some(session => session.id === args.sessionId))
    throw new OmpRefusal("session_unavailable");
  return prepareInteractiveResume(ctx, args);
}
