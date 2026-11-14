// Runs the published resolver and production subagent executor, never a copied precedence rule.
// Every provider request is restricted to the test-owned loopback pi-native server.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { resolveAgentModelSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import { runSubagentRunRequest, subagentRunRequest } from "@oh-my-pi/pi-coding-agent/task/executor";

const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  root: string;
  origin: string;
  cases: { agent: string; task: string; smol: string; active: string }[];
};
const originalFetch = globalThis.fetch;
globalThis.fetch = ((request: string | URL | Request, init?: RequestInit) => {
  const url = new URL(request instanceof Request ? request.url : request);
  if (url.origin !== input.origin) throw new Error("precedence_non_fixture_network_refused");
  return originalFetch(request, init);
}) as typeof fetch;
const agentDir = join(input.root, "agent");
const cwd = join(input.root, "cwd");
const settings = await Settings.init({ inMemory: true, cwd, agentDir, configFiles: [], overrides: {
  disabledProviders: getBundledProviders(),
  modelRoles: { default: "fixture/default:max", task: "fixture/task:medium", smol: "fixture/smol:medium", slow: "fixture/slow:high" },
  "startup.setupWizard": false, "lsp.enabled": false, "advisor.enabled": false,
  "prewalk.enabled": false, "retry.modelFallback": false, "task.agentAdvisor": { task: "off" },
  "task.prewalk": false, "task.maxRecursionDepth": 0, "skills.enabled": false,
} });
const auth = await AuthStorage.create(join(input.root, "auth.db"));
const registry = new ModelRegistry(auth, join(agentDir, "models.yml"), {
  ignoreLocalModelConfig: false, settings, cacheDbPath: join(input.root, "models.db"),
});
const bundled = loadBundledAgents();
const observed = [];
try {
  for (const [index, scenario] of input.cases.entries()) {
    const agent = bundled.find(candidate => candidate.name === scenario.agent);
    if (!agent || agent.source !== "bundled") throw new Error("precedence_bundled_agent_missing");
    settings.setModelRole("task", scenario.task);
    settings.setModelRole("smol", scenario.smol);
    const selection = resolveAgentModelSelection({
      ...(agent.model === undefined ? {} : { agentModel: agent.model }), settings, activeModelPattern: scenario.active,
    });
    const id = `Precedence${index}`;
    // This is the production worker entry used after native task/eval dispatch. Pass exactly the
    // native resolver's expanded patterns and the untouched bundled frontmatter thinking default.
    const result = await runSubagentRunRequest(subagentRunRequest({
      cwd, agent, task: `NATIVE-PRECEDENCE-${index}`, description: "Native bundled precedence proof", index, id,
      modelOverride: selection.patterns, ...(selection.role === undefined ? {} : { modelRole: selection.role }),
      ...(agent.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
      parentActiveModelPattern: scenario.active, settings, authStorage: auth, modelRegistry: registry,
      structured: false, restrictToolNames: true, enableMCP: false, enableLsp: false, enableIrc: false,
      skills: [], rules: [], contextFiles: [], promptTemplates: [], noContextFiles: true,
      artifactsDir: join(input.root, "sessions"), persistArtifacts: true, keepAlive: false,
      maxRuntimeMs: 20_000,
    }));
    if (result.exitCode !== 0) throw new Error(`precedence_executor_refused:${scenario.agent}:${result.error ?? result.stderr}`);
    const journal = await SessionManager.open(join(input.root, "sessions", `${id}.jsonl`), join(input.root, "sessions"), undefined,
      { throwIfMissing: true });
    try {
      const context = journal.buildSessionContext();
      observed.push({ agent: agent.name, source: agent.source, declaredThinking: agent.thinkingLevel ?? null,
        role: selection.role ?? null, model: context.models[journal.getLastModelChangeRole() ?? "default"],
        configuredThinking: context.configuredThinkingLevel ?? context.thinkingLevel,
        output: result.output,
      });
    } finally { await journal.close(); }
  }
} finally { auth.close(); }
console.log(JSON.stringify(observed));
process.exit(0);
