import { AgentToolReplySchema, AgentToolRequestSchema } from "@manifold/protocol";
import { z } from "zod";

// The native parent alone owns WorkerContext. This private child channel carries
// only the already-bound host messages, never an identity selector or credential.
export const AgentToolChildMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("agent_tool_call"),
    id: z.uuid(),
    request: AgentToolRequestSchema,
  }),
  z.strictObject({ type: z.literal("agent_tool_cancel"), id: z.uuid() }),
]);
export type AgentToolChildMessage = z.infer<typeof AgentToolChildMessageSchema>;

export const AgentToolParentMessageSchema = z.strictObject({
  type: z.literal("agent_tool_result"),
  id: z.uuid(),
  reply: AgentToolReplySchema,
});
export type AgentToolParentMessage = z.infer<typeof AgentToolParentMessageSchema>;
