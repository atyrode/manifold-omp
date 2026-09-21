#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, realpathSync, writeFileSync, type BigIntStats } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CString, cc, dlopen, ptr, read as nativeRead, toArrayBuffer } from "bun:ffi";
import { compilePlugin, type PackResult } from "../../manifold/packages/plugin-kit/src/pack.ts";
import { verifyBundledArtifacts } from "../../manifold/packages/plugin-kit/src/artifacts.ts";
import {
  ISOLATE_MAX_ARTIFACT_BYTES,
  MachineHalfSchema,
  PluginBundleSchema,
  PluginManifestSchema,
  type PluginManifest,
} from "../../manifold/packages/protocol/src/index.ts";
import { buildWorkerArtifacts, containsPath, verifyPreparedDependencies, type WorkerArtifacts, type WorkerTarget } from "./workers/build.ts";
import runtime from "./runtime-artifacts.json";

const pluginRoot = import.meta.dir;
// This is also the explicit installation order: parent, native accounts, gateway.
const familyIds = ["atyrode.omp", "atyrode.omp.accounts", "atyrode.omp.gateway"];
const manifoldRoot = resolve(pluginRoot, "../../manifold");
const configuredGit = process.env.OMP_PACK_GIT ?? Bun.which("git");
if (!configuredGit || !isAbsolute(configuredGit)) {
  throw new Error("Plugin packaging requires an absolute OMP_PACK_GIT or a resolvable git");
}
const gitExecutable = realpathSync(configuredGit);

async function git(args: readonly string[]): Promise<string> {
  const child = Bun.spawn([gitExecutable, "-C", manifoldRoot, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: 64 * 1024,
  });
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Cannot establish Manifold source provenance: ${error.trim()}`);
  return output.trim();
}

async function verifyManifoldSource(): Promise<string> {
  const expected = (await readFile(join(pluginRoot, "MANIFOLD_REV"), "utf8")).trim();
  if (!/^[a-f0-9]{40}$/.test(expected)) throw new Error("MANIFOLD_REV must contain one full Git revision");
  const revision = await git(["rev-parse", "HEAD"]);
  if (revision !== expected) {
    throw new Error(`Sibling Manifold source is ${revision}, not pinned MANIFOLD_REV ${expected}`);
  }
  if (await git(["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new Error("Sibling Manifold source is dirty; packaging provenance is not immutable");
  }
  return revision;
}

async function recordManifoldSource(
  compiled: Awaited<ReturnType<typeof compilePlugin>>,
  revision: string,
): Promise<Awaited<ReturnType<typeof compilePlugin>>> {
  const current = PluginBundleSchema.parse(JSON.parse(new TextDecoder().decode(compiled.bytes)));
  const bundle = PluginBundleSchema.parse({
    ...current,
    builtAgainst: { ...current.builtAgainst, "@manifold/source": revision },
  });
  await verifyBundledArtifacts(bundle);
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  if (bytes.byteLength > ISOLATE_MAX_ARTIFACT_BYTES) {
    throw new Error("plugin bundle exceeds the artifact byte budget");
  }
  return {
    bytes,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  };
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return join(canonicalPath(dirname(path)), basename(path));
  }
}

function containsDirectoryIdentity(parent: BigIntStats, path: string): boolean {
  for (let current = path;; current = dirname(current)) {
    try {
      if (sameDirectory(parent, lstatSync(current, { bigint: true }))) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) return false;
  }
}

function destinationPath(path: string): { path: string; existing: BigIntStats | undefined } {
  const requested = resolve(path);
  let existing: BigIntStats | undefined;
  try { existing = lstatSync(requested, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing && !existing.isDirectory()) throw new Error("Unsafe packaging destination: expected a directory, not a file or symlink");
  // realpath the leaf too: an existing PLUGINS alias can be the source directory
  // on a case-insensitive volume, even though its parent already is canonical.
  const destination = existing ? realpathSync(requested) : join(canonicalPath(dirname(requested)), basename(requested));
  const source = realpathSync(pluginRoot);
  const sdk = realpathSync(resolve(pluginRoot, "../../manifold"));
  const cwd = realpathSync(process.cwd());
  // realpath need not normalize case on every filesystem/runtime. Compare
  // ancestor inode identities too, including the nearest extant parent of an
  // absent output; spelling alone never authorizes a source or SDK alias.
  const withinSource = containsDirectoryIdentity(lstatSync(source, { bigint: true }), destination);
  const withinSdk = containsDirectoryIdentity(lstatSync(sdk, { bigint: true }), destination);
  if (containsPath(destination, source) || containsPath(destination, cwd) ||
      ((containsPath(source, destination) || withinSource) && destination !== join(source, "dist")) ||
      containsPath(destination, sdk) || containsPath(sdk, destination) || withinSdk ||
      (existing && [source, sdk, cwd].some(directory => containsDirectoryIdentity(existing, directory))) ||
      destination.split(sep).some(part => [".omp-native-pack-", ".omp-publish-", ".omp-deps-"].some(prefix => (process.platform === "darwin" ? part.toLowerCase() : part).startsWith(prefix)))) {
    throw new Error("Unsafe packaging destination: output must not overlap source, SDK or staging directories");
  }
  return { path: destination, existing };
}

const sameDirectory = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino;

/** All publication and cleanup names are single components relative to held
 * directories, never absolute paths checked before an await. The 0700 staging
 * directories are private to this run. This is not inode-CAS: neither platform
 * offers conditional exchange/unlink against an expected inode. A same-UID
 * process mutating private staging between individual syscalls is outside this
 * boundary; an unexpected displaced destination is retained, never recursed into.
 */
function directoryOperations() {
  const linux = process.platform === "linux";
  if ((!linux && process.platform !== "darwin") || !["x64", "arm64"].includes(process.arch)) throw new Error("Safe atomic packaging requires Linux or macOS on x64 or arm64");
  // Node does not expose O_CLOEXEC; use the native platform constants.
  const closeOnExec = linux ? 0x80000 : 0x1000000;
  const libc = dlopen(linux ? "libc.so.6" : "/usr/lib/libSystem.B.dylib", {
    // Only the addresses are consumed; variadic calls go through the C wrappers.
    openat: { args: [], returns: "i32" },
    fcntl: { args: [], returns: "i32" },
    mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
    unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    closedir: { args: ["ptr"], returns: "i32" },
  });
  // Pinned Bun exposes these addresses, but its declarations omit that property.
  const openatAddress = (libc.symbols.openat as typeof libc.symbols.openat & { readonly ptr: ReturnType<typeof ptr> }).ptr;
  const fcntlAddress = (libc.symbols.fcntl as typeof libc.symbols.fcntl & { readonly ptr: ReturnType<typeof ptr> }).ptr;
  if (!Number.isSafeInteger(openatAddress) || openatAddress <= 0 || !Number.isSafeInteger(fcntlAddress) || fcntlAddress <= 0) {
    libc.close();
    throw new Error("Native publication symbol addresses are unavailable; no pathname fallback is permitted");
  }
  const fixed = (() => {
    try {
      // No external compiler, SDK headers or library search; unsupported compilation
      // fails before filesystem mutation rather than narrowing the publication guarantee.
      return cc({
        source: join(pluginRoot, "pack-native.c"),
        flags: ["-nostdlib"],
        symbols: {
          omp_pack_openat: { args: ["ptr", "i32", "ptr", "i32", "u32"], returns: "i32" },
          omp_pack_fcntl_pointer: { args: ["ptr", "i32", "i32", "ptr"], returns: "i32" },
        },
      });
    } catch (error) {
      libc.close();
      throw error;
    }
  })();
  const platform = linux
    ? dlopen("libc.so.6", {
      renameat2: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
      __errno_location: { args: [], returns: "ptr" },
    })
    : dlopen("/usr/lib/libSystem.B.dylib", {
      renameatx_np: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
      __error: { args: [], returns: "ptr" },
    });
  // x64 Darwin retains the legacy 32-bit-inode ABI under unsuffixed names;
  // arm64 has only the 64-bit-inode ABI.
  const directorySuffix = !linux && process.arch === "x64" ? "$INODE64" : "";
  const directoryApi = dlopen(linux ? "libc.so.6" : "/usr/lib/libSystem.B.dylib", {
    [`fdopendir${directorySuffix}`]: { args: ["i32"], returns: "ptr" },
    [`readdir${directorySuffix}`]: { args: ["ptr"], returns: "ptr" },
  });
  const errnoAddress = ("__errno_location" in platform.symbols ? platform.symbols.__errno_location!() : platform.symbols.__error!())!;
  const errnoValue = new Int32Array(toArrayBuffer(errnoAddress, 0, 4));
  const errno = () => errnoValue[0]!;
  const failure = (operation: string) => new Error(`Safe packaging ${operation} failed (errno ${errno()}); no pathname fallback is permitted`);
  const nameBytes = (name: string) => {
    if (!name || name.includes("\0") || (name !== "/" && name.includes("/"))) throw new Error("Unsafe relative packaging name");
    return Buffer.from(`${name}\0`);
  };
  function openDirectory(parent: number, name: string, absent = false): number | undefined {
    const bytes = nameBytes(name);
    const fd = fixed.symbols.omp_pack_openat(openatAddress, parent, ptr(bytes), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec, 0);
    if (fd >= 0) return fd;
    if (absent && errno() === osConstants.errno.ENOENT) return undefined;
    throw failure(`openat directory ${name}`);
  }
  function makeDirectory(parent: number, name: string, mode = 0o700): void {
    const bytes = nameBytes(name);
    if (libc.symbols.mkdirat(parent, ptr(bytes), mode) !== 0) throw failure(`mkdirat ${name}`);
  }
  function pinPath(path: string, create = false): number {
    let fd = openDirectory(linux ? -100 : -2, "/")!;
    try {
      for (const name of resolve(path).split(sep).filter(Boolean)) {
        let next = openDirectory(fd, name, create);
        if (next === undefined) {
          makeDirectory(fd, name, 0o755);
          next = openDirectory(fd, name)!;
        }
        closeSync(fd);
        fd = next;
      }
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  function privateDirectory(parent: number, prefix: string): { name: string; fd: number } {
    const name = `${prefix}${randomUUID()}`;
    makeDirectory(parent, name);
    return { name, fd: openDirectory(parent, name)! };
  }
  function matches(parent: number, name: string, expected: number | undefined): boolean {
    let actual: number | undefined;
    try {
      actual = openDirectory(parent, name, true);
      return actual === undefined ? expected === undefined
        : expected !== undefined && sameDirectory(fstatSync(actual, { bigint: true }), fstatSync(expected, { bigint: true }));
    } catch { return false; }
    finally { if (actual !== undefined) closeSync(actual); }
  }
  function entries(fd: number): { name: string; directory: boolean }[] {
    const copy = openDirectory(fd, ".")!;
    const stream = directoryApi.symbols[`fdopendir${directorySuffix}`]!(copy);
    if (!stream) { closeSync(copy); throw failure("fdopendir"); }
    const result: { name: string; directory: boolean }[] = [];
    try {
      // Darwin's 64-bit dirent has d_name at 21; Linux's at 19. These ABIs
      // are shared by the supported x64/arm64 hosts. Other hosts fail closed.
      for (;;) {
        errnoValue[0] = 0;
        const entry = directoryApi.symbols[`readdir${directorySuffix}`]!(stream);
        if (!entry) {
          if (errno() !== 0) throw failure("readdir");
          break;
        }
        const name = new CString(entry, linux ? 19 : 21).toString();
        if (name !== "." && name !== "..") result.push({ name, directory: nativeRead.u8(entry, linux ? 18 : 20) === 4 });
      }
    } finally { libc.symbols.closedir(stream); }
    return result;
  }
  function unlink(parent: number, name: string, directory: boolean): void {
    const bytes = nameBytes(name);
    if (libc.symbols.unlinkat(parent, ptr(bytes), directory ? (linux ? 0x200 : 0x80) : 0) !== 0) throw failure(`unlinkat ${name}`);
  }
  function empty(fd: number): void {
    for (const entry of entries(fd)) {
      // Never follow symlinks, including symlinks in a retired output tree.
      // DT_UNKNOWN is handled by trying the directory-only nofollow open.
      let child: number | undefined;
      try { child = openDirectory(fd, entry.name); } catch (error) {
        if (entry.directory || ![osConstants.errno.ENOTDIR, osConstants.errno.ELOOP].includes(errno())) throw error;
      }
      if (child === undefined) unlink(fd, entry.name, false);
      else {
        try { removeOwned(fd, entry.name, child); } finally { closeSync(child); }
      }
    }
  }
  function removeOwned(parent: number, name: string, fd: number): void {
    if (!matches(parent, name, fd)) throw new Error(`Packaging cleanup identity changed; retained ${name}`);
    empty(fd);
    if (!matches(parent, name, fd)) throw new Error(`Packaging cleanup identity changed; retained ${name}`);
    unlink(parent, name, true);
  }
  function writeOutput(fd: number, name: string, bytes: Uint8Array | string): void {
    const path = nameBytes(name);
    const file = fixed.symbols.omp_pack_openat(openatAddress, fd, ptr(path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | closeOnExec, 0o644);
    if (file < 0) throw failure(`openat output ${name}`);
    try { writeFileSync(file, bytes); fsyncSync(file); } finally { closeSync(file); }
  }
  function publish(parent: number, name: string, publication: number, output: number, previous: number | undefined): boolean {
    if (!matches(publication, "family", output)) throw new Error("Publication staging identity changed");
    if (!matches(parent, name, previous)) throw new Error("Publication destination identity changed; existing bytes were preserved");
    fsyncSync(output);
    const from = nameBytes("family"), to = nameBytes(name);
    const status = "renameat2" in platform.symbols
      ? platform.symbols.renameat2!(publication, ptr(from), parent, ptr(to), previous === undefined ? 1 : 2)
      : platform.symbols.renameatx_np!(publication, ptr(from), parent, ptr(to), previous === undefined ? 4 : 2);
    if (status !== 0) throw failure("atomic directory publication");
    // The syscall does not compare inodes. Check the displaced side before any
    // recursive cleanup; do not attempt a second, equally non-CAS rollback.
    return previous === undefined || matches(publication, "family", previous);
  }
  function heldPath(fd: number): string {
    // Reporting only: no write or cleanup resolves authority back through this path.
    // Fail closed if Linux procfs or Darwin F_GETPATH cannot name the held inode.
    if (linux) return realpathSync(`/proc/self/fd/${fd}`);
    const bytes = Buffer.alloc(1024);
    if (fixed.symbols.omp_pack_fcntl_pointer(fcntlAddress, fd, 50, ptr(bytes)) !== 0) throw failure("F_GETPATH");
    const end = bytes.indexOf(0);
    if (end <= 0) throw new Error("Cannot name held packaging directory");
    return bytes.toString("utf8", 0, end);
  }
  return {
    pinPath, privateDirectory, openDirectory, makeDirectory, removeOwned, writeOutput, publish, heldPath,
    close() { directoryApi.close(); platform.close(); libc.close(); fixed.close(); },
  };
}

function includeSource(path: string): boolean {
  const name = basename(path);
  return !name.startsWith(".") && !["node_modules", "dist", "staging"].includes(name);
}

async function manifests(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!includeSource(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await manifests(path));
    else if (entry.isFile() && entry.name === "manifest.json") files.push(path);
  }
  return files.sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0));
}

async function generatedManifest(directory: string, expectedId: string, target: WorkerTarget): Promise<{ manifest: PluginManifest; built: WorkerArtifacts }> {
  const manifest = PluginManifestSchema.parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
  if (manifest.id !== expectedId || !manifest.machine) throw new Error(`${expectedId} native machine contract is missing`);
  const built = await buildWorkerArtifacts(target);
  manifest.machine.artifacts = built.artifacts;
  manifest.machine.tools = built.tools;
  const machine = MachineHalfSchema.parse(manifest.machine);
  const usedTools = new Set<string>();
  for (const [id, operation] of Object.entries(machine.operations)) {
    for (const required of built.requiredRuntimeTools) {
      if (!operation.runtimeTools.includes(required)) throw new Error(`${id} must declare the reviewed native '${required}' resource dependency`);
    }
    if ((target === "gateway" || id === "atyrode.omp.accounts.broker") && !operation.runtimeTools.includes("pi-natives")) throw new Error(`${id} must declare the pinned SDK native addon`);
    for (const alias of operation.runtimeTools) usedTools.add(alias);
  }
  for (const alias of Object.keys(built.tools)) {
    if (!usedTools.has(alias)) throw new Error(`${expectedId} has an unused managed tool: ${alias}`);
  }
  return { manifest, built };
}

/** Source and prepared dependencies are trusted read-only inputs during compilation.
 * Generated manifests and workers stay in memory; only verified bundle bytes reach
 * held-descriptor publication, so no replaceable source-staging path exists.
 */
export async function pack(outputDirectory?: string): Promise<readonly (PackResult & { readonly id: string })[]> {
  if (Bun.version !== runtime.bunVersion) throw new Error(`Plugin packaging requires pinned Bun ${runtime.bunVersion}; received ${Bun.version}`);
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Atomic packaging requires Linux or macOS");
  const requested = resolve(outputDirectory ?? join(pluginRoot, "dist"));
  const dist = destinationPath(requested);
  const directories = directoryOperations();
  let parent: number | undefined, previous: number | undefined, outputFd: number | undefined;
  let publication: { name: string; fd: number } | undefined;
  let retained = false;
  let packError: unknown;
  try {
    // Capture directory authority before the first dependency/build await. Walking
    // canonical components with O_NOFOLLOW also refuses substitution while opening.
    parent = directories.pinPath(dirname(dist.path), true);
    previous = directories.openDirectory(parent, basename(dist.path), true);
    if (previous === undefined ? dist.existing !== undefined
      : dist.existing === undefined || !sameDirectory(fstatSync(previous, { bigint: true }), dist.existing)) {
      throw new Error("Publication destination identity changed during validation");
    }
    const manifoldRevision = await verifyManifoldSource();
    const dependencyDigest = await verifyPreparedDependencies();
    publication = directories.privateDirectory(parent, ".omp-publish-");
    directories.makeDirectory(publication.fd, "family", 0o755);
    outputFd = directories.openDirectory(publication.fd, "family")!;
    const rootDirectory = join(pluginRoot, "atyrode.omp");
    const family = await manifests(rootDirectory);
    const byId = new Map<string, string>();
    for (const file of family) {
      const { id } = JSON.parse(await readFile(file, "utf8"));
      if (!familyIds.includes(id) || byId.has(id)) throw new Error(`Unexpected or duplicate OMP family manifest: ${relative(pluginRoot, file)}`);
      byId.set(id, file);
    }
    if (familyIds.some(id => !byId.has(id))) throw new Error("The three OMP family manifests must be packed together");
    // Keep previous output intact until every parent-before-part bundle has passed kit
    // schema, artifact hash/member checks and the aggregate 16 MiB JSON bound.
    const sums: string[] = [];
    const bundles: (PackResult & { readonly id: string })[] = [];
    let requirements: string | undefined;
    for (const id of familyIds) {
      const directory = dirname(byId.get(id)!);
      const filename = `${id}.manifold-plugin.json`;
      const target: WorkerTarget = id === "atyrode.omp" ? "root" : id === "atyrode.omp.accounts" ? "accounts" : "gateway";
      const { manifest, built } = await generatedManifest(directory, id, target);
      if (target === "root") requirements = `${JSON.stringify({ requiredRuntimeTools: built.requiredRuntimeTools, system: built.systemRequirements }, null, 2)}\n`;
      let result;
      try {
        result = await recordManifoldSource(
          await compilePlugin(directory, { generated: { manifest, members: built.members } }),
          manifoldRevision,
        );
      } catch (error) {
        throw new Error(`Packing ${id} failed`, { cause: error });
      }
      directories.writeOutput(outputFd, filename, result.bytes);
      sums.push(`${result.sha256}  ${filename}`);
      bundles.push({ id, file: filename, sha256: result.sha256, bytes: result.bytes.byteLength });
    }
    const checksums = `${sums.join("\n")}\n`;
    directories.writeOutput(outputFd, "SHA256SUMS", checksums);
    // A report, not a fake local installation: native admission checks the externally
    // reviewed system closure and its promoted digest on the selected machine.
    if (requirements === undefined) throw new Error("The root runtime requirements were not compiled");
    directories.writeOutput(outputFd, "native-requirements.json", requirements);
    if (await verifyPreparedDependencies() !== dependencyDigest) throw new Error("Prepared SDK changed while packaging");
    if (await verifyManifoldSource() !== manifoldRevision) throw new Error("Manifold source changed while packaging");
    const publishedParent = directories.heldPath(parent);
    if (!directories.publish(parent, basename(dist.path), publication.fd, outputFd, previous)) {
      retained = true;
      const identity = fstatSync(parent, { bigint: true });
      throw new Error(`Publication identity changed during atomic exchange; commit state is ambiguous. Displaced bytes retained at last-known path ${join(publishedParent, publication.name, "family")} (held parent dev=${identity.dev} ino=${identity.ino}); no unsafe rollback or cleanup attempted`);
    }
    if (outputDirectory === undefined) process.stdout.write(checksums);
    const reportedDirectory = publishedParent === dirname(dist.path) ? requested : join(publishedParent, basename(dist.path));
    return bundles.map(bundle => ({ ...bundle, file: join(reportedDirectory, basename(bundle.file)) }));
  } catch (error) {
    packError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (publication !== undefined && parent !== undefined && !retained) {
      try { directories.removeOwned(parent, publication.name, publication.fd); } catch (error) { cleanupErrors.push(error); }
    }
    for (const fd of [outputFd, previous, publication?.fd, parent]) {
      if (fd !== undefined) closeSync(fd);
    }
    directories.close();
    if (cleanupErrors.length) throw new AggregateError([...(packError === undefined ? [] : [packError]), ...cleanupErrors], "Packaging failed to clean only its owned directories");
  }
}

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error("Usage: bun plugins/pack.ts");
  await pack();
}
