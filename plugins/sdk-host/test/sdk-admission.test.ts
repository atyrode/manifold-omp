import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
  expandRoleAlias, resolveAdvisorRoleSelection, resolveAgentModelSelection, resolveModelFromString, resolveModelOverride,
  resolveModelRoleValue, resolveModelScope,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { CHAT_MODEL_ROLE_IDS } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveRoleModelFull } from "@oh-my-pi/pi-coding-agent/session/role-models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { exactModelScope, pinnedModelRoles } from "../../api/index.ts";
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

/**
 * Startup is not a one-shot's last selection. A task agent, the advisor, the plan hand-off and
 * compaction resolve a model role later, against the session's whole catalog, where an unset role
 * is not the default model and a workspace's `.omp/config.yml` may name any model for any role.
 * Settings load as OMP loads a one-shot's: the workspace's project layer beneath the job's file.
 */
test("a one-shot's pinned roles leave OMP's later selections nothing but its configured model", async () => {
  const configured = "openrouter/openrouter/stealth/space-bunny-alpha:medium";
  const served = "openrouter/openrouter/stealth/space-bunny-alpha";
  const other = "anthropic/claude-opus-4-8";
  const available = [listed("openrouter", "openrouter/stealth/space-bunny-alpha"),
    listed("anthropic", "claude-opus-4-8"), listed("anthropic", "claude-haiku-4-5")];
  const name = (selected: Model | undefined) => selected ? `${selected.provider}/${selected.id}` : "none";
  const root = mkdtempSync(join(tmpdir(), "one-shot-roles-"));
  const selections = async (modelRoles: Record<string, string>) => {
    const agentDir = join(root, crypto.randomUUID());
    const workspace = join(agentDir, "workspace");
    mkdirSync(join(workspace, ".omp"), { recursive: true });
    writeFileSync(join(agentDir, "config.yml"), JSON.stringify({ modelRoles }));
    writeFileSync(join(workspace, ".omp", "config.yml"), JSON.stringify({ modelRoles: { smol: other, task: other } }));
    const settings = await Settings.loadReadOnly({ cwd: workspace, agentDir, configFiles: [join(agentDir, "config.yml")] });
    const agent = (agentModel: string) => name(resolveModelOverride(
      resolveAgentModelSelection({ agentModel, settings, activeModelPattern: configured }).patterns,
      { getAvailable: () => available }, settings).model);
    return {
      advisor: name(resolveAdvisorRoleSelection(settings, available)?.model),
      taskAgent: agent("@task"),
      fastAgent: agent("@smol"),
      planHandoff: name(resolveModelFromString(expandRoleAlias("@smol", settings), available)),
      compaction: [...new Set(CHAT_MODEL_ROLE_IDS.map(role =>
        name(resolveRoleModelFull(settings, role, available, available[0]).model)))].filter(model => model !== "none"),
    };
  };
  try {
    // Unpinned, the advisor falls to OMP's reasoning list and the workspace picks the agents' model.
    expect(await selections({ default: configured })).toEqual({
      advisor: other, taskAgent: other, fastAgent: other, planHandoff: other, compaction: [served, other],
    });
    expect(await selections(pinnedModelRoles({ default: configured }))).toEqual({
      advisor: served, taskAgent: served, fastAgent: served, planHandoff: served, compaction: [served],
    });
    // A role the operator configured keeps its model.
    expect((await selections(pinnedModelRoles({ default: configured, smol: "anthropic/claude-haiku-4-5" }))).fastAgent)
      .toBe("anthropic/claude-haiku-4-5");
  } finally { rmSync(root, { recursive: true, force: true }); }
  // Every chat role this SDK knows is held, so a role a later OMP adds fails here instead of leaking.
  const pinned = pinnedModelRoles({ default: configured });
  for (const role of CHAT_MODEL_ROLE_IDS) expect(pinned[role]).toBe(configured);
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
