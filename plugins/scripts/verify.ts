#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

type Receipt = { ok: boolean; code?: string };
const success = {
  ok: true,
  family: "atyrode.omp",
  verification: "standalone-native-and-packaged-worker-boundaries",
} as const;
class VerificationFailure extends Error {
  constructor(readonly code: string) {
    super(`OMP verification failed: ${code}`);
  }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new VerificationFailure(code);
}
function receipt(value: unknown): Receipt | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    typeof value.ok !== "boolean"
  )
    return undefined;
  if (
    "code" in value &&
    (typeof value.code !== "string" ||
      !/^[a-z][a-z0-9-]{0,79}$/.test(value.code))
  )
    return undefined;
  return value as Receipt;
}

async function verifyConsumer(): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--no-install",
      fileURLToPath(new URL("./verify-consumer.ts", import.meta.url)),
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  check((await child.exited) === 0, "public-git-consumer-failed");
}

// The outer launcher owns one transient delegated unit, following Manifold's
// verify-runtime.sh. It grants no fleet service, package install or host profile.
async function delegated(): Promise<void> {
  const systemFile = process.env.OMP_VERIFY_SYSTEM;
  const bwrap = process.env.OMP_VERIFY_BWRAP;
  check(
    systemFile && isAbsolute(systemFile) && bwrap && isAbsolute(bwrap),
    "explicit-native-resources-required",
  );
  check(
    [undefined, "user", "system"].includes(process.env.OMP_VERIFY_SYSTEMD_MODE),
    "invalid-systemd-mode",
  );
  const systemMode = process.env.OMP_VERIFY_SYSTEMD_MODE === "system";
  const systemdRun = Bun.which("systemd-run"),
    systemctl = Bun.which("systemctl"),
    env = Bun.which("env");
  const sudo = systemMode ? Bun.which("sudo") : undefined;
  check(
    systemdRun && systemctl && env && (!systemMode || sudo),
    "delegated-unit-tools-missing",
  );
  const git = Bun.which("git");
  check(git && isAbsolute(git), "git-missing");
  const gitPath = await realpath(git);
  const busybox = process.env.MANIFOLD_TEST_STATIC_BUSYBOX;
  const unshare = Bun.which("unshare");
  check(busybox && isAbsolute(busybox) && unshare && isAbsolute(unshare), "bounded-output-tools-required");
  const busyboxPath = await realpath(busybox);
  const unsharePath = await realpath(unshare);
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  check(
    uid !== undefined && gid !== undefined && uid !== 0,
    "ordinary-host-user-required",
  );
  const root = await mkdtemp(join(tmpdir(), "omp-native-unit-"));
  const unit = `omp-native-verify-${randomUUID()}`;
  const manager = systemMode ? [sudo!, "-n"] : [];
  const managerEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  };
  let safeToRemove = true;
  let reported: Receipt | undefined;
  try {
    await chmod(root, 0o700);
    await Promise.all(
      ["home", "tmp"].map((name) => mkdir(join(root, name), { mode: 0o700 })),
    );
    // Freeze the explicit resource declaration for this run. Sources are read-only
    // native tool inputs; their actual digests are bound by the reviewed deployment.
    const systemBytes = await readFile(systemFile);
    check(
      systemBytes.length > 0 && systemBytes.length <= 65536,
      "invalid-system-declaration-size",
    );
    const frozenSystem = join(root, "system.json");
    await writeFile(frozenSystem, systemBytes, { mode: 0o600 });
    const command = [
      ...manager,
      systemdRun,
      systemMode ? "--system" : "--user",
      `--unit=${unit}`,
      "--collect",
      "--wait",
      "--pipe",
      "--property=Delegate=cpu memory pids",
      "--property=TasksMax=infinity",
      "--property=RuntimeMaxSec=900",
      "--property=TimeoutStopSec=10",
      "--property=KillMode=control-group",
      "--property=NoNewPrivileges=yes",
      ...(systemMode ? [`--uid=${uid}`, `--gid=${gid}`] : []),
      env,
      "-i",
      `PATH=${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      `HOME=${join(root, "home")}`,
      `TMPDIR=${join(root, "tmp")}`,
      "LANG=C",
      "TZ=UTC",
      "TERM=dumb",
      `OMP_VERIFY_UNIT=${unit}`,
      `OMP_VERIFY_SYSTEM=${frozenSystem}`,
      `OMP_VERIFY_BWRAP=${bwrap}`,
      `OMP_PACK_GIT=${gitPath}`,
      `MANIFOLD_TEST_STATIC_BUSYBOX=${busyboxPath}`,
      `OMP_VERIFY_UNSHARE=${unsharePath}`,
      ...(process.env.OMP_VERIFY_CONSUMER_MODULE ? [`OMP_VERIFY_CONSUMER_MODULE=${process.env.OMP_VERIFY_CONSUMER_MODULE}`] : []),
      process.execPath,
      "--no-env-file",
      "--no-install",
      fileURLToPath(import.meta.url),
    ];
    safeToRemove = false;
    const child = Bun.spawn(command, {
      env: managerEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const collect = async () => {
      const decoder = new TextDecoder();
      let buffered = "";
      const reader = child.stdout.getReader();
      try {
        while (true) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(chunk, { stream: true });
          check(buffered.length <= 8192, "invalid-unit-result");
          const lines = buffered.split(/\r?\n/);
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            let value: unknown;
            try {
              value = JSON.parse(line);
            } catch {
              continue;
            }
            const parsed = receipt(value);
            if (!parsed) continue;
            check(!reported, "duplicate-unit-result");
            reported = parsed;
          }
        }
      } finally {
        reader.releaseLock();
      }
    };
    const timer = setTimeout(() => child.kill("SIGTERM"), 920_000);
    let exit: number;
    try {
      [exit] = await Promise.all([child.exited, collect()]);
    } finally {
      clearTimeout(timer);
    }
    check(
      exit === 0 && reported?.ok === true,
      reported?.code ?? "delegated-native-proof-failed",
    );
  } finally {
    // Stop only the exact unit this invocation named; never remove a live owner's
    // backing directory merely because its systemd-run client has exited.
    if (!safeToRemove) {
      const control = [
        ...manager,
        systemctl,
        systemMode ? "--system" : "--user",
      ];
      const stop = Bun.spawn([...control, "stop", `${unit}.service`], {
        env: managerEnv,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const stopTimer = setTimeout(() => stop.kill("SIGKILL"), 20_000);
      try {
        await stop.exited;
      } finally {
        clearTimeout(stopTimer);
      }
      const state = Bun.spawn(
        [
          ...control,
          "show",
          `${unit}.service`,
          "--property=ActiveState",
          "--value",
        ],
        {
          env: managerEnv,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      const stateTimer = setTimeout(() => state.kill("SIGKILL"), 20_000);
      try {
        const [exit, text] = await Promise.all([
          state.exited,
          new Response(state.stdout).text(),
        ]);
        safeToRemove =
          (exit === 0 || exit === 4) &&
          ["", "inactive", "failed"].includes(text.trim());
      } finally {
        clearTimeout(stateTimer);
      }
    }
    if (safeToRemove) await rm(root, { recursive: true, force: true });
    check(safeToRemove, "unit-termination-unobserved-state-retained");
  }
}

async function isolated(): Promise<void> {
  const unit = process.env.OMP_VERIFY_UNIT;
  check(
    unit && /^omp-native-verify-[a-f0-9-]{36}$/.test(unit),
    "missing-disposable-unit",
  );
  const busybox = process.env.MANIFOLD_TEST_STATIC_BUSYBOX;
  const unshare = process.env.OMP_VERIFY_UNSHARE;
  check(busybox && isAbsolute(busybox) && unshare && isAbsolute(unshare), "bounded-output-tools-required");
  const membership = (await readFile("/proc/self/cgroup", "utf8"))
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
  check(
    membership?.endsWith(`/${unit}.service`),
    "unexpected-delegated-cgroup",
  );
  const group = `/sys/fs/cgroup${membership}`;
  const controllers = (
    await readFile(join(group, "cgroup.controllers"), "utf8")
  )
    .trim()
    .split(/\s+/);
  check(
    ["cpu", "memory", "pids"].every((name) => controllers.includes(name)),
    "missing-delegated-controllers",
  );
  await mkdir(join(group, "supervisor"));
  await writeFile(
    join(group, "supervisor", "cgroup.procs"),
    String(process.pid),
  );
  await writeFile(join(group, "cgroup.subtree_control"), "+cpu +memory +pids");
  const workloads = join(group, "workloads");
  await mkdir(workloads);
  await writeFile(
    join(workloads, "cgroup.subtree_control"),
    "+cpu +memory +pids",
  );

  const root = await mkdtemp(join(tmpdir(), "omp-native-verify-"));
  let safeToRemove = true;
  let timer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let result: Receipt | undefined;
  try {
    await chmod(root, 0o700);
    await Promise.all(
      [
        "home",
        "cwd",
        "tmp",
        "config",
        "data",
        "state",
        "cache",
        "runtime",
        "agent",
        "bin",
      ].map((name) => mkdir(join(root, name), { mode: 0o700 })),
    );
    // The SDK's reusable fixture invokes bun by name. A wrapper retains both the
    // selected interpreter and no-install policy for server/transport descendants.
    const interpreter = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    await writeFile(
      join(root, "bin", "bun"),
      `#!/bin/sh\nexec ${interpreter} --no-env-file --no-install "$@"\n`,
      { mode: 0o700 },
    );
    // Match Manifold's runtime gate: namespace-local root provisions bounded
    // tmpfs without granting the verifier host-root or mount authority.
    const child = spawn(
      unshare,
      [
        "--user", "--map-root-user", "--mount", "--propagation", "private",
        busybox, "sh", "-eu", "-c",
        '"$1" mount -t tmpfs -o size=1048576,nr_inodes=4096,mode=0700 tmpfs "$2"; exec "$3" --no-env-file --no-install "$4"',
        "omp-output-fixture", busybox, join(root, "runtime"), process.execPath,
        fileURLToPath(new URL("./verify-native.ts", import.meta.url)),
      ],
      {
        cwd: join(root, "cwd"),
        detached: true,
        env: {
          PATH: `${join(root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          HOME: join(root, "home"),
          USERPROFILE: join(root, "home"),
          PWD: join(root, "cwd"),
          TMPDIR: join(root, "tmp"),
          TMP: join(root, "tmp"),
          TEMP: join(root, "tmp"),
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "data"),
          XDG_STATE_HOME: join(root, "state"),
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_RUNTIME_DIR: join(root, "runtime"),
          PI_CODING_AGENT_DIR: join(root, "agent"),
          OMP_VERIFY_ROOT: root,
          OMP_VERIFY_CGROUP: workloads,
          OMP_VERIFY_SYSTEM: process.env.OMP_VERIFY_SYSTEM!,
          OMP_VERIFY_BWRAP: process.env.OMP_VERIFY_BWRAP!,
          OMP_VERIFY_DEVELOPMENT_SHELL: busybox,
          OMP_PACK_GIT: process.env.OMP_PACK_GIT!,
          ...(process.env.OMP_VERIFY_CONSUMER_MODULE ? { OMP_VERIFY_CONSUMER_MODULE: process.env.OMP_VERIFY_CONSUMER_MODULE } : {}),
          NODE_ENV: "test",
          LANG: "C",
          TZ: "UTC",
          TERM: "dumb",
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    safeToRemove = false;
    const stopGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const groupExists = () => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    let invalidReceipt = false;
    child.on("message", (message) => {
      const parsed = receipt(message);
      if (
        result ||
        !parsed ||
        Object.keys(parsed).some((key) => !["ok", "code"].includes(key))
      )
        invalidReceipt = true;
      else result = parsed;
    });
    const closed = new Promise<number | null>((resolve) => {
      child.once("error", () => {
        result = { ok: false, code: "child-startup-failed" };
      });
      child.once("close", (code) => resolve(code));
    });
    timer = setTimeout(() => {
      result = { ok: false, code: "verification-timed-out" };
      stopGroup("SIGTERM");
      killTimer = setTimeout(() => stopGroup("SIGKILL"), 5_000);
    }, 840_000);
    const code = await closed;
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (groupExists()) stopGroup("SIGKILL");
    const deadline = Date.now() + 5_000;
    while (groupExists() && Date.now() < deadline) await Bun.sleep(20);
    safeToRemove = !groupExists();
    check(safeToRemove, "child-termination-unobserved-state-retained");
    check(
      code === 0 && result?.ok === true && !invalidReceipt,
      invalidReceipt ? "invalid-result" : (result?.code ?? "child-failed"),
    );
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (safeToRemove) await rm(root, { recursive: true, force: true });
  }
}

try {
  const consumerModule = process.env.OMP_VERIFY_CONSUMER_MODULE;
  check(consumerModule === undefined || (isAbsolute(consumerModule) && consumerModule.endsWith(".ts")), "invalid-consumer-module");
  if (!process.env.OMP_VERIFY_UNIT) await verifyConsumer();
  check(Bun.version === "1.4.2", "pinned-bun-required");
  check(
    process.platform === "linux" && process.arch === "x64",
    "linux-x64-native-fixture-required",
  );
  if (process.env.OMP_VERIFY_UNIT) await isolated();
  else await delegated();
  console.log(JSON.stringify(success));
} catch (error) {
  const code =
    error instanceof VerificationFailure
      ? error.code
      : "verification-launcher-failed";
  console.log(JSON.stringify({ ok: false, code }));
  process.exitCode = 1;
}
