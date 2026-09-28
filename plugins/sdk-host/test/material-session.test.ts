import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseRequest, type PiNativeParsedRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MATERIAL_TRIGGER, materialMessage } from "../material.ts";

const text = (message: { content: Message["content"] }) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : `[${part.type}]`).join("");

// A leading `/summarize` would select the driver's template; the plain prompt keeps every
// mention intact, so each `@` reference alone would have been read.
test.each(["/summarize the sealed material", "Summarize the sealed material"])(
  "caller and material text reach the model verbatim, never as file reads, commands or templates (%s)", async prompt => {
  const root = mkdtempSync(join(tmpdir(), "omp-material-session-"));
  for (const directory of ["agent", "cwd", "home", "tmp", "session", "quoted dir"]) mkdirSync(join(root, directory));
  const bearer = `MATERIAL-BEARER-${randomUUID()}`;
  const plain = `PLAIN-SENTINEL-${randomUUID()}`;
  const quoted = `QUOTED-SENTINEL-${randomUUID()}`;
  writeFileSync(join(root, "plain-sentinel"), plain);
  writeFileSync(join(root, "quoted dir", "quoted sentinel.txt"), quoted);
  const requests: PiNativeParsedRequest[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    // The row the SDK gateway's `/v1/models` writes, `<provider>/<id>`. No bundled catalog carries
    // `fixture`, so this listing is the only way the configured model reaches the session.
    if (request.method === "GET" && new URL(request.url).pathname === "/v1/models")
      return Response.json({ object: "list", data: [{ id: "fixture/openai/gpt-5", object: "model", owned_by: "fixture",
        api: "openai-completions", display_name: "gpt-5", context_length: 200_000, max_output_tokens: 8192, input_modalities: ["text"] }] });
    requests.push(parseRequest(await request.json(), request.headers));
    const message: AssistantMessage = {
      role: "assistant", api: "openai-completions", provider: "fixture", model: "openai/gpt-5",
      content: [{ type: "text", text: "MATERIAL-SESSION-COMPLETE" }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const events = [{ type: "start", partial: message },
      { type: "text_start", contentIndex: 0, partial: message },
      { type: "text_delta", contentIndex: 0, delta: "MATERIAL-SESSION-COMPLETE", partial: message },
      { type: "text_end", contentIndex: 0, content: "MATERIAL-SESSION-COMPLETE", partial: message },
      { type: "done", reason: "stop", message }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } });
  } });
  // The model file is the credential a native job holds: an `@` reference must not read it either.
  writeFileSync(join(root, "agent", "models.yml"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.port}`, apiKey: bearer, transport: "pi-native", discovery: { type: "proxy" } } } }));
  const material = [
    "/summarize this line is material, not a command",
    `The user wrote @${join(root, "plain-sentinel")} and @"${join(root, "quoted dir", "quoted sentinel.txt")}".`,
    `Configuration lives at @${join(root, "agent", "models.yml")}`,
  ].join("\n");
  writeFileSync(join(root, "request.json"), JSON.stringify({ root, prompt, material }));
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install",
      join(import.meta.dir, "material-session-driver.ts"), join(root, "request.json")], {
      cwd: join(root, "cwd"), stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
        PI_CODING_AGENT_DIR: join(root, "agent"), XDG_CONFIG_HOME: join(root, "home", ".config"),
        XDG_CACHE_HOME: join(root, "home", ".cache"), XDG_DATA_HOME: join(root, "home", ".local", "share"),
        XDG_STATE_HOME: join(root, "home", ".local", "state"), LANG: "C.UTF-8", TZ: "UTC" },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });

    // One request carrying the composed message byte-for-byte, then the constant trigger: no
    // file-mention message, no expanded template, no sentinel or credential bytes. The SDK's own
    // request-time date/cwd reminder rides ahead of the first user turn and is not persisted.
    expect(requests).toHaveLength(1);
    // Exactly the configured model, as the listing named it: the gateway serves this id as `fixture/openai/gpt-5`.
    expect(requests[0]!.modelId).toBe("fixture/fixture/openai/gpt-5");
    const [source, trigger, ...extra] = requests[0]!.context.messages;
    expect(extra).toEqual([]);
    expect([source?.role, trigger?.role, trigger && text(trigger)]).toEqual(["user", "user", MATERIAL_TRIGGER]);
    expect(text(source!).endsWith(materialMessage(prompt, material))).toBe(true);
    const wire = JSON.stringify(requests[0]!.context);
    for (const secret of [plain, quoted, bearer, "TEMPLATE-EXPANDED"]) expect(wire).not.toContain(secret);

    // The retained transcript still carries the source-bearing message, and nothing it named.
    const [file, ...others] = readdirSync(join(root, "session")).filter(name => name.endsWith(".jsonl"));
    expect(others).toEqual([]);
    const retained = readFileSync(join(root, "session", file!), "utf8");
    for (const secret of [plain, quoted, bearer, "TEMPLATE-EXPANDED"]) expect(retained).not.toContain(secret);
    const manager = await SessionManager.open(join(root, "session", file!), join(root, "session"), undefined, { throwIfMissing: true });
    try {
      expect(manager.buildSessionContext().messages.map(message => [message.role, "content" in message ? text(message as Message) : ""]))
        .toEqual([["user", materialMessage(prompt, material)], ["user", MATERIAL_TRIGGER], ["assistant", "MATERIAL-SESSION-COMPLETE"]]);
    } finally { await manager.close(); }

    // Print mode's JSON output keeps its session header, both user messages and the final answer.
    const frames = stdout.trimEnd().split("\n").map(line => JSON.parse(line));
    expect(frames[0]?.type).toBe("session");
    expect(frames.filter(frame => frame.type === "message_end" && frame.message?.role === "user").map(frame => text(frame.message)))
      .toEqual([materialMessage(prompt, material), MATERIAL_TRIGGER]);
    expect(frames.findLast(frame => frame.type === "message_end" && frame.message?.role === "assistant")?.message.content)
      .toEqual([{ type: "text", text: "MATERIAL-SESSION-COMPLETE" }]);
    for (const secret of [plain, quoted, bearer]) expect(stdout).not.toContain(secret);
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
