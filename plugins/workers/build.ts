import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import type { BunPlugin } from "bun";
import { dlopen, ptr } from "bun:ffi";
import { MachineArtifactSchema, type MachineArtifact, type MachineHalf } from "../../../manifold/packages/protocol/src/jobs.ts";
import runtime from "../runtime-artifacts.json";

const root = resolve(import.meta.dir, "..");
const platforms = ["linux-x64", "linux-arm64"] as const;
const entrypoints = {
  root: {
    inventory: "probe/inventory.ts",
    benchmark: "probe/benchmark.ts",
    harness: "harness/entry.ts",
    sdkHost: "harness/sdk-host.ts",
  },
  accounts: {
    broker: "broker/entry.ts",
  },
  gateway: {
    gateway: "gateway/entry.ts",
  },
} as const;
export type WorkerTarget = keyof typeof entrypoints;
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const maxEmbeddedBytes = 16 * 1024 * 1024;
const loaderSha256 = "de59cfd780bfb4ff4411a542396ba2f7c512add3ad2d474cd2e30220c69e3930";
const dependencyMarker = ".omp-prepared-dependencies.json";
// Review together with the complete published dependency graph in bun.lock, never installed files.
const lockSha256 = "fdc7b5985342662199e13fa1c0e8e0cdfe6e59b41a84f6d436df1fc7ea701c8d";

export function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function syncTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await syncTree(path);
    else if (entry.isFile()) {
      const file = await open(path, "r");
      try { await file.sync(); } finally { await file.close(); }
    }
  }
  const file = await open(directory, "r");
  try { await file.sync(); } finally { await file.close(); }
}

/** Atomic namespace publication, never a remove/rename or backup/rename gap.
 * The caller owns the staging parent and removes the retired tree after exchange.
 * FFI is confined to this host-side packer; none of the worker entrypoints import it.
 */
export async function replaceDirectory(staged: string, destination: string): Promise<void> {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Atomic packaging requires Linux or macOS");
  if (containsPath(staged, destination) || containsPath(destination, staged)) throw new Error("Unsafe publication/staging relationship");
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (existing && !existing.isDirectory()) throw new Error("Publication destination must be a directory, not a file or symlink");
  await syncTree(staged);
  if (!existing) {
    await rename(staged, destination);
    return;
  }
  const source = Buffer.from(`${staged}\0`);
  const target = Buffer.from(`${destination}\0`);
  if (process.platform === "linux") {
    const library = dlopen("libc.so.6", { renameat2: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" } });
    try {
      if (library.symbols.renameat2(-100, ptr(source), -100, ptr(target), 2) !== 0) throw new Error("Atomic directory exchange failed; destination filesystem must support renameat2(RENAME_EXCHANGE)");
    } finally { library.close(); }
  } else {
    const library = dlopen("/usr/lib/libSystem.B.dylib", { renamex_np: { args: ["ptr", "ptr", "u32"], returns: "i32" } });
    try {
      if (library.symbols.renamex_np(ptr(source), ptr(target), 2) !== 0) throw new Error("Atomic directory exchange failed; destination filesystem must support renamex_np(RENAME_SWAP)");
    } finally { library.close(); }
  }
}

async function dependencyInputs(directory: string) {
  if (Bun.version !== "1.4.2" || runtime.bunVersion !== "1.4.2") throw new Error("Dependency preparation and packaging require pinned Bun 1.4.2");
  const [lock, manifest] = await Promise.all([
    readFile(join(directory, "bun.lock")),
    readFile(join(directory, "package.json"), "utf8").then(text => JSON.parse(text)),
  ]);
  if (hash(lock) !== lockSha256) throw new Error("Unreviewed bun.lock bytes");
  if (manifest.patchedDependencies !== undefined) throw new Error("Private SDK patches are not supported");
  const dependencies = {
    dependencies: manifest.dependencies, devDependencies: manifest.devDependencies,
  };
  return {
    format: 2, bunVersion: Bun.version, platform: process.platform, arch: process.arch,
    lockSha256, manifestSha256: hash(Buffer.from(JSON.stringify(dependencies))),
  };
}

/** Hash all installed bytes and structure, not a hand-maintained list of SDK files.
 * Internal package/bin symlinks are admitted; checkout/cache/host links are not.
 */
async function dependencyTree(directory: string): Promise<string> {
  const rootStat = await lstat(directory);
  if (!rootStat.isDirectory()) throw new Error("Prepared node_modules must be a private directory, not a symlink");
  const canonical = await realpath(directory);
  const digest = createHash("sha256");
  async function visit(current: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (current === directory && entry.name === dependencyMarker) continue;
      const path = join(current, entry.name);
      const member = relative(directory, path).split(sep).join("/");
      if (entry.isDirectory()) {
        digest.update(JSON.stringify(["directory", member]));
        await visit(path);
      } else if (entry.isFile()) {
        const info = await lstat(path);
        digest.update(JSON.stringify(["file", member, info.mode & 0o777, info.size]));
        for await (const bytes of createReadStream(path)) digest.update(bytes);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target) || !containsPath(canonical, await realpath(path))) throw new Error(`Dependency link escapes prepared tree: ${member}`);
        digest.update(JSON.stringify(["symlink", member, target]));
      } else throw new Error(`Unsupported dependency member: ${member}`);
    }
  }
  await visit(directory);
  return digest.digest("hex");
}

export async function verifyPreparedDependencies(): Promise<string> {
  const inputs = await dependencyInputs(root);
  const directory = join(root, "node_modules");
  const marker = join(directory, dependencyMarker);
  try {
    if (!(await lstat(marker)).isFile()) throw new Error("Preparation marker is not a regular file");
    const receipt = JSON.parse(await readFile(marker, "utf8"));
    const { treeSha256, ...recorded } = receipt;
    if (JSON.stringify(recorded) !== JSON.stringify(inputs) || typeof treeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(treeSha256)) throw new Error("Stale dependency preparation");
    if (await dependencyTree(directory) !== treeSha256) throw new Error("Installed SDK dependency tree changed after frozen preparation");
    return treeSha256;
  } catch (error) {
    throw new Error("Missing, stale or tampered SDK preparation; run `bun run deps:prepare` with Bun 1.4.2 before packaging", { cause: error });
  }
}

/** Explicit setup only: fresh cache, frozen published lock, no lifecycle scripts.
 * Normal pack/build paths only read this realization and never run an installer.
 */
async function prepareDependencies(): Promise<void> {
  const inputs = await dependencyInputs(root);
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Atomic dependency preparation requires Linux or macOS");
  const stage = await mkdtemp(join(root, ".omp-deps-"));
  try {
    const installation = join(stage, "installation");
    await mkdir(installation);
    await Promise.all(["package.json", "bun.lock"].map(file => cp(join(root, file), join(installation, file))));
    const home = join(stage, "home");
    await mkdir(home);
    const installer = Bun.spawn([
      process.execPath, "install", "--frozen-lockfile", "--ignore-scripts", "--linker", "hoisted",
      "--backend", "copyfile", "--cache-dir", join(stage, "cache"), "--no-progress",
    ], {
      cwd: installation, stdout: "pipe", stderr: "pipe",
      env: {
        PATH: dirname(process.execPath), HOME: home, XDG_CONFIG_HOME: home, NODE_ENV: "development",
        BUN_FEATURE_FLAG_DISABLE_NATIVE_DEPENDENCY_LINKER: "1", BUN_FEATURE_FLAG_DISABLE_IGNORE_SCRIPTS: "1",
        ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
      },
    });
    const [exit] = await Promise.all([
      installer.exited, new Response(installer.stdout).arrayBuffer(), new Response(installer.stderr).arrayBuffer(),
    ]);
    if (exit !== 0) throw new Error(`Clean frozen dependency realization failed (exit ${exit}); prior node_modules is unchanged`);
    if (JSON.stringify(await dependencyInputs(installation)) !== JSON.stringify(inputs) ||
        JSON.stringify(await dependencyInputs(root)) !== JSON.stringify(inputs)) throw new Error("Dependency inputs changed during preparation");
    const modules = join(installation, "node_modules");
    const treeSha256 = await dependencyTree(modules);
    await writeFile(join(modules, dependencyMarker), `${JSON.stringify({ ...inputs, treeSha256 }, null, 2)}\n`);
    await replaceDirectory(modules, join(root, "node_modules"));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Deliberately replaces only the pinned SDK's host/cache-searching loader, not its API.
 * The owner mounts the verified native artifact at this fixed private path. No package
 * resolution, CPU probing, extraction, cache fallback, source checkout or host PATH.
 */
const pinnedLoader = `
let bindings;
export function loadNative() {
  if (bindings) return bindings;
  const module = { exports: {} };
  process.dlopen(module, "/runtime/bin/pi-natives");
  const install = module.exports.__ompInstallTokioRuntime;
  if (typeof install === "function") install();
  bindings = module.exports;
  return bindings;
}
`;

export interface WorkerArtifacts {
  /** Assign these two fields to the selected installation's generated machine half. */
  artifacts: MachineHalf["artifacts"];
  tools: NonNullable<MachineHalf["tools"]>;
  /** Owned bytes for every declared bundleFile, without filesystem staging. */
  members: ReadonlyMap<string, Uint8Array>;
  embeddedBase64Bytes: number;
  /** External owner-provisioned native resource, intentionally not a managed artifact. */
  requiredRuntimeTools: readonly ["system"];
  systemRequirements: typeof runtime.requiredRuntimeTools.system;
}

async function packageRoot(name: string, version = runtime.sdkVersion): Promise<string> {
  let directory = dirname(await realpath(Bun.resolveSync(name, root)));
  for (;;) {
    const file = Bun.file(join(directory, "package.json"));
    if (await file.exists()) {
      const manifest = await file.json();
      if (manifest.name === name) {
        if (!containsPath(await realpath(join(root, "node_modules")), directory)) throw new Error(`Pinned dependency resolves outside prepared node_modules: ${name}`);
        if (manifest.version !== version) throw new Error(`Pinned dependency mismatch: ${name}`);
        return directory;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Pinned package missing: ${name}`);
    directory = parent;
  }
}

function replacePublishedSource(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error("Published packaging adapter no longer matches exactly once");
  return source.replace(before, after);
}

/** Execute the complete shipped helper, changing only its monorepo path mapping.
 * Its export expansion, exclusions, shims and lazy registry remain publisher code.
 * The private copy is temporary; installed packages and upstream checkouts are untouched.
 */
async function legacyPiPlugin(codingAgent: string): Promise<BunPlugin> {
  const packages = {
    agent: "@oh-my-pi/pi-agent-core", ai: "@oh-my-pi/pi-ai",
    "coding-agent": "@oh-my-pi/pi-coding-agent", natives: "@oh-my-pi/pi-natives",
    tui: "@oh-my-pi/pi-tui", utils: "@oh-my-pi/pi-utils",
  };
  const installed = Object.fromEntries(await Promise.all(Object.entries(packages).map(async ([key, name]) => [key, await packageRoot(name)])));
  let source = await readFile(join(codingAgent, "scripts/legacy-pi-virtual-module.ts"), "utf8");
  source = replacePublishedSource(source, 'const packageDir = path.resolve(import.meta.dir, "..");', `const packageDir = ${JSON.stringify(codingAgent)};`);
  source = replacePublishedSource(source, 'path.join(repoRoot, "packages", pkg.dir)', `(${JSON.stringify(installed)} as Record<string, string>)[pkg.dir]!`);
  const stage = await mkdtemp(join(root, ".omp-sdk-helper-"));
  try {
    const file = join(stage, "legacy-pi-virtual-module.ts");
    await writeFile(file, source);
    const helper = await import(file);
    return await helper.createLegacyPiVirtualModulePlugin();
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

// quickjs-wasi@2.2.0 publishes MIT metadata but no standalone license, including
// at its release tag cc1fea4a6a4ac1d960e0db68d35e1459064a1a23. Do not invent a
// publisher copyright. Preserve that provenance and the canonical MIT terms,
// plus the exact QuickJS-NG submodule's publisher copyright/permission notice.
// https://github.com/quickjs-ng/quickjs/blob/dec012362bd93876449f3ecff4f835b2eba89bab/LICENSE
const quickjsNotice = `quickjs-wasi@2.2.0
Publisher: vercel-labs/quickjs-wasi; package.json license: MIT.
https://github.com/vercel-labs/quickjs-wasi/tree/cc1fea4a6a4ac1d960e0db68d35e1459064a1a23
The publisher supplies no standalone LICENSE or copyright notice for this package.
Canonical MIT permission terms follow with the bundled QuickJS-NG engine notice.

QuickJS-NG submodule dec012362bd93876449f3ecff4f835b2eba89bab
The MIT License (MIT)

Copyright (c) 2017-2026 Fabrice Bellard
Copyright (c) 2017-2024 Charlie Gordon
Copyright (c) 2023-2026 Ben Noordhuis
Copyright (c) 2023-2026 Saúl Ibarra Corretgé

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
`;

/** Deterministic ustar: regular members only, fixed mode/uid/gid/mtime, no PAX,
 * host tar/gzip invocation, unbounded directory walks, links or extra files. */
function archive(files: ReadonlyMap<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.length > 100 || name.split("/").some(part => part === ".." || part === ".")) throw new Error("Invalid archive member");
    const header = Buffer.alloc(512);
    header.write(name);
    const octal = (value: number, offset: number, length: number): void => {
      const text = value.toString(8).padStart(length - 1, "0");
      if (text.length >= length) throw new Error("Archive field overflow");
      header.write(`${text}\0`, offset, length, "ascii");
    };
    octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(bytes.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header[156] = 48;
    header.write("ustar\0", 257, "ascii"); header.write("00", 263, "ascii");
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/** Collect license/notice text from packages actually read by the bundler. */
async function notices(importedFiles: Set<string>, codingAgent: string): Promise<Buffer> {
  const visited = new Set<string>();
  const packages = new Map<string, string>();
  for (const imported of [...importedFiles].sort()) {
    let directory = dirname(imported);
    while (!visited.has(directory)) {
      visited.add(directory);
      const file = Bun.file(join(directory, "package.json"));
      if (await file.exists()) {
        const manifest = await file.json();
        if (typeof manifest.name === "string") packages.set(`${manifest.name}@${manifest.version ?? "workspace"}`, directory);
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const sections: string[] = [];
  const publisherNotices = await readFile(join(codingAgent, "THIRD-PARTY-NOTICES.txt"), "utf8");
  let needsPublisherNotices = false;
  for (const [name, directory] of [...packages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice|third-party-notices)(?:[.-].*)?$/i.test(entry.name))
      .map(entry => entry.name).sort();
    for (const filename of entries) sections.push(`${name} / ${filename}\n${await readFile(join(directory, filename), "utf8")}`);
    if (entries.length === 0 && directory.includes("node_modules")) {
      if (name === "quickjs-wasi@2.2.0") sections.push(quickjsNotice);
      else if (name === "@puppeteer/browsers@3.0.6" || name === "puppeteer-core@25.3.0") {
        if (!publisherNotices.includes(`- ${name}: canonical Apache-2.0 text`)) throw new Error(`Missing exact publisher attribution: ${name}`);
        sections.push(`${name} / Apache-2.0\nLicense supplied by @oh-my-pi/pi-coding-agent@${runtime.sdkVersion} THIRD-PARTY-NOTICES.txt below.`);
        needsPublisherNotices = true;
      } else throw new Error(`Bundled dependency has no packaged license: ${name}`);
    }
  }
  if (needsPublisherNotices && !packages.has(`@oh-my-pi/pi-coding-agent@${runtime.sdkVersion}`))
    sections.push(`@oh-my-pi/pi-coding-agent@${runtime.sdkVersion} / THIRD-PARTY-NOTICES.txt\n${publisherNotices}`);
  return Buffer.from(sections.join("\n\n------------------------------------------------------------\n\n") + "\n");
}

/** Build one installation's workers, embedding bounded JS, notices and pinned data.
 * Large native binaries stay exact, hash-pinned published resources. No runtime package installation.
 * Requires the frozen dependency install and pinned sibling Manifold checkout.
 * The packer enforces the final 16 MiB JSON budget after server/web bundling too.
 */
export async function buildWorkerArtifacts(target: WorkerTarget): Promise<WorkerArtifacts> {
  if (Bun.version !== runtime.bunVersion) throw new Error(`Worker packaging requires pinned Bun ${runtime.bunVersion}; received ${Bun.version}`);
  await verifyPreparedDependencies();
  await Promise.all(["@oh-my-pi/pi-ai", "@oh-my-pi/pi-catalog", "@oh-my-pi/pi-utils"].map(name => packageRoot(name)));
  const codingAgent = await packageRoot("@oh-my-pi/pi-coding-agent");
  const legacyPlugin = await legacyPiPlugin(codingAgent);
  const docs = await readFile(join(codingAgent, "dist/docs-index.generated.txt"), "utf8");
  const quickjs = await packageRoot("quickjs-wasi", "2.2.0");
  const quickjsModule = await realpath(join(quickjs, "dist/index.js"));
  const nativePackage = await packageRoot("@oh-my-pi/pi-natives");
  const nativeLoader = await realpath(join(nativePackage, "native/loader-state.js"));
  if (hash(await readFile(nativeLoader)) !== loaderSha256) throw new Error("Unreviewed native SDK loader bytes");
  const artifacts: WorkerArtifacts["artifacts"] = {};
  const tools: WorkerArtifacts["tools"] = {};
  const members = new Map<string, Uint8Array>();
  let embeddedBase64Bytes = 0;
  for (const [alias, layouts] of Object.entries(runtime.tools)) {
    if (target === "gateway" && alias === "omp") continue;
    tools[alias] = {};
    for (const platform of platforms) {
      const declaration = MachineArtifactSchema.parse(layouts[platform]);
      tools[alias]![platform] = declaration;
      if (!declaration.bundleFile || members.has(declaration.bundleFile)) continue;
      const directory = await realpath(join(root, "runtime-data"));
      const file = await realpath(join(directory, declaration.bundleFile));
      const metadata = await lstat(file);
      if (!containsPath(directory, file) || !metadata.isFile() || metadata.size > declaration.maxBytes)
        throw new Error(`Invalid bundled runtime data: ${alias}`);
      const bytes = await readFile(file);
      if (bytes.length > declaration.maxBytes || hash(bytes) !== declaration.sha256)
        throw new Error(`Unreviewed bundled runtime data: ${alias}`);
      embeddedBase64Bytes += 4 * Math.ceil(bytes.length / 3);
      if (embeddedBase64Bytes > maxEmbeddedBytes) throw new Error("Bundled runtime data exceeds native aggregate limit");
      members.set(declaration.bundleFile, bytes);
    }
  }
  for (const [name, source] of Object.entries(entrypoints[target])) {
    const importedFiles = new Set<string>();
    const assets = new Map<string, Buffer>();
    const plugin: BunPlugin = {
      name: "omp-pinned-native-worker",
      setup(build) {
        build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
          const path = await realpath(args.path);
          importedFiles.add(path);
          if (path === nativeLoader) return { contents: pinnedLoader, loader: "js" };
          if (path === quickjsModule) {
            const asset = `${name}-assets/quickjs.wasm`;
            assets.set(asset, await readFile(join(quickjs, "quickjs.wasm")));
            // Preserve the real PAC implementation, relocating only its default file read.
            const contents = replacePublishedSource(await readFile(path, "utf8"),
              "new URL('../quickjs.wasm', import.meta.url)", `new URL(${JSON.stringify(`./${asset}`)}, import.meta.url)`);
            return { contents, loader: "js" };
          }
          return undefined;
        });
      },
    };
    const outputDirectory = join(root, ".omp-worker-output");
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, source)], outdir: outputDirectory,
      naming: { entry: `${name}.js`, asset: `${name}-assets/[name]-[hash].[ext]` },
      target: "bun", format: "esm", splitting: false, minify: true,
      sourcemap: "none", packages: "bundle", plugins: [legacyPlugin, plugin],
      define: { "process.env.PI_DOCS_EMBED": JSON.stringify(docs) },
      tsconfig: join(root, "tsconfig.json"),
    });
    if (!result.success) throw new AggregateError(result.logs, `Worker bundling failed: ${name}`);
    const entry = result.outputs.find(output => output.kind === "entry-point");
    if (!entry) throw new Error(`Missing worker entrypoint: ${name}`);
    for (const output of result.outputs) {
      if (output === entry) continue;
      const member = relative(outputDirectory, resolve(output.path)).split(sep).join("/");
      const prefix = `${name}-assets/`;
      if (output.kind !== "asset" || !member.startsWith(prefix) ||
          !/^(?:template-[a-z0-9]+\.(?:css|html|js)|tool-views\.generated-[a-z0-9]+\.js|CHANGELOG-[a-z0-9]+\.md)$/.test(member.slice(prefix.length)))
        throw new Error(`Undeclared worker bundle output: ${name}: ${member}`);
      const bytes = Buffer.from(await output.arrayBuffer());
      const prior = assets.get(member);
      // Bun may emit an identical file-loader asset through multiple module identities.
      if (prior && !prior.equals(bytes)) throw new Error(`Conflicting worker bundle output: ${name}: ${member}`);
      assets.set(member, bytes);
    }
    const javascript = Buffer.from(await entry.arrayBuffer());
    const imports = new Bun.Transpiler({ loader: "js" }).scanImports(javascript);
    for (const item of imports) {
      if (item.path === "bun" || item.path.startsWith("bun:") || item.path.startsWith("node:") || builtinModules.includes(item.path)) continue;
      throw new Error(`Unbundled worker import: ${name}: ${item.path}`);
    }
    const licenses = await notices(importedFiles, codingAgent);
    let bytes: Buffer;
    let declaration: MachineArtifact;
    if (name === "inventory" || name === "benchmark") {
      if (assets.size !== 0) throw new Error(`Raw worker has undeclared assets: ${name}`);
      // License comments cannot terminate early on third-party text.
      bytes = Buffer.concat([javascript, Buffer.from(`\n/*\n${licenses.toString("utf8").replaceAll("*/", "* /")}\n*/\n`)]);
      const filename = `omp-${name}.js`;
      declaration = { bundleFile: filename, sha256: hash(bytes), format: "raw", entry: [filename], entrySha256: hash(bytes), maxBytes: bytes.length, maxExpandedBytes: bytes.length, maxMembers: 1 };
    } else {
      const files = new Map([[`${name}.js`, javascript], ["licenses/THIRD-PARTY-NOTICES.txt", licenses], ...assets]);
      const declaredFiles: NonNullable<MachineArtifact["files"]> = {
        [`${name}-notices`]: { entry: ["licenses", "THIRD-PARTY-NOTICES.txt"], sha256: hash(licenses), relativeTarget: [`${name}-licenses`, "THIRD-PARTY-NOTICES.txt"] },
      };
      let index = 0;
      for (const [member, asset] of assets) {
        declaredFiles[`${name}-asset-${index++}`] = { entry: member.split("/"), sha256: hash(asset), relativeTarget: member.split("/") };
      }
      bytes = archive(files);
      declaration = {
        bundleFile: `omp-${name}.tar.gz`, sha256: hash(bytes), format: "tar.gz", entry: [`${name}.js`], entrySha256: hash(javascript),
        maxBytes: bytes.length, maxExpandedBytes: 1024 + [...files.values()].reduce((total, file) => total + 512 + Math.ceil(file.length / 512) * 512, 0), maxMembers: files.size,
        files: declaredFiles,
      };
    }
    declaration = MachineArtifactSchema.parse(declaration);
    embeddedBase64Bytes += 4 * Math.ceil(bytes.length / 3);
    if (embeddedBase64Bytes > maxEmbeddedBytes) throw new Error(`Bundled worker members require ${embeddedBase64Bytes} base64 bytes; native plugin aggregate limit is ${maxEmbeddedBytes}. Publish these exact worker archives before distribution; no worker release URL is assumed.`);
    members.set(declaration.bundleFile!, bytes);
    const layouts = Object.fromEntries(platforms.map(platform => [platform, declaration]));
    if (name === "inventory" || name === "broker" || name === "gateway") Object.assign(artifacts, layouts);
    else tools[name] = layouts;
  }
  if (Object.keys(tools).length > 8) throw new Error("Too many native tool maps");
  return { artifacts, tools, members, embeddedBase64Bytes, requiredRuntimeTools: ["system"], systemRequirements: runtime.requiredRuntimeTools.system };
}

if (import.meta.main) {
  if (process.argv.length !== 3 || process.argv[2] !== "--prepare-dependencies") throw new Error("Usage: bun plugins/workers/build.ts --prepare-dependencies");
  await prepareDependencies();
}
