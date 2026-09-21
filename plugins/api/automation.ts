import { z } from "zod";

/** Deliberately supported native SDK tools, not a second tool registry. */
export const RESTRICTED_TOOL_NAMES = ["read", "grep", "glob", "bash", "edit", "write"] as const;
export const RestrictedAutomationSchema = z.strictObject({
  mode: z.literal("restricted"),
  toolNames: z.array(z.enum(RESTRICTED_TOOL_NAMES)).max(RESTRICTED_TOOL_NAMES.length)
    .refine(names => new Set(names).size === names.length, "duplicate restricted tool"),
  delegation: z.literal("disabled").describe("Disables OMP task/advisor spawning, not operating-system subprocess authority granted to a shell tool."),
});
export const AutomationReviewSchema = z.union([
  z.strictObject({ mode: z.literal("ordinary") }), RestrictedAutomationSchema,
]);
export type RestrictedAutomation = z.infer<typeof RestrictedAutomationSchema>;
