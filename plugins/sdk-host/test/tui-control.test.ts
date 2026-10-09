import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent";
import { attachTuiControl, type TuiChannel, type TuiSession } from "../tui-control.ts";
import { TuiChildMessageSchema, type TuiActivityFrame, type TuiChildMessage, type TuiCommand } from "../../tui-control-ipc.ts";

type Model = { provider: string; id: string };
type SetToolUIContext = CreateAgentSessionResult["setToolUIContext"];
type UIContext = Parameters<SetToolUIContext>[0];
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** The main agent's session as the TUI holds it. Discovery-backed models appear only after a
 * background refresh, thinking clamps to `high` the way a model without `xhigh` clamps it, and a
 * selection that changes the model emits `model_changed`, as `AgentSession` does. */
function sessionFixture(options: {
  discovered?: Model[];
  refresh?: Promise<void>;
  prompt?: () => Promise<void>;
  closed?: boolean;
} = {}) {
  const served = [{ provider: "openai", id: "gpt-5" }];
  const calls: string[] = [];
  let listener: ((event: { type: string; isTerminal?: boolean }) => void) | undefined;
  let refreshed = false;
  let model: Model | undefined = served[0];
  let thinking: string | undefined = "low";
  const fixture = {
    subscribe(receive: typeof listener) { listener = receive; return () => { listener = undefined; }; },
    getAvailableModels: () => refreshed ? [...served, ...options.discovered ?? []] : served,
    modelRegistry: { async awaitBackgroundRefresh() { calls.push("refresh"); await options.refresh; refreshed = true; } },
    async setModel(next: Model) {
      calls.push(`model ${next.provider}/${next.id}`);
      const changed = model?.provider !== next.provider || model.id !== next.id;
      model = next;
      if (changed) listener?.({ type: "model_changed" });
    },
    setThinkingLevel(level: string) {
      if (options.closed) throw new Error("fixture-session-closed");
      calls.push(`thinking ${level}`);
      thinking = levels.indexOf(level) > levels.indexOf("high") ? "high" : level;
    },
    configuredThinkingLevel: () => thinking,
    prompt(message: string, prompt: { streamingBehavior: string }) {
      calls.push(`prompt ${prompt.streamingBehavior} ${message}`);
      return options.prompt?.() ?? Promise.resolve();
    },
    get model() { return model; },
  };
  // Only the members `TuiSession` picks are implemented.
  const session = fixture as unknown as TuiSession;
  return { session, calls, emit: (event: { type: string; isTerminal?: boolean }) => listener?.(event),
    subscribed: () => listener !== undefined,
    /** The operator's own selector, or a retry fallback: the session changes model with no dial. */
    select: (next: Model) => fixture.setModel(next) };
}

/** The child's side of the private IPC channel, as the wrapper drives it. Every frame the child
 * sends must parse as the wire schema the wrapper reads. */
function attached(session: TuiSession, setToolUIContext: SetToolUIContext = () => {}) {
  const sent: TuiChildMessage[] = [];
  let receive: ((raw: unknown) => void) | undefined;
  let stopped = 0;
  const channel: TuiChannel = {
    send(message) { sent.push(TuiChildMessageSchema.parse(message)); },
    listen(next) { receive = next; return () => { receive = undefined; }; },
  };
  const control = attachTuiControl(session, setToolUIContext, channel, () => { stopped++; });
  const command = (value: TuiCommand) => {
    const id = randomUUID();
    receive?.({ type: "tui_command", id, command: value });
    return id;
  };
  return {
    control, sent, command,
    deliver: (raw: unknown) => receive?.(raw),
    results: () => sent.flatMap(message => message.type === "tui_result" ? [message] : []),
    events: () => sent.flatMap(message => message.type === "tui_event" ? [message.frame] : []),
    listening: () => receive !== undefined,
    stopped: () => stopped,
  };
}

/** A dialog's opening request, whose id its closing request must name. */
function openedId(frame: TuiActivityFrame | undefined): string {
  if (frame?.type !== "extension_ui_request" || frame.method === "cancel") throw new Error("dialog request missing");
  return frame.id;
}

test("a model dial selects only a model the session serves, after one refresh for a provider still listing", async () => {
  const session = sessionFixture({ discovered: [{ provider: "openai", id: "o3" }] });
  const tui = attached(session.session);
  const listed = tui.command({ type: "control", model: "openai/o3" });
  await settle();
  expect(tui.results()).toEqual([{ type: "tui_result", id: listed, outcome: { ok: true, dials: { model: "openai/o3", thinking: "low" } } }]);
  expect(session.calls).toEqual(["refresh", "model openai/o3"]);
  // A model of the same id under another provider, or one nobody serves, is refused and changes
  // nothing, the thinking it came with included.
  session.calls.length = 0;
  const foreign = tui.command({ type: "control", model: "anthropic/o3", thinking: "high" });
  const unserved = tui.command({ type: "control", model: "openai/not-served" });
  await settle();
  expect(tui.results().slice(1)).toEqual([
    { type: "tui_result", id: foreign, outcome: { ok: false, reason: "model_unavailable" } },
    { type: "tui_result", id: unserved, outcome: { ok: false, reason: "model_unavailable" } },
  ]);
  expect(session.calls).toEqual(["refresh", "refresh"]);
  // A served model needs no refresh.
  session.calls.length = 0;
  tui.command({ type: "control", model: "openai/gpt-5" });
  await settle();
  expect(session.calls).toEqual(["model openai/gpt-5"]);
});

test("dials apply one command at a time and in order, and reply with the dials the session reports", async () => {
  const refresh = Promise.withResolvers<void>();
  const session = sessionFixture({ discovered: [{ provider: "openai", id: "o3" }], refresh: refresh.promise });
  const tui = attached(session.session);
  const model = tui.command({ type: "control", model: "openai/o3" });
  // Delivered while the model waits on discovery: it must apply to the new model, not before it.
  const thinking = tui.command({ type: "control", thinking: "xhigh" });
  await settle();
  expect(session.calls).toEqual(["refresh"]);
  expect(tui.results()).toEqual([]);
  refresh.resolve();
  await settle();
  expect(session.calls).toEqual(["refresh", "model openai/o3", "thinking xhigh"]);
  // The session clamped the level to the model; the reply says what applied, not what was asked.
  expect(tui.results()).toEqual([
    { type: "tui_result", id: model, outcome: { ok: true, dials: { model: "openai/o3", thinking: "low" } } },
    { type: "tui_result", id: thinking, outcome: { ok: true, dials: { model: "openai/o3", thinking: "high" } } },
  ]);
  session.calls.length = 0;
  for (const selector of ["off", "auto"] as const) tui.command({ type: "control", thinking: selector });
  await settle();
  expect(session.calls).toEqual(["thinking off", "thinking auto"]);
  expect(tui.results().at(-1)?.outcome).toEqual({ ok: true, dials: { model: "openai/o3", thinking: "auto" } });
});

test("the session's model reaches the wrapper at ready and once per change, whatever changed it", async () => {
  const session = sessionFixture({ discovered: [{ provider: "openai", id: "o3" }] });
  const tui = attached(session.session);
  const sent = () => tui.sent.map(message => message.type === "tui_model" ? `model ${message.model.provider}/${message.model.model}` : message.type);
  expect(sent()).toEqual([]);
  tui.control.ready();
  expect(tui.sent).toEqual([{ type: "tui_ready" }, { type: "tui_model", model: { provider: "openai", model: "gpt-5" } }]);
  // A dial's switch is sent before the reply that confirms it; a dial that keeps the model sends none.
  tui.command({ type: "control", model: "openai/o3" });
  tui.command({ type: "control", model: "openai/o3", thinking: "high" });
  await settle();
  expect(sent().slice(2)).toEqual(["model openai/o3", "tui_result", "tui_result"]);
  // The operator's own selector is a change too; the same selector rebound after discovery is not.
  await session.select({ provider: "openai", id: "gpt-5" });
  session.emit({ type: "model_changed" });
  // A model `Run.model` cannot carry is not sent, and the next one that it can is.
  await session.select({ provider: "openai", id: "m".repeat(257) });
  await session.select({ provider: "openai", id: "o3" });
  expect(sent().slice(5)).toEqual(["model openai/gpt-5", "model openai/o3"]);
});

test("a session that cannot apply a dial answers unavailable, and the next command still applies", async () => {
  const tui = attached(sessionFixture({ closed: true }).session);
  const refused = tui.command({ type: "control", thinking: "high" });
  const next = tui.command({ type: "control", model: "openai/gpt-5" });
  await settle();
  expect(tui.results()).toEqual([
    { type: "tui_result", id: refused, outcome: { ok: false, reason: "session_unavailable" } },
    { type: "tui_result", id: next, outcome: { ok: true, dials: { model: "openai/gpt-5", thinking: "low" } } },
  ]);
});

test("a prompt enters as the operator's own follow-up or steer, and its turn never fails the channel", async () => {
  const session = sessionFixture({ prompt: () => Promise.reject(new Error("fixture-turn-failed")) });
  const tui = attached(session.session);
  tui.command({ type: "prompt", message: "FOLLOW-UP", streamingBehavior: "followUp" });
  tui.command({ type: "prompt", message: "STEER", streamingBehavior: "steer" });
  await settle();
  expect(session.calls).toEqual(["prompt followUp FOLLOW-UP", "prompt steer STEER"]);
  expect(tui.results().map(result => result.outcome.ok)).toEqual([true, true]);
  expect(tui.stopped()).toBe(0);
});

test("a message outside the channel's schema stops the session and applies nothing", async () => {
  for (const raw of [
    { type: "tui_command", id: "not-a-uuid", command: { type: "control", thinking: "high" } },
    { type: "tui_command", id: randomUUID(), command: { type: "control", thinking: "high", sessionId: randomUUID() } },
    { type: "tui_command", id: randomUUID(), command: { type: "set_model", provider: "openai", modelId: "o3" } },
    { type: "tui_command", id: randomUUID(), command: { type: "prompt", message: "x", streamingBehavior: "now" } },
  ]) {
    const session = sessionFixture();
    const tui = attached(session.session);
    tui.deliver(raw);
    await settle();
    expect(tui.stopped()).toBe(1);
    expect(session.calls).toEqual([]);
    expect(tui.results()).toEqual([]);
  }
});

test("activity forwards only lifecycle event names, and an agent end continues only when the session says so", () => {
  const session = sessionFixture();
  const tui = attached(session.session);
  for (const event of [
    { type: "agent_start" }, { type: "message_update" }, { type: "tool_execution_start" }, { type: "model_changed" },
    { type: "agent_end", isTerminal: false }, { type: "agent_end", isTerminal: true }, { type: "agent_end" },
    { type: "auto_retry_start" }, { type: "auto_retry_end" }, { type: "auto_compaction_start" }, { type: "auto_compaction_end" },
  ]) session.emit(event);
  expect(tui.events()).toEqual([
    { type: "agent_start" },
    { type: "agent_end", willContinue: true }, { type: "agent_end", willContinue: false }, { type: "agent_end", willContinue: false },
    { type: "auto_retry_start" }, { type: "auto_retry_end" }, { type: "auto_compaction_start" }, { type: "auto_compaction_end" },
  ]);
  tui.control.ready();
  expect(tui.sent.at(-1)).toEqual({ type: "tui_ready" });
  // Closing releases both directions: nothing more is forwarded or received.
  tui.control.close();
  session.emit({ type: "agent_start" });
  expect(tui.sent.at(-1)).toEqual({ type: "tui_ready" });
  expect(session.subscribed()).toBe(false);
  expect(tui.listening()).toBe(false);
});

test("an operator dialog reports blocked for exactly its duration, and its question and answer never leave the TUI", async () => {
  const answer = Promise.withResolvers<string>();
  const notify = () => {};
  // The dialogs the stock TUI implements, plus one member that is not a dialog.
  const ui = {
    select: () => answer.promise,
    confirm: async () => true,
    input: async () => { throw new Error("fixture-dialog-dismissed"); },
    editor: async () => "EDITED-SECRET",
    askDialog: async () => "ASKED-SECRET",
    notify,
  } as unknown as UIContext;
  let installed: UIContext | undefined;
  const tui = attached(sessionFixture().session, (context, hasUI) => { expect(hasUI).toBe(true); installed = context; });
  tui.control.setToolUIContext(ui, true);
  if (!installed) throw new Error("UI context not installed");
  expect(installed.notify).toBe(notify);
  const pending = installed.select("QUESTION-SECRET", []);
  const opened = openedId(tui.events()[0]);
  expect(tui.events()).toEqual([{ type: "extension_ui_request", method: "select", id: opened }]);
  answer.resolve("ANSWER-SECRET");
  expect(await pending).toBe("ANSWER-SECRET");
  expect(tui.events()[1]).toEqual({ type: "extension_ui_request", method: "cancel", targetId: opened });
  expect(await installed.confirm("QUESTION-SECRET", "")).toBe(true);
  await expect(installed.input("QUESTION-SECRET")).rejects.toThrow("fixture-dialog-dismissed");
  expect(await installed.editor("QUESTION-SECRET")).toBe("EDITED-SECRET");
  const asked: unknown = await installed.askDialog?.([]);
  expect(asked).toBe("ASKED-SECRET");
  // Each dialog opens and closes its own request, a dismissed one included; `askDialog` is a select.
  const requests = tui.events().slice(2);
  expect(requests.map(frame => "method" in frame ? frame.method : frame.type)).toEqual(
    ["confirm", "cancel", "input", "cancel", "editor", "cancel", "select", "cancel"]);
  for (let index = 0; index < requests.length; index += 2)
    expect(requests[index + 1]).toEqual({ type: "extension_ui_request", method: "cancel", targetId: openedId(requests[index]) });
  expect(JSON.stringify(tui.sent)).not.toMatch(/SECRET/);
});
