#!/usr/bin/env bun
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pluginsRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(pluginsRoot, "..");
const requestedSource = process.env.OMP_CONSUMER_SOURCE;
if (
  requestedSource !== undefined &&
  !/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[a-f0-9]{40}$/.test(
    requestedSource,
  )
) {
  throw new Error("OMP_CONSUMER_SOURCE must name an immutable GitHub commit");
}

const root = await mkdtemp(join(tmpdir(), "manifold-omp-consumer-"));
let source = requestedSource;
if (source === undefined) {
  const pack = Bun.spawn(
    [process.execPath, "pm", "pack", "--destination", root],
    {
      cwd: repositoryRoot,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const [packCode, packError] = await Promise.all([
    pack.exited,
    new Response(pack.stderr).text(),
  ]);
  if (packCode !== 0)
    throw new Error(`consumer package failed: ${packError.trim()}`);
  source = `file:${join(root, "atyrode-manifold-omp-0.1.0.tgz")}`;
}
try {
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@atyrode/manifold-omp": source,
        typescript: "5.9.3",
      },
    }),
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "Preserve",
        moduleResolution: "Bundler",
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        allowImportingTsExtensions: true,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["consumer.ts"],
    }),
  );
  await writeFile(
    join(root, "consumer.ts"),
    `import { OMP_PLUGIN_ID, PreparedSessionSchema, createOmpClient } from "@atyrode/manifold-omp";
const machineId = "consumer-machine";
const parsed = PreparedSessionSchema.parse({
  destination: { containerId: "consumer-container", machineId },
  reviewDigest: "a".repeat(64),
  runtime: {
    machineId,
    pluginId: OMP_PLUGIN_ID,
    operationId: "atyrode.omp.launch",
    installationRevision: "consumer-installation",
    artifactSha256: "b".repeat(64),
    resourceBindingDigest: "c".repeat(64),
    input: {},
  },
});
const client = createOmpClient(async () => ({}));
if (parsed.runtime.machineId !== machineId || typeof client.call !== "function") throw new Error("invalid public API");
console.log(OMP_PLUGIN_ID);
`,
  );
  const install = Bun.spawn([process.execPath, "install", "--no-progress"], {
    cwd: root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [installCode, installError] = await Promise.all([
    install.exited,
    new Response(install.stderr).text(),
  ]);
  if (installCode !== 0)
    throw new Error(`consumer install failed: ${installError.trim()}`);

  const typecheck = Bun.spawn([process.execPath, "x", "tsc", "-p", "."], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [typecheckCode, typecheckOutput, typecheckError] = await Promise.all([
    typecheck.exited,
    new Response(typecheck.stdout).text(),
    new Response(typecheck.stderr).text(),
  ]);
  if (typecheckCode !== 0)
    throw new Error(
      `consumer typecheck failed: ${typecheckOutput}${typecheckError}`.trim(),
    );

  const run = Bun.spawn([process.execPath, "consumer.ts"], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [runCode, output, runError] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  if (runCode !== 0 || output.trim() !== "atyrode.omp")
    throw new Error(`consumer execution failed: ${runError.trim()}`);
  console.log(
    JSON.stringify({
      ok: true,
      source: requestedSource === undefined ? "package" : "git",
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
