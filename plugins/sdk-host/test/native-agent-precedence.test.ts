import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseRequest, type PiNativeParsedRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";

test("native executor applies shared-role suffixes before bundled thinking defaults and inherits unconfigured specialists", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-native-precedence-"));
  for (const directory of ["agent", "cwd", "home", "tmp", "sessions"]) mkdirSync(join(root, directory));
  const thinking = getBundledModel("openai", "gpt-5").thinking;
  const low = thinking?.efforts.find(effort => effort === "low");
  const medium = thinking?.efforts.find(effort => effort === "medium");
  const high = thinking?.efforts.find(effort => effort === "high");
  if (thinking === undefined || low === undefined || medium === undefined || high === undefined)
    throw new Error("native_executor_fixture_requires_controllable_effort_metadata");
  const scenarios = [
    { agent: "task", task: "fixture/task:medium", smol: "fixture/smol:low", active: "fixture/active:low", model: "task", thinking: medium, role: "task", declared: "auto" },
    { agent: "task", task: "fixture/task:high", smol: "fixture/smol:low", active: "fixture/active:low", model: "task", thinking: high, role: "task", declared: "auto" },
    { agent: "scout", task: "fixture/task:medium", smol: "fixture/smol:low", active: "fixture/active:high", model: "smol", thinking: low, role: "smol", declared: "medium" },
    { agent: "scout", task: "fixture/task:medium", smol: "fixture/smol:high", active: "fixture/active:low", model: "smol", thinking: high, role: "smol", declared: "medium" },
    { agent: "sonic", task: "fixture/task:medium", smol: "fixture/smol:low", active: "fixture/active:high", model: "smol", thinking: low, role: "smol", declared: "medium" },
    { agent: "sonic", task: "fixture/task:medium", smol: "fixture/smol:high", active: "fixture/active:low", model: "smol", thinking: high, role: "smol", declared: "medium" },
    { agent: "security-reviewer", task: "fixture/task:medium", smol: "fixture/smol:medium", active: "fixture/active:low", model: "active", thinking: low, role: null, declared: null },
    { agent: "security-reviewer", task: "fixture/task:medium", smol: "fixture/smol:medium", active: "fixture/active:high", model: "active", thinking: high, role: null, declared: null },
    { agent: "seance", task: "fixture/task:medium", smol: "fixture/smol:medium", active: "fixture/active:low", model: "active", thinking: low, role: null, declared: null },
    { agent: "seance", task: "fixture/task:medium", smol: "fixture/smol:medium", active: "fixture/active:high", model: "active", thinking: high, role: null, declared: null },
    { agent: "reviewer", task: "fixture/task:medium", smol: "fixture/smol:low", active: "fixture/active:low", model: "slow", thinking: high, role: "slow", declared: null },
  ];
  const bearer = `SYNTHETIC-NATIVE-PRECEDENCE-${randomUUID()}`;
  const requests: PiNativeParsedRequest[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/pi/stream" ||
      request.headers.get("authorization") !== `Bearer ${bearer}`) return new Response("unexpected fixture route", { status: 400 });
    const parsed = parseRequest(await request.json(), request.headers);
    requests.push(parsed);
    const message: AssistantMessage = {
      role: "assistant", api: "openai-completions", provider: "fixture", model: parsed.modelId.slice("fixture/".length),
      content: [{ type: "text", text: "NATIVE-PRECEDENCE-COMPLETE" }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const events = [{ type: "start", partial: message },
      { type: "text_start", contentIndex: 0, partial: message },
      { type: "text_delta", contentIndex: 0, delta: "NATIVE-PRECEDENCE-COMPLETE", partial: message },
      { type: "text_end", contentIndex: 0, content: "NATIVE-PRECEDENCE-COMPLETE", partial: message },
      { type: "done", reason: "stop", message }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  writeFileSync(join(root, "agent", "models.yml"), JSON.stringify({ providers: { fixture: {
    baseUrl: origin, apiKey: bearer, api: "openai-completions", transport: "pi-native",
    // Synthetic identities reuse the published controllable-effort metadata, without mutating its catalog row.
    models: ["default", "active", "task", "smol", "slow"].map(id => ({ id, name: id, reasoning: true,
      thinking,
      input: ["text"], contextWindow: 200_000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  } } }));
  writeFileSync(join(root, "request.json"), JSON.stringify({ root, origin, cases: scenarios }));
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    child = Bun.spawn([process.execPath, "--no-env-file", "--no-install",
      join(import.meta.dir, "native-agent-precedence-driver.ts"), join(root, "request.json")], {
      cwd: join(root, "cwd"), stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
        PI_CODING_AGENT_DIR: join(root, "agent"), XDG_CONFIG_HOME: join(root, "home", ".config"),
        XDG_CACHE_HOME: join(root, "home", ".cache"), XDG_DATA_HOME: join(root, "home", ".local", "share"),
        XDG_STATE_HOME: join(root, "home", ".local", "state"), LANG: "C.UTF-8", TZ: "UTC" },
    });
    // Real subprocess watchdog only: completion awaits child.exited, never a guessed delay.
    // A fake timer cannot reap a wedged OS child in this integration test.
    const timer = setTimeout(() => child?.kill("SIGKILL"), 90_000);
    let code: number;
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try { code = await child.exited; } finally { clearTimeout(timer); }
    expect({ code, stderr: code === 0 ? "" : await stderr }).toEqual({ code: 0, stderr: "" });
    const observed = JSON.parse(await stdout) as Record<string, unknown>[];
    expect(observed).toEqual(scenarios.map(scenario => ({ agent: scenario.agent, source: "bundled",
      declaredThinking: scenario.declared, role: scenario.role, model: `fixture/${scenario.model}`,
      configuredThinking: scenario.thinking, output: "NATIVE-PRECEDENCE-COMPLETE",
    })));
    expect(requests).toHaveLength(scenarios.length);
    expect(requests.map(request => ({ model: request.modelId, thinking: request.options.reasoning })))
      .toEqual(scenarios.map(scenario => ({ model: `fixture/${scenario.model}`, thinking: scenario.thinking })));
    // Exact one-request-per-native-agent turns: no automatic title, label, fallback or classifier inference.
    for (const [index, request] of requests.entries())
      expect(JSON.stringify(request.context.messages)).toContain(`NATIVE-PRECEDENCE-${index}`);
    console.log("native-executor-precedence", JSON.stringify(observed.map(({ agent, declaredThinking, role, model, configuredThinking }) =>
      ({ agent, declaredThinking, role, model, configuredThinking }))));
  } finally {
    if (child?.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
