import { defineServerAction, defineServerPlugin, type GuestCtx } from "@manifold/plugin-kit/server";
import { PluginManifestSchema } from "@manifold/protocol";
import { z } from "zod";
import manifest from "./manifest.json";

const effect = z.strictObject({ marker: z.string(), runId: z.string(), traceId: z.number() });
const input = z.strictObject({ marker: z.string().min(1).max(64), wait: z.boolean().optional() });
const pending = new Set<() => void>();
async function commit(ctx: GuestCtx, args: z.infer<typeof input>) {
  if (!ctx.agentRun) return { refused: "run_required" };
  const entry = { marker: args.marker, runId: ctx.agentRun.runId, traceId: ctx.traceId };
  const previous = await ctx.storage.get("effects");
  const effects = z.array(effect).parse(previous === null ? [] : JSON.parse(previous));
  effects.push(entry);
  await ctx.storage.set("effects", JSON.stringify(effects));
  // The effect is already durable. Holding only its reply lets the verifier cancel
  // an uncertain invocation without inventing a transport or replaying the action.
  if (args.wait) await new Promise<void>(resolve => { pending.add(resolve); });
  return { ...entry, privateWitness: "NOT-PUBLISHED-TO-THE-MODEL" };
}
const actions = ["commit", "unselected"].map(name => defineServerAction({
  name, title: "Commit one durable run-owned witness", caps: ["containers:write"], input,
  result: z.union([effect.extend({ privateWitness: z.string() }), z.strictObject({ refused: z.string() })]),
  resultProjection: { kind: "projected-json", fields: [["marker"], ["runId"], ["traceId"]], maxArrayItems: 1, maxResultBytes: 1024 },
}));
defineServerPlugin({
  manifest: PluginManifestSchema.parse(manifest),
  actions: [...actions,
    defineServerAction({ name: "observe", title: "Read durable witnesses", caps: ["containers:write"],
      input: z.strictObject({}), result: z.array(effect) }),
    defineServerAction({ name: "release", title: "Release disposable waiting invocations", caps: ["containers:write"],
      input: z.strictObject({}), result: z.strictObject({}) }),
  ],
  handlers: {
    commit, unselected: commit,
    async observe(ctx) {
      const previous = await ctx.storage.get("effects");
      return z.array(effect).parse(previous === null ? [] : JSON.parse(previous));
    },
    async release() { for (const resolve of pending) resolve(); pending.clear(); return {}; },
  },
});
