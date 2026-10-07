/**
 * Spike evidence driver, never a gate: can an Agent Run carry OMP's stock TUI with live
 * model/thinking dials, Run activity and Run renewal?
 *
 * Real: a disposable Manifold hub (testkit, sibling checkout at plugins/MANIFOLD_REV), the
 * `core.access` V2 doors, the packed `harness` and `sdkHost` worker artifacts from `dist/`, the
 * pinned Bun and SDK natives, bubblewrap, and a tmux pane as the job terminal. Synthetic: inference
 * (a loopback pi-native fixture), and the owner's job context and private control socket, which
 * the driver supplies in place of a native owner (`job-linux.ts` passes the same two descriptors).
 * No provider is contacted and no credential is real.
 *
 * Usage: bun sdk-host/test/live-control-spike.ts <evidence-directory> <system-closure.json>
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai/types";
import { z } from "zod";
import {
  CreateRunV2CredentialResultSchema, InspectRunV2ResultSchema, PluginBundleSchema, RegisterAgentV2ResultSchema, type MachineArtifact,
} from "@manifold/protocol";
import { deliveredArtifact, extractArtifact, verifyBundledArtifacts } from "../../../../manifold/packages/plugin-kit/src/artifacts.ts";
import { dispatch } from "../../../../manifold/packages/plugin-kit/src/hub.ts";
import { startServer, type TestServer } from "../../../../manifold/packages/testkit/src/index.ts";

const [evidence, systemFile] = process.argv.slice(2).map(path => resolve(path!));
if (!evidence || !systemFile) throw new Error("usage: live-control-spike.ts <evidence-directory> <system-closure.json>");
const bundlePath = resolve(import.meta.dir, "../../dist/atyrode.omp.manifold-plugin.json");
const cacheDirectory = join(tmpdir(), "omp-live-control-artifacts");
const bubblewrap = Bun.which("bwrap");
const tmux = Bun.which("tmux");
const bash = Bun.which("bash");
const LEASE_MS = 60_000;
const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);
const lines: string[] = [];
const log = (message: string) => {
  const line = `[${elapsed()}s] ${message}`;
  lines.push(line);
  console.log(line);
};
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`spike check failed: ${message}`);
}
async function until(predicate: () => boolean | Promise<boolean>, message: string, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  while (!await predicate()) {
    check(Date.now() < deadline, `timed out: ${message}`);
    await Bun.sleep(100);
  }
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sealed = (path: string, value: unknown) => writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o400 });

async function publicArtifact(spec: MachineArtifact): Promise<Buffer> {
  const cached = join(cacheDirectory, spec.sha256);
  const existing = await readFile(cached).catch(() => undefined);
  if (existing && hash(existing) === spec.sha256) return existing;
  check(spec.url && ["https://github.com", "https://registry.npmjs.org"].includes(new URL(spec.url).origin), "artifact origin");
  let url = spec.url;
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(180_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      url = new URL(response.headers.get("location") ?? "", url).href;
      await response.body?.cancel();
      continue;
    }
    check(response.ok, `artifact download ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    check(bytes.length <= spec.maxBytes && hash(bytes) === spec.sha256, "artifact digest");
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    await writeFile(cached, bytes, { mode: 0o600 });
    return bytes;
  }
  throw new Error("artifact redirect limit");
}

/** The packed, digest-verified programs under test. Nothing here is rebuilt from source. */
async function extractRuntime(runtime: string) {
  const bundle = PluginBundleSchema.parse(JSON.parse(await readFile(bundlePath, "utf8")));
  check(bundle.manifest.id === "atyrode.omp", "bundle identity");
  await verifyBundledArtifacts(bundle);
  const tools = bundle.manifest.machine?.tools;
  check(tools, "runtime tools");
  for (const alias of ["bun", "ca-certificates", "harness", "sdk-pi-natives", "sdkHost"] as const) {
    const spec = tools[alias]?.["linux-x64"];
    check(spec, `runtime alias ${alias}`);
    const archive = spec.bundleFile ? deliveredArtifact(spec, { bundleFile: spec.bundleFile, data: bundle.files[spec.bundleFile]! })! : await publicArtifact(spec);
    const extracted = await extractArtifact(archive, spec, AbortSignal.timeout(120_000));
    await writeFile(join(runtime, "bin", alias), extracted.executable, { mode: alias === "bun" ? 0o500 : 0o400 });
    for (const [name, bytes] of Object.entries(extracted.files)) {
      const destination = join(runtime, "bin", ...spec.files![name]!.relativeTarget!);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { mode: 0o400 });
    }
  }
}

// ---------------------------------------------------------------- synthetic inference
const MODELS = ["openai/gpt-5", "openai/o3", "openai/gpt-4.1"];
const inference: { at: string; modelId: string; thinking: string; prompt: string }[] = [];
let slowReleased: (() => void) | undefined;
function stream(message: AssistantMessage, hold?: Promise<void>) {
  const events: AssistantMessageEvent[] = [{ type: "start", partial: message }];
  message.content.forEach((content, index) => {
    if (content.type === "text") {
      events.push({ type: "text_start", contentIndex: index, partial: message });
      events.push({ type: "text_delta", contentIndex: index, delta: content.text, partial: message });
      events.push({ type: "text_end", contentIndex: index, content: content.text, partial: message });
    } else if (content.type === "toolCall") {
      events.push({ type: "toolcall_start", contentIndex: index, partial: message });
      events.push({ type: "toolcall_end", contentIndex: index, toolCall: content, partial: message });
    }
  });
  events.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
  const encode = (list: AssistantMessageEvent[]) => new TextEncoder().encode(list.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encode(events.slice(0, 1)));
      if (hold) await hold;
      controller.enqueue(encode(events.slice(1)));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}
const FIXTURE_KEY = "SYNTHETIC-LOCAL-FIXTURE-NOT-A-CREDENTIAL";
let replies = 0;
function startGateway(): Bun.Server<undefined> {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${FIXTURE_KEY}`) return new Response("unauthorized", { status: 401 });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: MODELS.map(id => ({ id, object: "model", owned_by: "openai",
        api: "openai-completions", display_name: id, context_length: 200_000, max_output_tokens: 8192, input_modalities: ["text"] })) });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/pi/stream") return new Response("not found", { status: 404 });
    const parsed = parseRequest(await request.json(), request.headers);
    const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "fixture", model: parsed.modelId,
      content: [], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if ((parsed.context.tools ?? []).length === 0) {
      message.content = [{ type: "text", text: "Live control spike" }];
      return stream(message);
    }
    const last = parsed.context.messages.at(-1);
    const prompt = last?.role === "user" ? JSON.stringify(last.content) : `(${last?.role})`;
    const thinking = parsed.options.reasoning ?? (parsed.options.disableReasoning ? "off" : "unset");
    inference.push({ at: elapsed().trim(), modelId: parsed.modelId, thinking, prompt: prompt.slice(0, 80) });
    if (last?.role === "user" && prompt.includes("ASK-THE-OPERATOR")) {
      message.stopReason = "toolUse";
      message.content = [{ type: "toolCall", id: "ask-operator", name: "ask",
        arguments: { questions: [{ id: "proceed", question: "Fixture asks: proceed?", options: [{ label: "Proceed" }, { label: "Stop" }] }] } }];
      return stream(message);
    }
    message.content = [{ type: "text", text: `FIXTURE-REPLY ${++replies}: served by ${parsed.modelId}, thinking ${thinking}.` }];
    if (last?.role === "user" && prompt.includes("SLOW-TURN")) {
      const hold = Promise.withResolvers<void>();
      slowReleased = hold.resolve;
      return stream(message, hold.promise);
    }
    return stream(message);
  } });
}

// ---------------------------------------------------------------- driver-owned descriptors
function listen(onConnection: (socket: Socket) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(onConnection);
  const { promise, resolve: listening, reject } = Promise.withResolvers<{ server: Server; port: number }>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") listening({ server, port: address.port });
    else reject(new Error("listener address"));
  });
  return promise;
}

let root: string | undefined;
let server: TestServer | undefined;
let gateway: Bun.Server<undefined> | undefined;
let contextServer: Server | undefined;
let controlServer: Server | undefined;
let control: Socket | undefined;
const tmuxSocket = `omp-live-control-${process.pid}`;
const session = "spike";
let tmuxStarted = false;
const timeline: { t: string; state: string; activity: string; expiresInS: number; renewals: number; model: string }[] = [];
let polling = true;
let failure: unknown;
const tmuxRun = async (...args: string[]) => {
  const child = Bun.spawn([tmux!, "-L", tmuxSocket, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  check(code === 0, `tmux ${args[0]} failed: ${err.trim()}`);
  return out;
};
const pane = () => tmuxRun("capture-pane", "-t", session, "-p");
async function capture(name: string, note: string) {
  const text = await pane();
  await writeFile(join(evidence, `${name}.txt`), text);
  await writeFile(join(evidence, `${name}.ansi`), await tmuxRun("capture-pane", "-t", session, "-p", "-e"));
  log(`captured ${name}: ${note}`);
  return text;
}
const statusRows = (text: string) => text.trimEnd().split("\n").slice(-4).join("\n");

try {
  check(bubblewrap && tmux && bash, "bwrap, tmux and bash are required");
  check(Bun.version === "1.4.2", "pinned Bun 1.4.2 is required");
  await mkdir(evidence, { recursive: true });
  root = await mkdtemp(join(tmpdir(), "omp-live-control-"));
  await chmod(root, 0o700);
  const runtime = join(root, "runtime");
  const home = join(root, "home");
  const inputs = join(root, "inputs");
  for (const path of [join(runtime, "bin"), join(home, "workspace"), join(home, "tmp"), join(home, "omp-sessions"), join(home, ".omp/agent"), inputs])
    await mkdir(path, { recursive: true, mode: 0o700 });
  log("extracting packed harness, sdkHost, Bun and SDK natives from dist/atyrode.omp.manifold-plugin.json");
  await extractRuntime(runtime);

  gateway = startGateway();
  log(`synthetic pi-native gateway on 127.0.0.1:${gateway.port}`);
  const ownerKey = randomBytes(32).toString("hex");
  server = await startServer({ dataDir: join(root, "hub"), ownerKey });
  const hub = { url: `http://127.0.0.1:${server.port}` };
  log(`disposable hub ${hub.url} (Manifold ${(await readFile(resolve(import.meta.dir, "../../MANIFOLD_REV"), "utf8")).trim().slice(0, 8)})`);
  const call = async (token: string, door: string, input: unknown) => {
    const outcome = await dispatch(hub, token, door, input);
    if (!outcome.ok) return { ok: false as const, rule: outcome.denial.rule, message: outcome.denial.message };
    return { ok: true as const, result: outcome.result };
  };

  // Code's shape: an Agent with no Manifold authority, a 60 s lease ceiling for a fast renewal proof.
  const registration = await call(ownerKey, "core.access.registerAgentV2", {
    name: "live-control-spike", purpose: "Spike: TUI harness with live dials, activity and renewal", harness: "external",
    grant: { scope: [], maxRunLifetimeMs: LEASE_MS, delegation: { maxDepth: 0, maxDescendants: 0 }, expiresAt: Date.now() + 3_600_000 },
    context: { profile: {} },
  });
  check(registration.ok, `registerAgentV2: ${JSON.stringify(registration)}`);
  const registered = RegisterAgentV2ResultSchema.parse(registration.result);
  check(registered.credential, "runner credential");
  const agentId = registered.agent.agentId;
  log(`registerAgentV2 → agent ${agentId}, scope [], maxRunLifetimeMs ${LEASE_MS}`);
  const creation = await call(registered.credential.token, "core.access.createRunV2",
    { agentId, lifetimeMs: LEASE_MS, model: { provider: "fixture", model: "openai/gpt-5" } });
  check(creation.ok, `createRunV2: ${JSON.stringify(creation)}`);
  const { run, credential: { token: runToken } } = CreateRunV2CredentialResultSchema.parse(creation.result);
  log(`createRunV2 (runner) → run ${run.id}, state ${run.state}, expires in ${((run.expiresAt - Date.now()) / 1000).toFixed(1)} s`);
  const inspect = async () => {
    const reply = await call(ownerKey, "core.access.inspectRunV2", { runId: run.id });
    check(reply.ok, `inspectRunV2: ${JSON.stringify(reply)}`);
    return InspectRunV2ResultSchema.parse(reply.result).run;
  };
  // Renewal before any acknowledgement, with the Run's own credential: the door refuses.
  const early = await call(runToken, "core.access.renewAgentRunV2", { runId: run.id, lifetimeMs: LEASE_MS });
  log(`renewAgentRunV2 while ${run.state} → ${early.ok ? "ok" : `refused ${early.rule}: ${early.message}`}`);

  void (async () => {
    while (polling) {
      const current = await inspect().catch(() => undefined);
      if (current) {
        const row = { t: elapsed().trim(), state: current.state, activity: current.activity,
          expiresInS: Math.round((current.expiresAt - Date.now()) / 1000), renewals: current.renewals,
          model: current.model ? `${current.model.provider}/${current.model.model}` : "none" };
        const previous = timeline.at(-1);
        if (!previous || previous.state !== row.state || previous.activity !== row.activity || previous.renewals !== row.renewals) {
          timeline.push(row);
          log(`hub inspectRunV2: state=${row.state} activity=${row.activity} renewals=${row.renewals} expiresIn=${row.expiresInS}s model=${row.model}`);
        }
      }
      await Bun.sleep(150);
    }
  })();

  // Sealed inputs exactly as the harness operation reads them.
  const sessionId = randomUUID();
  const config = { extensions: [], disabledProviders: [], extendedContext: false, startup: { setupWizard: false },
    modelRoles: { default: "fixture/openai/gpt-5" }, defaultThinkingLevel: "low", skills: { enabled: false } };
  await sealed(join(home, ".omp/agent/config.yml"), config);
  await sealed(join(home, ".omp/agent/models.yml"), { providers: { fixture: {
    baseUrl: `http://127.0.0.1:${gateway.port}`, apiKey: FIXTURE_KEY, transport: "pi-native", discovery: { type: "proxy" } } } });
  await sealed(join(inputs, "sessionId"), sessionId);
  await sealed(join(inputs, "prompt"), "FIRST-TURN from the Agent's instructions.");
  await sealed(join(inputs, "automation"), { mode: "ordinary" });
  await sealed(join(inputs, "skillRuntime"), { mode: "disabled", names: [] });
  await sealed(join(inputs, "resumeOverrides"), {});
  await sealed(join(inputs, "lease"), { expiresAt: run.expiresAt, lifetimeMs: LEASE_MS });

  const context = await listen(socket => {
    socket.on("error", () => {});
    socket.write(`${JSON.stringify({ type: "context", locations: [
      { locationId: "atyrode.omp.workspace", guestPath: "/home/job/workspace", access: "write" },
      { locationId: "atyrode.omp.sessions", guestPath: "/home/job/omp-sessions", access: "write" },
    ] })}\n`);
  });
  contextServer = context.server;
  const controlListener = await listen(socket => { socket.on("error", () => {}); control = socket; });
  controlServer = controlListener.server;
  const sendControl = (frame: unknown) => {
    check(control && !control.destroyed, "control socket");
    control.write(`${JSON.stringify(frame)}\n`);
    log(`control descriptor ← ${JSON.stringify(frame)}`);
  };

  const system = z.array(z.strictObject({ source: z.string(), target: z.string(), kind: z.literal("file") }))
    .parse(JSON.parse(await readFile(systemFile, "utf8")));
  const tokenFile = join(root, "run-token");
  await writeFile(tokenFile, runToken, { mode: 0o400 });
  const sandbox = [
    bubblewrap, "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--as-pid-1", "--die-with-parent",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", runtime, "/runtime", "--bind", home, "/home/job", "--ro-bind", inputs, "/inputs",
    "--ro-bind", join(home, ".omp/agent/config.yml"), "/home/job/.omp/agent/config.yml",
    "--ro-bind", join(home, ".omp/agent/models.yml"), "/home/job/.omp/agent/models.yml",
    ...system.flatMap(bind => ["--ro-bind", bind.source, bind.target]),
    "--chdir", "/home/job", "--",
    "/runtime/bin/bun", "--no-env-file", "--no-install", "--config=/dev/null", "/runtime/bin/harness", "launch", "--tui",
  ];
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(join(root, "pane.sh"), [
    "set -eu",
    // The owner's two private descriptors: job context (3) and harness control (4).
    `exec 3<>/dev/tcp/127.0.0.1/${context.port}`,
    `exec 4<>/dev/tcp/127.0.0.1/${controlListener.port}`,
    `exec env -i HOME=/home/job PATH=/runtime/bin TMPDIR=/home/job/tmp LANG=C.UTF-8 TZ=UTC TERM=xterm-256color \\`,
    `  MANIFOLD_JOB_CONTEXT_FD=3 MANIFOLD_HARNESS_CONTROL_FD=4 MANIFOLD_RUN_ID=${quote(run.id)} \\`,
    `  MANIFOLD_ORIGIN=${quote(`${hub.url}/`)} MANIFOLD_RUN_TOKEN="$(cat ${quote(tokenFile)})" \\`,
    `  ${sandbox.map(quote).join(" ")}`,
  ].join("\n"), { mode: 0o500 });
  await tmuxRun("new-session", "-d", "-s", session, "-x", "120", "-y", "36",
    `${bash} ${join(root, "pane.sh")}; echo PANE-EXIT=$?; sleep 600`);
  tmuxStarted = true;
  log("tmux pane → bubblewrap → harness launch --tui (packed) → sdkHost tui (packed)");

  // 1. The stock TUI renders the Agent's first prompt; activity reaches the hub.
  await until(async () => (await pane()).includes("FIXTURE-REPLY 1"), "first turn rendered", 90_000);
  await until(() => timeline.some(row => row.activity === "done"), "activity done after first turn");
  const first = await capture("01-first-turn", "gpt-5 / low");
  check(control, "control descriptor connected");

  // 2. Live model dial through the private control descriptor.
  sendControl({ type: "set_model", provider: "fixture", modelId: "openai/o3" });
  await until(async () => statusRows(await pane()) !== statusRows(first), "status line after model dial", 10_000);
  await Bun.sleep(500);
  const afterModel = await capture("02-after-set-model", "dial: fixture/openai/o3");
  // 3. Live thinking dial.
  sendControl({ type: "set_thinking_level", level: "high" });
  await until(async () => statusRows(await pane()) !== statusRows(afterModel), "status line after thinking dial", 10_000);
  await Bun.sleep(500);
  await capture("03-after-set-thinking", "dial: high");
  // 4. The next turn is served by the dialled model at the dialled level.
  sendControl({ type: "prompt", message: "SECOND-TURN after both dials." });
  await until(async () => (await pane()).includes("FIXTURE-REPLY 2"), "second turn rendered");
  await capture("04-turn-after-dials", "inference after dials");
  // A dial outside the served set is refused inside the SDK host. Job input has no reply channel.
  const beforeRefused = statusRows(await pane());
  sendControl({ type: "set_model", provider: "fixture", modelId: "openai/not-served" });
  await Bun.sleep(2_000);
  check(statusRows(await pane()) === beforeRefused, "an unserved model must leave the session unchanged");
  await capture("04b-refused-dial", "unserved model: status unchanged, nothing returned to the sender");

  // 5. The operator still owns the keyboard: a typed turn, slow enough to observe `working`.
  await tmuxRun("send-keys", "-t", session, "-l", "SLOW-TURN typed by the operator");
  await tmuxRun("send-keys", "-t", session, "Enter");
  await until(() => slowReleased !== undefined, "slow turn reached inference");
  await until(() => timeline.at(-1)?.activity === "working", "working while the slow turn streams");
  await capture("05-working", "slow turn in flight");
  slowReleased!();
  await until(async () => (await pane()).includes("FIXTURE-REPLY 3"), "slow turn rendered");

  // 6. A tool dialog in the TUI is `blocked`; the operator answers it in the TUI.
  await tmuxRun("send-keys", "-t", session, "-l", "ASK-THE-OPERATOR before continuing");
  await tmuxRun("send-keys", "-t", session, "Enter");
  await until(() => timeline.at(-1)?.activity === "blocked", "blocked while the ask dialog is open");
  await Bun.sleep(500);
  await capture("06-blocked", "ask dialog open");
  await tmuxRun("send-keys", "-t", session, "Enter");
  await until(async () => (await pane()).includes("FIXTURE-REPLY 4"), "turn after the answer rendered");
  await until(() => timeline.at(-1)?.activity === "done", "done after the answered turn");
  await capture("07-after-answer", "dialog answered in the TUI");

  // 7. Renewal: hold the session past two of its original 60 s leases, then dial and talk again.
  await until(async () => (await inspect()).renewals >= 1, "first renewal", 90_000);
  await until(() => Date.now() - run.createdAt > 2 * LEASE_MS + 5_000, "two original leases elapsed", 150_000);
  sendControl({ type: "set_model", provider: "fixture", modelId: "openai/gpt-5" });
  sendControl({ type: "set_thinking_level", level: "minimal" });
  sendControl({ type: "prompt", message: "LATE-TURN after renewals." });
  await until(async () => (await pane()).includes("FIXTURE-REPLY 5"), "late turn rendered");
  await until(() => timeline.at(-1)?.activity === "done", "done after the late turn");
  const beyond = await inspect();
  check(beyond.state === "active" && beyond.renewals >= 3, `active with three renewals, got ${beyond.state}/${beyond.renewals}`);
  await capture("08-after-renewals", `renewals=${beyond.renewals}, ${((Date.now() - run.createdAt) / 1000).toFixed(0)} s after creation`);

  // 8. The operator quits the TUI; the harness settles the Run.
  await tmuxRun("send-keys", "-t", session, "C-d");
  await until(async () => (await pane()).includes("PANE-EXIT="), "TUI exit", 20_000);
  await until(async () => !["active", "pending_policy"].includes((await inspect()).state), "run settled", 10_000);
  await capture("09-exit", "operator quit");
  const final = await inspect();
  log(`final run: state=${final.state} activity=${final.activity} renewals=${final.renewals} model=${JSON.stringify(final.model)}`);
} catch (error) {
  failure = error;
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  if (tmuxStarted) await capture("99-failure", "pane at failure").catch(() => undefined);
} finally {
  polling = false;
  await Bun.sleep(300);
  await writeFile(join(evidence, "timeline.json"), JSON.stringify(timeline, null, 2)).catch(() => {});
  await writeFile(join(evidence, "inference.json"), JSON.stringify(inference, null, 2)).catch(() => {});
  await writeFile(join(evidence, "run.log"), `${lines.join("\n")}\n`).catch(() => {});
  if (tmuxStarted) await tmuxRun("kill-session", "-t", session).catch(() => undefined);
  // The private server exits with its only session; its socket file does not.
  await rm(join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid!()}`, tmuxSocket), { force: true });
  control?.destroy();
  contextServer?.close();
  controlServer?.close();
  await server?.stop().catch(() => undefined);
  await gateway?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
}
process.exit(failure ? 1 : 0);
