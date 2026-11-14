// Public backend lifecycle + real completeSimple dispatch into a registered in-process provider.
// No private callback replacement, module mocks, provider transport, or account credentials.
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  root: string;
  backend: "off" | "mnemopi";
  rejectPrimary: boolean;
  memoryFallback: string[];
};
const networkAttempts: string[] = [];
function refuseNetwork(): never {
  networkAttempts.push("refused");
  throw new Error("native_memory_fixture_network_refused");
}
// Install the egress fence before importing the SDK. Even an accidental discovery,
// embedding download, HTTP request, or websocket cannot reach an external service.
for (const [target, name] of [
  [globalThis, "fetch"], [globalThis, "WebSocket"],
  [http, "request"], [http, "get"], [https, "request"], [https, "get"],
  [net, "connect"], [net, "createConnection"], [net.Socket.prototype, "connect"],
  [tls, "connect"], [dgram, "createSocket"], [Bun, "connect"], [Bun, "udpSocket"],
] as const) Object.defineProperty(target, name, { value: refuseNetwork });
syncBuiltinESMExports();

// Intentional module-loading boundary: static SDK imports would initialize before
// this test's fail-closed egress fence, defeating isolation during module loading.
const { createAssistantMessageEventStream } = await import("@oh-my-pi/pi-ai");
const { AgentRegistry, AuthStorage, ModelRegistry, SessionManager, Settings, createAgentSession } =
  await import("@oh-my-pi/pi-coding-agent");
const { resolveMemoryBackend } = await import("@oh-my-pi/pi-coding-agent/memory-backend");
const { getBundledModel, getBundledProviders } = await import("@oh-my-pi/pi-catalog/models");
const thinking = getBundledModel("openai", "gpt-5").thinking;
const medium = thinking?.efforts.find(effort => effort === "medium");
const high = thinking?.efforts.find(effort => effort === "high");
if (thinking === undefined || medium === undefined || high === undefined)
  throw new Error("native_memory_fixture_requires_controllable_effort_metadata");
const agentDir = join(input.root, "agent");
const cwd = join(input.root, "cwd");
const memoryDir = join(input.root, "memory");
const marker = "NATIVE-MEMORY-ROLE: I prefer durable synthetic fixtures without external services.";
const bearer = "SYNTHETIC-MEMORY-FIXTURE-NOT-AN-ACCOUNT";
const source = "native-memory-role-fixture";
const settings = await Settings.init({ inMemory: true, cwd, agentDir, configFiles: [], overrides: {
  disabledProviders: getBundledProviders(),
  modelRoles: { default: "fixture/expensive:high", smol: "fixture/expensive:high",
    tiny: "fixture/expensive:high", memory: "fixture/cheap-memory:medium" },
  "retry.modelFallback": false, "retry.fallbackChains": { memory: input.memoryFallback },
  "memory.backend": input.backend, "mnemopi.dbPath": join(memoryDir, "memory.db"),
  "mnemopi.scoping": "global", "mnemopi.bank": "native-memory-role-fixture",
  "mnemopi.llmMode": "smol", "mnemopi.noEmbeddings": true,
  "mnemopi.autoRecall": false, "mnemopi.autoRetain": false,
  "mnemopi.polyphonicRecall": false, "mnemopi.enhancedRecall": false, "mnemopi.proactiveLinking": false,
  "autolearn.enabled": false, "startup.setupWizard": false, "lsp.enabled": false,
  "advisor.enabled": false, "prewalk.enabled": false, "skills.enabled": false,
  "task.prewalk": false, "task.agentAdvisor": { task: "off" },
} });
const auth = await AuthStorage.create(join(input.root, "auth.db"));
const registry = new ModelRegistry(auth, join(agentDir, "models.yml"), {
  ignoreLocalModelConfig: true, settings, cacheDbPath: join(input.root, "models.db"),
});
const requests: {
  model: string;
  api: string;
  context: Context;
  options: { [K in "reasoning" | "disableReasoning" | "maxTokens" | "temperature" | "thinkingBudgets"]: SimpleStreamOptions[K] };
  syntheticKey: boolean;
  hasSessionId: boolean;
}[] = [];
registry.registerProvider("fixture", {
  api: "native-memory-fixture", baseUrl: "http://127.0.0.1:1", apiKey: bearer,
  // Fictional cost ordering, not a provider price or catalog snapshot.
  models: ["cheap-memory", "expensive"].map(id => ({ id, name: id, reasoning: true, thinking,
    input: ["text"], contextWindow: 32_768, maxTokens: 8192,
    cost: { input: id === "cheap-memory" ? 0 : 1, output: id === "cheap-memory" ? 0 : 1,
      cacheRead: 0, cacheWrite: 0 },
  })),
  streamSimple(model, context, options) {
    requests.push({ model: `${model.provider}/${model.id}`, api: model.api, context,
      options: { reasoning: options?.reasoning, disableReasoning: options?.disableReasoning,
        maxTokens: options?.maxTokens, temperature: options?.temperature, thinkingBudgets: options?.thinkingBudgets },
      syntheticKey: options?.apiKey === bearer, hasSessionId: typeof options?.sessionId === "string",
    });
    const rejected = input.rejectPrimary && model.id === "cheap-memory";
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: rejected ? [] : [{ type: "text", text: JSON.stringify({ facts: [marker], instructions: [],
        preferences: [], timelines: [], kg: [] }) }],
      stopReason: rejected ? "error" : "stop",
      ...(rejected ? { errorStatus: 400, errorMessage: "Fixture permanently rejects this memory request" } : {}),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    if (rejected) stream.push({ type: "error", reason: "error", error: message });
    else stream.push({ type: "done", reason: "stop", message });
    stream.end();
    return stream;
  },
}, source);
const journal = SessionManager.inMemory(cwd);
let session: AgentSession | undefined;
let result: Record<string, unknown> | undefined;
try {
  const expensive = registry.find("fixture", "expensive");
  if (!expensive) throw new Error("native_memory_fixture_primary_missing");
  const created = await createAgentSession({
    cwd, agentDir, settings, authStorage: auth, modelRegistry: registry, sessionManager: journal,
    agentRegistry: new AgentRegistry(), model: expensive, thinkingLevel: high,
    hasUI: false, cacheWarming: false, bindProcessState: false, skills: [],
    systemPrompt: ["Synthetic native memory consumer fixture."], toolNames: [], restrictToolNames: true,
    customTools: [], extensions: [], additionalExtensionPaths: [], disableExtensionDiscovery: true,
    rules: [], contextFiles: [], slashCommands: [], promptTemplates: [],
    enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true, spawns: "",
  });
  session = created.session;
  journal.appendMessage({ role: "user", content: marker, timestamp: Date.now() });
  const backend = await resolveMemoryBackend(settings);
  // Restricted SDK sessions skip automatic memory startup. Await the public lifecycle
  // explicitly instead of enabling autolearn or racing the SDK's background startup.
  const beforeStart = requests.length;
  await backend.start({ session, settings, modelRegistry: registry, agentDir, taskDepth: 0 });
  const afterStart = requests.length;
  await backend.enqueue(agentDir, cwd, session);
  const afterEnqueue = requests.length;
  const status = await backend.status?.({ agentDir, cwd, session });
  result = { backend: backend.id, beforeStart, afterStart, afterEnqueue, requests,
    active: status?.active, memoryDirectoryCreated: existsSync(memoryDir),
    availableModels: registry.getAvailable("all").map(model => `${model.provider}/${model.id}`).sort(),
    expectedMedium: medium, expectedHigh: high, marker };
} finally {
  // enqueue joins pending extraction. Session disposal unsubscribes listeners, drains
  // remaining work and closes its owned SQLite banks; the child is reaped by the test.
  try { await session?.dispose(); } finally {
    try { await journal.close(); } finally { registry.clearSourceRegistrations(source); auth.close(); }
  }
}
console.log(JSON.stringify({ ...result, afterDispose: requests.length, networkAttempts: networkAttempts.length }));
