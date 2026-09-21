import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync, type Stats } from "node:fs";
import { z } from "zod";
import {
  AgentRegistry, AuthStorage, InteractiveMode, ModelRegistry, SessionManager, Settings,
  createAgentSession, loadSkillsFromDir, type Skill, type CreateAgentSessionResult,
} from "@oh-my-pi/pi-coding-agent";
import type { SettingsOptions } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { OverlaySchema } from "../api/index.ts";
import { ProbeConfigSchema, ProbeModelsConfigSchema, PROBE_AGENT, readProbeInput } from "../workers/probe/inputs.ts";
import { openSessionsRoot, resolveSessionFile, SESSIONS_ROOT, SessionIdSchema } from "../workers/harness/sessions.ts";
import { validateSkillInputs } from "../workers/harness/skills.ts";
import { readAutomation, readResumeOverrides, readSessionInput } from "../workers/harness/sdk-inputs.ts";
import { admitSdkSession } from "./sdk-admission.ts";

// This entry is always a new, sanitized child, never imported by CLI passthrough.
const cwd = "/home/job/workspace";
const controller = new AbortController();
const stopped = Promise.withResolvers<void>();
const cancel = () => { controller.abort(); stopped.resolve(); };
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
process.on("SIGHUP", cancel);
let manager: SessionManager | undefined;
let auth: AuthStorage | undefined;
let created: CreateAgentSessionResult | undefined;
let mode: InteractiveMode | undefined;
let heldFile: number | undefined;
let code = 1;
try {
  if (Object.keys(process.env).some(name => name.startsWith("MANIFOLD_"))) throw new Error("omp_sdk_environment_invalid");
  const kind = z.enum(["interactive", "print", "resume", "rpc", "rpc-resume"]).parse(process.argv[2]);
  const resume = kind === "resume" || kind === "rpc-resume";
  const rpc = kind === "rpc" || kind === "rpc-resume";
  const automation = readAutomation();
  const restricted = automation.mode === "restricted";
  if (rpc && restricted) throw new Error("omp_restricted_harness_unsupported");
  const overrides = readResumeOverrides();
  if (!resume && overrides) throw new Error("omp_sdk_input_invalid");
  const skillsRuntime = validateSkillInputs();
  if (restricted && skillsRuntime.mode === "preserve") throw new Error("omp_restricted_skills_unsupported");
  const config = ProbeConfigSchema.extend(OverlaySchema.shape).extend({
    skills: z.union([
      z.strictObject({ enabled: z.literal(false) }),
      z.strictObject({ customDirectories: z.array(z.string()).max(15) }),
    ]).optional(),
  }).parse(readProbeInput("config"));
  const expectedSkills = skillsRuntime.mode === "disabled" ? { enabled: false }
    : skillsRuntime.mode === "selected" ? { customDirectories: skillsRuntime.names.map((_, index) => `/inputs/optionalSkill${index}`) }
    : undefined;
  if (JSON.stringify(config.skills) !== JSON.stringify(expectedSkills)) throw new Error("omp_sdk_skill_changed");
  const models = ProbeModelsConfigSchema.parse(readProbeInput("models"));
  if (restricted && (config.task?.agentAdvisor?.task === "on" || config.task?.prewalk === true || config.advisor?.enabled === true ||
    config.prewalk?.enabled === true || config.retry?.modelFallback === true))
    throw new Error("omp_restricted_delegation_unsupported");
  const settingsOverrides: NonNullable<SettingsOptions["overrides"]> = {
    ...config,
    // Seal auxiliary delegation settings alongside the SDK's spawn policy.
    "startup.setupWizard": false,
    ...(restricted ? {
      "lsp.enabled": false, "irc.enabled": false, "advisor.enabled": false,
      "prewalk.enabled": false, "retry.modelFallback": false,
      "task.agentAdvisor": { task: "off" }, "task.prewalk": false,
      "skills.enabled": skillsRuntime.mode === "selected",
    } : {}),
  };
  // Ordinary resume retains OMP's project layer; the sealed launch config still wins.
  // Restricted startup never reads ambient settings. Both paths share the stock TUI singleton.
  const settings = await Settings.init({ inMemory: true, cwd: restricted ? "/home/job" : cwd,
    agentDir: PROBE_AGENT, configFiles: restricted ? [] : [`${PROBE_AGENT}/config.yml`],
    overrides: restricted ? settingsOverrides : { "startup.setupWizard": false } });
  mkdirSync("/home/job/tmp", { recursive: true, mode: 0o700 });
  auth = await AuthStorage.create("/home/job/tmp/sdk-auth.db");
  const registry = new ModelRegistry(auth, `${PROBE_AGENT}/models.yml`, {
    // This is the immutable validated native gateway capability file, not ambient configuration.
    ignoreLocalModelConfig: false, settings, cacheDbPath: "/home/job/tmp/sdk-models.db",
  });
  // Exact provider discovery uses only the gateway capabilities in the sealed model file.
  await registry.refreshDiscoverableProviders(Object.keys(models.providers), "online");
  if (controller.signal.aborted) throw new Error("omp_sdk_cancelled");
  let original: Stats | undefined;
  let resumePath: string | undefined;
  if (resume || process.argv[3] !== undefined) {
    const filename = process.argv[3];
    if (!filename || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.jsonl$/.test(filename)) throw new Error("omp_resume_session_unavailable");
    const root = openSessionsRoot();
    try {
      const id = SessionIdSchema.parse(readSessionInput("sessionId", 36));
      if (resolveSessionFile(root, id) !== filename) throw new Error("omp_resume_session_changed");
      resumePath = `${SESSIONS_ROOT}/${filename}`;
      heldFile = openSync(`/proc/self/fd/${root}/${filename}`, constants.O_RDONLY | constants.O_NOFOLLOW);
      original = fstatSync(heldFile);
      if (!original.isFile() || original.nlink !== 1) throw new Error("omp_resume_session_unavailable");
      manager = await SessionManager.open(resumePath, SESSIONS_ROOT, undefined, { throwIfMissing: true });
      if (manager.getSessionId() !== id || manager.getSessionFile() !== resumePath || manager.getCwd() !== cwd)
        throw new Error("omp_resume_session_changed");
      if (!resume && manager.getEntries().length !== 0) throw new Error("omp_sdk_session_changed");
    } finally { closeSync(root); }
  }
  const admitted = admitSdkSession(registry, resume ? manager : undefined, config, overrides);
  if (!Object.hasOwn(models.providers, admitted.model.provider) || config.disabledProviders.includes(admitted.model.provider))
    throw new Error("omp_resume_model_unavailable");
  if (!await registry.getApiKey(admitted.model, manager?.getSessionId(), { signal: controller.signal }))
    throw new Error("omp_resume_model_unavailable");
  const skills: Skill[] = [];
  if (skillsRuntime.mode === "selected") {
    for (let index = 0; index < skillsRuntime.names.length; index++) {
      const result = await loadSkillsFromDir({ dir: `/inputs/optionalSkill${index}`, source: "native-sealed-selection" });
      if (result.warnings.length || result.skills.length !== 1 || result.skills[0]!.name !== skillsRuntime.names[index])
        throw new Error("omp_sdk_skill_changed");
      skills.push(result.skills[0]!);
    }
  }
  if (resumePath && original && heldFile !== undefined) {
    const current = lstatSync(resumePath);
    const held = fstatSync(heldFile);
    if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino ||
      current.size !== original.size || current.mtimeMs !== original.mtimeMs || current.ctimeMs !== original.ctimeMs ||
      held.size !== original.size || held.mtimeMs !== original.mtimeMs || held.ctimeMs !== original.ctimeMs)
      throw new Error("omp_resume_session_changed");
  }
  if (controller.signal.aborted) throw new Error("omp_sdk_cancelled");
  if (!manager) {
    const sessionRoot = kind === "print" ? "/outputs/session" : SESSIONS_ROOT;
    const root = openSessionsRoot(sessionRoot);
    try { manager = SessionManager.create(cwd, sessionRoot); }
    finally { closeSync(root); }
  }
  created = await createAgentSession({
    cwd, agentDir: PROBE_AGENT, settings, authStorage: auth, modelRegistry: registry,
    sessionManager: manager, agentRegistry: new AgentRegistry(), ...admitted,
    hasUI: kind === "interactive" || kind === "resume",
    ...(restricted || skillsRuntime.mode === "disabled" ? { skills } : {}),
    ...(rpc ? { appendSystemPrompt: readFileSync(process.argv[4]!, "utf8") } : {}),
    ...(restricted ? {
      systemPrompt: ["You are a coding assistant operating under an explicit native tool policy. Delegation is disabled. Selected skills are instructions only, never authorization.",
        ...skills.map(skill => `Selected skill ${skill.name}: ${skill.description}. Read skill://${skill.name} for instructions and resources.`)],
      toolNames: automation.toolNames, restrictToolNames: true, allowRestrictedCustomTools: false,
      customTools: [], extensions: [], additionalExtensionPaths: [], disableExtensionDiscovery: true,
      rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
      enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true, spawns: "",
    } : {}),
  });
  if (created.modelFallbackMessage || created.session.model?.provider !== admitted.model.provider ||
    created.session.model.id !== admitted.model.id) throw new Error("omp_resume_model_changed");
  if (created.session.configuredThinkingLevel() !== admitted.thinkingLevel) throw new Error("omp_resume_thinking_incompatible");
  if (resume && overrides && (overrides.model !== undefined || overrides.thinking !== undefined)) {
    // SDK construction accepts runtime overrides without recording their durable selectors.
    if (overrides.model !== undefined) manager!.appendModelChange(`${admitted.model.provider}/${admitted.model.id}`);
    manager!.appendThinkingLevelChange(created.session.thinkingLevel, created.session.configuredThinkingLevel());
    await manager!.flush();
  }
  const abort = () => { void created!.session.abort(); };
  controller.signal.addEventListener("abort", abort, { once: true });
  if (controller.signal.aborted) abort();
  try {
    if (kind === "print") {
      code = await runPrintMode(created.session, { mode: "json", initialMessage: readSessionInput("prompt") });
    } else if (rpc) {
      await runRpcMode(created.session, created.setToolUIContext, created.eventBus);
    } else {
      mode = new InteractiveMode(created.session, "18.2.7", undefined, created.setToolUIContext,
        created.lspServers, created.mcpManager, created.eventBus);
      await mode.init();
      if (resume) await mode.renderInitialMessages();
      if (!resume) {
        const prompt = readSessionInput("prompt");
        if (prompt) await created.session.prompt(prompt);
      }
      await stopped.promise;
      code = controller.signal.aborted ? 1 : 0;
    }
  } finally { controller.signal.removeEventListener("abort", abort); }
} catch (error) {
  const reason = error instanceof Error && /^omp_(?:resume|sdk|restricted)_[a-z_]+$/.test(error.message)
    ? error.message : "omp_sdk_failed";
  writeSync(2, `${reason}\n`);
} finally {
  try {
    await created?.session.abort();
    await created?.session.dispose();
    if (!created) await manager?.close();
  } finally {
    mode?.stop();
    auth?.close();
    if (heldFile !== undefined) closeSync(heldFile);
    process.off("SIGTERM", cancel); process.off("SIGINT", cancel); process.off("SIGHUP", cancel);
  }
}
process.exit(code);
