import { z } from "zod";
import { ThinkingLevelSchema } from "./api/contracts.ts";

// Private channel between a TUI harness wrapper and its SDK child. The wrapper alone
// holds the Run credential and the control descriptor. This channel carries only the
// reviewed live dials and activity-relevant event names: never transcript bytes,
// terminal input, session identities, paths or credentials.
export const TuiThinkingSchema = z.union([ThinkingLevelSchema, z.literal("off"), z.literal("auto")]);
export const TuiControlCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("set_model"), provider: z.string().min(1).max(128), modelId: z.string().min(1).max(512) }),
  z.strictObject({ type: z.literal("set_thinking_level"), level: TuiThinkingSchema }),
  z.strictObject({ type: z.literal("prompt"), message: z.string().min(1).max(16384) }),
]);
export type TuiControlCommand = z.infer<typeof TuiControlCommandSchema>;

export const TuiParentMessageSchema = z.strictObject({ type: z.literal("tui_control"), id: z.uuid(), command: TuiControlCommandSchema });
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
  z.strictObject({ type: z.literal("tui_event"), frame: TuiActivityFrameSchema }),
  z.strictObject({
    type: z.literal("tui_result"), id: z.uuid(), ok: z.boolean(),
    model: z.string().max(1024).optional(), thinking: z.string().max(32).optional(),
  }),
]);
export type TuiChildMessage = z.infer<typeof TuiChildMessageSchema>;
