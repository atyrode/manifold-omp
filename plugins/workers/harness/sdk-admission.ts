import type { ModelRegistry, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { parseConfiguredThinkingLevel, resolveThinkingLevelForModel } from "@oh-my-pi/pi-tui/thinking";
import type { ActionInput, Overlay } from "../../api/index.ts";

/** No SDK default/fuzzy/fallback model selection is allowed across explicit resume. */
export function admitSdkSession(registry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">,
  manager: SessionManager | undefined, overlay: Overlay, overrides: ActionInput<"resumeSession">["overrides"]) {
  const context = manager?.buildSessionContext();
  const lastRole = manager?.getLastModelChangeRole();
  const role = !lastRole || lastRole === EPHEMERAL_MODEL_CHANGE_ROLE ? "default" : lastRole;
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
    !manager!.getBranch().some(entry => entry.type === "thinking_level_change"))
    throw new Error("omp_resume_thinking_missing");
  const thinking = parseConfiguredThinkingLevel(configured);
  if (thinking === undefined || thinking !== configured || thinking === "auto" || resolveThinkingLevelForModel(model, thinking) !== thinking)
    throw new Error("omp_resume_thinking_incompatible");
  return { model, thinkingLevel: thinking };
}
