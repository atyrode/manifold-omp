import { expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { admitSdkSession } from "../workers/harness/sdk-admission.ts";

const model: Model = buildModel({
  provider: "fixture", id: "saved", name: "Fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1",
  reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
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
    expect(() => admitSdkSession(registry, manager, defaults, undefined)).toThrow("omp_resume_thinking_incompatible");
    manager.appendThinkingLevelChange("off", "off");
    expect(() => admitSdkSession({ ...registry, hasConfiguredAuth: () => false }, manager, defaults, undefined))
      .toThrow("omp_resume_model_unavailable");
    // An unavailable last-active role must never fall back to the saved/default model.
    manager.appendModelChange("fixture/missing", "smol");
    expect(() => admitSdkSession(registry, manager, defaults, undefined)).toThrow("omp_resume_model_unavailable");
  } finally { await manager.close(); }
});
