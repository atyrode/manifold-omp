#!/usr/bin/env bun
import { appendFile, chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// This declaration belongs only to an ephemeral Ubuntu CI runner. Verification
// copies and digest-pins each file; neither the packer nor a fleet owner discovers
// or mounts an ambient host library directory.
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`OMP CI preparation refused: ${reason}`);
}
function absolute(value: string | undefined, name: string): string {
  check(value && isAbsolute(value) && !/[\r\n]/.test(value), `${name} must be an absolute single-line path`);
  return value;
}

check(process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted",
  "an ephemeral GitHub-hosted runner is required");
check(process.platform === "linux" && process.arch === "x64" && process.getuid?.() !== 0,
  "an ordinary user on Linux x64 is required");
check(/^ID=ubuntu$/m.test(await readFile("/etc/os-release", "utf8")), "the reviewed Ubuntu fixture is required");
const environment = absolute(process.env.GITHUB_ENV, "GITHUB_ENV");
const temporary = absolute(process.env.RUNNER_TEMP, "RUNNER_TEMP");
// The reusable workflow has installed this fixture in the same preparation step,
// before GITHUB_ENV additions become visible to child repository commands.
const bwrap = await realpath(absolute(process.env.MANIFOLD_TEST_BWRAP ?? "/usr/local/bin/bwrap", "MANIFOLD_TEST_BWRAP"));
const bwrapStat = await lstat(bwrap);
check(bwrapStat.isFile() && (bwrapStat.mode & 0o6000) === 0 && (bwrapStat.mode & 0o111) !== 0,
  "the prepared non-setuid bubblewrap executable is required");
const targets = [
  "/lib64/ld-linux-x86-64.so.2",
  ...["libc.so.6", "libm.so.6", "libdl.so.2", "libpthread.so.0", "librt.so.1", "libresolv.so.2", "libutil.so.1"]
    .map(name => `/lib/x86_64-linux-gnu/${name}`),
];
const binds = await Promise.all(targets.map(async target => {
  const source = await realpath(target);
  check((await lstat(source)).isFile(), "every declared runtime input must be a regular file");
  return { source, target, kind: "file" as const };
}));
const root = await mkdtemp(join(temporary, "omp-native-ci-"));
try {
  await chmod(root, 0o700);
  const declaration = join(root, "system.json");
  await writeFile(declaration, JSON.stringify(binds), { mode: 0o600 });
  await appendFile(environment, `OMP_VERIFY_SYSTEM=${declaration}\nOMP_VERIFY_BWRAP=${bwrap}\nOMP_VERIFY_SYSTEMD_MODE=system\n`);
} catch (error) {
  await rm(root, { recursive: true, force: true });
  throw error;
}
console.log("Prepared explicit per-file native CI resources; no daemon or credentials installed.");
