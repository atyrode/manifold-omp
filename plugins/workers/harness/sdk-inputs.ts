import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { z } from "zod";
import { AgentToolsSelectionSchema, AutomationReviewSchema, OmpSessionRefSchema, ResumeSessionInputSchema } from "../../api/index.ts";

// The host generates the session identity after review. It is sealed beside the
// ordinary policy, not accepted as a public profile or model-supplied selector.
const nativeAutomation = z.union([
  AutomationReviewSchema.options[0].extend({
    agentTools: AgentToolsSelectionSchema.extend({ sessionId: OmpSessionRefSchema.shape.sessionId }).optional(),
  }),
  AutomationReviewSchema.options[1],
]);

export function readSessionInput(name: "automation" | "resumeOverrides" | "prompt" | "sessionId", limit = 65536): string {
  const fd = openSync(`/inputs/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || (stat.mode & 0o222) !== 0) throw new Error("omp_sdk_input_invalid");
    const bytes = Buffer.alloc(stat.size + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== stat.size) throw new Error("omp_sdk_input_changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
  } finally { closeSync(fd); }
}
export function readAutomation() {
  return nativeAutomation.parse(JSON.parse(readSessionInput("automation", 4096)));
}
export function readResumeOverrides() {
  const value: unknown = JSON.parse(readSessionInput("resumeOverrides", 4096));
  if (z.strictObject({}).safeParse(value).success) return undefined;
  return ResumeSessionInputSchema.shape.overrides.parse(value);
}
