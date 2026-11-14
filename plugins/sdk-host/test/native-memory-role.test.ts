import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

interface MemoryObservation {
  backend: "off" | "mnemopi";
  beforeStart: number;
  afterStart: number;
  afterEnqueue: number;
  afterDispose: number;
  active: boolean;
  memoryDirectoryCreated: boolean;
  availableModels: string[];
  expectedMedium: string;
  expectedHigh: string;
  marker: string;
  networkAttempts: number;
  requests: {
    model: string;
    api: string;
    context: { systemPrompt?: string[]; messages: { role: string; content: unknown }[] };
    options: { reasoning?: string; disableReasoning?: boolean; maxTokens?: number;
      temperature?: number; thinkingBudgets?: Record<string, number> };
    syntheticKey: boolean;
    hasSessionId: boolean;
  }[];
}

async function observeMemory(backend: "off" | "mnemopi", rejectPrimary = false, memoryFallback: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "omp-native-memory-role-"));
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    for (const directory of ["agent", "cwd", "home", "tmp"]) mkdirSync(join(root, directory));
    writeFileSync(join(root, "request.json"), JSON.stringify({ root, backend, rejectPrimary, memoryFallback }));
    child = Bun.spawn([process.execPath, "--no-env-file", "--no-install",
      join(import.meta.dir, "native-memory-role-driver.ts"), join(root, "request.json")], {
      cwd: join(root, "cwd"), stdin: "ignore", stdout: "pipe", stderr: "pipe",
      // No inherited provider keys, login state, proxy, Bun preload, or user config.
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
        PI_CODING_AGENT_DIR: join(root, "agent"), XDG_CONFIG_HOME: join(root, "home", ".config"),
        XDG_CACHE_HOME: join(root, "home", ".cache"), XDG_DATA_HOME: join(root, "home", ".local", "share"),
        XDG_STATE_HOME: join(root, "home", ".local", "state"), LANG: "C.UTF-8", TZ: "UTC",
        // Explicit fixture output cap, not an assertion about native defaults or reasoning budgets.
        MNEMOPI_LLM_MAX_TOKENS: "2048" },
    });
    // Only a watchdog, not a timing-based completion gate: enqueue drains extraction,
    // disposal closes the owned banks, and child.exited joins the entire subprocess.
    // Fake timers cannot kill/reap a wedged OS subprocess in this integration test.
    const timer = setTimeout(() => child?.kill("SIGKILL"), 30_000);
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    let code: number;
    try { code = await child.exited; } finally { clearTimeout(timer); }
    const [out, err] = await Promise.all([stdout, stderr]);
    expect({ code, stderr: code === 0 ? "" : err }).toEqual({ code: 0, stderr: "" });
    return JSON.parse(out) as MemoryObservation;
  } finally {
    if (child?.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}

test("native memory stays dormant when off and consumes its own medium role and fallback chain when explicitly started", async () => {
  const off = await observeMemory("off");
  const managed = await observeMemory("mnemopi");
  const ownEmpty = await observeMemory("mnemopi", true);
  // Positive control: this consumer can walk its OWN chain even though the fixture
  // globally disables model fallback. The empty chain must therefore be intentional.
  const explicitFallback = await observeMemory("mnemopi", true, ["fixture/expensive:high"]);
  for (const observation of [off, managed, ownEmpty, explicitFallback]) {
    expect(observation.beforeStart).toBe(0);
    expect(observation.afterStart).toBe(0);
    expect(observation.afterDispose).toBe(observation.afterEnqueue);
    expect(observation.networkAttempts).toBe(0);
    expect(observation.availableModels).toEqual(["fixture/cheap-memory", "fixture/expensive"]);
  }
  expect(off.backend).toBe("off");
  expect(off.active).toBe(false);
  expect(off.memoryDirectoryCreated).toBe(false);
  expect(off.afterEnqueue).toBe(0);
  expect(off.requests).toEqual([]);
  for (const observation of [managed, ownEmpty, explicitFallback]) {
    expect(observation.backend).toBe("mnemopi");
    expect(observation.active).toBe(true);
    expect(observation.memoryDirectoryCreated).toBe(true);
    for (const request of observation.requests) {
      expect(request.api).toBe("native-memory-fixture");
      expect(request.syntheticKey).toBe(true);
      expect(request.hasSessionId).toBe(true);
      expect(request.context.systemPrompt?.length).toBeGreaterThan(0);
      expect(request.context.messages).toHaveLength(1);
      expect(request.context.messages[0]!.role).toBe("user");
      expect(JSON.stringify(request.context.messages[0]!.content)).toContain(observation.marker);
      expect(request.options.reasoning).toBe(request.model === "fixture/cheap-memory"
        ? observation.expectedMedium : observation.expectedHigh);
      expect(request.options.disableReasoning).toBeUndefined();
      expect(request.options.temperature).toBe(0);
      // This is completeSimple's OUTPUT-token option. Medium remains enabled and
      // no custom thinking budget is supplied; 2048 does not bound reasoning cost.
      expect(request.options.maxTokens).toBe(2048);
      expect(request.options.thinkingBudgets).toBeUndefined();
    }
  }
  expect(managed.requests.map(request => request.model)).toEqual(["fixture/cheap-memory"]);
  expect(ownEmpty.requests.map(request => request.model)).toEqual(["fixture/cheap-memory"]);
  expect(explicitFallback.requests.map(request => request.model)).toEqual(["fixture/cheap-memory", "fixture/expensive"]);
  expect(managed.expectedMedium).toBe("medium");
  expect(explicitFallback.expectedHigh).toBe("high");
  // Native enqueue's age-gated sleep uses deterministic non-LLM consolidation.
  // We do not manufacture an asynchronous summarizer call or enable autolearn.
  console.log("native-memory-role", JSON.stringify({ offModelCallbacks: off.afterDispose,
    managed: managed.requests.map(request => ({ model: request.model, effort: request.options.reasoning,
      maxTokens: request.options.maxTokens, disableReasoning: request.options.disableReasoning ?? null,
      thinkingBudgets: request.options.thinkingBudgets ?? null })),
    rejectedWithOwnEmpty: ownEmpty.requests.map(request => request.model),
    explicitFallback: explicitFallback.requests.map(request => ({ model: request.model, effort: request.options.reasoning })),
    capMeaning: "2048 output tokens; not a reasoning-cost bound", networkAttempts: 0 }));
}, 150_000);
