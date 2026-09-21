import { copyFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type { AssistantMessage, AssistantMessageEvent, ToolResultMessage } from "@oh-my-pi/pi-ai/types";

// Fixture control, not a substitute host. Only the packaged /runtime/bin/sdkHost
// constructs agent sessions or runs tools. This process uses the public journal
// API to inspect/reopen its output and public pi-native messages to drive it.
const scenario = process.argv[2]!;
const sessions = "/home/job/omp-sessions";
const saved = join(sessions, "saved.jsonl");
const resumed = !["selected", "disabled", "cancel"].includes(scenario);
let child: Bun.Subprocess | undefined;
let gateway: Bun.Server<undefined> | undefined;
let failure: string | undefined;
let requests = 0;
let discoveries = 0;
let cancelled = false;
let terminal = "";
let stderr = "";
let serverError: string | undefined;
let completed = false;
let waitingStream = false;

class ProofFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new ProofFailure(code);
}
async function until(predicate: () => boolean, code: string, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    check(!serverError, serverError ?? "gateway-failed");
    check(child?.exitCode === null, "host-exited-early");
    check(Date.now() < deadline, code);
    await Bun.sleep(20);
  }
}
function response(message: AssistantMessage) {
  const events: AssistantMessageEvent[] = [{ type: "start", partial: message }];
  for (let index = 0; index < message.content.length; index++) {
    const content = message.content[index]!;
    if (content.type === "text") {
      events.push({ type: "text_start", contentIndex: index, partial: message });
      events.push({ type: "text_delta", contentIndex: index, delta: content.text, partial: message });
      events.push({ type: "text_end", contentIndex: index, content: content.text, partial: message });
    } else if (content.type === "toolCall") {
      events.push({ type: "toolcall_start", contentIndex: index, partial: message });
      events.push({ type: "toolcall_end", contentIndex: index, toolCall: content, partial: message });
    }
  }
  events.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}

try {
  check(process.cwd() === "/inputs" && process.env.HOME === "/home/job" && Bun.version === "1.4.2", "private-environment");
  check(!Object.keys(process.env).some(key => /^(?:MANIFOLD_|AWS_|OPENAI_|ANTHROPIC_|CODE_)/.test(key)), "ambient-environment");
  const routes = (await readFile("/proc/net/route", "utf8")).trim().split("\n").slice(1);
  check(routes.every(line => line.split(/\s+/)[0] === "lo"), "network-namespace");
  if (resumed && scenario !== "missing") {
    await copyFile("/proof-state/baseline.jsonl", saved);
    if (scenario === "missing-model" || scenario === "missing-thinking") {
      // Deliberate missing durable metadata, not a replacement journal resolver.
      const omitted = scenario === "missing-model" ? "model_change" : "thinking_level_change";
      const entries: { type: string; id?: string; parentId?: string | null }[] = (await readFile(saved, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
      const dropped = new Map(entries.filter(entry => entry.type === omitted).map(entry => [entry.id, entry.parentId]));
      const retained = entries.filter(entry => entry.type !== omitted);
      for (const entry of retained) {
        while (entry.parentId && dropped.has(entry.parentId)) entry.parentId = dropped.get(entry.parentId) ?? null;
      }
      await writeFile(saved, retained.map(entry => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
    } else if (scenario === "incompatible") {
      const manager = await SessionManager.open(saved, sessions);
      manager.appendModelChange("fixture/openai/gpt-4.1");
      manager.appendThinkingLevelChange("high", "high");
      await manager.flush();
      await manager.close();
    } else if (scenario === "changed") {
      const manager = await SessionManager.open(saved, sessions);
      const lines = (await readFile(saved, "utf8")).trimEnd().split("\n");
      await manager.close();
      await writeFile(saved, lines.map(line => {
        const entry = JSON.parse(line);
        return entry.type === "session" ? JSON.stringify({ ...entry, cwd: "/changed-workspace" }) : line;
      }).join("\n") + "\n", { mode: 0o600 });
    }
  }
  const before = new Map<string, string>();
  for (const name of await readdir(sessions)) if (name.endsWith(".jsonl")) before.set(name, await readFile(join(sessions, name), "utf8"));
  const refused = ["missing-model", "missing-thinking", "incompatible", "changed", "missing", "rpc-restricted"].includes(scenario);
  const expectedModel = scenario === "model-only" || scenario === "model-suffix" ? "fixture/openai/o3" : scenario === "both" ? "fixture/openai/gpt-4.1" : "fixture/openai/gpt-5";
  const expectedThinking = ["model-suffix", "thinking-only", "both", "disabled", "cancel"].includes(scenario) ? "off" : "high";
  gateway = Bun.serve({ hostname: "127.0.0.1", port: 38457, idleTimeout: 0, async fetch(request) {
    try {
      check(request.headers.get("authorization") === `Bearer ${["SYNTHETIC", "LOCAL", "FIXTURE", "NOT", "A", "CREDENTIAL"].join("-")}`, "synthetic-capability");
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/models") {
        discoveries++;
        return Response.json({ object: "list", data: ["openai/gpt-5", "openai/o3", "openai/gpt-4.1"].map(id => ({
          id, object: "model", owned_by: "openai", api: "openai-completions", display_name: id,
          context_length: 200_000, max_output_tokens: 8192, input_modalities: ["text"],
        })) });
      }
      check(request.method === "POST" && url.pathname === "/v1/pi/stream", "unexpected-gateway-route");
      const parsed = parseRequest(await request.json(), request.headers);
      requests++;
      check(!refused, "refused-state-reached-inference");
      check(requests <= 2, "unexpected-extra-inference");
      check(parsed.modelId === expectedModel, "resumed-model-selection");
      if (expectedThinking === "high") check(parsed.options.reasoning === "high", "resumed-thinking-preservation");
      else check(parsed.options.reasoning === undefined && parsed.options.disableReasoning === true, "explicit-thinking-off");
      const names = (parsed.context.tools ?? []).map(tool => tool.name).sort();
      check(JSON.stringify(names) === JSON.stringify(["read"]), "restricted-registry-widened");
      const instructions = JSON.stringify({ system: parsed.context.systemPrompt, tools: parsed.context.tools });
      check(!instructions.includes("HOSTILE-AMBIENT-SKILL") && !instructions.includes("HOSTILE-PROJECT-CONTEXT"), "ambient-discovery");
      if (scenario === "selected") check(instructions.includes("skill://sealed-proof"), "selected-skill-not-advertised");
      else check(!instructions.includes("skill://"), "disabled-skill-advertised");
      if (scenario === "cancel") {
        waitingStream = true;
        request.signal.addEventListener("abort", () => { cancelled = true; }, { once: true });
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode(": waiting for verifier cancellation\n\n")); },
          cancel() { cancelled = true; },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      const message: AssistantMessage = {
        role: "assistant", api: "openai-completions", provider: "fixture", model: expectedModel.slice("fixture/".length),
        content: [{ type: "text", text: resumed ? "SDK-PROOF-RESUMED-COMPLETE" : "SDK-PROOF-COMPLETE" }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      if (scenario === "selected" && requests === 1) {
        message.stopReason = "toolUse";
        message.content = [
          { type: "toolCall", id: "proof-read", name: "read", arguments: { path: "skill://sealed-proof/resource.txt" } },
          { type: "toolCall", id: "proof-bash", name: "bash", arguments: { command: "touch /home/job/forbidden-executed" } },
          { type: "toolCall", id: "proof-task", name: "task", arguments: { task: "Write /home/job/forbidden-executed" } },
        ];
      } else {
        if (scenario === "selected") {
          const results = parsed.context.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
          check(results.some(result => result.toolCallId === "proof-read" && !result.isError && JSON.stringify(result.content).includes("SDK-SEALED-RESOURCE-ONLY")), "sealed-resource-read");
          for (const id of ["proof-bash", "proof-task"]) check(results.some(result => result.toolCallId === id && result.isError), "forbidden-tool-executed");
        }
        completed = true;
      }
      return response(message);
    } catch (error) {
      serverError = error instanceof ProofFailure ? error.code : "gateway-wire-failed";
      return Response.json({ error: { type: "fixture_failure", message: "Synthetic fixture refused request" } }, { status: 400 });
    }
  } });
  const kind = scenario === "rpc-restricted" ? "rpc-resume" : resumed ? "resume" : "print";
  const argv = ["/runtime/bin/bun", "--no-env-file", "--no-install", "--config=/dev/null", "/runtime/bin/sdkHost", kind];
  if (resumed) argv.push(scenario === "missing" ? "missing.jsonl" : "saved.jsonl");
  const env = { ...process.env };
  let rendered = false;
  const spawnOptions = { cwd: "/inputs", env, stderr: "pipe" as const };
  if (resumed && !refused) {
    child = Bun.spawn(argv, { ...spawnOptions, terminal: { cols: 120, rows: 40, name: "xterm-256color", data(pty, data) {
      const text = new TextDecoder().decode(data);
      terminal = (terminal + text).slice(-256_000);
      // Standard terminal queries only; the stock renderer and editor are real.
      if (text.includes("\x1b[6n")) pty.write("\x1b[1;1R");
      if (text.includes("\x1b[c")) pty.write("\x1b[?1;2c");
      if (text.includes("\x1b]11;?")) pty.write("\x1b]11;rgb:0000/0000/0000\x1b\\");
      if (terminal.includes("SDK-PROOF-COMPLETE")) rendered = true;
    } } });
  } else child = Bun.spawn(argv, { ...spawnOptions, stdin: "ignore", stdout: "pipe" });
  const stderrRead = child.stderr instanceof ReadableStream ? new Response(child.stderr).text().then(value => { stderr = value; }) : Promise.resolve();
  const stdoutRead = child.stdout instanceof ReadableStream ? new Response(child.stdout).text() : Promise.resolve("");
  if (resumed && !refused) {
    // The saved assistant message is a semantic stock-renderer readiness signal.
    await until(() => rendered, "resume-renderer-not-ready");
    child.terminal!.write("SDK-PROOF-RESUMED-TURN\r");
    await until(() => completed, "resume-did-not-infer");
    // Observe the actual stock renderer consuming the completed response, then
    // let host shutdown flush it before reopening through SessionManager.
    await until(() => terminal.includes("SDK-PROOF-RESUMED-COMPLETE"), "resume-result-not-rendered");
    child.kill("SIGTERM");
  } else if (scenario === "cancel") {
    await until(() => waitingStream, "cancel-stream-not-started");
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => child?.kill("SIGKILL"), 30_000);
  let exit: number;
  try { exit = await child.exited; } finally { clearTimeout(timer); }
  await Promise.all([stderrRead, stdoutRead]);
  check(child.signalCode !== "SIGKILL", "host-cleanup-timeout");
  child.terminal?.close();
  check(!serverError, serverError ?? "gateway-failed");
  if (refused) {
    const reasons: Record<string, string> = {
      "missing-model": "omp_resume_model_missing", "missing-thinking": "omp_resume_thinking_missing",
      incompatible: "omp_resume_thinking_incompatible", changed: "omp_resume_session_changed",
      missing: "omp_resume_session_changed", "rpc-restricted": "omp_restricted_harness_unsupported",
    };
    check(exit !== 0 && stderr.includes(reasons[scenario]!), "expected-refusal");
    check(requests === 0, "refusal-inferred");
    const after = (await readdir(sessions)).filter(name => name.endsWith(".jsonl")).sort();
    check(JSON.stringify(after) === JSON.stringify([...before.keys()].sort()), "refusal-created-transcript");
    for (const [name, bytes] of before) check(await readFile(join(sessions, name), "utf8") === bytes, "refusal-mutated-transcript");
  } else if (scenario === "cancel") {
    check(exit !== 0 && requests === 1, "cancel-exit");
    const deadline = Date.now() + 5_000;
    while (!cancelled && Date.now() < deadline) await Bun.sleep(20);
    check(cancelled, "gateway-stream-not-cancelled");
  } else {
    check(discoveries > 0 && completed && (resumed ? exit !== 0 : exit === 0), "program-completion");
    const path = resumed ? saved : join("/outputs/session", (await readdir("/outputs/session")).find(name => name.endsWith(".jsonl")) ?? "missing");
    const manager = await SessionManager.open(path, resumed ? sessions : "/outputs/session");
    const context = manager.buildSessionContext();
    check(context.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(resumed ? "SDK-PROOF-RESUMED-COMPLETE" : "SDK-PROOF-COMPLETE")), "durable-completion");
    check(context.models[manager.getLastModelChangeRole() ?? "default"] === expectedModel, "durable-model");
    check((context.configuredThinkingLevel ?? context.thinkingLevel) === expectedThinking, "durable-thinking");
    if (resumed) check(context.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("SDK-PROOF-RESUMED-TURN")), "durable-resumed-turn");
    if (scenario === "selected") {
      await manager.setSessionName("SDK proof saved session", "user");
      await manager.flush();
      await writeFile("/proof-state/session-id", manager.getSessionId(), { mode: 0o600 });
    }
    await manager.close();
    if (scenario === "selected") await copyFile(path, "/proof-state/baseline.jsonl");
  }
  for (const marker of ["discovery-executed", "forbidden-executed", "preload-executed", "env-executed"])
    check(!(await stat(`/home/job/${marker}`).catch(() => undefined)), "ambient-execution");
  check((await readFile(`/proc/self/task/${process.pid}/children`, "utf8")).trim() === "", "child-not-reaped");
  await gateway.stop(true);
  gateway = undefined;
  let closed = false;
  try { await fetch("http://127.0.0.1:38457/v1/models", { signal: AbortSignal.timeout(1_000) }); } catch { closed = true; }
  check(closed, "gateway-not-closed");
} catch (error) {
  failure = error instanceof ProofFailure ? error.code : "control-failed";
} finally {
  if (child?.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  child?.terminal?.close();
  await gateway?.stop(true);
}
console.log(failure ? `sdk-host-proof:${failure}` : "sdk-host-proof-ok");
process.exit(failure ? 1 : 0);
