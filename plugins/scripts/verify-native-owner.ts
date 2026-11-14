import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { PluginBundleSchema } from "@manifold/protocol";
import { runTerminalHost } from "../../../manifold/packages/agent/src/index.ts";
import { preparedSourceArtifacts } from "./source-assets.ts";

// The same process-owned host factory as the normal core CLI. Only this private
// source-CI fixture supplies constructor-owned archives; production has no such
// config, environment, CLI, action or RPC injection surface.
const root = process.env.OMP_VERIFY_ROOT;
if (!root || !isAbsolute(root) || process.cwd() !== join(root, "cwd") || process.env.HOME !== join(root, "home"))
  throw new Error("Native owner fixture requires the private verification environment");
const directory = join(root, "bundles");
const bundle = PluginBundleSchema.parse(JSON.parse(await readFile(join(directory, "atyrode.omp.manifold-plugin.json"), "utf8")));
if (bundle.manifest.id !== "atyrode.omp" || !bundle.manifest.machine) throw new Error("Missing packed native proof family");
await runTerminalHost({ preparedArtifactArchives: await preparedSourceArtifacts(directory, bundle.manifest.machine) });
