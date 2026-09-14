import {
  defineServerAction,
  defineServerPlugin,
} from "@manifold/plugin-kit/server";
import { z } from "zod";
import { PluginManifestSchema, type Cap } from "@manifold/protocol";
import manifestJson from "./manifest.json";
import {
  rootActionSchemas,
  type RootAction,
  type ActionInput,
  type ActionResult,
} from "../api/index.ts";
import { describeDestination, type OmpContext } from "./machine-server.ts";
import { refusal } from "./refusal.ts";
import { readDefaults, writeDefaults } from "./state.ts";
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
};
const workspaceObservationCaps: readonly Cap[] = ["machines:run", "jobs:read"];
// The write door may execute either mode; Native still rechecks the exact operation's refs.
const workspaceExecutionCaps: readonly Cap[] = [
  ...workspaceObservationCaps,
  "locations:read",
  "locations:create",
];
const observedRuntimeCaps: readonly Cap[] = [
  "machines:run",
  "jobs:read",
  "services:read",
  "services:invoke",
];
const delegates: Record<RootAction, readonly Cap[]> = {
  readDefaults: [],
  writeDefaults: [],
  describeDestination: ["machines:run", "jobs:read", "services:read"],
  reviewWorkspace: workspaceObservationCaps,
  prepareWorkspace: workspaceExecutionCaps,
  startInventory: [
    "machines:run",
    "jobs:read",
    "services:read",
    "services:invoke",
    "operations:invoke",
    "network:host",
  ],
  readInventory: ["machines:run", "jobs:read"],
  startBenchmark: [
    "machines:run",
    "jobs:read",
    "services:read",
    "services:invoke",
    "operations:invoke",
    "network:host",
  ],
  readBenchmark: ["machines:run", "jobs:read"],
  reviewSession: observedRuntimeCaps,
  prepareSession: observedRuntimeCaps,
  // Posting the one-shot job discharges that operation's own declared rights, not only
  // the observation `prepareSession` needs to hand a terminal its descriptor.
  runSession: [...observedRuntimeCaps, "network:host", "locations:write"],
  readSession: ["machines:run", "jobs:read"],
};
const writes: Partial<Record<RootAction, true>> = {
  writeDefaults: true,
  prepareWorkspace: true,
  prepareSession: true,
  runSession: true,
};
export const handlers = Object.fromEntries(
  (Object.keys(rootActionSchemas) as RootAction[]).map((name) => [
    name,
    async (ctx: OmpContext, raw: unknown) => {
      try {
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
      caps: [writes[name] ? "containers:write" : "containers:read"],
      delegates: delegates[name],
      scope:
        name === "readDefaults" || name === "writeDefaults"
          ? "workspace"
          : "container",
      trace: "opaque",
      input: rootActionSchemas[name].input as z.ZodType<unknown>,
      result: rootActionSchemas[name].result as z.ZodType<unknown>,
    }),
  ),
  handlers,
};
defineServerPlugin(plugin);
export default plugin;
