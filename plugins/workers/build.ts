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
const loaderSha256 = "6d46cb5c28e1ed40ae94c6019c90399b9b326f4d2b5bf944a802542147356bf8";
const dependencyMarker = ".omp-prepared-dependencies.json";
const patchFile = "patches/@oh-my-pi%2Fpi-ai@18.1.14.patch";
// Review these together with bun.lock and the complete patch, never installed files.
const lockSha256 = "ad91009fa29101b83f5311ad863d652e2b0c79173ebca2cbd57075ff83878b3d";
const patchSha256 = "ef3aaf1d847e1cc2729819b695e28c96ac697561987a49f4951c566141c8c40d";

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
  const [lock, patch, manifest] = await Promise.all([
    readFile(join(directory, "bun.lock")), readFile(join(directory, patchFile)),
    readFile(join(directory, "package.json"), "utf8").then(text => JSON.parse(text)),
  ]);
  if (hash(lock) !== lockSha256) throw new Error("Unreviewed bun.lock bytes");
  if (hash(patch) !== patchSha256) throw new Error("Unreviewed pi-ai patch bytes");
  const dependencies = {
    dependencies: manifest.dependencies, devDependencies: manifest.devDependencies,
    patchedDependencies: manifest.patchedDependencies,
  };
  if (JSON.stringify(manifest.patchedDependencies) !== JSON.stringify({ "@oh-my-pi/pi-ai@18.1.14": patchFile })) throw new Error("Unreviewed SDK patch declaration");
  return {
    format: 1, bunVersion: Bun.version, platform: process.platform, arch: process.arch,
    lockSha256, patchSha256, manifestSha256: hash(Buffer.from(JSON.stringify(dependencies))),
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

/** Explicit setup only: fresh cache, frozen lock, exact patch, no lifecycle scripts.
 * Normal pack/build paths only read this realization and never run an installer.
 */
async function prepareDependencies(): Promise<void> {
  const inputs = await dependencyInputs(root);
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Atomic dependency preparation requires Linux or macOS");
  const stage = await mkdtemp(join(root, ".omp-deps-"));
  try {
    const installation = join(stage, "installation");
    await mkdir(join(installation, "patches"), { recursive: true });
    await Promise.all(["package.json", "bun.lock", patchFile].map(file => cp(join(root, file), join(installation, file))));
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

async function packageRoot(name: string): Promise<string> {
  let directory = dirname(await realpath(Bun.resolveSync(name, root)));
  for (;;) {
    const file = Bun.file(join(directory, "package.json"));
    if (await file.exists()) {
      const manifest = await file.json();
      if (manifest.name === name) {
        if (!containsPath(await realpath(join(root, "node_modules")), directory)) throw new Error(`Pinned dependency resolves outside prepared node_modules: ${name}`);
        if (manifest.version !== runtime.sdkVersion) throw new Error(`Pinned dependency mismatch: ${name}`);
        return directory;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Pinned package missing: ${name}`);
    directory = parent;
  }
}

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
async function notices(importedFiles: Set<string>): Promise<Buffer> {
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
  for (const [name, directory] of [...packages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice|third-party-notices)(?:[.-].*)?$/i.test(entry.name))
      .map(entry => entry.name).sort();
    for (const filename of entries) sections.push(`${name} / ${filename}\n${await readFile(join(directory, filename), "utf8")}`);
    if (entries.length === 0 && directory.includes("node_modules")) throw new Error(`Bundled dependency has no packaged license: ${name}`);
  }
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
  await Promise.all(["@oh-my-pi/pi-ai", "@oh-my-pi/pi-catalog", "@oh-my-pi/pi-utils"].map(packageRoot));
  const nativePackage = await packageRoot("@oh-my-pi/pi-natives");
  const nativeLoader = await realpath(join(nativePackage, "native/loader-state.js"));
  if (hash(await readFile(nativeLoader)) !== loaderSha256) throw new Error("Unreviewed native SDK loader bytes");
  const artifacts: WorkerArtifacts["artifacts"] = {};
  const tools: WorkerArtifacts["tools"] = {};
  const members = new Map<string, Uint8Array>();
  let embeddedBase64Bytes = 0;
  for (const [alias, layouts] of Object.entries(runtime.tools)) {
    if (target === "gateway" && alias === "omp") continue;
    if (target === "root" && alias === "pi-natives") continue;
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
    let usesNative = false;
    const plugin: BunPlugin = {
      name: "omp-pinned-native-worker",
      setup(build) {
        build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
          const path = await realpath(args.path);
          importedFiles.add(path);
          if (path !== nativeLoader) return undefined;
          usesNative = true;
          return { contents: pinnedLoader, loader: "js" };
        });
      },
    };
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, source)], naming: `${name}.js`,
      target: "bun", format: "esm", splitting: false, minify: true,
      sourcemap: "none", packages: "bundle", plugins: [plugin],
      tsconfig: join(root, "tsconfig.json"),
    });
    if (!result.success) throw new AggregateError(result.logs, `Worker bundling failed: ${name}`);
    if (result.outputs.length !== 1) throw new Error(`Undeclared worker bundle outputs: ${name}`);
    const javascript = Buffer.from(await result.outputs[0]!.arrayBuffer());
    const imports = new Bun.Transpiler({ loader: "js" }).scanImports(javascript);
    for (const item of imports) {
      if (item.path === "bun" || item.path.startsWith("bun:") || item.path.startsWith("node:") || builtinModules.includes(item.path)) continue;
      throw new Error(`Unbundled worker import: ${name}: ${item.path}`);
    }
    if (usesNative && target === "root") throw new Error(`Worker unexpectedly needs native addon: ${name}`);
    const licenses = await notices(importedFiles);
    let bytes: Buffer;
    let declaration: MachineArtifact;
    if (name === "inventory" || name === "benchmark") {
      // License comments cannot terminate early on third-party text.
      bytes = Buffer.concat([javascript, Buffer.from(`\n/*\n${licenses.toString("utf8").replaceAll("*/", "* /")}\n*/\n`)]);
      const filename = `omp-${name}.js`;
      declaration = { bundleFile: filename, sha256: hash(bytes), format: "raw", entry: [filename], entrySha256: hash(bytes), maxBytes: bytes.length, maxExpandedBytes: bytes.length, maxMembers: 1 };
    } else {
      const files = new Map([[`${name}.js`, javascript], ["licenses/THIRD-PARTY-NOTICES.txt", licenses]]);
      bytes = archive(files);
      declaration = {
        bundleFile: `omp-${name}.tar.gz`, sha256: hash(bytes), format: "tar.gz", entry: [`${name}.js`], entrySha256: hash(javascript),
        maxBytes: bytes.length, maxExpandedBytes: 2048 + Math.ceil(javascript.length / 512) * 512 + Math.ceil(licenses.length / 512) * 512, maxMembers: files.size,
        files: { [`${name}-notices`]: { entry: ["licenses", "THIRD-PARTY-NOTICES.txt"], sha256: hash(licenses), relativeTarget: [`${name}-licenses`, "THIRD-PARTY-NOTICES.txt"] } },
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
