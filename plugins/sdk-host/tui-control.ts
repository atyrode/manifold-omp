import { randomUUID } from "node:crypto";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent";
import { TuiParentMessageSchema, type TuiActivityFrame, type TuiChildMessage } from "../tui-control-ipc.ts";

type Session = CreateAgentSessionResult["session"];
type SetToolUIContext = CreateAgentSessionResult["setToolUIContext"];
type UIContext = Parameters<SetToolUIContext>[0];

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

/** The terminal stays the operator's. The parent may turn only the reviewed dials and
 * observe activity; it never reads or writes terminal bytes. */
export function attachTuiControl(session: Session, setToolUIContext: SetToolUIContext, stop: () => void): TuiControl {
  if (!process.send || !process.connected) throw new Error("omp_sdk_control_unavailable");
  const send = (message: TuiChildMessage) => {
    try {
      if (!process.send || !process.connected) { stop(); return; }
      process.send(message, (error: Error | null) => { if (error) stop(); });
    } catch { stop(); }
  };
  const activity = (frame: TuiActivityFrame) => send({ type: "tui_event", frame });
  const unsubscribe = session.subscribe(event => {
    if (!Object.hasOwn(forwarded, event.type)) return;
    activity(event.type === "agent_end" ? { type: "agent_end", willContinue: event.willContinue === true }
      : { type: event.type as Exclude<TuiActivityFrame["type"], "agent_end" | "extension_ui_request"> });
  });
  // Ordered: a thinking dial sent after a model dial applies to the new model.
  let tail = Promise.resolve();
  const receive = (raw: unknown) => {
    const parsed = TuiParentMessageSchema.safeParse(raw);
    if (!parsed.success) { stop(); return; }
    const { id, command } = parsed.data;
    tail = tail.then(async () => {
      try {
        if (command.type === "set_model") {
          const { provider, modelId } = command;
          // Discovery-backed providers may still be listing; never select outside the served set.
          if (!session.getAvailableModels().some(model => model.provider === provider && model.id === modelId))
            await session.modelRegistry.awaitBackgroundRefresh();
          const model = session.getAvailableModels().find(model => model.provider === provider && model.id === modelId);
          if (!model) throw new Error("omp_sdk_model_unavailable");
          await session.setModel(model);
        } else if (command.type === "set_thinking_level") {
          session.setThinkingLevel(command.level);
        } else {
          // Admission only: the turn renders in the TUI like typed input and settles there.
          void session.prompt(command.message, { streamingBehavior: "followUp" }).catch(() => {});
        }
        const current = session.model;
        const thinking = session.configuredThinkingLevel();
        send({ type: "tui_result", id, ok: true,
          ...(current ? { model: `${current.provider}/${current.id}` } : {}), ...(thinking ? { thinking } : {}) });
      } catch {
        send({ type: "tui_result", id, ok: false });
      }
    });
  };
  process.on("message", receive);
  process.once("disconnect", stop);
  return {
    setToolUIContext: (ui: UIContext, hasUI: boolean) => setToolUIContext(observeDialogs(ui, activity), hasUI),
    ready: () => send({ type: "tui_ready" }),
    close() {
      unsubscribe();
      process.off("message", receive);
      process.off("disconnect", stop);
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
