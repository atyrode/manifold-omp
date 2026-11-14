import { connect, type Socket } from "node:net";
import { open, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type { AssistantMessage, AssistantMessageEvent, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { exerciseGrammarOperations, grammarCases, summaryCases } from "./grammar-operations.ts";
import grammarMetadata from "../../runtime-data/omp-grammar-assets-v1/grammars-v1.json";

// Unlike the general SDK controller, the CLI controller imports no SDK session
// or native module. Its sandbox does not even contain sdkHost/sdk-pi-natives.
const sdk = process.argv[2] === "grammar-sdk";
const languagePath = (item: { language: string; extension: string }) => `/home/job/workspace/grammars/${item.language}.${item.extension}`;
const summaryPath = (item: { language: string; extension: string }) => `/home/job/workspace/grammars/summary-${item.language}.${item.extension}`;
const completion = "GRAMMAR-PROOF-COMPLETE";
const fences = "\n```nix\nlet cli_nix = 42; in cli_nix\n```\n```sql\nSELECT 42 AS cli_sql;\n```\n```vue\n<template><span>cli_vue</span></template>\n```";
class ProofFailure extends Error { constructor(readonly code: string) { super(code); } }
function check(value: unknown, code: string): asserts value { if (!value) throw new ProofFailure(code); }
function response(message: AssistantMessage): Response {
  const events: AssistantMessageEvent[] = [{ type: "start", partial: message }];
  for (const [contentIndex, content] of message.content.entries()) {
    if (content.type === "text") events.push({ type: "text_start", contentIndex, partial: message },
      { type: "text_delta", contentIndex, delta: content.text, partial: message },
      { type: "text_end", contentIndex, content: content.text, partial: message });
    else if (content.type === "toolCall") events.push({ type: "toolcall_start", contentIndex, partial: message },
      { type: "toolcall_end", contentIndex, toolCall: content, partial: message });
  }
  events.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}
function plain(value: string): string { return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""); }
function tokenForeground(line: string, token: string): string | undefined {
  const index = plain(line).indexOf(token);
  if (index < 0) return undefined;
  const ansi = /\x1b\[([0-9;]*)m/g;
  let foreground = "default", visible = 0, cursor = 0;
  for (const match of line.matchAll(ansi)) {
    const text = plain(line.slice(cursor, match.index));
    if (visible + text.length > index) return foreground;
    visible += text.length;
    const codes = match[1]!.split(";").map(Number);
    for (let offset = 0; offset < codes.length; offset++) {
      const code = codes[offset]!;
      if (code === 0 || code === 39) foreground = "default";
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) foreground = String(code);
      else if (code === 38 && codes[offset + 1] === 2) { foreground = codes.slice(offset, offset + 5).join(";"); offset += 4; }
      else if (code === 38 && codes[offset + 1] === 5) { foreground = codes.slice(offset, offset + 3).join(";"); offset += 2; }
    }
    cursor = match.index! + match[0].length;
  }
  return foreground;
}
function checkResults(messages: readonly { role: string }[], durable: boolean): void {
  const results = messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
  check(results.length === grammarCases.length + summaryCases.length, "tool-result-count");
  for (const item of grammarCases) {
    const result = results.find(result => result.toolCallId === `grammar-${item.language}`);
    check(result && !result.isError, `ast-${item.language}-execution`);
    const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    check(text.includes(`${item.language}.${item.extension}`) && text.includes(item.source.trim().split("\n")[0]!) &&
      /\d+[|:]/.test(text), `ast-${item.language}-positive-match`);
    if (durable) {
      const details = result.details as { xdev?: { tool?: string; inner?: { matchCount?: number; fileCount?: number; parseErrors?: unknown[] } } } | undefined;
      check(details?.xdev?.tool === "ast_grep" && (details.xdev.inner?.matchCount ?? 0) > 0 &&
        details.xdev.inner?.fileCount === 1 && !details.xdev.inner?.parseErrors?.length, `ast-${item.language}-durable-native-result`);
    }
  }
  for (const item of summaryCases) {
    const result = results.find(result => result.toolCallId === `summary-${item.language}`);
    check(result && !result.isError, `summary-${item.language}-execution`);
    const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    check(text.includes(item.retained) && !text.includes(item.omitted), `summary-${item.language}-structural-elision`);
    if (durable) {
      const details = result.details as { summary?: { elidedSpans?: number; elidedLines?: number } } | undefined;
      check((details?.summary?.elidedSpans ?? 0) > 0 && (details?.summary?.elidedLines ?? 0) > 0,
        `summary-${item.language}-durable-parser-result`);
    }
  }
}
let child: Bun.Subprocess | undefined;
let owner: Socket | undefined;
let gateway: Bun.Server<undefined> | undefined;
let terminal = "", completed = false, requests = 0, failure: string | undefined, consumerInspected = false;
try {
  check(process.cwd() === "/inputs" && process.env.HOME === "/home/job", "private-environment");
  const routes = (await readFile("/proc/net/route", "utf8")).trim().split("\n").slice(1);
  check(routes.every(line => line.split(/\s+/)[0] === "lo"), "network-namespace");
  for (const alias of ["sdkHost", "sdk-pi-natives"]) check(Boolean(await stat(`/runtime/bin/${alias}`).catch(() => undefined)) === sdk, "native-alias-isolation");
  const launch = JSON.parse(await readFile("/inputs/launch", "utf8")) as { argv: string[]; sessionId: string; environment?: Record<string, string>; locations?: unknown[] };
  gateway = Bun.serve({ hostname: "127.0.0.1", port: 38457, async fetch(request) {
    try {
      check(request.headers.get("authorization") === `Bearer ${["SYNTHETIC", "LOCAL", "FIXTURE", "NOT", "A", "CREDENTIAL"].join("-")}`, "synthetic-capability");
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/models") return Response.json({ object: "list", data: [{
        id: "openai/gpt-5", object: "model", owned_by: "openai", api: "openai-completions", display_name: "Grammar proof",
        context_length: 200_000, max_output_tokens: 8192, input_modalities: ["text"],
      }] });
      check(request.method === "POST" && url.pathname === "/v1/pi/stream", "gateway-route");
      const parsed = parseRequest(await request.json(), request.headers);
      const names = (parsed.context.tools ?? []).map(tool => tool.name);
      const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "fixture", model: "openai/gpt-5",
        content: [{ type: "text", text: completion + (sdk ? "" : fences) }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (names.length === 0 || JSON.stringify(parsed.context.messages.at(-1)?.content).includes("<title-request>")) {
        check(!sdk, "headless-title-request");
        message.content = [{ type: "text", text: "Grammar proof" }];
        return response(message);
      }
      check(names.includes("read") && names.includes("write") && ++requests <= 2, "ordinary-native-tool-registry");
      if (!consumerInspected) {
        const pids = (await readFile(`/proc/${child!.pid}/task/${child!.pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
        const consumers: string[] = [];
        for (const pid of pids) {
          const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
          if (argv.includes(sdk ? "/runtime/bin/sdkHost" : "/runtime/bin/omp")) consumers.push(pid);
        }
        check(consumers.length === 1, "actual-shipped-consumer-process");
        const maps = await readFile(`/proc/${consumers[0]}/maps`, "utf8");
        check(sdk ? maps.includes("/runtime/bin/sdk-pi-natives") && !maps.includes("/tmp/omp-native/18.20.1/")
          : maps.includes("/tmp/omp-native/18.20.1/") && !maps.includes("sdk-pi-natives"), "actual-consumer-addon-identity");
        const environment = (await readFile(`/proc/${consumers[0]}/environ`, "utf8")).split("\0");
        check(environment.includes("PI_NATIVES_DIR=/tmp/omp-native") && !environment.some(value => value.startsWith("MANIFOLD_")), "consumer-private-environment");
        consumerInspected = true;
      }
      if (requests === 1) {
        message.stopReason = "toolUse";
        message.content = [
          ...grammarCases.map(item => ({ type: "toolCall" as const, id: `grammar-${item.language}`, name: "write", arguments: {
            path: "xd://ast_grep", content: JSON.stringify({ pat: item.pattern, path: languagePath(item), lang: item.language }),
          } })),
          ...summaryCases.map(item => ({ type: "toolCall" as const, id: `summary-${item.language}`, name: "read", arguments: { path: summaryPath(item) } })),
        ];
      } else { checkResults(parsed.context.messages, false); completed = true; }
      return response(message);
    } catch (error) {
      failure = error instanceof ProofFailure ? error.code : "gateway-failed";
      return Response.json({ error: { type: "fixture_failure", message: "Synthetic fixture refused request" } }, { status: 400 });
    }
  } });
  const options = { cwd: "/inputs", env: { ...process.env, ...launch.environment, MANIFOLD_JOB_CONTEXT_FD: "3", CLICOLOR_FORCE: "1", COLORTERM: "truecolor" },
    stdio: ["ignore", "pipe", "pipe", "socket-fd"] as ["ignore", "pipe", "pipe", "socket-fd"] };
  child = Bun.spawn(["/runtime/bin/bun", ...launch.argv], sdk ? options : { ...options,
    stdio: ["pipe", "pipe", "pipe", "socket-fd"] as ["pipe", "pipe", "pipe", "socket-fd"],
    terminal: { cols: 140, rows: 45, name: "xterm-256color", data(pty, data) {
      const text = new TextDecoder().decode(data); terminal = (terminal + text).slice(-2_000_000);
      if (text.includes("\x1b[6n")) pty.write("\x1b[1;1R");
      if (text.includes("\x1b[c")) pty.write("\x1b[?1;2c");
      if (text.includes("\x1b]11;?")) pty.write("\x1b]11;rgb:0000/0000/0000\x1b\\");
    } } });
  check(typeof child.stdio[3] === "number", "worker-context-socket");
  owner = (connect as unknown as (options: { fd: number }) => Socket)({ fd: child.stdio[3] });
  owner.on("error", () => {});
  owner.on("data", () => {});
  owner.write(`${JSON.stringify({ type: "context", locations: launch.locations ?? [
    { locationId: "atyrode.omp.workspace", guestPath: "/home/job/workspace", access: "write" },
    { locationId: "atyrode.omp.sessions", guestPath: "/home/job/omp-sessions", access: "write" },
  ] })}\n`);
  const stdout = child.stdout instanceof ReadableStream ? new Response(child.stdout).text() : Promise.resolve("");
  const stderr = child.stderr instanceof ReadableStream ? new Response(child.stderr).text() : Promise.resolve("");
  const deadline = Date.now() + 75_000;
  while (!completed || (!sdk && (!terminal.includes("\x1b[38;2;") ||
    !([["let", "cli_nix"], ["SELECT", "cli_sql"], ["span", "cli_vue"]] as const).every(([keyword, identifier]) =>
      terminal.split(/\r?\n/).some(line => plain(line).includes(identifier) &&
        tokenForeground(line, keyword) !== undefined && tokenForeground(line, keyword) !== tokenForeground(line, identifier)))))) {
    check(!failure, failure ?? "gateway-failed");
    check(child.exitCode === null && Date.now() < deadline, "consumer-completion");
    await Bun.sleep(20);
  }
  if (!sdk) {
    const lines = terminal.split(/\r?\n/);
    for (const [keyword, identifier] of [["let", "cli_nix"], ["SELECT", "cli_sql"], ["span", "cli_vue"]]) {
      check(lines.some(line => plain(line).includes(identifier!) && tokenForeground(line, keyword!) !== undefined &&
        tokenForeground(line, keyword!) !== tokenForeground(line, identifier!)), `cli-highlight-${identifier}`);
    }
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => child?.kill("SIGKILL"), 10_000);
  let exit: number;
  try { exit = await child.exited; } finally { clearTimeout(timer); }
  await Promise.all([stdout, stderr]);
  check(!failure && child.signalCode !== "SIGKILL" && (!sdk || exit === 0), "consumer-exit");
  child.terminal?.close();
  const directory = sdk ? "/outputs/session" : "/home/job/omp-sessions";
  const journals = (await readdir(directory)).filter(name => name.endsWith(".jsonl"));
  check(journals.length === 1, "single-durable-session");
  const entries = (await readFile(`${directory}/${journals[0]}`, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  checkResults(entries.filter(entry => entry.type === "message").map(entry => entry.message), true);
  check(consumerInspected, "consumer-addon-not-observed");
  check(await readlink("/tmp/omp-native/grammars") === "/runtime/bin/omp-grammars", "fixed-readonly-grammar-link");
  check(await realpath("/tmp/omp-native/grammars") === await realpath("/runtime/bin/omp-grammars"), "same-physical-grammar-tree");
  check((await readdir("/runtime/bin/omp-grammars")).sort().join("\0") === grammarMetadata.members.map(member => member.path).sort().join("\0"),
    "complete-selected-readonly-tree");
  const nix = grammarMetadata.members.find(member => member.path.startsWith("nix-"))!;
  let writeRefused = false;
  try { const probe = await open(`/runtime/bin/omp-grammars/${nix.path}`, "r+"); await probe.close(); }
  catch (error) { writeRefused = ["EROFS", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""); }
  check(writeRefused, "grammar-directory-kernel-readonly");
  if (sdk) {
    // Intentional module-loading boundary: this code must never load in the CLI sandbox.
    const [{ __ompSetGrammarDir, wasmGrammarFor }, { getNativeGrammarsDir }] = await Promise.all([
      import("@oh-my-pi/pi-natives"), import("@oh-my-pi/pi-utils"),
    ]);
    __ompSetGrammarDir("/runtime/bin/omp-grammars");
    check(await realpath(getNativeGrammarsDir()) === await realpath("/runtime/bin/omp-grammars"), "sdk-utils-same-grammar-tree");
    check(wasmGrammarFor({ lang: "nix" })?.installed === true, "preinstalled-nix-native-parser");
    const evidence = await exerciseGrammarOperations("/home/job/tmp");
    check(evidence.grammars.length === 39 && evidence.consumers.length === 3, "complete-native-consumers");
    check((await readdir("/tmp/omp-native")).join("\0") === "grammars", "sdk-no-addon-extraction");
  }
  check(!(await stat("/home/job/.omp/natives/grammars").catch(() => undefined)), "no-home-grammar-cache");
  if (!sdk) {
    const addons = (await readdir("/tmp/omp-native/18.20.1")).filter(name => name.endsWith(".node"));
    check(addons.length > 0, "stock-cli-embedded-addon-extraction");
  }
  check((await readFile(`/proc/self/task/${process.pid}/children`, "utf8")).trim() === "", "child-not-reaped");
  console.log("grammar-proof-ok");
} catch (error) {
  console.log(`grammar-proof:${error instanceof ProofFailure ? error.code : "fixture-failed"}`);
  process.exitCode = 1;
} finally {
  owner?.destroy();
  if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; child.terminal?.close(); }
  await gateway?.stop(true);
}
