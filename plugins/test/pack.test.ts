import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { PackResult } from "../../../manifold/packages/plugin-kit/src/pack.ts";
import type { pack } from "../pack.ts";

const source = resolve(import.meta.dir, "..");
const family = ["atyrode.omp", "atyrode.omp.accounts", "atyrode.omp.gateway"];
const publishedFiles = [...family.map(id => `${id}.manifold-plugin.json`), "SHA256SUMS", "native-requirements.json"].sort();
let fixture: string;
let scratch: string;
let fixturePack: typeof pack;

beforeAll(async () => {
  // A private same-depth source and dependency copy exercises real compiler failures
  // without changing the checkout, shared installed packages or another test's dist.
  fixture = await mkdtemp(join(dirname(source), ".omp-pack-test-"));
  scratch = await mkdtemp(join(tmpdir(), "omp-pack-test-"));
  await cp(source, fixture, {
    recursive: true, verbatimSymlinks: true,
    filter: path => !basename(path).startsWith(".") && !["node_modules", "dist", "staging"].includes(basename(path)),
  });
  // The prepared tree must retain every member, including its generated marker.
  await cp(join(source, "node_modules"), join(fixture, "node_modules"), { recursive: true, verbatimSymlinks: true });
  const module = await import(join(fixture, "pack.ts"));
  fixturePack = module.pack;
}, 180_000);

afterAll(async () => {
  await Promise.all([
    ...(fixture ? [rm(fixture, { recursive: true, force: true })] : []),
    ...(scratch ? [rm(scratch, { recursive: true, force: true })] : []),
  ]);
});

async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(current: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files[path.slice(directory.length + 1)] = (await readFile(path)).toString("base64");
    }
  }
  await visit(directory);
  return files;
}

async function priorFamily(destination: string): Promise<Record<string, string>> {
  await mkdir(join(destination, "stale-member"), { recursive: true });
  await writeFile(join(destination, "stale-member", "retained.txt"), "prior nested bytes\n");
  for (const filename of publishedFiles) await writeFile(join(destination, filename), `prior ${filename}\n`);
  return snapshot(destination);
}

for (const destinationKind of ["default", "caller"] as const) {
  describe(`${destinationKind} destination`, () => {
    for (const [part, id] of [["accounts", family[1]!], ["gateway", family[2]!]] as const) {
      test(`${part} compiler failure preserves the complete prior family`, async () => {
        const destination = destinationKind === "default" ? join(fixture, "dist") : join(scratch, `failure-${part}`);
        const previous = await priorFamily(destination);
        const entrypoint = join(fixture, "atyrode.omp", part, "server.ts");
        const sourceBytes = await readFile(entrypoint);
        try {
          await writeFile(entrypoint, "export const invalid = ;\n");
          await expect(fixturePack(destinationKind === "default" ? undefined : destination)).rejects.toThrow(`Packing ${id} failed`);
          expect(await snapshot(destination)).toEqual(previous);
        } finally {
          await writeFile(entrypoint, sourceBytes);
        }
      }, 180_000);
    }

    test("publication is atomic, removes stale members and preserves deterministic family order", async () => {
      const destination = destinationKind === "default" ? join(fixture, "dist") : join(scratch, "published");
      await priorFamily(destination);
      const previousNames = (await readdir(destination)).sort();
      const observations = new Set([JSON.stringify(previousNames)]);
      let observing = true;
      const observer = (async () => {
        while (observing) {
          try { observations.add(JSON.stringify((await readdir(destination)).sort())); }
          catch (error) { observations.add(String(error)); break; }
        }
      })();
      const first = await fixturePack(destinationKind === "default" ? undefined : destination).finally(async () => {
        observing = false;
        await observer;
      });
      const finalNames = (await readdir(destination)).sort();
      observations.add(JSON.stringify(finalNames));
      for (const names of observations) expect([JSON.stringify(previousNames), JSON.stringify(publishedFiles)]).toContain(names);
      expect(finalNames).toEqual(publishedFiles);
      expect(first.map(({ id }) => id)).toEqual(family);
      expect(first.map(({ file }) => file)).toEqual(family.map(id => join(destination, `${id}.manifold-plugin.json`)));
      expect(await readFile(join(destination, "SHA256SUMS"), "utf8")).toBe(first.map(({ id, sha256 }) => `${sha256}  ${id}.manifold-plugin.json\n`).join(""));
      for (const bundle of first) {
        const bytes = await readFile(bundle.file);
        expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(bundle.sha256);
        expect(bytes.length).toBe(bundle.bytes);
        const parsed = JSON.parse(bytes.toString("utf8"));
        expect(parsed.manifest.id).toBe(bundle.id);
        expect(parsed.builtAgainst?.["@manifold/source"]).toBe(
          (await readFile(join(fixture, "MANIFOLD_REV"), "utf8")).trim(),
        );
      }
      const firstBytes = await snapshot(destination);
      const second = await fixturePack(destinationKind === "default" ? undefined : destination);
      expect(second.map(({ id }) => id)).toEqual(family);
      expect(await snapshot(destination)).toEqual(firstBytes);
    }, 360_000);
  });
}

for (const dependency of ["@oh-my-pi/pi-ai", "@oh-my-pi/pi-wire"]) {
  test(`same-version ${dependency} source tampering refuses publication`, async () => {
    const destination = join(scratch, "tampered-sdk");
    const previous = await priorFamily(destination);
    const entrypoint = Bun.resolveSync(dependency, fixture);
    const original = await readFile(entrypoint);
    const manifest = JSON.parse(await readFile(join(fixture, "node_modules", dependency, "package.json"), "utf8"));
    expect(manifest.version).toBe("18.1.14");
    try {
      await writeFile(entrypoint, Buffer.concat([original, Buffer.from("\n// changed installed SDK bytes\n")]));
      await expect(fixturePack(destination)).rejects.toThrow("SDK preparation");
      expect(await snapshot(destination)).toEqual(previous);
    } finally {
      await writeFile(entrypoint, original);
    }
  }, 180_000);
}

for (const [filename, refusal] of [["bun.lock", "Unreviewed bun.lock"], ["patches/@oh-my-pi%2Fpi-ai@18.1.14.patch", "Unreviewed pi-ai patch"]]) {
  test(`${filename} drift refuses the previously prepared SDK`, async () => {
    const destination = join(scratch, "changed-input");
    const previous = await priorFamily(destination);
    const file = join(fixture, filename!);
    const original = await readFile(file);
    try {
      await writeFile(file, Buffer.concat([original, Buffer.from("\n")]));
      await expect(fixturePack(destination)).rejects.toThrow(refusal!);
      expect(await snapshot(destination)).toEqual(previous);
    } finally {
      await writeFile(file, original);
    }
  });
}

test("a MANIFOLD_REV that does not name the sibling source refuses publication", async () => {
  const destination = join(scratch, "changed-manifold-pin");
  const previous = await priorFamily(destination);
  const file = join(fixture, "MANIFOLD_REV");
  const original = await readFile(file);
  try {
    await writeFile(file, `${"0".repeat(40)}\n`);
    await expect(fixturePack(destination)).rejects.toThrow("not pinned MANIFOLD_REV");
    expect(await snapshot(destination)).toEqual(previous);
  } finally {
    await writeFile(file, original);
  }
});

test("missing preparation and a forged tree digest fail closed", async () => {
  const destination = join(scratch, "missing-preparation");
  const previous = await priorFamily(destination);
  const marker = join(fixture, "node_modules", ".omp-prepared-dependencies.json");
  const original = await readFile(marker);
  try {
    await rm(marker);
    await expect(fixturePack(destination)).rejects.toThrow("SDK preparation");
    expect(await snapshot(destination)).toEqual(previous);
    const receipt = JSON.parse(original.toString("utf8"));
    await writeFile(marker, JSON.stringify({ ...receipt, treeSha256: "0".repeat(64) }));
    await expect(fixturePack(destination)).rejects.toThrow("SDK preparation");
    expect(await snapshot(destination)).toEqual(previous);
  } finally {
    await writeFile(marker, original);
  }
}, 180_000);

test("tampered bundled CA data preserves the complete prior family", async () => {
  const destination = join(scratch, "tampered-ca-data");
  const previous = await priorFamily(destination);
  const file = join(fixture, "runtime-data", "certifi-2026.1.4-py3-none-any.whl");
  const original = await readFile(file);
  try {
    const corrupted = Buffer.from(original);
    corrupted[0] = corrupted[0]! ^ 1;
    await writeFile(file, corrupted);
    await expect(fixturePack(destination)).rejects.toThrow();
    expect(await snapshot(destination)).toEqual(previous);
  } finally {
    await writeFile(file, original);
  }
}, 180_000);

test("source, SDK, symlink and another run's staging destinations are refused without mutation", async () => {
  const sentinel = join(scratch, "unrelated", ".omp-publish-other");
  await mkdir(sentinel, { recursive: true });
  await writeFile(join(sentinel, "keep"), "not owned by this pack\n");
  const alias = join(scratch, "source-alias");
  await symlink(join(fixture, "atyrode.omp"), alias, "dir");
  for (const destination of [fixture, dirname(fixture), join(fixture, "atyrode.omp"), join(fixture, "workers", "output"), resolve(source, "../../manifold"), alias, join(sentinel, "family")]) {
    await expect(fixturePack(destination)).rejects.toThrow("Unsafe packaging destination");
  }
  expect(await readFile(join(sentinel, "keep"), "utf8")).toBe("not owned by this pack\n");
  expect((await lstat(alias)).isSymbolicLink()).toBe(true);
  expect(await readdir(sentinel)).toEqual(["keep"]);
});

// Interpose only in a fresh child: the gate is an actual dependency read after
// output authority is captured, not a production hook or a timing-only race.
const raceChild = `
  import { mock } from "bun:test";
  import * as fs from "node:fs/promises";
  import * as ffi from "bun:ffi";
  import { renameSync, symlinkSync, lstatSync, rmSync } from "node:fs";
  import { dirname } from "node:path";
  const options = JSON.parse(process.env.OMP_PACK_RACE);
  const originalReadFile = fs.readFile;
  const originalCopy = fs.cp;
  let substitutedStage;
  let paused = false;
  mock.module("node:fs/promises", () => ({
    ...fs,
    async readFile(path, ...args) {
      if (!paused && path === options.fixture + "/bun.lock") {
        paused = true;
        process.stdout.write("validated\\n");
        await Bun.stdin.text();
      }
      return originalReadFile(path, ...args);
    },
    async cp(source, destination, ...args) {
      if (options.stageVictim && !substitutedStage && destination.includes("/.omp-native-pack-")) {
        substitutedStage = dirname(destination);
        renameSync(substitutedStage, options.stageHeld);
        symlinkSync(options.stageVictim, substitutedStage, "dir");
      }
      return originalCopy(source, destination, ...args);
    },
  }));
  if (options.exchangeReplacement) {
    const originalDlopen = ffi.dlopen;
    mock.module("bun:ffi", () => ({
      ...ffi,
      dlopen(...args) {
        const library = originalDlopen(...args);
        const symbol = process.platform === "linux" ? "renameat2" : "renameatx_np";
        const exchange = library.symbols[symbol];
        if (!exchange) return library;
        return {
          ...library,
          symbols: {
            ...library.symbols,
            [symbol](...values) {
              // Exercise the unavoidable inode-CAS gap deterministically while
              // still performing the real native exchange and cleanup path.
              if (options.previous) renameSync(options.destination, options.previous);
              renameSync(options.exchangeReplacement, options.destination);
              return exchange(...values);
            },
          },
        };
      },
    }));
  }
  try {
    const { pack } = await import(options.fixture + "/pack.ts");
    process.stdout.write(JSON.stringify({ bundles: await pack(options.destination) }) + "\\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: String(error) }) + "\\n");
    process.exitCode = 1;
  } finally {
    if (substitutedStage && lstatSync(substitutedStage).isSymbolicLink()) rmSync(substitutedStage);
  }
`;

async function pausedPack(destination: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "--no-install", "--eval", raceChild], {
    cwd: fixture, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, OMP_PACK_RACE: JSON.stringify({ fixture, destination, ...extra }) },
  });
  const reader = child.stdout.getReader();
  const diagnostic = new Response(child.stderr).text();
  let text = "";
  while (!text.includes("\n")) {
    const next = await reader.read();
    if (next.done) throw new Error(`Pack child failed before validation: ${text} ${await diagnostic}`);
    text += new TextDecoder().decode(next.value);
  }
  if (!text.startsWith("validated\n")) throw new Error(`Unexpected pack child response: ${text}`);
  text = text.slice("validated\n".length);
  return {
    async finish() {
      child.stdin.write("continue");
      child.stdin.end();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += new TextDecoder().decode(next.value);
      }
      const exit = await child.exited;
      return { exit, diagnostic: await diagnostic, ...JSON.parse(text) } as {
        exit: number; diagnostic: string; error?: string; bundles?: readonly (PackResult & { readonly id: string })[];
      };
    },
    async stop() {
      if (child.exitCode === null) child.kill();
      await child.exited;
      reader.releaseLock();
    },
  };
}

test("compiler preparation cannot overwrite another directory through a replaced source-staging entry", async () => {
  const destination = join(scratch, "staging-entry-output");
  const stageVictim = join(scratch, "staging-entry-victim");
  const stageHeld = join(scratch, "staging-entry-held");
  await mkdir(stageVictim);
  await writeFile(join(stageVictim, "package.json"), "unrelated package metadata\n");
  const before = await readFile(join(stageVictim, "package.json"));
  const child = await pausedPack(destination, { stageVictim, stageHeld });
  try {
    const result = await child.finish();
    expect(await readFile(join(stageVictim, "package.json"))).toEqual(before);
    expect(await readdir(stageVictim)).toEqual(["package.json"]);
    expect(result.exit).toBe(0);
    await publishedFamily(destination);
  } finally {
    await child.stop();
    await rm(stageHeld, { recursive: true, force: true });
  }
}, 360_000);

async function publishedFamily(directory: string): Promise<void> {
  expect((await readdir(directory)).sort()).toEqual(publishedFiles);
  const sums = (await readFile(join(directory, "SHA256SUMS"), "utf8")).trim().split("\n");
  expect(sums.map(line => line.slice(66))).toEqual(family.map(id => `${id}.manifold-plugin.json`));
  for (const [index, id] of family.entries()) {
    const bytes = await readFile(join(directory, `${id}.manifold-plugin.json`));
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(sums[index]!.slice(0, 64));
    expect(JSON.parse(bytes.toString("utf8")).manifest.id).toBe(id);
  }
  expect(JSON.parse(await readFile(join(directory, "native-requirements.json"), "utf8")).requiredRuntimeTools).toEqual(["system"]);
}

for (const existing of [false, true]) {
  test(`replaced output parent cannot redirect ${existing ? "existing" : "absent"} publication into source`, async () => {
    const parent = join(scratch, `parent-race-${existing}`);
    const moved = `${parent}-held`;
    await mkdir(parent);
    const destination = join(parent, basename(fixture));
    if (existing) {
      await priorFamily(destination);
      await symlink(join(fixture, "atyrode.omp"), join(destination, "source-link"), "dir");
    }
    const unowned = join(parent, ".omp-publish-unowned");
    await mkdir(unowned);
    await writeFile(join(unowned, "keep"), "another run owns these bytes\n");
    const sourceBytes = await snapshot(join(fixture, "atyrode.omp"));
    const dependencyBytes = await readFile(join(fixture, "node_modules", ".omp-prepared-dependencies.json"));
    const child = await pausedPack(destination);
    try {
      await rename(parent, moved);
      await symlink(dirname(fixture), parent, "dir");
      const result = await child.finish();
      expect(result.error ?? result.diagnostic).toBe("");
      expect(result.exit).toBe(0);
      await publishedFamily(join(moved, basename(fixture)));
      expect(result.bundles?.map(bundle => bundle.file)).toEqual(family.map(id => join(moved, basename(fixture), `${id}.manifold-plugin.json`)));
      expect(await snapshot(join(fixture, "atyrode.omp"))).toEqual(sourceBytes);
      expect(await readFile(join(fixture, "node_modules", ".omp-prepared-dependencies.json"))).toEqual(dependencyBytes);
      expect((await readdir(moved)).sort()).toEqual([".omp-publish-unowned", basename(fixture)].sort());
      expect(await readFile(join(moved, ".omp-publish-unowned", "keep"), "utf8")).toBe("another run owns these bytes\n");
      expect((await lstat(parent)).isSymbolicLink()).toBe(true);
    } finally { await child.stop(); }
  }, 180_000);
}

for (const substitution of ["directory", "source-link"] as const) {
  test(`destination ${substitution} substitution preserves authorized and unexpected bytes`, async () => {
    const parent = join(scratch, `leaf-race-${substitution}`);
    const destination = join(parent, "output");
    const prior = await priorFamily(destination);
    const moved = join(parent, "previous");
    const sourceBytes = await snapshot(join(fixture, "atyrode.omp"));
    const child = await pausedPack(destination);
    try {
      await rename(destination, moved);
      if (substitution === "source-link") await symlink(join(fixture, "atyrode.omp"), destination, "dir");
      else {
        await mkdir(destination);
        await writeFile(join(destination, "keep"), "substituted directory is not owned\n");
      }
      const result = await child.finish();
      expect(result.exit).toBe(1);
      expect(result.error).toContain("destination identity changed");
      expect(await snapshot(moved)).toEqual(prior);
      expect(await snapshot(join(fixture, "atyrode.omp"))).toEqual(sourceBytes);
      if (substitution === "source-link") expect((await lstat(destination)).isSymbolicLink()).toBe(true);
      else expect(await snapshot(destination)).toEqual({ keep: Buffer.from("substituted directory is not owned\n").toString("base64") });
      expect((await readdir(parent)).sort()).toEqual(["output", "previous"]);
    } finally { await child.stop(); }
  }, 180_000);
}

test("unexpected displaced inode is retained without claiming rollback or deleting its bytes", async () => {
  const parent = join(scratch, "exchange-race");
  const destination = join(parent, "output");
  const prior = await priorFamily(destination);
  const replacement = join(parent, "unowned");
  await mkdir(join(replacement, "nested"), { recursive: true });
  await writeFile(join(replacement, "nested", "keep"), "unowned displaced bytes\n");
  const unexpected = await snapshot(replacement);
  const previous = join(parent, "previous");
  const child = await pausedPack(destination, { exchangeReplacement: replacement, previous });
  try {
    const result = await child.finish();
    expect(result.exit).toBe(1);
    expect(result.error).toContain("commit state is ambiguous");
    const retained = (await readdir(parent)).filter(name => name.startsWith(".omp-publish-"));
    expect(retained).toHaveLength(1);
    expect(result.error).toContain(join(parent, retained[0]!, "family"));
    expect(await snapshot(join(parent, retained[0]!, "family"))).toEqual(unexpected);
    expect(await snapshot(previous)).toEqual(prior);
    await publishedFamily(destination);
  } finally { await child.stop(); }
}, 180_000);

test("a destination appearing at the absent-name commit boundary is never overwritten", async () => {
  const parent = join(scratch, "absent-exchange-race");
  const destination = join(parent, "output");
  const replacement = join(parent, "unowned");
  const unexpected = await priorFamily(replacement);
  const child = await pausedPack(destination, { exchangeReplacement: replacement });
  try {
    const result = await child.finish();
    expect(result.exit).toBe(1);
    expect(result.error).toContain("atomic directory publication");
    expect(await snapshot(destination)).toEqual(unexpected);
    expect(await readdir(parent)).toEqual(["output"]);
  } finally { await child.stop(); }
}, 180_000);

test("existing case-insensitive source leaf aliases are refused without mutation", async () => {
  // Only isolated copied sources are targets: a regressed guard must never
  // turn this regression into publication over the developer's actual SDK.
  // Run the destructive spelling only when the host filesystem aliases it.
  for (const directory of [fixture, join(fixture, "atyrode.omp")]) {
    const alias = join(dirname(directory), basename(directory).toUpperCase());
    const original = await lstat(directory);
    const aliased = await lstat(alias).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!aliased || aliased.dev !== original.dev || aliased.ino !== original.ino) continue;
    const entries = (await readdir(directory)).sort();
    const sentinel = join(directory, directory === fixture ? "pack.ts" : "manifest.json");
    const bytes = await readFile(sentinel);
    await expect(fixturePack(alias)).rejects.toThrow("Unsafe packaging destination");
    expect((await lstat(directory)).ino).toBe(original.ino);
    expect((await readdir(directory)).sort()).toEqual(entries);
    expect(await readFile(sentinel)).toEqual(bytes);
  }
});
