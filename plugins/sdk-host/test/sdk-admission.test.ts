import { expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelRoleValue, resolveModelScope } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { exactModelScope } from "../../api/index.ts";
import { admitSdkSession, SdkSessionConfigSchema } from "../sdk-admission.ts";

const listed = (provider: string, id: string): Model => buildModel({
  provider, id, name: id, api: "openai-completions", baseUrl: "http://127.0.0.1:1",
  reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const model = listed("fixture", "saved");
const replacement = { ...model, id: "replacement" };
const registry = {
  find: (provider: string, id: string) => provider !== "fixture" ? undefined :
    id === model.id ? model : id === replacement.id ? replacement : undefined,
  hasConfiguredAuth: () => true,
};

test("resume preserves persisted fields against current defaults and overrides only the named field", async () => {
  const manager = SessionManager.inMemory("/fixture");
  manager.appendModelChange("fixture/saved");
  manager.appendThinkingLevelChange("off", "off");
  const defaults = { modelRoles: { default: "fixture/replacement" }, defaultThinkingLevel: "high" as const };
  try {
    expect(admitSdkSession(registry, manager, defaults, undefined)).toEqual({ model, thinkingLevel: "off" });
    expect(admitSdkSession(registry, manager, defaults, { model: "fixture/replacement" }))
      .toEqual({ model: replacement, thinkingLevel: "off" });
    expect(() => admitSdkSession(registry, manager, defaults, { model: "fixture/replacement:high" }))
      .toThrow("omp_resume_thinking_incompatible");
    expect(admitSdkSession(registry, manager, defaults, { model: "fixture/replacement:high", thinking: "off" }))
      .toEqual({ model: replacement, thinkingLevel: "off" });
    manager.appendThinkingLevelChange("high", "high");
    expect(admitSdkSession(registry, manager, defaults, { thinking: "off" }))
      .toEqual({ model, thinkingLevel: "off" });
    expect(() => admitSdkSession(registry, manager, defaults, { model: "fixture/replacement" }))
      .toThrow("omp_resume_thinking_incompatible");
    manager.appendThinkingLevelChange("off", "off");
    manager.appendModelChange("fixture/replacement", "fallback", true);
    expect(admitSdkSession(registry, manager, defaults, undefined)).toEqual({ model, thinkingLevel: "off" });
  } finally { await manager.close(); }
});

test("resume refuses missing, unavailable, unauthenticated and incompatible state without fallback", async () => {
  const manager = SessionManager.inMemory("/fixture");
  const defaults = { modelRoles: { default: "fixture/replacement" }, defaultThinkingLevel: "high" as const };
  try {
    expect(() => admitSdkSession(registry, manager, defaults, undefined)).toThrow("omp_resume_model_missing");
    manager.appendModelChange("fixture/saved");
    expect(() => admitSdkSession(registry, manager, defaults, undefined)).toThrow("omp_resume_thinking_missing");
    manager.appendThinkingLevelChange("off", "auto");
    expect(admitSdkSession(registry, manager, defaults, undefined)).toEqual({ model, thinkingLevel: "auto" });
    manager.appendThinkingLevelChange("off", "off");
    expect(() => admitSdkSession({ ...registry, hasConfiguredAuth: () => false }, manager, defaults, undefined))
      .toThrow("omp_resume_model_unavailable");
    // An unavailable last-active role must never fall back to the saved/default model.
    manager.appendModelChange("fixture/missing", "smol");
    expect(() => admitSdkSession(registry, manager, defaults, undefined)).toThrow("omp_resume_model_unavailable");
  } finally { await manager.close(); }
});

test("a one-shot's startup scope admits its configured model and never one OMP would resolve instead", async () => {
  const available = [
    listed("openrouter", "x-ai/grok-4.5"),
    listed("openrouter", "openai/gpt-5.5"),
    // A live-listed model as a session discovers it: under every pool provider, keyed as the
    // gateway lists it.
    listed("openrouter", "openrouter/stealth/space-bunny-alpha"),
    listed("anthropic", "openrouter/stealth/space-bunny-alpha"),
  ];
  const scope = async (reference: string) => (await resolveModelScope([exactModelScope(reference)], { getAvailable: () => available }))
    .map(({ model }) => `${model.provider}/${model.id}`);
  // Unscoped, an id the catalog lacks resolves to a neighbour by spelling: the substitution.
  expect(resolveModelRoleValue("openrouter/x-ai/grok-5", available).model?.id).toBe("x-ai/grok-4.5");
  expect(await scope("openrouter/x-ai/grok-5")).toEqual([]);
  expect(await scope("openrouter/stealth/space-bunny")).toEqual([]);
  expect(await scope("openrouter/openai/gpt-5.5:high")).toEqual(["openrouter/openai/gpt-5.5"]);
  expect(await scope("openrouter/stealth/space-bunny-alpha:medium"))
    .toEqual(["openrouter/openrouter/stealth/space-bunny-alpha", "anthropic/openrouter/stealth/space-bunny-alpha"]);
});

test("the SDK host admits a startup scope only when it names exactly the configured model", () => {
  const configured = "openrouter/stealth/space-bunny-alpha:medium";
  const config = { extensions: [], disabledProviders: [], extendedContext: true, startup: { setupWizard: false },
    modelRoles: { default: configured } };
  expect(SdkSessionConfigSchema.safeParse(config).success).toBe(true);
  expect(SdkSessionConfigSchema.safeParse({ ...config, enabledModels: [exactModelScope(configured)] }).success).toBe(true);
  for (const enabledModels of [[configured], [exactModelScope("openrouter/openai/gpt-5.5")],
    [exactModelScope(configured), "openrouter/*"]])
    expect(SdkSessionConfigSchema.safeParse({ ...config, enabledModels }).success).toBe(false);
});
