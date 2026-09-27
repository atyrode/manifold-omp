// Child process of material-session.test.ts. It builds the published SDK session a material job
// builds, restricted the same way, but outside the sealed sandbox, so the test can plant files the
// session could reach and observe exactly what crosses the model wire.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRegistry, AuthStorage, ModelRegistry, SessionManager, Settings, createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { MATERIAL_SYSTEM_PROMPT, materialMessage, runMaterialPrintMode } from "../material.ts";
import { admitSdkSession, SdkSessionConfigSchema } from "../sdk-admission.ts";

const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { root: string; prompt: string; material: string };
const agentDir = join(input.root, "agent");
const cwd = join(input.root, "cwd");
const config = SdkSessionConfigSchema.parse({ extensions: [], disabledProviders: [], extendedContext: false,
  startup: { setupWizard: false }, modelRoles: { default: "fixture/openai/gpt-5" }, skills: { enabled: false } });
const settings = await Settings.init({ inMemory: true, cwd: input.root, agentDir, configFiles: [], overrides: {
  ...config, "startup.setupWizard": false, "lsp.enabled": false, "advisor.enabled": false,
  "prewalk.enabled": false, "retry.modelFallback": false, "task.agentAdvisor": { task: "off" }, "task.prewalk": false,
  "skills.enabled": false,
} });
const auth = await AuthStorage.create(join(input.root, "auth.db"));
let code = 1;
try {
  const registry = new ModelRegistry(auth, join(agentDir, "models.yml"), {
    ignoreLocalModelConfig: false, settings, cacheDbPath: join(input.root, "models.db"),
  });
  await registry.refreshDiscoverableProviders(["fixture"], "online");
  const created = await createAgentSession({
    cwd, agentDir, settings, authStorage: auth, modelRegistry: registry,
    sessionManager: SessionManager.create(cwd, join(input.root, "session")), agentRegistry: new AgentRegistry(),
    ...admitSdkSession(registry, undefined, config, undefined), hasUI: false, skills: [],
    systemPrompt: [MATERIAL_SYSTEM_PROMPT], toolNames: [], restrictToolNames: true, allowRestrictedCustomTools: false,
    customTools: [], extensions: [], additionalExtensionPaths: [], disableExtensionDiscovery: true,
    rules: [], contextFiles: [], slashCommands: [],
    // Production sessions register none. This one makes expansion observable: a caller or
    // material line starting `/summarize` would become TEMPLATE-EXPANDED if it were processed.
    promptTemplates: [{ name: "summarize", description: "fixture", content: "TEMPLATE-EXPANDED", source: "(fixture)" }],
    enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true, spawns: "",
  });
  if (created.session.getAllToolNames().length !== 0) throw new Error("material registry is not empty");
  code = await runMaterialPrintMode(created.session, materialMessage(input.prompt, input.material));
} finally { auth.close(); }
process.exit(code);
