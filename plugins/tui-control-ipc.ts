import { z } from "zod";
import { RunModelSchema } from "@manifold/protocol";
import { ControlRunInputSchema, RunDialsSchema } from "./api/index.ts";
import { RunControlRefusalSchema } from "./workers/harness/control.ts";

// The private channel between the TUI harness wrapper and its SDK child. The wrapper alone holds
// the Run credential and the control descriptor. This channel carries only the reviewed dials,
// the model the session serves, operator-equivalent prompts and activity-relevant event names:
// never transcript bytes, terminal input, session identities, paths or credentials.
export const TuiCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("control"), model: ControlRunInputSchema.shape.model, thinking: ControlRunInputSchema.shape.thinking }),
  z.strictObject({ type: z.literal("prompt"), message: z.string().min(1).max(16384), streamingBehavior: z.enum(["steer", "followUp"]) }),
]);
export type TuiCommand = z.infer<typeof TuiCommandSchema>;

export const TuiParentMessageSchema = z.strictObject({ type: z.literal("tui_command"), id: z.uuid(), command: TuiCommandSchema });
export type TuiParentMessage = z.infer<typeof TuiParentMessageSchema>;

/** Shaped exactly as the RPC frames `OmpRpcActivity` already consumes. */
export const TuiActivityFrameSchema = z.union([
  z.strictObject({ type: z.enum(["agent_start", "auto_compaction_start", "auto_compaction_end", "auto_retry_start", "auto_retry_end"]) }),
  z.strictObject({ type: z.literal("agent_end"), willContinue: z.boolean() }),
  z.strictObject({ type: z.literal("extension_ui_request"), method: z.enum(["select", "confirm", "input", "editor"]), id: z.uuid() }),
  z.strictObject({ type: z.literal("extension_ui_request"), method: z.literal("cancel"), targetId: z.uuid() }),
]);
export type TuiActivityFrame = z.infer<typeof TuiActivityFrameSchema>;

export const TuiChildMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("tui_ready") }),
  /** The model the session serves, sent once per change: Manifold's `Run.model` shape. */
  z.strictObject({ type: z.literal("tui_model"), model: RunModelSchema }),
  z.strictObject({ type: z.literal("tui_event"), frame: TuiActivityFrameSchema }),
  z.strictObject({ type: z.literal("tui_result"), id: z.uuid(), outcome: z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), dials: RunDialsSchema }),
    z.strictObject({ ok: z.literal(false), reason: RunControlRefusalSchema }),
  ]) }),
]);
export type TuiChildMessage = z.infer<typeof TuiChildMessageSchema>;
