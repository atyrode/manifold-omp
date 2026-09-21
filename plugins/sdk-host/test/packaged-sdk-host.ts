import { closeSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { copyFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type { AssistantMessage, AssistantMessageEvent, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { createSessionFile, openSessionsRoot } from "../../workers/harness/sessions.ts";

// Fixture control, not a substitute runtime. Only shipped /runtime/bin programs
// construct agent sessions or run tools. Public journal inspection and pi-native
// messages verify their output; fresh terminal cases enter the governed worker.
const scenario = process.argv[2]!;
const sessions = "/home/job/omp-sessions";
const saved = join(sessions, "saved.jsonl");
const fresh = scenario.startsWith("fresh-");
const rpc = scenario === "fresh-rpc-selected";
const selected = scenario === "selected" || scenario === "fresh-sdk-selected" || rpc;
const filtered = scenario === "fresh-sdk-filtered";
const resumed = !fresh && !["selected", "disabled", "cancel"].includes(scenario);
let owner: Socket | undefined;
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
  const launch: { argv: string[]; sessionId: string } | undefined = fresh ? JSON.parse(await readFile("/inputs/launch", "utf8")) : undefined;
  if (fresh) {
    // An unrelated prior selected-skill conversation must neither be continued
    // nor contribute its historical optional skill choice to this fresh launch.
    await copyFile("/proof-state/baseline.jsonl", saved);
    if (rpc) {
      // RPC tests the public packaged SDK protocol directly; no synthetic
      // ActionRunner authority or production service is introduced.
      const root = openSessionsRoot();
      try { createSessionFile(root, launch!.sessionId, "/home/job/workspace"); }
      finally { closeSync(root); }
    }
  }
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
    } else if (scenario === "auto") {
      const manager = await SessionManager.open(saved, sessions);
      manager.appendThinkingLevelChange("high", "auto");
      await manager.flush();
      await manager.close();
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
  const expectedThinking = scenario === "auto" ? "auto" : fresh ? "low" : ["model-suffix", "thinking-only", "both", "disabled", "cancel"].includes(scenario) ? "off" : "high";
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
      const names = (parsed.context.tools ?? []).map(tool => tool.name).sort();
      const message: AssistantMessage = {
        role: "assistant", api: "openai-completions", provider: "fixture", model: expectedModel.slice("fixture/".length),
        content: [{ type: "text", text: resumed ? "SDK-PROOF-RESUMED-COMPLETE" : "SDK-PROOF-COMPLETE" }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      // The CLI may title a new session separately. This reply cannot satisfy
      // the primary-turn completion or ordinary tool-registry proof.
      if (fresh && names.length === 0) {
        message.content = [{ type: "text", text: "Fixture session title" }];
        return response(message);
      }
      requests++;
      check(!refused, "refused-state-reached-inference");
      check(requests <= 2, "unexpected-extra-inference");
      check(parsed.modelId === expectedModel, "resumed-model-selection");
      if (expectedThinking === "high" || expectedThinking === "low") check(parsed.options.reasoning === expectedThinking, "resumed-thinking-preservation");
      else check(parsed.options.reasoning === undefined && parsed.options.disableReasoning === true, "explicit-thinking-off");
      if (!fresh) check(JSON.stringify(names) === JSON.stringify(["read"]), "restricted-registry-widened");
      else check(names.includes("read"), "ordinary-read-tool-missing");
      const instructions = JSON.stringify({ system: parsed.context.systemPrompt, tools: parsed.context.tools });
      check(!instructions.includes("HOSTILE-AMBIENT-SKILL") && !instructions.includes("HOSTILE-PROJECT-CONTEXT"), "ambient-discovery");
      if (selected) check(instructions.includes("sealed-proof"), "selected-skill-not-advertised");
      else if (!fresh || scenario === "fresh-sdk-disabled") check(!instructions.includes("skill://"), "disabled-skill-advertised");
      else check(!instructions.includes("sealed-proof"), filtered ? "filtered-skill-advertised" : "historical-skill-restored");
      if (fresh) {
        check(parsed.context.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("SDK-PROOF-PROMPT")), "fresh-prompt-missing");
        check(!JSON.stringify(parsed.context.messages).includes("SDK-PROOF-COMPLETE"), "historical-conversation-restored");
      }
      if (rpc) check(String(parsed.context.systemPrompt).includes(await readFile("/inputs/admission", "utf8")), "rpc-admission-prompt-missing");
      if (scenario === "cancel") {
        waitingStream = true;
        request.signal.addEventListener("abort", () => { cancelled = true; }, { once: true });
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode(": waiting for verifier cancellation\n\n")); },
          cancel() { cancelled = true; },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      if ((selected || filtered) && requests === 1) {
        message.stopReason = "toolUse";
        message.content = [
          { type: "toolCall", id: "proof-read", name: "read", arguments: { path: "skill://sealed-proof/resource.txt" } },
          ...(scenario === "selected" ? [
            { type: "toolCall" as const, id: "proof-bash", name: "bash", arguments: { command: "touch /home/job/forbidden-executed" } },
            { type: "toolCall" as const, id: "proof-task", name: "task", arguments: { task: "Write /home/job/forbidden-executed" } },
          ] : []),
        ];
      } else {
        if (selected || filtered) {
          const results = parsed.context.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
          const read = results.find(result => result.toolCallId === "proof-read");
          check(read && (filtered ? read.isError : !read.isError && JSON.stringify(read.content).includes("SDK-SEALED-RESOURCE-ONLY")),
            filtered ? "filtered-skill-remained-readable" : "sealed-resource-read");
          if (scenario === "selected") for (const id of ["proof-bash", "proof-task"]) check(results.some(result => result.toolCallId === id && result.isError), "forbidden-tool-executed");
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
  const argv = fresh && !rpc ? ["/runtime/bin/bun", ...launch!.argv]
    : ["/runtime/bin/bun", "--no-env-file", "--no-install", "--config=/dev/null", "/runtime/bin/sdkHost", rpc ? "rpc" : kind];
  if (resumed) argv.push(scenario === "missing" ? "missing.jsonl" : "saved.jsonl");
  if (rpc) argv.push(`${launch!.sessionId}.jsonl`, "/inputs/admission");
  const env = { ...process.env };
  if (fresh && !rpc) env.MANIFOLD_JOB_CONTEXT_FD = "3";
  let rendered = false;
  const spawnOptions = { cwd: "/inputs", env, stderr: "pipe" as const };
  if ((resumed && !refused) || (fresh && !rpc)) {
    child = Bun.spawn(argv, { ...spawnOptions,
      ...(fresh ? { stdio: ["pipe", "pipe", "pipe", "socket-fd"] as ["pipe", "pipe", "pipe", "socket-fd"] } : {}),
      terminal: { cols: 120, rows: 40, name: "xterm-256color", data(pty, data) {
      const text = new TextDecoder().decode(data);
      terminal = (terminal + text).slice(-256_000);
      // Standard terminal queries only; the stock renderer and editor are real.
      if (text.includes("\x1b[6n")) pty.write("\x1b[1;1R");
      if (text.includes("\x1b[c")) pty.write("\x1b[?1;2c");
      if (text.includes("\x1b]11;?")) pty.write("\x1b]11;rgb:0000/0000/0000\x1b\\");
      if (terminal.includes("SDK-PROOF-COMPLETE")) rendered = true;
    } } });
  } else child = Bun.spawn(argv, { ...spawnOptions, stdin: rpc ? "pipe" : "ignore", stdout: "pipe" });
  if (fresh && !rpc) {
    // The pinned Bun exposes an owned socketpair endpoint for the native ABI.
    const fd = child.stdio[3];
    check(typeof fd === "number", "worker-context-socket");
    owner = (connect as unknown as (options: { fd: number }) => Socket)({ fd });
    owner.on("error", () => {});
  }
  owner?.write(`${JSON.stringify({ type: "context", locations: [
    { locationId: "atyrode.omp.workspace", guestPath: "/home/job/workspace", access: "write" },
    { locationId: "atyrode.omp.sessions", guestPath: sessions, access: "write" },
  ] })}\n`);
  const stderrRead = child.stderr instanceof ReadableStream ? new Response(child.stderr).text().then(value => { stderr = value; }) : Promise.resolve();
  const rpcResponses = new Map<string, { success: boolean; data?: { sessionId?: string; sessionFile?: string } }>();
  let rpcEnded = false;
  const stdoutRead = child.stdout instanceof ReadableStream ? (async () => {
    if (!rpc) return await new Response(child!.stdout as ReadableStream).text();
    let pending = "";
    const decoder = new TextDecoder();
    const reader = (child!.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const frame = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (frame.type === "response" && typeof frame.id === "string") rpcResponses.set(frame.id, frame);
        if (frame.type === "agent_end") rpcEnded = true;
      }
    }
    reader.releaseLock();
    return "";
  })() : Promise.resolve("");
  if (rpc) {
    const send = (frame: unknown) => {
      check(child!.stdin && typeof child!.stdin !== "number", "rpc-stdin");
      child!.stdin.write(`${JSON.stringify(frame)}\n`);
      child!.stdin.flush();
    };
    send({ id: "before", type: "get_session_stats" });
    await until(() => rpcResponses.has("before"), "rpc-not-ready");
    check(rpcResponses.get("before")?.success && rpcResponses.get("before")?.data?.sessionId === launch!.sessionId &&
      rpcResponses.get("before")?.data?.sessionFile === join(sessions, `${launch!.sessionId}.jsonl`), "rpc-fresh-identity");
    send({ id: "prompt", type: "prompt", message: "SDK-PROOF-PROMPT" });
    await until(() => completed && rpcEnded, "rpc-did-not-complete");
    send({ id: "after", type: "get_session_stats" });
    await until(() => rpcResponses.has("after"), "rpc-stats-after-turn");
    check(rpcResponses.get("after")?.success && rpcResponses.get("after")?.data?.sessionId === launch!.sessionId, "rpc-identity-changed");
    child.kill("SIGTERM");
  } else if (fresh) {
    await until(() => completed && terminal.includes("SDK-PROOF-COMPLETE"), "fresh-result-not-rendered");
    child.kill("SIGTERM");
  } else if (resumed && !refused) {
    // The saved assistant message is a semantic stock-renderer readiness signal.
    await until(() => rendered, "resume-renderer-not-ready");
    if (scenario !== "auto") {
      child.terminal!.write("SDK-PROOF-RESUMED-TURN\r");
      await until(() => completed, "resume-did-not-infer");
      // Observe the stock renderer before flushing and reopening the journal.
      await until(() => terminal.includes("SDK-PROOF-RESUMED-COMPLETE"), "resume-result-not-rendered");
    }
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
    check(discoveries > 0 && (scenario === "auto" ? requests === 0 : completed) && (resumed || fresh ? exit !== 0 : exit === 0), "program-completion");
    const path = fresh ? join(sessions, `${launch!.sessionId}.jsonl`) : resumed ? saved
      : join("/outputs/session", (await readdir("/outputs/session")).find(name => name.endsWith(".jsonl")) ?? "missing");
    const manager = await SessionManager.open(path, resumed || fresh ? sessions : "/outputs/session", undefined, { throwIfMissing: true });
    if (fresh) {
      check(manager.getSessionId() === launch!.sessionId && manager.getSessionFile() === path && manager.getCwd() === "/home/job/workspace", "fresh-durable-identity");
      check(await readFile(saved, "utf8") === before.get("saved.jsonl"), "fresh-mutated-history");
      const files = (await readdir(sessions)).filter(name => name.endsWith(".jsonl")).sort();
      check(JSON.stringify(files) === JSON.stringify(["saved.jsonl", `${launch!.sessionId}.jsonl`].sort()), "fresh-extra-journal");
    }
    const context = manager.buildSessionContext();
    check(context.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(resumed && scenario !== "auto" ? "SDK-PROOF-RESUMED-COMPLETE" : "SDK-PROOF-COMPLETE")), "durable-completion");
    check(context.models[manager.getLastModelChangeRole() ?? "default"] === expectedModel, "durable-model");
    check((context.configuredThinkingLevel ?? context.thinkingLevel) === expectedThinking, "durable-thinking");
    if (fresh) check(context.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("SDK-PROOF-PROMPT")), "fresh-durable-prompt");
    if (resumed && scenario !== "auto") check(context.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("SDK-PROOF-RESUMED-TURN")), "durable-resumed-turn");
    if (scenario === "selected") {
      await manager.setSessionName("SDK proof saved session", "user");
      await manager.flush();
      await writeFile("/proof-state/session-id", manager.getSessionId(), { mode: 0o600 });
    }
    await manager.close();
    if (scenario === "selected") await copyFile(path, "/proof-state/baseline.jsonl");
  }
  owner?.destroy();
  owner = undefined;
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
  owner?.destroy();
  await gateway?.stop(true);
}
console.log(failure ? `sdk-host-proof:${failure}` : "sdk-host-proof-ok");
process.exit(failure ? 1 : 0);
