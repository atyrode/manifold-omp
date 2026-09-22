import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { setTimeout, clearTimeout } from "node:timers";
import { ActionRunner } from "@manifold/sdk";
import type { ActionRunnerResponse } from "@manifold/protocol";
import { z } from "zod";
import { probeChildEnvironment } from "../probe/inputs.ts";
import { openSessionsRoot, prepareSessionFile, SESSIONS_ROOT, SessionIdSchema } from "./sessions.ts";
import { OmpRpcActivity, OmpSendInputSchema, rpcFrames, RPC_FRAME_BYTES } from "./rpc.ts";
import { ADMISSION_CONTEXT_BYTES, writeAdmissionContext, type AdmissionContextFile } from "./admission.ts";
import { dispatchOmpModelRequest, OmpModelToolInputSchema } from "./model.ts";
import { validateSkillInputs } from "./skills.ts";
import { readAutomation } from "./sdk-inputs.ts";
import { forwardOmpOutput, type ReportOmpProgress } from "./progress.ts";

const runnerEnvironment = z.strictObject({
  origin: z.string().url(), token: z.string().regex(/^[a-f0-9]{64}$/i), runId: z.string().min(1).max(128),
  controlFd: z.coerce.number().int().min(3),
});

const ompEnvironment = {
  ...probeChildEnvironment(), TERM: "xterm-256color",
  SSL_CERT_FILE: "/runtime/bin/ca-certificates", GIT_SSL_CAINFO: "/runtime/bin/ca-certificates",
};

/** Fresh ordinary admitted Agents retain the published CLI RPC path. */
function ompLaunchArgs(sessionFile: string, options: { planYolo?: boolean; admissionPath: string; disableSkills?: boolean }): string[] {
  const args = [
    "--session-dir", SESSIONS_ROOT, "--session", `${SESSIONS_ROOT}/${sessionFile}`,
    "--config", "/home/job/.omp/agent/config.yml", ...(options.planYolo ? ["--plan-yolo"] : []),
    ...(options.disableSkills ? ["--no-skills"] : []),
  ];
  return ["--mode", "rpc", ...args, "--append-system-prompt", options.admissionPath];
}

/** Consume launcher-only authority before any model or control stream is read. */
export function takeRunEnvironment(environment: NodeJS.ProcessEnv) {
  const input = {
    origin: environment.MANIFOLD_ORIGIN, token: environment.MANIFOLD_RUN_TOKEN,
    runId: environment.MANIFOLD_RUN_ID, controlFd: environment.MANIFOLD_HARNESS_CONTROL_FD,
  };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("MANIFOLD_") && key !== "MANIFOLD_JOB_CONTEXT_FD") delete environment[key];
  }
  const parsed = runnerEnvironment.safeParse(input);
  if (!parsed.success) throw new Error("invalid_run_environment");
  if (parsed.data.controlFd === Number(environment.MANIFOLD_JOB_CONTEXT_FD) || !fstatSync(parsed.data.controlFd).isSocket()) throw new Error("invalid_control_descriptor");
  return parsed.data;
}

function inputText(name: "sessionId" | "prompt", limit: number): string {
  const fd = openSync(`/inputs/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || (stat.mode & 0o222) !== 0) throw new Error("invalid_harness_input");
    const bytes = Buffer.alloc(stat.size + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== stat.size) throw new Error("invalid_harness_input");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
  } finally { closeSync(fd); }
}

/** Operator resume uses only immutable native inputs; the SDK child owns the
 * stock terminal renderer and never receives private Agent authority. */
export async function runOmpResume(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) throw new Error("harness_cancelled");
  validateSkillInputs();
  const sessionId = SessionIdSchema.parse(inputText("sessionId", 36));
  const root = openSessionsRoot();
  let sessionFile: string;
  try { sessionFile = prepareSessionFile(root, sessionId, "/home/job/workspace", true); }
  finally { closeSync(root); }
  if (signal.aborted) throw new Error("harness_cancelled");
  const child = spawn("/runtime/bin/bun", ["--no-env-file", "--no-install", "--config=/dev/null", "/runtime/bin/sdkHost", "resume", sessionFile], {
    cwd: "/inputs", env: ompEnvironment, stdio: "inherit",
  });
  const exit = Promise.withResolvers<number | null>();
  child.once("close", exit.resolve);
  child.once("error", exit.reject);
  let killTimeout: NodeJS.Timeout | undefined;
  const stop = () => {
    child.kill("SIGTERM");
    killTimeout = setTimeout(() => child.kill("SIGKILL"), 1000);
    killTimeout.unref();
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    const code = await exit.promise;
    return code === 0 && !signal.aborted;
  } finally {
    signal.removeEventListener("abort", stop);
    clearTimeout(killTimeout);
  }
}

/** Interactive paths hand over the terminal directly. One-shot paths additionally
 * observe the published JSON stream without changing argv or output bytes. */
export async function runOmpNative(signal: AbortSignal, reportProgress: ReportOmpProgress): Promise<boolean> {
  const skills = validateSkillInputs();
  if (signal.aborted) throw new Error("harness_cancelled");
  const separator = process.argv.indexOf("--", 3);
  const options = process.argv.slice(3, separator < 0 ? undefined : separator);
  const print = options.includes("-p");
  let sessionFile: string | undefined;
  if (!print) {
    const root = openSessionsRoot();
    try { sessionFile = prepareSessionFile(root, SessionIdSchema.parse(inputText("sessionId", 36)), "/home/job/workspace", false); }
    finally { closeSync(root); }
  }
  if (readAutomation().mode === "restricted" || skills.mode !== "preserve") {
    if (options.includes("--plan-yolo")) throw new Error("omp_skills_plan_unsupported");
    const child = spawn("/runtime/bin/bun", ["--no-env-file", "--no-install", "--config=/dev/null", "/runtime/bin/sdkHost",
      print ? "print" : "interactive", ...(sessionFile ? [sessionFile] : [])], {
      cwd: "/inputs", env: ompEnvironment, stdio: print ? ["inherit", "pipe", "inherit"] : "inherit",
    });
    const exit = Promise.withResolvers<number | null>();
    child.once("close", exit.resolve);
    child.once("error", exit.reject);
    const output = print
      ? forwardOmpOutput(child.stdout!, process.stdout, reportProgress, signal).then(() => true, () => false)
      : Promise.resolve(true);
    let timeout: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      timeout = setTimeout(() => child.kill("SIGKILL"), 1000);
      timeout.unref();
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      const code = await exit.promise;
      const forwarded = await output;
      return code === 0 && forwarded && !signal.aborted;
    }
    finally { signal.removeEventListener("abort", stop); clearTimeout(timeout); }
  }
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith("MANIFOLD_")) delete environment[name];
  const child = spawn("/runtime/bin/omp", [...(sessionFile ? ["--session", `${SESSIONS_ROOT}/${sessionFile}`] : []), ...process.argv.slice(3)], {
    cwd: "/home/job/workspace", env: environment, stdio: print ? ["inherit", "pipe", "inherit"] : "inherit",
  });
  const exit = Promise.withResolvers<number | null>();
  child.once("close", exit.resolve);
  child.once("error", exit.reject);
  const output = print
    ? forwardOmpOutput(child.stdout!, process.stdout, reportProgress, signal).then(() => true, () => false)
    : Promise.resolve(true);
  let timeout: NodeJS.Timeout | undefined;
  const stop = () => {
    child.kill("SIGTERM");
    timeout = setTimeout(() => child.kill("SIGKILL"), 1000);
    timeout.unref();
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    const code = await exit.promise;
    const forwarded = await output;
    return code === 0 && forwarded && !signal.aborted;
  }
  finally { signal.removeEventListener("abort", stop); clearTimeout(timeout); }
}

/** A native operation, not a shell command. OMP sees neither the runner credential
 * nor the private control descriptor; its only host boundary is the RPC pipe. */
export async function runOmpHarness(signal: AbortSignal): Promise<boolean> {
  const skills = validateSkillInputs();
  if (skills.mode !== "preserve" && process.argv.includes("--plan-yolo")) throw new Error("omp_skills_plan_unsupported");
  if (readAutomation().mode === "restricted") throw new Error("omp_restricted_harness_unsupported");
  const binding = takeRunEnvironment(process.env);
  const sessionId = SessionIdSchema.parse(inputText("sessionId", 36));
  const prompt = inputText("prompt", 16384 * 4);
  const root = openSessionsRoot();
  let sessionFile: string;
  try { sessionFile = prepareSessionFile(root, sessionId, "/home/job/workspace", process.argv.includes("--resume")); }
  finally { closeSync(root); }
  // Bun adopts inherited socketpairs through connect({fd}), not Socket({fd}).
  const connectDescriptor = connect as unknown as (options: { fd: number }) => Socket;
  const control = connectDescriptor({ fd: binding.controlFd });
  let emitted: ActionRunnerResponse[] = [];
  let emittedBytes = 0;
  const runner = new ActionRunner({ origin: binding.origin, token: binding.token, bind: { runId: binding.runId }, emit(frame) {
    const size = Buffer.byteLength(JSON.stringify(frame));
    if (emittedBytes + size > ADMISSION_CONTEXT_BYTES) throw new Error("harness_response_limit");
    emittedBytes += size;
    emitted.push(frame);
  } });
  binding.token = "";
  let runnerTail = Promise.resolve();
  let queuedRunner = 0;
  const useRunner = (action: () => Promise<void>): Promise<void> => {
    if (queuedRunner >= 64) return Promise.reject(new Error("harness_pending_limit"));
    queuedRunner++;
    const next = runnerTail.then(action).finally(() => { queuedRunner--; });
    runnerTail = next.catch(() => {});
    return next;
  };
  const reportActivity = (activity: "working" | "blocked" | "done" | "idle") => useRunner(async () => {
    if (runner.closed) return;
    emitted = []; emittedBytes = 0;
    await runner.reportActivity({ runId: binding.runId, activity });
    emitted = []; emittedBytes = 0;
  });
  let child: ChildProcess | undefined;
  let completed = false;
  let controlFailed = false;
  let admission: AdmissionContextFile | undefined;
  control.once("error", () => { controlFailed = true; if (!runner.successful) child?.kill("SIGTERM"); });
  try {
    await runner.bind();
    admission = writeAdmissionContext(emitted);
    emitted = []; emittedBytes = 0;
    if (signal.aborted || controlFailed) throw new Error("harness_cancelled");
    const resuming = process.argv.includes("--resume");
    const useSdk = resuming || skills.mode !== "preserve";
    child = spawn(useSdk ? "/runtime/bin/bun" : "/runtime/bin/omp", useSdk
      ? ["--no-env-file", "--no-install", "--config=/dev/null", "/runtime/bin/sdkHost", resuming ? "rpc-resume" : "rpc", sessionFile, admission.path]
      : ompLaunchArgs(sessionFile, {
        admissionPath: admission.path, planYolo: process.argv.includes("--plan-yolo"),
        disableSkills: process.argv.includes("--no-skills"),
      }), { cwd: useSdk ? "/inputs" : "/home/job/workspace", env: ompEnvironment, stdio: ["pipe", "pipe", "pipe"] });
    const processChild = child;
    const stdin = processChild.stdin!;
    // Provider diagnostics are not a safe public channel. RPC failures are fixed codes below.
    processChild.stderr!.resume();
    const exit = Promise.withResolvers<number | null>();
    processChild.once("exit", exit.resolve);
    processChild.once("error", exit.reject);
    void exit.promise.catch(() => {});
    const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
    const writeFrame = async (frame: unknown): Promise<void> => {
      const bytes = `${JSON.stringify(frame)}\n`;
      if (Buffer.byteLength(bytes) > RPC_FRAME_BYTES) throw new Error("rpc_frame_limit");
      const written = Promise.withResolvers<void>();
      stdin.write(bytes, error => error ? written.reject(new Error("rpc_unavailable")) : written.resolve());
      await written.promise;
    };
    const request = (type: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      if (pending.size >= 64) return Promise.reject(new Error("rpc_pending_limit"));
      const id = randomUUID();
      const response = Promise.withResolvers<unknown>();
      const timeout = setTimeout(() => { pending.delete(id); response.reject(new Error("rpc_timeout")); }, 30000);
      pending.set(id, { resolve: response.resolve, reject: response.reject, timeout });
      void writeFrame({ ...args, type, id }).catch(error => { clearTimeout(timeout); pending.delete(id); response.reject(error); });
      return response.promise;
    };
    const activity = new OmpRpcActivity();
    const prompts = new Map<string, string>();
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (runner.successful) stdin.end();
      else processChild.kill("SIGTERM");
      control.destroy();
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const receive = (async () => {
      try {
        for await (const frame of rpcFrames(processChild.stdout!)) {
          if (frame.type === "rpc_chunk") throw new Error("rpc_frame_limit");
          if (frame.type === "rpc_frame_error") throw new Error("omp_rpc_frame_error");
          if (frame.type === "response" && typeof frame.id === "string") {
            const waiter = pending.get(frame.id);
            if (waiter) {
              clearTimeout(waiter.timeout); pending.delete(frame.id);
              if (frame.success === true) waiter.resolve(frame.data);
              else waiter.reject(new Error("omp_rpc_refused"));
            }
            else if (frame.success === false) throw new Error("omp_rpc_refused");
          } else if (frame.type === "host_tool_call") {
            if (frame.toolName !== "manifold" || typeof frame.id !== "string") throw new Error("invalid_host_tool");
            const toolId = frame.id;
            // Do not stall the child event reader while an HTTP door is running.
            void useRunner(async () => {
              emitted = []; emittedBytes = 0;
              try {
                const outcome = await dispatchOmpModelRequest(runner, frame.arguments, binding.runId, async refused => {
                  await writeFrame({ type: "host_tool_result", id: toolId, ...(refused ? { isError: true } : {}),
                    result: { content: [{ type: "text", text: refused ? "manifold_request_refused" : JSON.stringify(emitted) }], details: {} } });
                });
                if (outcome === "failed") stop();
                else if (outcome === "completed") {
                  // Send the final tool result before EOF. RPC drains pending work
                  // on EOF and exits cleanly; no post-close activity can invert it.
                  stdin.end();
                  control.destroy();
                }
              } finally { emitted = []; emittedBytes = 0; }
            }).catch(stop);
          }
          if (frame.type === "extension_ui_request") {
            if (["select", "confirm", "input", "editor"].includes(String(frame.method)) && typeof frame.id === "string") {
              prompts.set(frame.id, String(frame.method));
              process.stdout.write(`\n${String(frame.title ?? "OMP needs input")}\n`);
              if (Array.isArray(frame.options)) process.stdout.write(`${frame.options.join("\n")}\n`);
            } else if (frame.method === "cancel" && typeof frame.targetId === "string") prompts.delete(frame.targetId);
          } else if (frame.type === "agent_end" && frame.willContinue !== true) prompts.clear();
          const next = activity.consume(frame);
          if (next) void reportActivity(next).catch(stop);
          if (frame.type === "message_update") {
            const event = frame.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
            if (event?.type === "text_delta" && typeof event.delta === "string") process.stdout.write(event.delta);
          } else if (frame.type === "agent_end") process.stdout.write("\n");
        }
      } finally {
        for (const waiter of pending.values()) { clearTimeout(waiter.timeout); waiter.reject(new Error("rpc_unavailable")); }
        pending.clear();
      }
    })();
    // Attach a rejection handler immediately, including during startup negotiation.
    void receive.catch(stop);
    try {
      const checkSession = async () => {
        // get_state includes the full system prompt and can overflow OMP's 1 MiB
        // output frame when admission schemas are large. Stats carries identity only.
        const state = await request("get_session_stats") as { sessionId?: unknown; sessionFile?: unknown };
        if (state?.sessionId !== sessionId || state.sessionFile !== `${SESSIONS_ROOT}/${sessionFile}`) throw new Error("session_binding_changed");
      };
      await checkSession();
      await request("set_host_tools", { tools: [{ name: "manifold", label: "Manifold", description: "Invoke governed Manifold actions. Read the delivered policy and explicitly acknowledge its exact revision and digests before invoking actions. Credentials and session binding are harness-owned.", parameters: z.toJSONSchema(OmpModelToolInputSchema) }] });
      await reportActivity("idle");
      if (prompt) await request("prompt", { message: prompt, streamingBehavior: "steer" });
      const send = async (raw: unknown) => {
        let input = OmpSendInputSchema.parse(raw);
        const waiting = prompts.entries().next().value;
        if (input.type === "prompt" && waiting) {
          input = waiting[1] === "confirm"
            ? { type: "extension_ui_response", id: waiting[0], confirmed: /^(yes|y|true)$/i.test(input.message.trim()) }
            : { type: "extension_ui_response", id: waiting[0], value: input.message };
        }
        if (input.type === "extension_ui_response") {
          await writeFrame(input);
          if (prompts.delete(input.id)) {
            const next = activity.answer(input.id);
            if (next) await reportActivity(next);
          }
        } else await request(input.type, input.type === "abort" ? {} : { message: input.message, ...(input.type === "prompt" ? { streamingBehavior: "steer" } : {}) });
        await checkSession();
      };
      const consumeControl = (async () => { for await (const frame of rpcFrames(control, 65536)) await send(frame); })();
      void consumeControl.catch(stop);
      // The terminal remains usable for human follow-ups. These are ordinary prompts,
      // never an alternate parser for RPC commands, session identities or credentials.
      const consumeTerminal = (async () => {
        let line = "";
        for await (const chunk of process.stdin) {
          line += String(chunk);
          if (Buffer.byteLength(line) > 65536) throw new Error("terminal_input_limit");
          let newline: number;
          while ((newline = line.indexOf("\n")) >= 0) {
            const message = line.slice(0, newline).replace(/\r$/, "");
            line = line.slice(newline + 1);
            if (message) await send({ type: "prompt", message });
          }
        }
      })();
      void consumeTerminal.catch(stop);
      const code = await exit.promise;
      await receive;
      await runnerTail;
      completed = runner.closed ? runner.successful : !stopped && !controlFailed && code === 0;
      if (completed) await reportActivity("done");
    } finally {
      signal.removeEventListener("abort", stop);
      processChild.kill("SIGTERM");
      control.destroy();
    }
  } catch (error) {
    await runnerTail;
    if (!runner.successful) throw error;
    completed = true;
  } finally {
    child?.kill("SIGTERM");
    control.destroy();
    try {
      await runnerTail;
      if (runner.closed) completed = runner.successful;
      const cleanup = await runner.close(completed ? "completed" : signal.aborted ? "cancelled" : "failed");
      completed = completed && cleanup;
    } finally { admission?.close(); }
  }
  return completed;
}
