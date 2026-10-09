import { randomUUID } from "node:crypto";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { RunModelSchema } from "@manifold/protocol";
import { sessionDials, type RunControlOutcome } from "../workers/harness/control.ts";
import {
  TuiParentMessageSchema, type TuiActivityFrame, type TuiChildMessage, type TuiCommand,
} from "../tui-control-ipc.ts";

type Session = CreateAgentSessionResult["session"];
type SetToolUIContext = CreateAgentSessionResult["setToolUIContext"];
type UIContext = Parameters<SetToolUIContext>[0];
/** All the parent can reach: the main agent's dials, operator-equivalent prompts, event names. */
export type TuiSession = Pick<Session, "subscribe" | "getAvailableModels" | "setModel" | "setThinkingLevel" |
  "configuredThinkingLevel" | "prompt" | "model"> & { readonly modelRegistry: Pick<Session["modelRegistry"], "awaitBackgroundRefresh"> };

export interface TuiChannel {
  send(message: TuiChildMessage): void;
  /** Returns the unsubscribe. */
  listen(receive: (raw: unknown) => void): () => void;
}

const forwarded: Readonly<Record<string, true>> = { agent_start: true, agent_end: true, auto_compaction_start: true,
  auto_compaction_end: true, auto_retry_start: true, auto_retry_end: true };
// Every operator dialog a tool can open in the stock TUI. `askDialog` is the rich `ask` selector.
const dialogs: Readonly<Record<string, "select" | "confirm" | "input" | "editor">> =
  { select: "select", confirm: "confirm", input: "input", editor: "editor", askDialog: "select" };

export interface TuiControl {
  setToolUIContext: SetToolUIContext;
  ready(): void;
  close(): void;
}

/** The IPC channel Bun opens when the harness wrapper spawns this child with an `ipc` slot. */
export function parentChannel(stop: () => void): TuiChannel {
  if (!process.send || !process.connected) throw new Error("omp_sdk_control_unavailable");
  return {
    send(message) {
      try {
        if (!process.send || !process.connected) { stop(); return; }
        process.send(message, (error: Error | null) => { if (error) stop(); });
      } catch { stop(); }
    },
    listen(receive) {
      process.on("message", receive);
      process.once("disconnect", stop);
      return () => { process.off("message", receive); process.off("disconnect", stop); };
    },
  };
}

/** The terminal stays the operator's. The parent turns only the main agent's reviewed dials, adds
 * prompts as if typed, and observes activity and the model the session serves; it never reads or
 * writes terminal bytes. */
export function attachTuiControl(session: TuiSession, setToolUIContext: SetToolUIContext, channel: TuiChannel, stop: () => void): TuiControl {
  const activity = (frame: TuiActivityFrame) => channel.send({ type: "tui_event", frame });
  // Once per change of the main agent's model, whatever changed it: a dial, the operator's own
  // selector or a retry fallback. A model `Run.model` cannot carry is not sent.
  let served: string | undefined;
  const serve = () => {
    const model = RunModelSchema.safeParse(session.model && { provider: session.model.provider, model: session.model.id });
    const key = model.success ? JSON.stringify(model.data) : undefined;
    if (!model.success || key === served) return;
    served = key;
    channel.send({ type: "tui_model", model: model.data });
  };
  const unsubscribe = session.subscribe(event => {
    if (event.type === "model_changed") serve();
    if (!Object.hasOwn(forwarded, event.type)) return;
    activity(event.type === "agent_end" ? { type: "agent_end", willContinue: event.isTerminal === false }
      : { type: event.type as Exclude<TuiActivityFrame["type"], "agent_end" | "extension_ui_request"> });
  });
  const apply = async (command: TuiCommand): Promise<RunControlOutcome> => {
    if (command.type === "prompt") {
      // Admission only: the turn renders in the TUI like typed input and settles there.
      void session.prompt(command.message, { streamingBehavior: command.streamingBehavior }).catch(() => {});
    } else {
      if (command.model !== undefined) {
        const separator = command.model.indexOf("/");
        const provider = command.model.slice(0, separator);
        const id = command.model.slice(separator + 1);
        const requested = (model: { provider: string; id: string }) => model.provider === provider && model.id === id;
        // Discovery-backed providers may still be listing; never select outside the served set.
        let model = session.getAvailableModels().find(requested);
        if (!model) {
          await session.modelRegistry.awaitBackgroundRefresh();
          model = session.getAvailableModels().find(requested);
        }
        if (!model) return { ok: false, reason: "model_unavailable" };
        try { await session.setModel(model); }
        catch { return { ok: false, reason: "model_unavailable" }; }
      }
      if (command.thinking !== undefined) {
        const thinking = parseConfiguredThinkingLevel(command.thinking);
        if (thinking === undefined) throw new Error("omp_sdk_thinking_invalid");
        // The session clamps it to the model, as the TUI's own selector does; the reply says what applied.
        session.setThinkingLevel(thinking);
      }
    }
    return { ok: true, dials: sessionDials(session.model, session.configuredThinkingLevel()) };
  };
  // Ordered: a thinking change after a model change applies to the new model.
  let tail = Promise.resolve();
  const stopListening = channel.listen(raw => {
    const parsed = TuiParentMessageSchema.safeParse(raw);
    if (!parsed.success) { stop(); return; }
    const { id, command } = parsed.data;
    tail = tail.then(() => apply(command)).then(
      outcome => channel.send({ type: "tui_result", id, outcome }),
      () => channel.send({ type: "tui_result", id, outcome: { ok: false, reason: "session_unavailable" } }));
  });
  return {
    setToolUIContext: (ui: UIContext, hasUI: boolean) => setToolUIContext(observeDialogs(ui, activity), hasUI),
    ready() {
      channel.send({ type: "tui_ready" });
      serve();
    },
    close() {
      unsubscribe();
      stopListening();
    },
  };
}

/** A pending operator dialog is the only `blocked` signal; its bytes never leave the TUI. */
function observeDialogs(ui: UIContext, activity: (frame: TuiActivityFrame) => void): UIContext {
  return new Proxy(ui, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      const method = typeof property === "string" && Object.hasOwn(dialogs, property) ? dialogs[property] : undefined;
      if (!method || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const id = randomUUID();
        activity({ type: "extension_ui_request", method, id });
        try { return await value.apply(target, args); }
        finally { activity({ type: "extension_ui_request", method: "cancel", targetId: id }); }
      };
    },
  });
}
