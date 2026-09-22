import {
  defineServerAction,
  defineServerPlugin,
} from "@manifold/plugin-kit/server";
import { z } from "zod";
import { PluginManifestSchema, type Cap } from "@manifold/protocol";
import manifestJson from "./manifest.json";
import {
  rootActionSchemas,
  RestrictedAutomationSchema,
  type RootAction,
  type ActionInput,
  type ActionResult,
} from "../api/index.ts";
import { describeDestination, OmpRefusal, type OmpContext } from "./machine-server.ts";
import { refusal } from "./refusal.ts";
import { readDefaults, writeDefaults } from "./state.ts";
import { readSkillCatalog, writeSkillCatalog } from "./skills.ts";
import { harness } from "./harness.ts";
import { listSessions, resumeSession } from "./sessions.ts";
import {
  reviewWorkspace,
  prepareWorkspace,
  startInventory,
  readInventory,
  startBenchmark,
  readBenchmark,
  reviewSession,
  prepareSession,
  runSession,
  readSession,
  followSession,
  cancelSession,
} from "./execution.ts";

type RootHandlers = {
  [K in RootAction]: (
    ctx: OmpContext,
    args: ActionInput<K>,
  ) => Promise<ActionResult<K>>;
};
const implementations: RootHandlers = {
  readDefaults,
  writeDefaults,
  readSkillCatalog,
  writeSkillCatalog,
  describeDestination,
  reviewWorkspace,
  prepareWorkspace,
  startInventory,
  readInventory,
  startBenchmark,
  readBenchmark,
  reviewSession,
  prepareSession,
  runSession,
  readSession,
  followSession,
  cancelSession,
  listSessions,
  resumeSession,
};
/**
 * READING A MACHINE'S OWN FACTS IS ITS OWN WORD, SEPARATE FROM RUNNING THERE. Every door
 * below that observes a destination reaches `ctx.jobs.describe` and `describeDeployment`
 * through `observeNative`, and since atyrode/manifold#736 that read takes `machines:read` in
 * the calling plugin's capabilities — "reading what a folder IS is not authority to execute
 * anything there". Nothing here named it, so every native observation in this family refused
 * `job_capability_absent:machines:read` the moment the pin reached a Manifold carrying that
 * rule, including the no-installation answer `describeDestination` exists to give (#45,
 * atyrode/manifold#743).
 *
 * Declaring it lends this family a read it already needed and grants no new authority: a
 * delegate is a ceiling the door spends with its own consented authority, bounded by the
 * install grant (atyrode/manifold#740), and every door here still gates the CALLER on
 * `machines:run` for that machine first (`observeNative`). `cancelSession` stays out because
 * it observes no machine.
 */
const nativeObservationCaps: readonly Cap[] = ["machines:read", "machines:run", "jobs:read"];
// The write door may execute either mode; Native still rechecks the exact operation's refs.
const workspaceExecutionCaps: readonly Cap[] = [
  ...nativeObservationCaps,
  "locations:read",
  "locations:create",
];
const observedRuntimeCaps: readonly Cap[] = [
  ...nativeObservationCaps,
  "services:read",
  "services:invoke",
];
const delegates: Record<RootAction, readonly Cap[]> = {
  readDefaults: [],
  writeDefaults: [],
  readSkillCatalog: ["machines:run", "jobs:read"],
  writeSkillCatalog: ["machines:run", "jobs:read"],
  describeDestination: [...nativeObservationCaps, "services:read"],
  reviewWorkspace: nativeObservationCaps,
  prepareWorkspace: workspaceExecutionCaps,
  startInventory: [...observedRuntimeCaps, "operations:invoke", "network:host"],
  readInventory: nativeObservationCaps,
  startBenchmark: [...observedRuntimeCaps, "operations:invoke", "network:host"],
  readBenchmark: nativeObservationCaps,
  reviewSession: observedRuntimeCaps,
  prepareSession: observedRuntimeCaps,
  // Posting the one-shot job discharges that operation's own declared rights, not only
  // the observation `prepareSession` needs to hand a terminal its descriptor.
  runSession: [...observedRuntimeCaps, "network:host", "locations:write"],
  readSession: nativeObservationCaps,
  followSession: ["jobs:read"],
  // Ending a run needs no observation of the machine, only the job's own two verbs.
  cancelSession: ["jobs:read", "jobs:cancel"],
  listSessions: [...nativeObservationCaps, "jobs:cancel", "locations:read"],
  resumeSession: [...observedRuntimeCaps, "jobs:cancel", "locations:read"],
};
const writes: Partial<Record<RootAction, true>> = {
  writeDefaults: true,
  writeSkillCatalog: true,
  prepareWorkspace: true,
  prepareSession: true,
  runSession: true,
  cancelSession: true,
};
export const handlers = Object.fromEntries(
  (Object.keys(rootActionSchemas) as RootAction[]).map((name) => [
    name,
    async (ctx: OmpContext, raw: unknown) => {
      try {
        if (typeof raw === "object" && raw !== null && "automation" in raw &&
          raw.automation !== undefined && !RestrictedAutomationSchema.safeParse(raw.automation).success)
          throw new OmpRefusal("automation_unsupported");
        const args = rootActionSchemas[name].input.parse(raw);
        const handler = implementations[name] as (
          context: OmpContext,
          input: typeof args,
        ) => Promise<unknown>;
        return rootActionSchemas[name].result.parse(await handler(ctx, args));
      } catch (error) {
        return refusal(error);
      }
    },
  ]),
);
const plugin = {
  manifest: PluginManifestSchema.parse(manifestJson),
  actions: (Object.keys(rootActionSchemas) as RootAction[]).map((name) =>
    defineServerAction({
      name,
      title: name.replace(/([A-Z])/g, " $1"),
      // Operator doors enforce owner authority in their handler. Governed machine
      // caps belong to the native target admission below, not context-level caps.
      caps: name === "listSessions" || name === "resumeSession" ? [] : [writes[name] ? "containers:write" : "containers:read"],
      delegates: delegates[name],
      scope:
        name === "readDefaults" || name === "writeDefaults" || name === "writeSkillCatalog" || name === "listSessions" || name === "resumeSession"
          ? "workspace"
          : "container",
      trace: "opaque",
      input: rootActionSchemas[name].input as z.ZodType<unknown>,
      result: rootActionSchemas[name].result as z.ZodType<unknown>,
    }),
  ),
  handlers,
  harness,
};
defineServerPlugin(plugin);
export default plugin;
