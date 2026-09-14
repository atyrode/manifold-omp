import { z } from "zod";
import type { ServerHarness, GuestCtx } from "@manifold/plugin-kit/server";
import { PublicJobSchema } from "@manifold/protocol";
import {
  OMP_PLUGIN_ID, OmpHarnessProfileSchema, OmpSessionRefSchema, SessionInputSchema, TargetSchema,
} from "../api/index.ts";
import { prepareHarnessSession } from "./execution.ts";
import { readDefaults } from "./state.ts";
import { sessionInventory } from "./sessions.ts";
import {
  authorizeTarget, OmpRefusal, type OmpContext,
} from "./machine-server.ts";

const operationId = `${OMP_PLUGIN_ID}.harness`;


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
