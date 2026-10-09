import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai/types";
import {
  AgentPolicyChallengeSchema, CreateRunV2CredentialResultSchema, CreateRunV2ResultSchema, InspectRunV2ResultSchema,
  JobDeploymentReviewSchema, JobDeploymentSchema, JobDescriptionSchema, LaunchRunResultSchema, ListJobRunsResultSchema, ListRunsV2ResultSchema,
  MANIFOLD_ROOT_URI, PublicJobSchema, RegisterAgentV2ResultSchema, ServiceConfigurationReadSchema, ServicePolicySchema, canonicalJobJson,
  formatManifoldUri, type RunActivity, type RunModel, type ServiceConfiguration,
} from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import { dispatch, ownerAction } from "../../../manifold/packages/plugin-kit/src/hub.ts";
import { connect, waitFor, type TestServer } from "../../../manifold/packages/testkit/src/index.ts";
import {
  OMP_PLUGIN_ID, OmpHarnessProfileSchema, RefusalSchema, RunDialsSchema, actionDoor,
  type AccountReference, type ActionInput, type ActionReply, type ActionResult, type OmpAction, type RunDials,
} from "../api/index.ts";

class HarnessProofFailure extends Error {
  constructor(code: string) { super(`native-harness-${code}`); }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new HarnessProofFailure(code);
}
const HARNESS_OPERATION_ID = `${OMP_PLUGIN_ID}.harness`;
const LEASE_MS = 60_000;
/** Status-line labels of the stock TUI's default symbol preset: the thinking glyph, then the model's name. */
const LOW_GPT5 = /◔ GPT-5\b/;
const HIGH_O3 = /◒ o3\b/;

/**
 * An Agent whose profile selects OMP's own terminal UI, launched as Code launches one: the
 * operator creates its Run, `core.access.launchRun` prepares the packed harness, and the
 * operator opens the returned runtime as a terminal. The harness never acknowledges the Run's
 * policy, so the Run stays `pending_policy` while it renews and reports activity, with the model
 * its session serves, on its own credential (atyrode/manifold#1070, #1071). The operator turns the
 * dials through `controlRun`, the TUI redraws them and `Run.model` follows; an Agent principal is
 * refused. Only inference is synthetic.
 */
export async function verifyNativeHarness({ root, server, hub, target, broker, client }: {
  root: string;
  server: TestServer;
  hub: Parameters<typeof ownerAction>[0];
  target: { containerId: string; machineId: string };
  broker: { origin: string; bearer: string };
  client: { call<K extends OmpAction>(name: K, input: ActionInput<K>): Promise<ActionReply<K>> };
}): Promise<void> {
  let phase = "account";
  async function call<K extends OmpAction>(name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
    const reply = await client.call(name, input);
    check(!RefusalSchema.safeParse(reply).success, `${phase}-refused`);
    return reply as ActionResult<K>;
  }
  async function asToken(token: string, action: string, input: unknown): Promise<unknown> {
    const reply = await dispatch(hub, token, action, input);
    check(reply.ok, `${phase}-door-refused`);
    return reply.result;
  }
  /** The door's answer: the session's dials, or the refusal or denial the caller is told. */
  async function controlRun(token: string, input: ActionInput<"controlRun">): Promise<RunDials | string> {
    const reply = await dispatch(hub, token, actionDoor("controlRun"), input);
    if (!reply.ok) return reply.denial.rule === "refused" ? reply.denial.message : `denied-${reply.denial.rule}`;
    const refusal = RefusalSchema.safeParse(reply.result);
    return refusal.success ? refusal.data.refused : RunDialsSchema.parse(reply.result);
  }

  // Synthetic pi-native inference: it lists two models and answers each operator turn with the
  // model and thinking level it was asked for. A held turn stays in flight until released.
  const turns = new Map<string, { model: string; thinking: string }>();
  let held: PromiseWithResolvers<void> | undefined;
  let inferenceFailure = false;
  function respond(text: string, model: string, hold?: Promise<void>): Response {
    const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "openai", model,
      content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const events: AssistantMessageEvent[] = [
      { type: "start", partial: message },
      { type: "text_start", contentIndex: 0, partial: message },
      { type: "text_delta", contentIndex: 0, delta: text, partial: message },
      { type: "text_end", contentIndex: 0, content: text, partial: message },
      { type: "done", reason: "stop", message },
    ];
    const encode = (list: AssistantMessageEvent[]) => new TextEncoder().encode(list.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      controller.enqueue(encode(events.slice(0, 1)));
      await hold;
      controller.enqueue(encode(events.slice(1)));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  }
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/models") return Response.json({ object: "list", data: ["gpt-5", "o3"].map(id => ({
        id, object: "model", owned_by: "openai", api: "openai-completions", display_name: id,
        context_length: 200_000, max_output_tokens: 8192, input_modalities: ["text"],
      })) });
      check(request.method === "POST" && url.pathname === "/v1/pi/stream", "unexpected-inference-route");
      const parsed = parseRequest(await request.json(), request.headers);
      // A request without tools is the session's own housekeeping, such as a title, never a turn.
      if ((parsed.context.tools ?? []).length === 0) return respond("Disposable harness proof", parsed.modelId);
      const last = parsed.context.messages.at(-1);
      const marker = last?.role === "user" ? /NATIVE-HARNESS-TURN-\d/.exec(JSON.stringify(last.content))?.[0] : undefined;
      check(marker && !turns.has(marker), "unexpected-inference-turn");
      const thinking = parsed.options.reasoning ?? (parsed.options.disableReasoning ? "off" : "unset");
      turns.set(marker, { model: parsed.modelId, thinking });
      return respond(`${marker}-REPLY served by ${parsed.modelId} at ${thinking}`, parsed.modelId, held?.promise);
    } catch {
      inferenceFailure = true;
      return new Response(null, { status: 500 });
    }
  } });

  let originalServices: ServiceConfiguration | undefined;
  let credential: { id: number; reference: AccountReference } | undefined;
  let agent: { agentId: string; principalId: string } | undefined;
  const runs: string[] = [];
  let canvas: SessionClient | undefined;
  let home: SessionClient | undefined;
  let terminalId: string | undefined;
  let failed = false;
  try {
    // Existing broker client ingress owns this one synthetic slot. No provider is contacted.
    const before = new Set((await call("accounts", {})).accounts.map(account => account.credentialId));
    const upload = await fetch(`${broker.origin}/v1/credential`, {
      method: "POST", headers: { authorization: `Bearer ${broker.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", credential: { type: "api_key", key: "SYNTHETIC-UNPAID-NATIVE-HARNESS-PROOF" } }),
      signal: AbortSignal.timeout(5000),
    });
    check(upload.ok, "synthetic-account-upload");
    await upload.body?.cancel();
    const account = (await call("accounts", {})).accounts.find(value => !before.has(value.credentialId));
    check(account && account.reference.provider === "openai" && !account.disabled, "synthetic-account-unobserved");
    credential = { id: account.credentialId, reference: account.reference };

    phase = "service";
    // Earlier proofs leave their own `omp` policy behind; this one replaces it and restores it after.
    const services = ServiceConfigurationReadSchema.parse(await ownerAction(hub, "engine.services.readConfiguration", { machineId: target.machineId })).configuration;
    originalServices = services;
    const policy = ServicePolicySchema.parse({ serviceId: "omp", revision: "1", origin: gateway.url.origin,
      allowLoopbackHttp: true, maxConcurrent: 2, operations: {
        models: { kind: "http-proxy", method: "GET", path: "/v1/models", request: { kind: "none" },
          response: { kind: "stream", disclosure: "full", contentTypes: ["application/json"], headers: [] },
          timeoutMs: 5000, maxRequestBytes: 65536, maxResponseBytes: 1048576 },
        stream: { kind: "http-proxy", method: "POST", path: "/v1/pi/stream", request: { kind: "json", disclosure: "full" },
          response: { kind: "stream", disclosure: "full", contentTypes: ["text/event-stream"], headers: [] },
          timeoutMs: 60000, maxRequestBytes: 16 * 1024 * 1024, maxResponseBytes: 16 * 1024 * 1024,
          meter: { kind: "pi-native-usage" } },
      } });
    await ownerAction(hub, "engine.services.configureConfiguration", { machineId: target.machineId,
      expectedRevision: services.revision, policies: [...services.policies.filter(item => item.serviceId !== "omp"), policy] });
    const policyDigest = createHash("sha256").update(canonicalJobJson(policy)).digest("hex");
    await waitFor(async () => {
      const native = JobDescriptionSchema.parse(await ownerAction(hub, "engine.jobs.describe", { machineId: target.machineId, pluginId: OMP_PLUGIN_ID }));
      return native.connected && native.resources?.services.omp === policyDigest;
    }, 30_000, 50);

    phase = "deployment";
    // The workspace preparation door creates the transcript store; this disposable machine has none yet.
    await mkdir(join(root, "state", "omp", "sessions"), { recursive: true, mode: 0o700 });
    const deployment = { deploymentId: randomUUID(), pluginId: OMP_PLUGIN_ID,
      targets: [{ machineId: target.machineId, platform: "linux-x64" }], operationIds: [HARNESS_OPERATION_ID] };
    const review = JobDeploymentReviewSchema.parse(await ownerAction(hub, "engine.jobs.reviewDeployment", deployment));
    check(review.approvable, `deployment-${review.targets.find(item => !item.approvable)?.reason?.replaceAll("_", "-") ?? "refused"}`);
    await ownerAction(hub, "engine.jobs.applyDeployment", { request: deployment, reviewDigest: review.reviewDigest });
    await waitFor(async () => {
      const current = JobDeploymentSchema.parse(await ownerAction(hub, "engine.jobs.readDeployment", { deploymentId: deployment.deploymentId }));
      check(!current.targets.some(item => ["refused", "needs_review", "cancelled", "superseded"].includes(item.state)), "deployment-refused");
      return current.targets.every(item => item.state === "ready");
    }, 480_000, 100);

    phase = "agent";
    const accountPool = { openai: [{ scope: account.reference.scope, credentialId: account.credentialId, identityKey: account.identityKey }] };
    const profile = OmpHarnessProfileSchema.parse({ accountPool, planYolo: false, tui: true, overlay: {
      modelRoles: { default: "openai/gpt-5" }, defaultThinkingLevel: "low",
      retry: { enabled: false, modelFallback: false }, prewalk: { enabled: false }, advisor: { enabled: false } } });
    // Manifold hands a hardened plugin harness the V1 projection of its Agent and Run, so both
    // need one nonempty rectangle of authority; `scope: []` refuses `scoped_authority_requires_v2`.
    // The model never holds it: the Run stays pending and reaches no ordinary door.
    const registered = RegisterAgentV2ResultSchema.parse(await ownerAction(hub, "core.access.registerAgentV2", {
      name: "Disposable native OMP TUI witness", purpose: "Prove the packed TUI harness without paid inference",
      harness: OMP_PLUGIN_ID, context: { profile },
      grant: { scope: [{ target: MANIFOLD_ROOT_URI, reach: "subtree", caps: ["containers:read"] }], maxRunLifetimeMs: LEASE_MS,
        delegation: { maxDepth: 0, maxDescendants: 0 }, expiresAt: Date.now() + 900_000 },
    }));
    check(registered.created && registered.credential, "agent-runner-missing");
    agent = { agentId: registered.agent.agentId, principalId: registered.agent.principalId };
    const runnerToken = registered.credential.token;

    phase = "launch";
    const harnessTarget = { machineId: target.machineId, containerId: target.containerId };
    // The Run's scope is the one rectangle at its own target, the container it launches into.
    const runScope = { target: harnessTarget, reach: "subtree", lifetimeMs: LEASE_MS,
      scope: [{ target: formatManifoldUri({ kind: "container", containerId: target.containerId }), reach: "subtree", caps: ["containers:read"] }] };
    // As Code launches: the operator creates the Run, which hands it no bearer, and launches it.
    const created = CreateRunV2ResultSchema.parse(await ownerAction(hub, "core.access.createRunV2", { agentId: agent.agentId, ...runScope }));
    const runId = created.run.id;
    runs.push(runId);
    check(created.run.state === "pending_policy" && created.credential === undefined, "run-not-fresh");
    const launched = LaunchRunResultSchema.parse(await ownerAction(hub, "core.access.launchRun", { runId, target: harnessTarget }));
    check(launched.runtime.operationId === HARNESS_OPERATION_ID && launched.runtime.input.tui === true
      && launched.session.harness === OMP_PLUGIN_ID && launched.destination.machineId === target.machineId, "launch-not-tui-harness");
    const inspect = async () => InspectRunV2ResultSchema.parse(await ownerAction(hub, "core.access.inspectRunV2", { runId })).run;
    check(created.run.model === undefined, "run-model-preset");
    const { agentId } = agent;
    /** `Run.model` as inspection and the Agent's Run list both show it, once the harness resolved the session's report. */
    const model = (expected: RunModel, code: string) => until(async () => {
      const listed = ListRunsV2ResultSchema.parse(await ownerAction(hub, "core.access.listRunsV2", { agentId })).runs.find(run => run.id === runId);
      return JSON.stringify((await inspect()).model) === JSON.stringify(expected) && JSON.stringify(listed?.model) === JSON.stringify(expected);
    }, `model-${code}`);

    phase = "terminal";
    canvas = await connect(server, { containerId: target.containerId, token: hub.ownerKey, reconnect: false });
    const terminal = await canvas.openTerminal({ elementId: randomUUID(), machineId: target.machineId,
      runtime: launched.runtime, cols: 120, rows: 40, timeoutMs: 60_000 });
    terminalId = terminal.id;
    const viewer = home = await connect(server, { containerId: terminal.containerId, token: hub.ownerKey, reconnect: false });
    let views = 0;
    /** The terminal's current screen as plain rows. Each attach replays the whole screen; escape
     * sequences are dropped, and a cursor-forward run keeps the spaces it skips. */
    async function screen(): Promise<string[]> {
      const viewportId = `harness-proof-${++views}`;
      const snapshot = Promise.withResolvers<string>();
      const off = viewer.on("terminal_snapshot", message => {
        if (message.terminalId !== terminal.id || message.viewportId !== viewportId) return;
        viewer.ackTerminal(terminal.id, viewportId, message.deliveryId, message.deliverySeq);
        snapshot.resolve(Buffer.from(message.data, "base64").toString("utf8"));
      });
      const timer = setTimeout(() => snapshot.reject(new HarnessProofFailure(`${phase}-snapshot-timeout`)), 10_000);
      viewer.attachTerminal(terminal.id, viewportId);
      try {
        return (await snapshot.promise)
          .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
          .replace(/\x1b\[(\d*)C/g, (_, count: string) => " ".repeat(Number(count || "1")))
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
          .replace(/\x1b[()][0-9A-Za-z]|\x1b[@-_]/g, "")
          .split(/\r?\n/);
      } finally {
        clearTimeout(timer);
        off();
        viewer.detachTerminal(terminal.id, viewportId);
      }
    }
    async function until(predicate: () => Promise<boolean>, code: string, timeoutMs = 30_000): Promise<void> {
      try { await waitFor(async () => { check(!inferenceFailure, "synthetic-inference-contract"); return await predicate(); }, timeoutMs, 250); }
      catch (error) {
        if (error instanceof HarnessProofFailure) throw error;
        // A harness that failed prints its fixed code on the operator's terminal.
        const reason = (await screen().catch(() => [])).join("\n").match(/\bomp_[a-z_]{1,48}\b/)?.[0];
        throw new HarnessProofFailure(reason ? `${code}-${reason.replaceAll("_", "-")}` : code);
      }
    }
    const activity = (expected: RunActivity, code: string) =>
      until(async () => (await inspect()).activity === expected, `activity-${code}`);

    phase = "tui-start";
    // The TUI opens on the profile's dials. The Run reports `idle` on its own credential before any acknowledgement.
    await until(async () => (await screen()).some(row => LOW_GPT5.test(row)), "status-before-dial", 120_000);
    await activity("idle", "idle-at-launch");
    // The session's first model, reported once it serves one and accepted by the Run's own harness.
    await model({ provider: "openai", model: "gpt-5" }, "at-launch");
    const job = await waitFor(async () => {
      const listed = ListJobRunsResultSchema.parse(await ownerAction(hub, "engine.jobs.listRuns", {
        machineId: target.machineId, pluginId: OMP_PLUGIN_ID, operationId: HARNESS_OPERATION_ID }));
      return listed.runs.flatMap(({ job }) => job?.terminal?.terminalId === terminal.id ? [job] : [])[0] ?? false;
    }, 10_000, 100);
    check(job.state === "started" && job.terminal?.runId === runId, "harness-job-not-run-bound");
    check((await inspect()).state === "pending_policy", "harness-acknowledged-policy");

    phase = "control";
    const dials = await controlRun(hub.ownerKey, { runId, model: "openai/o3", thinking: "high" });
    check(typeof dials === "object" && dials.model === "openai/o3" && dials.thinking === "high", "dials-not-applied");
    await until(async () => (await screen()).some(row => HIGH_O3.test(row)), "status-after-dial", 10_000);
    // The confirmed switch reaches `Run.model`, while the Run still awaits its policy and stays idle.
    await model({ provider: "openai", model: "o3" }, "after-dial");
    check((await inspect()).state === "pending_policy", "model-report-acknowledged-policy");
    await activity("idle", "idle-after-dial");
    // A model the session does not serve changes nothing and says so.
    check(await controlRun(hub.ownerKey, { runId, model: "openai/not-served" }) === "omp_model_unavailable", "unserved-model-not-refused");
    await model({ provider: "openai", model: "o3" }, "after-unserved-dial");

    phase = "authority";
    // HUMAN SPONSORSHIP: an Agent principal that Manifold admits to ordinary doors, this Agent's
    // own policy-current Run, is refused by the door itself before it reads anything.
    const witness = CreateRunV2CredentialResultSchema.parse(await asToken(runnerToken, "core.access.createRunV2", {
      agentId: agent.agentId, ...runScope }));
    runs.push(witness.run.id);
    const challenge = AgentPolicyChallengeSchema.parse(await asToken(witness.credential.token, "core.access.getAgentPolicy", {}));
    await asToken(witness.credential.token, "core.access.acknowledgeAgentPolicyV2", { revision: challenge.revision,
      acknowledgements: challenge.required.map(({ id, digest }) => ({ id, digest })) });
    check(await controlRun(witness.credential.token, { runId, thinking: "minimal" }) === "omp_run_control_forbidden", "agent-principal-not-refused");
    check(await controlRun(witness.credential.token, { runId: witness.run.id, thinking: "minimal" }) === "omp_run_control_forbidden",
      "own-run-not-refused");
    await ownerAction(hub, "core.access.finishAgentRunV2", { runId: witness.run.id, outcome: "completed" });

    phase = "turn";
    held = Promise.withResolvers<void>();
    await ownerAction(hub, "core.access.sendRunInput", { runId, input: "NATIVE-HARNESS-TURN-1" });
    await activity("working", "working-in-turn");
    held.resolve();
    await activity("done", "done-after-turn");
    check(JSON.stringify(turns.get("NATIVE-HARNESS-TURN-1")) === JSON.stringify({ model: "openai/o3", thinking: "high" }), "turn-not-on-dials");
    await until(async () => (await screen()).join("\n").includes("NATIVE-HARNESS-TURN-1-REPLY"), "turn-not-rendered", 10_000);

    phase = "renewal";
    // Past the Run's first lease: renewed on its own credential, still pending acknowledgement.
    const createdAt = created.run.createdAt;
    await until(async () => Date.now() > createdAt + LEASE_MS + 5_000, "lease-wait", LEASE_MS + 30_000);
    const renewed = await inspect();
    check(renewed.renewals >= 1 && renewed.expiresAt > Date.now() && renewed.state === "pending_policy", "run-not-renewed");
    // Activity keeps reporting on the renewed credential, and the dials hold.
    held = Promise.withResolvers<void>();
    await ownerAction(hub, "core.access.sendRunInput", { runId, input: "NATIVE-HARNESS-TURN-2" });
    await activity("working", "working-after-renewal");
    held.resolve();
    await activity("done", "done-after-renewal");
    check(JSON.stringify(turns.get("NATIVE-HARNESS-TURN-2")) === JSON.stringify({ model: "openai/o3", thinking: "high" }), "dials-lost-on-renewal");
    await model({ provider: "openai", model: "o3" }, "after-renewal");

    phase = "exit";
    // The operator quits the TUI; the harness settles its Run.
    viewer.sendTerminalInput(terminal.id, "\x04");
    const settled = await waitFor(async () => {
      const value = PublicJobSchema.parse(await ownerAction(hub, "engine.jobs.status", {
        node: { kind: "job", machineId: target.machineId, operationId: HARNESS_OPERATION_ID, jobId: job.jobId } }));
      return value.result ? value : false;
    }, 30_000, 100);
    check(settled.state === "exited" && settled.result?.exitCode === 0, `harness-${settled.state}-${String(settled.result?.exitCode ?? "none")}`);
    terminalId = undefined;
    await until(async () => (await inspect()).state === "completed", "run-not-completed", 10_000);
  } catch (error) {
    failed = true;
    throw error instanceof HarnessProofFailure ? error : new HarnessProofFailure(`${phase}-failed`);
  } finally {
    let cleanupFailed = false;
    if (terminalId) try {
      await ownerAction(hub, "core.terminals.kill", { terminalId });
      await waitFor(async () => {
        const listed = ListJobRunsResultSchema.parse(await ownerAction(hub, "engine.jobs.listRuns", {
          machineId: target.machineId, pluginId: OMP_PLUGIN_ID, operationId: HARNESS_OPERATION_ID }));
        return listed.runs.every(({ job }) => job?.terminal?.terminalId !== terminalId || job?.result !== null);
      }, 30_000, 100);
    } catch { cleanupFailed = true; }
    home?.close();
    canvas?.close();
    held?.resolve();
    for (const runId of runs) try {
      const run = InspectRunV2ResultSchema.parse(await ownerAction(hub, "core.access.inspectRunV2", { runId })).run;
      if (["active", "pending_policy", "policy_stale"].includes(run.state))
        await ownerAction(hub, "core.access.finishAgentRunV2", { runId, outcome: failed ? "failed" : "completed" });
    } catch { cleanupFailed = true; }
    if (agent) try {
      await ownerAction(hub, "core.access.retireAgentV2", { agentId: agent.agentId });
      await ownerAction(hub, "core.access.revoke", { principalId: agent.principalId });
    } catch { cleanupFailed = true; }
    if (originalServices) try {
      const current = ServiceConfigurationReadSchema.parse(await ownerAction(hub, "engine.services.readConfiguration", { machineId: target.machineId }));
      await ownerAction(hub, "engine.services.configureConfiguration", { machineId: target.machineId,
        expectedRevision: current.configuration.revision, policies: originalServices.policies });
    } catch { cleanupFailed = true; }
    gateway.stop(true);
    if (credential) try {
      await call("disableCredential", { containerId: target.containerId, reference: credential.reference, credentialId: credential.id });
    } catch { cleanupFailed = true; }
    if (!failed) check(!cleanupFailed, "cleanup-failed");
  }
}
