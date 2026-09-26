import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { NativeToolConsumer, NativeToolConsumerModule } from "./verify-consumer-types.ts";
import { z } from "zod";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type { AssistantMessage, AssistantMessageEvent, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import {
  AgentPolicyChallengeSchema, AgentRunInspectionSchema, AgentToolReplySchema, CreateRunResultSchema, RegisterAgentResultSchema,
  FinishAgentRunResultSchema, GetAgentResultSchema, JobDeploymentReviewSchema, JobDeploymentSchema, RevokeResultSchema,
  JobDescriptionSchema, JobOutputPageSchema, PublicJobSchema, ServiceConfigurationReadSchema, ServicePolicySchema,
  MANIFOLD_ROOT_URI, MAX_JOB_OUTPUT_PAGE_BYTES, actionResultProjectionDigest, agentToolName, canonicalJobJson,
  type AgentToolReply, type PublicJob,
} from "@manifold/protocol";
import { compilePlugin } from "../../../manifold/packages/plugin-kit/src/pack.ts";
import { installBundle } from "../../../manifold/packages/plugin-kit/src/install.ts";
import { dispatch, ownerAction, roster } from "../../../manifold/packages/plugin-kit/src/hub.ts";
import { waitFor } from "../../../manifold/packages/testkit/src/index.ts";
import {
  actionSchemas, OmpHarnessProfileSchema, type AccountReference, type ActionInput, type ActionResult, type OmpAction,
} from "../api/index.ts";

interface Options {
  root: string;
  policyFile: string;
  hub: { url: string; ownerKey: string };
  target: { machineId: string; containerId: string };
  expectedDefaultsRevision: number;
  broker: { origin: string; bearer: string };
  installed: string[];
  consumerModule?: string;
  call<K extends OmpAction>(name: K, input: ActionInput<K>): Promise<ActionResult<K>>;
}
export class NativeToolProofFailure extends Error {
  constructor(readonly code: string) { super(`Native tool proof: ${code}`); }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new NativeToolProofFailure(code);
}
const fixtureId = "fixture.omp-tools";
const door = `${fixtureId}.commit`;
const toolName = agentToolName(door);
const unselectedName = agentToolName(`${fixtureId}.unselected`);
const effectsSchema = z.array(z.strictObject({ marker: z.string(), runId: z.string(), traceId: z.number() }));

/** The real public session doors, packed native owner and SDK. Only inference is synthetic.
 * Initial native admission uses the existing trusted-launcher policy acknowledgement;
 * the mandatory-policy rotation below is acknowledged exclusively by model-visible tools.
 */
export async function verifyNativeTools(options: Options): Promise<void> {
  const { root, hub, target, call, policyFile, installed } = options;
  let phase = "install";
  let gateway: Bun.Server<undefined> | undefined;
  let activeJob: PublicJob | undefined;
  let agentId: string | undefined;
  let agentPrincipalId: string | undefined;
  let runnerToken: string | undefined;
  let credentialId: number | undefined;
  let accountReference: AccountReference | undefined;
  let fixtureReady = false;
  let originalServices: z.infer<typeof ServiceConfigurationReadSchema>["configuration"] | undefined;
  const ownedRuns: string[] = [];
  let failed = false;
  let inferenceFailure: NativeToolProofFailure | undefined;
  let consumer: NativeToolConsumer | undefined;
  const runSession = (input: ActionInput<"runSession">) => consumer ? consumer.runSession(input) : call("runSession", input);
  const readSession = (input: ActionInput<"readSession">) => consumer ? consumer.readSession(input) : call("readSession", input);
  const cancelSession = (input: ActionInput<"cancelSession">) => consumer ? consumer.cancelSession(input) : call("cancelSession", input);
  const observe = async () => effectsSchema.parse(await ownerAction(hub, `${fixtureId}.observe`, {}));
  async function asToken(token: string, action: string, input: unknown) {
    const result = await dispatch(hub, token, action, input);
    check(result.ok, `${phase}-door-refused`);
    return result.result;
  }
  try {
    const compiled = await compilePlugin(resolve(import.meta.dir, "../test/fixtures/native-tools"));
    const file = join(root, "native-tools.manifold-plugin.json");
    await writeFile(file, compiled.bytes, { mode: 0o600 });
    installed.push(fixtureId);
    await installBundle({ source: file, sha256: compiled.sha256, hub, hardened: true });
    fixtureReady = true;
    const publication = (await roster(hub)).find(row => row.manifest.id === fixtureId)?.actions.find(action => action.name === door);
    check(publication?.resultProjection, "projection-not-published");
    const approval = { door, contractDigest: await actionResultProjectionDigest(publication.resultProjection), maxResultBytes: 1024 };

    phase = "disposable-account";
    // Existing broker client ingress owns this one synthetic slot. No provider is contacted.
    const upload = await fetch(`${options.broker.origin}/v1/credential`, {
      method: "POST", headers: { authorization: `Bearer ${options.broker.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", credential: { type: "api_key", key: "SYNTHETIC-UNPAID-NATIVE-TOOL-PROOF" } }),
      signal: AbortSignal.timeout(5000),
    });
    check(upload.ok, "synthetic-account-upload");
    await upload.body?.cancel();
    const accounts = await call("accounts", {});
    const account = accounts.accounts.find(value => value.reference.provider === "openai");
    check(account && !account.disabled, "synthetic-account-unobserved");
    credentialId = account.credentialId;
    accountReference = account.reference;
    const accountPool = { openai: [{ scope: account.reference.scope, credentialId: account.credentialId, identityKey: account.identityKey }] };
    let base: ActionInput<"reviewSession"> = { ...target, expectedDefaultsRevision: options.expectedDefaultsRevision, accountPool,
      overlay: { modelRoles: { default: "openai/gpt-5" }, defaultThinkingLevel: "low" as const,
        retry: { enabled: false, modelFallback: false }, prewalk: { enabled: false }, advisor: { enabled: false } },
      skills: { mode: "disabled" as const }, prompt: "NATIVE-TOOL-COMPOSITION-PROOF", planYolo: false };

    phase = "registered-agent-profile";
    const profile = OmpHarnessProfileSchema.parse({ accountPool, overlay: base.overlay, planYolo: false });
    phase = "registered-agent";
    const grant = { caps: ["containers:write" as const], tools: [approval], targets: [MANIFOLD_ROOT_URI],
      reach: "subtree" as const, maxRunLifetimeMs: 300_000, delegation: { maxDepth: 0, maxDescendants: 0 }, expiresAt: Date.now() + 900_000 };
    const registration = await dispatch(hub, hub.ownerKey, "core.access.registerAgent", {
      name: "Disposable native OMP tool witness", purpose: "Prove the packed consumer composition without paid inference",
      harness: "atyrode.omp", grant, context: { profile },
    });
    if (!registration.ok) {
      const known = new Map([
        ["harness unavailable", "harness-unavailable"], ["harness profile invalid", "harness-profile-invalid"],
        ["agent_registration_requires_human", "registration-requires-human"],
        ["sponsor_authority_unavailable", "sponsor-authority-unavailable"],
      ]);
      throw new NativeToolProofFailure(known.get(registration.denial.message) ?? "registration-door-refused");
    }
    const registered = RegisterAgentResultSchema.parse(registration.result);
    check(registered.created && registered.credential, "agent-runner-missing");
    agentId = registered.agent.agentId;
    agentPrincipalId = registered.agent.principalId;
    runnerToken = registered.credential.token;

    let scenario: "policy" | "cancel" | "default-off" = "policy";
    let runId = "";
    let turn = 0;
    let waitingForCancellation = false;
    let challenge: z.infer<typeof AgentPolicyChallengeSchema> | undefined;
    const replies = new Map<string, AgentToolReply>();
    const modelCalls: string[] = [];
    function respond(content: AssistantMessage["content"], model: string) {
      const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "openai", model,
        content, stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const events: AssistantMessageEvent[] = [{ type: "start", partial: message }];
      for (let index = 0; index < content.length; index++) {
        const item = content[index]!;
        if (item.type === "toolCall") events.push({ type: "toolcall_start", contentIndex: index, partial: message },
          { type: "toolcall_end", contentIndex: index, toolCall: item, partial: message });
        else if (item.type === "text") events.push({ type: "text_start", contentIndex: index, partial: message },
          { type: "text_delta", contentIndex: index, delta: item.text, partial: message },
          { type: "text_end", contentIndex: index, content: item.text, partial: message });
      }
      events.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }
    function emit(id: string, name: string, args: Record<string, unknown>): AssistantMessage["content"] {
      modelCalls.push(id);
      return [{ type: "toolCall", id, name, arguments: args }];
    }
    gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
      try {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/v1/models") return Response.json({ object: "list", data: [{
          id: "gpt-5", object: "model", owned_by: "openai", api: "openai-completions", display_name: "gpt-5",
          context_length: 200_000, max_output_tokens: 8192, input_modalities: ["text"],
        }] });
        check(request.method === "POST" && url.pathname === "/v1/pi/stream", "unexpected-inference-route");
        const parsed = parseRequest(await request.json(), request.headers);
        const tools = parsed.context.tools ?? [];
        if (scenario === "default-off") {
          check(!tools.some(tool => tool.name.startsWith("manifold")), "default-off-tool-leak");
          check(tools.some(tool => tool.name === "read"), "default-off-discovery-disabled");
          turn++;
          check(turn === 1, "default-off-extra-turn");
          return respond([{ type: "text", text: "NATIVE-TOOL-DEFAULT-OFF" }], "gpt-5");
        }
        if (tools.length === 0) return respond([{ type: "text", text: "Disposable tool proof" }], "gpt-5");
        check(parsed.modelId === "openai/gpt-5", "synthetic-model-changed");
        const selected = tools.find(tool => tool.name === toolName);
        check(selected && tools.some(tool => tool.name === "manifold_policy") && tools.some(tool => tool.name === "manifold_ack_policy")
          && !tools.some(tool => tool.name === "manifold" || tool.name === unselectedName), "model-registry-widened");
        const parameters = selected.parameters as { properties?: Record<string, unknown>; required?: string[] };
        check(parameters.properties?.marker && parameters.required?.includes("marker") && !parameters.properties?.args,
          "selected-schema-not-flat");
        for (const message of parsed.context.messages) {
          if (message.role !== "toolResult") continue;
          const result = message as ToolResultMessage;
          const text = result.content.filter(part => part.type === "text").map(part => part.text).join("");
          if (result.toolCallId === "unselected" || result.toolCallId === "invalid") {
            if (!result.isError) {
              const denial = AgentToolReplySchema.parse(JSON.parse(text));
              check(denial.type === "refused" || (denial.type === "result" && !denial.outcome.ok),
                `${result.toolCallId}-call-not-denied-${denial.type}`);
            }
            continue;
          }
          if (!modelCalls.includes(result.toolCallId)) continue;
          const reply = AgentToolReplySchema.parse(JSON.parse(text));
          replies.set(result.toolCallId, reply);
          check(!text.includes("NOT-PUBLISHED-TO-THE-MODEL"), "private-effect-leaked");
        }
        turn++;
        check(turn <= 9, "automatic-replay-or-extra-turn");
        if (scenario === "cancel") {
          check(turn === 1, "cancelled-invocation-replayed");
          waitingForCancellation = true;
          return respond(emit("uncertain", toolName, { marker: "uncertain", wait: true }), "gpt-5");
        }
        if (turn === 1) {
          // SDK startup has described tools, but has not acknowledged this revision.
          await writeFile(policyFile, "Disposable native proof policy B: read and acknowledge this exact revision before committing.\n", { mode: 0o600 });
          const rotated = await ownerAction(hub, "core.access.reloadAgentPolicy", {}) as { suspendedRuns: number };
          check(rotated.suspendedRuns === 1, "mandatory-policy-not-rotated");
          return respond(emit("before-policy", toolName, { marker: "forbidden-before-policy" }), "gpt-5");
        }
        if (turn === 2) {
          const denied = replies.get("before-policy");
          check(denied?.type === "result" && !denied.outcome.ok && denied.outcome.denial.rule === "policy_stale",
            "stale-policy-effect-not-denied");
          check((await observe()).length === 0, "stale-policy-mutated");
          return respond(emit("policy-read", "manifold_policy", {}), "gpt-5");
        }
        if (turn === 3) {
          const policy = replies.get("policy-read");
          check(policy?.type === "policy" && policy.policy.runId === runId && policy.policy.acknowledgedAt === undefined,
            "model-policy-challenge-missing");
          challenge = policy.policy;
          check(challenge.required.some(bundle => bundle.source === "operator" && bundle.body.includes("policy B")), "model-policy-wrong-revision");
          const pending = AgentRunInspectionSchema.parse(await ownerAction(hub, "core.access.inspectRun", { runId }));
          check(pending.run.state === "policy_stale" && pending.run.acknowledgedPolicyRevision !== challenge.revision
            && pending.run.policyAcknowledgedAt === null,
            "policy-read-implicitly-acknowledged");
          check((await observe()).length === 0, "policy-read-acknowledged-or-mutated");
          return respond(emit("policy-ack", "manifold_ack_policy", { revision: challenge.revision,
            acknowledgements: challenge.required.map(({ id, digest }) => ({ id, digest })) }), "gpt-5");
        }
        if (turn === 4) {
          const ack = replies.get("policy-ack");
          check(ack?.type === "result" && ack.outcome.ok, "model-policy-ack-failed");
          const acknowledged = AgentRunInspectionSchema.parse(await ownerAction(hub, "core.access.inspectRun", { runId }));
          check(acknowledged.run.state === "active" && acknowledged.run.acknowledgedPolicyRevision === challenge?.revision,
            "model-ack-not-durable");
          return respond(emit("unselected", unselectedName, { marker: "forbidden-unselected" }), "gpt-5");
        }
        if (turn === 5) {
          check((await observe()).length === 0, "unselected-tool-mutated");
          return respond(emit("invalid", toolName, { marker: 42, door: `${fixtureId}.unselected` }), "gpt-5");
        }
        if (turn === 6) {
          check((await observe()).length === 0, "invalid-tool-mutated");
          return respond(emit("selected", toolName, { marker: "selected" }), "gpt-5");
        }
        if (turn === 7) {
          const selectedReply = replies.get("selected");
          check(selectedReply?.type === "result" && selectedReply.outcome.ok && selectedReply.projection?.ok
            && selectedReply.projection.trust === "untrusted", "selected-effect-not-projected");
          const effects = await observe();
          check(effects.length === 1 && effects[0]?.marker === "selected" && effects[0].runId === runId
            && effects[0].traceId === selectedReply.traceId, "effect-trace-run-mismatch");
          check(JSON.stringify(selectedReply.projection.data) === JSON.stringify(effects[0]), "projection-differs-from-durable-effect");
          // Change live authority after descriptor creation. The closure must not
          // pick up a broader descriptor or an alternate invocation path.
          GetAgentResultSchema.parse(await ownerAction(hub, "core.access.updateAgent", {
            agentId, grant: { ...grant, tools: [{ ...approval, maxResultBytes: 32 }] },
          }));
          return respond(emit("changed-grant", toolName, { marker: "forbidden-changed-grant" }), "gpt-5");
        }
        const changed = replies.get("changed-grant");
        check(changed?.type === "refused" && changed.code === "publication_changed", "changed-grant-widened");
        check((await observe()).length === 1, "changed-grant-mutated");
        return respond([{ type: "text", text: "NATIVE-TOOL-PROOF-COMPLETE" }], "gpt-5");
      } catch (error) {
        inferenceFailure = error instanceof NativeToolProofFailure ? error : new NativeToolProofFailure("synthetic-inference-contract");
        return new Response(null, { status: 500 });
      }
    } });

    phase = "owner-service-policy";
    originalServices = ServiceConfigurationReadSchema.parse(await ownerAction(hub, "engine.services.readConfiguration", { machineId: target.machineId })).configuration;
    // Match the packed operation's service contract, not the configuration CAS revision.
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
      expectedRevision: originalServices.revision, policies: [...originalServices.policies.filter(item => item.serviceId !== "omp"), policy] });
    // Configuration admission is not native-owner acknowledgement. Wait for its
    // exact non-secret policy fingerprint before reviewing resource bindings.
    const policyDigest = createHash("sha256").update(canonicalJobJson(policy)).digest("hex");
    await waitFor(async () => {
      const native = JobDescriptionSchema.parse(await ownerAction(hub, "engine.jobs.describe", {
        machineId: target.machineId, pluginId: "atyrode.omp",
      }));
      return native.connected && native.resources?.services.omp === policyDigest;
    }, 30_000, 50);

    phase = "packed-session-deployment";
    const deployment = { deploymentId: randomUUID(), pluginId: "atyrode.omp",
      targets: [{ machineId: target.machineId, platform: "linux-x64" }],
      operationIds: ["atyrode.omp.session", ...(options.consumerModule ? ["atyrode.omp.launch"] : [])] };
    const reviewed = JobDeploymentReviewSchema.parse(await ownerAction(hub, "engine.jobs.reviewDeployment", deployment));
    const reviewReason = reviewed.targets.find(item => !item.approvable)?.reason;
    const knownReviewReason = [
      "executor_revoked_or_unknown", "plugin_disabled", "owner_identity_unproved",
      "installation_platform_unavailable", "resource_evidence_unknown",
      "artifact_bundle_unavailable", "active_installation", "owner_offline",
    ].find(reason => reason === reviewReason);
    check(reviewed.approvable, knownReviewReason
      ? `packed-session-${knownReviewReason.replaceAll("_", "-")}` : "packed-session-review-refused");
    await ownerAction(hub, "engine.jobs.applyDeployment", { request: deployment, reviewDigest: reviewed.reviewDigest });
    await waitFor(async () => {
      const current = JobDeploymentSchema.parse(await ownerAction(hub, "engine.jobs.readDeployment", { deploymentId: deployment.deploymentId }));
      check(!current.targets.some(item => ["refused", "needs_review", "cancelled", "superseded"].includes(item.state)), "packed-session-install-refused");
      return current.targets.every(item => item.state === "ready");
    }, 480_000, 100);

    if (options.consumerModule) {
      phase = "consumer-configuration";
      // The consuming repository explicitly selects this verifier-only module.
      const module = await import(pathToFileURL(options.consumerModule).href) as NativeToolConsumerModule;
      check(typeof module.createNativeToolConsumer === "function", "consumer-module-invalid");
      consumer = await module.createNativeToolConsumer({ root, hub, target, installed, input: base, accounts });
      check(consumer.originDoor.length > 0 && consumer.input.machineId === target.machineId
        && consumer.input.containerId === target.containerId && consumer.input.agentTools === undefined,
        "consumer-input-invalid");
      base = consumer.input;
    }

    async function launch() {
      phase = `${scenario}-run-admission`;
      const created = CreateRunResultSchema.parse(await asToken(runnerToken!, "core.access.createRun", {
        agentId, tools: [door], lifetimeMs: 300_000, target: MANIFOLD_ROOT_URI,
      }));
      ownedRuns.push(created.run.id);
      runId = created.run.id;
      check(created.credential && created.run.state === "pending_policy", "run-not-fresh");
      // Normal native admission is unchanged. This is a launcher acknowledgement,
      // explicitly NOT the model acknowledgement tested after startup above.
      const initial = AgentPolicyChallengeSchema.parse(await asToken(created.credential.token, "core.access.getAgentPolicy", {}));
      await asToken(created.credential.token, "core.access.acknowledgeAgentPolicy", { revision: initial.revision,
        acknowledgements: initial.required.map(({ id, digest }) => ({ id, digest })) });
      const args = { ...base, agentTools: { runId } };
      phase = `${scenario}-session-review`;
      const review = await call("reviewSession", args);
      check(review.operationId === "atyrode.omp.session" && review.agentTools?.runId === runId, "review-not-tool-selected");
      // A changed selector must refuse at the public door, before it can consume a Run.
      const changedSelector = await dispatch(hub, hub.ownerKey, "atyrode.omp.runSession", {
        ...args, agentTools: { runId: randomUUID() }, reviewDigest: review.reviewDigest,
      });
      check(!changedSelector.ok && changedSelector.denial.rule === "refused", "review-selector-not-fenced");
      phase = `${scenario}-session-admission`;
      activeJob = PublicJobSchema.parse(await runSession({ ...args, reviewDigest: review.reviewDigest }));
      phase = `${scenario}-session-settlement`;
      check(activeJob.agentRunId === runId, "session-run-binding-changed");
      check(activeJob.authority.origin.kind === "action" && activeJob.authority.origin.door === (consumer?.originDoor ?? "atyrode.omp.runSession"),
        "session-bypassed-public-door");
    }
    phase = "policy-composition";
    await launch();
    activeJob = await waitFor(async () => {
      if (inferenceFailure) throw inferenceFailure;
      const job = PublicJobSchema.parse(await ownerAction(hub, "engine.jobs.status", {
        node: { kind: "job", machineId: target.machineId, operationId: "atyrode.omp.session", jobId: activeJob!.jobId },
      }));
      return job.result ? job : false;
    }, 120_000, 50);
    if (activeJob.state !== "exited" || activeJob.result?.exitCode !== 0 || turn !== 8) {
      const stderr = activeJob.result?.outputs.find(output => output.name === "stderr");
      if (stderr && stderr.bytes > 0 && stderr.bytes <= 65_536) {
        const page = JobOutputPageSchema.parse(await ownerAction(hub, "engine.jobs.outputs", {
          node: { kind: "job", machineId: target.machineId, operationId: "atyrode.omp.session",
            jobId: activeJob.jobId },
          name: "stderr", offset: 0, limit: 65_536,
        }));
        // The worker deliberately emits fixed codes, never raw provider diagnostics.
        const code = Buffer.from(page.data, "base64").toString("utf8").split("\n")
          .find(line => /^omp_(?:resume|sdk|restricted|agent_tools|harness)_[a-z_]{1,48}$/.test(line));
        if (code) throw new NativeToolProofFailure(code.replaceAll("_", "-"));
      }
      throw new NativeToolProofFailure(`session-${activeJob.state}-${String(activeJob.result?.exitCode ?? "none")}-turn-${String(turn)}`);
    }
    await assertJournal(activeJob, runId, ["before-policy", "policy-read", "policy-ack", "unselected", "invalid", "selected", "changed-grant"], replies);
    const receipt = actionSchemas.readSession.result.parse(await readSession({ ...target, jobId: activeJob.jobId }));
    check(receipt.session?.finalMessage.includes("NATIVE-TOOL-PROOF-COMPLETE"), "public-session-receipt-missing");
    activeJob = undefined;

    phase = "uncertain-cancellation";
    GetAgentResultSchema.parse(await ownerAction(hub, "core.access.updateAgent", { agentId, grant }));
    scenario = "cancel"; turn = 0; replies.clear(); modelCalls.length = 0;
    await launch();
    await waitFor(async () => {
      if (inferenceFailure) throw inferenceFailure;
      return waitingForCancellation && (await observe()).some(effect => effect.marker === "uncertain" && effect.runId === runId);
    }, 30_000, 25);
    await cancelSession({ ...target, jobId: activeJob!.jobId });
    activeJob = await waitFor(async () => {
      const job = PublicJobSchema.parse(await ownerAction(hub, "engine.jobs.status", {
        node: { kind: "job", machineId: target.machineId, operationId: "atyrode.omp.session", jobId: activeJob!.jobId },
      }));
      return job.result ? job : false;
    }, 30_000, 25);
    check(activeJob.state === "cancelled" && turn === 1, "uncertain-cancel-replayed");
    await ownerAction(hub, `${fixtureId}.release`, {});
    await assertJournal(activeJob, runId, ["uncertain"], new Map());
    const effects = await observe();
    check(effects.length === 2 && effects.filter(effect => effect.marker === "uncertain").length === 1,
      "uncertain-effect-replayed");
    activeJob = undefined;

    if (consumer) {
      phase = "consumer-default-off";
      scenario = "default-off"; turn = 0;
      const review = await call("reviewSession", base);
      check(review.operationId === "atyrode.omp.launch" && review.agentTools === undefined, "default-off-review-selected-tools");
      activeJob = PublicJobSchema.parse(await runSession({ ...base, reviewDigest: review.reviewDigest }));
      check(activeJob.agentRunId === undefined && activeJob.authority.origin.kind === "action"
        && activeJob.authority.origin.door === consumer.originDoor, "default-off-job-selected-tools");
      const ordinary = await waitFor(async () => {
        if (inferenceFailure) throw inferenceFailure;
        const result = await readSession({ ...target, jobId: activeJob!.jobId });
        return result.job.result ? result : false;
      }, 120_000, 50);
      check(ordinary.job.state === "exited" && ordinary.job.result?.exitCode === 0 && turn === 1
        && ordinary.session?.finalMessage.includes("NATIVE-TOOL-DEFAULT-OFF"), "default-off-session-failed");
      check((await observe()).length === 2, "default-off-tool-effect");
      activeJob = undefined;
    }

    async function assertJournal(job: PublicJob, expectedRunId: string, ids: string[], expectedReplies: Map<string, AgentToolReply>) {
      const output = job.result?.outputs.find(item => item.name === "session");
      check(output?.sha256 && output.bytes > 0 && output.bytes <= 16 * 1024 * 1024, "sealed-session-output-missing");
      const archive = Buffer.alloc(output.bytes);
      let offset = 0;
      while (offset < archive.length) {
        const page = JobOutputPageSchema.parse(await ownerAction(hub, "engine.jobs.outputs", {
          node: { kind: "job", machineId: target.machineId, operationId: "atyrode.omp.session", jobId: job.jobId },
          name: "session", offset, limit: Math.min(MAX_JOB_OUTPUT_PAGE_BYTES, archive.length - offset),
        }));
        const bytes = Buffer.from(page.data, "base64");
        check(page.offset === offset && bytes.length > 0 && offset + bytes.length <= archive.length, "sealed-session-page-invalid");
        bytes.copy(archive, offset); offset += bytes.length;
      }
      check(createHash("sha256").update(archive).digest("hex") === output.sha256, "sealed-session-digest-mismatch");
      const entrySchema = z.object({ type: z.string(), id: z.string().optional(), message: z.object({
        role: z.string(), toolCallId: z.string().optional(), details: z.unknown().optional(), isError: z.boolean().optional(),
      }).optional() });
      const journals: { name: string; entries: z.infer<typeof entrySchema>[] }[] = [];
      for (let cursor = 0; cursor + 512 <= archive.length;) {
        const header = archive.subarray(cursor, cursor + 512);
        if (header.every(byte => byte === 0)) break;
        const field = (start: number, length: number) => header.subarray(start, start + length).toString().replace(/\0.*$/, "");
        const size = Number.parseInt(field(124, 12).trim(), 8);
        check(Number.isSafeInteger(size) && size >= 0 && cursor + 512 + size <= archive.length, "session-archive-invalid");
        const name = field(0, 100);
        if (name.endsWith(".jsonl")) journals.push({ name, entries: archive.subarray(cursor + 512, cursor + 512 + size).toString("utf8")
          .trim().split("\n").map(line => entrySchema.parse(JSON.parse(line))) });
        cursor += 512 + Math.ceil(size / 512) * 512;
      }
      check(journals.length === 1, "fixed-journal-not-unique");
      const journal = journals[0]!;
      const session = journal.entries.find(entry => entry.type === "session");
      const inspection = AgentRunInspectionSchema.parse(await ownerAction(hub, "core.access.inspectRun", { runId: expectedRunId }));
      check(session?.id && session.id === inspection.run.session?.sessionId && journal.name.endsWith(`${session.id}.jsonl`),
        "sealed-journal-run-session-mismatch");
      for (const id of ids) {
        const results = journal.entries.filter(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === id);
        check(results.length === 1, "journal-tool-result-missing-or-replayed");
        if ((id === "unselected" || id === "invalid") && results[0]!.message!.isError) continue;
        const result = AgentToolReplySchema.parse(results[0]!.message!.details);
        if (id === "uncertain") check(result.type === "unknown", "cancelled-uncertain-effect-claimed-certain");
        else if (id === "unselected" || id === "invalid")
          check(result.type === "refused" || (result.type === "result" && !result.outcome.ok), "journal-rejected-call-succeeded");
        else check(JSON.stringify(result) === JSON.stringify(expectedReplies.get(id)), "sealed-journal-model-result-mismatch");
      }
      const traceIds = (await observe()).filter(effect => effect.runId === expectedRunId).map(effect => effect.traceId);
      check(traceIds.every(id => inspection.traces.some(trace => trace.traceId === String(id)
        && trace.action === door && trace.actor === inspection.run.principalId)), "durable-effect-trace-missing");
    }
  } catch (error) {
    failed = true;
    if (error instanceof Error && "code" in error && typeof error.code === "string"
      && /^consumer-[a-z][a-z0-9-]{0,60}$/.test(error.code)) throw new NativeToolProofFailure(error.code);
    if (
      error instanceof Error && "code" in error && typeof error.code === "string" &&
      /^public-(?:review|run|read|cancel)-session-(?:invalid-request|operation-unavailable|broker-unavailable|resources-changed|result-unavailable|invalid-session|provenance-changed|model-substituted|unexpected-refusal)$/.test(error.code)
    ) throw new NativeToolProofFailure(error.code);
    throw error instanceof NativeToolProofFailure ? error : new NativeToolProofFailure(`${phase}-failed`);
  } finally {
    let cleanupFailed = false;
    if (activeJob) try { await cancelSession({ ...target, jobId: activeJob.jobId }); } catch { cleanupFailed = true; }
    if (fixtureReady) try { await ownerAction(hub, `${fixtureId}.release`, {}); } catch { cleanupFailed = true; }
    if (activeJob) try {
      await waitFor(async () => Boolean(PublicJobSchema.parse(await ownerAction(hub, "engine.jobs.status", {
        node: { kind: "job", machineId: target.machineId, operationId: "atyrode.omp.session", jobId: activeJob!.jobId },
      })).result), 30_000, 50);
    } catch { cleanupFailed = true; }
    for (const runId of ownedRuns) try {
      const inspection = AgentRunInspectionSchema.parse(await ownerAction(hub, "core.access.inspectRun", { runId }));
      if (["active", "pending_policy", "policy_stale"].includes(inspection.run.state))
        FinishAgentRunResultSchema.parse(await ownerAction(hub, "core.access.finishAgentRun", { runId, outcome: failed ? "failed" : "completed" }));
      const finished = AgentRunInspectionSchema.parse(await ownerAction(hub, "core.access.inspectRun", { runId }));
      check(finished.run.cleanup.status === "finished" && finished.credentials.every(credential => credential.state !== "live"),
        "run-authority-not-cleaned");
    } catch { cleanupFailed = true; }
    if (agentId) try { await ownerAction(hub, "core.access.retireAgent", { agentId }); } catch { cleanupFailed = true; }
    if (agentPrincipalId) try {
      const revoked = RevokeResultSchema.parse(await ownerAction(hub, "core.access.revoke", { principalId: agentPrincipalId }));
      check(revoked.revoked > 0, "agent-runner-credential-not-revoked");
    } catch { cleanupFailed = true; }
    runnerToken = undefined;
    if (originalServices) try {
      const current = ServiceConfigurationReadSchema.parse(await ownerAction(hub, "engine.services.readConfiguration", { machineId: target.machineId }));
      await ownerAction(hub, "engine.services.configureConfiguration", { machineId: target.machineId,
        expectedRevision: current.configuration.revision, policies: originalServices.policies });
    } catch { cleanupFailed = true; }
    gateway?.stop(true);
    if (credentialId !== undefined && accountReference) try {
      await call("disableCredential", { containerId: target.containerId, reference: accountReference, credentialId });
      const remaining = await call("accounts", {});
      check(remaining.accounts.every(account => account.credentialId !== credentialId || account.disabled),
        "synthetic-account-not-withdrawn");
    } catch { cleanupFailed = true; }
    await writeFile(policyFile, "Disposable native proof policy A.\n", { mode: 0o600 });
    try { await ownerAction(hub, "core.access.reloadAgentPolicy", {}); } catch { cleanupFailed = true; }
    check(!cleanupFailed, "native-tool-cleanup-failed");
  }
}
