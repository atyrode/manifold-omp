import { z } from "zod";
import type { ModelRegistry, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { parseConfiguredThinkingLevel, resolveThinkingLevelForModel } from "@oh-my-pi/pi-tui/thinking";
import { exactModelScope, OverlaySchema, type ActionInput, type Overlay } from "../api/index.ts";
import { ProbeConfigSchema } from "../workers/probe/inputs.ts";

/** The sealed session settings: native runtime settings, the reviewed overlay, the reviewed skill
 * choice and, for a one-shot, a startup scope that names exactly the configured model. */
export const SdkSessionConfigSchema = ProbeConfigSchema.extend(OverlaySchema.shape).extend({
  skills: z.union([
    z.strictObject({ enabled: z.literal(false) }),
    z.strictObject({ customDirectories: z.array(z.string()).max(15) }),
  ]).optional(),
  enabledModels: z.tuple([z.string()]).optional(),
}).refine(config => config.enabledModels === undefined ||
  config.enabledModels[0] === exactModelScope(config.modelRoles?.default ?? ""));

/** No SDK default/fuzzy/fallback model selection is allowed across explicit resume. */
export function admitSdkSession(registry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">,
  manager: SessionManager | undefined, overlay: Overlay, overrides: ActionInput<"resumeSession">["overrides"]) {
  const context = manager?.buildSessionContext();
  const entries = manager?.getBranch();
  const lastRole = manager?.getLastModelChangeRole();
  const role = !lastRole || lastRole === EPHEMERAL_MODEL_CHANGE_ROLE ? "default" : lastRole;
  if (context && overrides?.model === undefined &&
    !entries!.some(entry => entry.type === "model_change" && (entry.role ?? "default") === role && entry.model === context.models[role]))
    throw new Error("omp_resume_model_missing");
  const selector = overrides?.model ?? (context ? context.models[role] : overlay.modelRoles?.default);
  if (!selector) throw new Error("omp_resume_model_missing");
  const selected = parseModelString(selector, {
    allowMaxSuffix: true, allowAutoAlias: false,
    isLiteralModelId: (provider, id) => registry.find(provider, id) !== undefined,
  });
  if (!selected) throw new Error("omp_resume_model_ambiguous");
  const model = registry.find(selected.provider, selected.id);
  if (!model || !registry.hasConfiguredAuth(model)) throw new Error("omp_resume_model_unavailable");
  const explicitThinking = overrides?.thinking ?? (overrides?.model ? selected.thinkingLevel : undefined);
  const configured = explicitThinking ?? (context
    ? context.configuredThinkingLevel ?? context.thinkingLevel
    : selected.thinkingLevel ?? overlay.defaultThinkingLevel ?? "off");
  if (context && explicitThinking === undefined &&
    !entries!.some(entry => entry.type === "thinking_level_change"))
    throw new Error("omp_resume_thinking_missing");
  const thinking = parseConfiguredThinkingLevel(configured);
  if (thinking === undefined || thinking !== configured || (thinking !== "auto" && resolveThinkingLevelForModel(model, thinking) !== thinking))
    throw new Error("omp_resume_thinking_incompatible");
  return { model, thinkingLevel: thinking };
}
