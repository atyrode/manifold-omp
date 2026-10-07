import { z } from "zod";
import { ControlRunInputSchema, RunDialsSchema, ThinkingSelectorSchema, type RunDials } from "../../api/index.ts";

/** A live dial change that `atyrode.omp.controlRun` writes to a harness Run's private control
 * descriptor. It names only the reviewed dials, never a session, path or credential. */
export const RunControlFrameSchema = z.strictObject({
  type: z.literal("control"),
  // Lowercase: the id names the progress stage that answers it.
  id: z.uuid().regex(/^[0-9a-f-]{36}$/),
  model: ControlRunInputSchema.shape.model,
  thinking: ControlRunInputSchema.shape.thinking,
}).refine(value => value.model !== undefined || value.thinking !== undefined, "empty run control");
export type RunControlFrame = z.infer<typeof RunControlFrameSchema>;

export const RunControlRefusalSchema = z.enum(["model_unavailable", "session_unavailable", "unsupported"]);
export type RunControlOutcome =
  | { ok: true; dials: RunDials }
  | { ok: false; reason: z.infer<typeof RunControlRefusalSchema> };

/** The session's dials as a reply can carry them: an unreportable value reads null, never truncated. */
export function sessionDials(model: { provider: string; id: string } | undefined, thinking: string | undefined): RunDials {
  const reference = model ? `${model.provider}/${model.id}` : undefined;
  return {
    model: reference !== undefined && RunDialsSchema.shape.model.safeParse(reference).success ? reference : null,
    thinking: ThinkingSelectorSchema.safeParse(thinking).data ?? null,
  };
}

/**
 * Job input is one-way, so the outcome rides the job's progress, the one channel from a running
 * native job back to its plugin's doors. The stage names the frame it answers; the owner keeps
 * only the newest line per window, so the door that wrote the frame waits for its own stage.
 */
export function controlProgress(id: string, outcome: RunControlOutcome): { stage: string; message: string } {
  return {
    stage: `control ${id}`,
    message: outcome.ok
      ? `applied ${outcome.dials.thinking ?? "-"} ${outcome.dials.model ?? "-"}`
      : `refused ${outcome.reason}`,
  };
}

/** Null is a reply this module did not write: the change is unconfirmed, never guessed. */
export function readControlProgress(message: string | undefined): RunControlOutcome | null {
  const refused = /^refused ([a-z_]+)$/.exec(message ?? "");
  if (refused) {
    const reason = RunControlRefusalSchema.safeParse(refused[1]);
    return reason.success ? { ok: false, reason: reason.data } : null;
  }
  const applied = /^applied (\S+) (\S+)$/.exec(message ?? "");
  if (!applied) return null;
  const dials = RunDialsSchema.safeParse({
    thinking: applied[1] === "-" ? null : applied[1],
    model: applied[2] === "-" ? null : applied[2],
  });
  return dials.success ? { ok: true, dials: dials.data } : null;
}
