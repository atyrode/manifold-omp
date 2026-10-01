import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { base64ToText, type SessionClient } from "@manifold/sdk";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import {
  InstanceServiceDescriptionSchema, JobDeploymentReviewSchema, JobDeploymentSchema, JobDescriptionSchema, ListJobRunsResultSchema,
  PublicJobSchema, ServiceConfigurationReadSchema, ServicePolicySchema, TerminalsResponseSchema, canonicalJobJson,
} from "@manifold/protocol";
import { dispatch, ownerAction } from "../../../manifold/packages/plugin-kit/src/hub.ts";
import { connect, waitFor, type TestServer } from "../../../manifold/packages/testkit/src/index.ts";
import {
  ACCOUNTS_PLUGIN_ID, BROKER_OPERATION_ID, BROKER_SERVICE_ID, GATEWAY_PLUGIN_ID,
  INTERACTIVE_HANDOFF_OPERATION_ID, OMP_PLUGIN_ID, SIGN_IN_OPERATION_ID, actionDoor,
  type AccountReference, type ActionInput, type ActionResult, type OmpAction,
} from "../api/index.ts";

export class NativeHandoffProofFailure extends Error {
  constructor(readonly code: string) { super(`Native handoff proof: ${code}`); }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new NativeHandoffProofFailure(code);
}

/** Real hardened public doors, SQLite claim, native terminal and public projections.
 * The only model service is this disposable synthetic loopback receiver. No Code,
 * browser fake, production credential, CLI cache or general resume is involved. */
export async function verifyNativeHandoff(options: {
  root: string;
  server: TestServer;
  target: { containerId: string; machineId: string };
  hub: Parameters<typeof ownerAction>[0];
  expectedDefaultsRevision: number;
  broker: { origin: string; bearer: string };
  call<K extends OmpAction>(name: K, input: ActionInput<K>): Promise<ActionResult<K>>;
}): Promise<void> {
  const { root, server, target, hub, call } = options;
  const canary = `PRIVATE-UNSENT-${randomUUID()}`;
  const edited = "NATIVE-HANDOFF-EDITED-USER-BUFFER";
  const continued = "NATIVE-HANDOFF-CONTINUED-SAME-SESSION";
  const clean = (value: unknown, code: string) => check(!JSON.stringify(value).includes(canary), code);
  let phase = "synthetic-account-upload";
  let posts = 0, discoveries = 0, userStreams = 0, titles = 0, sends = 0;
  let receiverFailure: NativeHandoffProofFailure | undefined;
  let originalServices: z.infer<typeof ServiceConfigurationReadSchema>["configuration"] | undefined;
  let credential: { credentialId: number; reference: AccountReference } | undefined;
  let home: SessionClient | undefined;
  let canvas: SessionClient | undefined;
  let terminalId: string | undefined;
  let terminalHome: string | undefined;
  let screen = "";
  const unsubscribe: (() => void)[] = [];
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    try {
      if (request.method === "POST") { posts++; check(sends > 0, "post-before-send"); }
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/v1/models") {
        discoveries++;
        return Response.json({ object: "list", data: [{ id: "gpt-5", object: "model", owned_by: "openai",
          api: "openai-completions", display_name: "gpt-5", context_length: 200000,
          max_output_tokens: 8192, input_modalities: ["text"] }] });
      }
      check(request.method === "POST" && path === "/v1/pi/stream", "unexpected-route");
      const parsed = parseRequest(await request.json(), request.headers);
      const title = (parsed.context.tools ?? []).length === 0;
      if (title) {
        check(JSON.stringify(parsed.context.systemPrompt).includes("<title>"), "unclassified-auxiliary-post");
        titles++;
      }
      else {
        userStreams++;
        check(userStreams === sends && userStreams <= 2 && parsed.modelId === "openai/gpt-5", "duplicate-user-stream");
        const users = parsed.context.messages.filter(message => message.role === "user");
        // SDK date/cwd context is a separate prefix block, not user-authored text.
        const text = (content: typeof users[number]["content"]) => typeof content === "string" ? content
          : content.findLast(block => block.type === "text")?.text ?? "";
        check(users.length === userStreams && text(users[0]!.content) === edited &&
          (userStreams === 1 || text(users[1]!.content) === continued), "edited-buffer-not-exact");
        clean(parsed.context, "original-draft-submitted");
      }
      const text = title ? "<title>Native handoff proof</title>" : userStreams === 1 ? "NATIVE-HANDOFF-FIRST-COMPLETE" : "NATIVE-HANDOFF-SECOND-COMPLETE";
      const message = { role: "assistant", api: "openai-completions", provider: "openai", model: "gpt-5",
        content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const events = [{ type: "start", partial: message }, { type: "text_start", contentIndex: 0, partial: message },
        { type: "text_delta", contentIndex: 0, delta: text, partial: message },
        { type: "text_end", contentIndex: 0, content: text, partial: message }, { type: "done", reason: "stop", message }];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } });
    } catch (error) {
      receiverFailure = error instanceof NativeHandoffProofFailure ? error : new NativeHandoffProofFailure("receiver-invalid");
      return new Response(null, { status: 400 });
    }
  } });
  try {
    const upload = await fetch(`${options.broker.origin}/v1/credential`, {
      method: "POST", headers: { authorization: `Bearer ${options.broker.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", credential: { type: "api_key", key: `SYNTHETIC-UNPAID-HANDOFF-${randomUUID()}` } }),
      signal: AbortSignal.timeout(5000),
    });
    check(upload.ok, "synthetic-account-upload");
    await upload.body?.cancel();
    phase = "account-observation";
    const account = (await call("accounts", {})).accounts.find(value => value.reference.provider === "openai" && !value.disabled);
    check(account, "synthetic-account-missing");
    credential = { credentialId: account.credentialId, reference: account.reference };
    const input: ActionInput<"reviewInteractiveHandoff"> = {
      ...target, handoffVersion: 1, handoffKey: `native-${randomUUID()}`,
      sourceDigest: createHash("sha256").update("synthetic provenance revision 1").digest("hex"),
      initialDraft: canary, prompt: "", planYolo: false, expectedDefaultsRevision: options.expectedDefaultsRevision,
      accountPool: { openai: [{ scope: account.reference.scope, credentialId: account.credentialId, identityKey: account.identityKey }] },
      overlay: { modelRoles: { default: "openai/gpt-5" }, defaultThinkingLevel: "low",
        retry: { enabled: false, modelFallback: false }, prewalk: { enabled: false }, advisor: { enabled: false } },
    };
    phase = "service-policy-read";
    originalServices = ServiceConfigurationReadSchema.parse(await ownerAction(hub, "engine.services.readConfiguration", { machineId: target.machineId })).configuration;
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
    phase = "service-policy-configure";
    await ownerAction(hub, "engine.services.configureConfiguration", { machineId: target.machineId,
      expectedRevision: originalServices.revision, policies: [...originalServices.policies.filter(value => value.serviceId !== "omp"), policy] });
    const policyDigest = createHash("sha256").update(canonicalJobJson(policy)).digest("hex");
    phase = "service-policy-ready";
    await waitFor(async () => {
      const native = JobDescriptionSchema.parse(await ownerAction(hub, "engine.jobs.describe", { machineId: target.machineId, pluginId: OMP_PLUGIN_ID }));
      return native.connected && native.resources?.services.omp === policyDigest;
    }, 30000, 50);
    await mkdir(join(root, "state", "omp", "sessions"), { recursive: true, mode: 0o700 });
    phase = "deployment-review";
    const deployment = { deploymentId: randomUUID(), pluginId: OMP_PLUGIN_ID,
      targets: [{ machineId: target.machineId, platform: "linux-x64" }], operationIds: [INTERACTIVE_HANDOFF_OPERATION_ID] };
    const nativeReview = JobDeploymentReviewSchema.parse(await ownerAction(hub, "engine.jobs.reviewDeployment", deployment));
    check(nativeReview.approvable, "deployment-review-refused");
    phase = "deployment-apply";
    await ownerAction(hub, "engine.jobs.applyDeployment", { request: deployment, reviewDigest: nativeReview.reviewDigest });
    phase = "deployment-ready";
    await waitFor(async () => {
      const current = JobDeploymentSchema.parse(await ownerAction(hub, "engine.jobs.readDeployment", { deploymentId: deployment.deploymentId }));
      check(!current.targets.some(item => ["refused", "needs_review", "cancelled", "superseded"].includes(item.state)), "deployment-refused");
      return current.targets.every(value => value.state === "ready");
    }, 480000, 100);
    phase = "handoff-review";
    const review = await call("reviewInteractiveHandoff", input);
    clean(review, "review-leaked-draft");
    const request = { ...input, reviewDigest: review.reviewDigest };
    phase = "handoff-claim";
    const prepared = await Promise.all(Array.from({ length: 4 }, () => call("prepareInteractiveHandoff", request)));
    const winner = prepared.find(value => value.state === "claimed");
    check(winner?.state === "claimed" && prepared.filter(value => "runtime" in value).length === 1, "claim-not-single-winner");
    check(prepared.every(value => value.claimId === winner.claimId && value.session.sessionId === winner.session.sessionId), "claim-association-changed");
    for (const value of prepared) if (value.state !== "claimed") clean(value, "retry-leaked-draft");
    // Reopen the real isolate/storage lifecycle before any terminal exists.
    // Dependents must close before their required parent. Disabling also revokes
    // native installations; restore them by review, never bypass that admission.
    phase = "reopen-snapshot";
    const accountsBefore = JobDescriptionSchema.parse(await ownerAction(hub, "engine.jobs.describe",
      { machineId: target.machineId, pluginId: ACCOUNTS_PLUGIN_ID }));
    const ompBefore = JobDescriptionSchema.parse(await ownerAction(hub, "engine.jobs.describe",
      { machineId: target.machineId, pluginId: OMP_PLUGIN_ID }));
    const brokerBefore = InstanceServiceDescriptionSchema.parse(await ownerAction(hub, "engine.services.describeInstance",
      { serviceId: BROKER_SERVICE_ID }));
    check(brokerBefore.state === "ready" && brokerBefore.configuration?.enabled, "reopen-broker-not-ready");
    const brokerRunsBefore = ListJobRunsResultSchema.parse(await ownerAction(hub, "engine.jobs.listRuns",
      { machineId: target.machineId, pluginId: ACCOUNTS_PLUGIN_ID, operationId: BROKER_OPERATION_ID }));
    const liveBrokers = brokerRunsBefore.runs.flatMap(value =>
      value.job?.state === "started" && value.job.result === null ? [value.job] : []);
    check(liveBrokers.length === 1, "reopen-broker-workload-not-single");
    const brokerJobBefore = liveBrokers[0]!;
    check(brokerJobBefore.authority.origin.kind === "service" &&
      brokerJobBefore.authority.origin.serviceId === BROKER_SERVICE_ID &&
      brokerJobBefore.authority.origin.revision === brokerBefore.configuration.revision &&
      accountsBefore.installation !== null && brokerJobBefore.installationRevision === accountsBefore.installation.revision &&
      brokerJobBefore.artifactSha256 === accountsBefore.installation.artifactSha256, "reopen-broker-workload-mismatch");
    const brokerNode = { kind: "job" as const, machineId: target.machineId,
      operationId: BROKER_OPERATION_ID, jobId: brokerJobBefore.jobId };
    for (const [index, id] of [GATEWAY_PLUGIN_ID, ACCOUNTS_PLUGIN_ID, OMP_PLUGIN_ID].entries()) {
      phase = `plugin-disable-${index}`;
      await ownerAction(hub, "engine.plugins.setEnabled", { id, enabled: false });
    }
    for (const [index, id] of [OMP_PLUGIN_ID, ACCOUNTS_PLUGIN_ID, GATEWAY_PLUGIN_ID].entries()) {
      phase = `plugin-enable-${index}`;
      await ownerAction(hub, "engine.plugins.setEnabled", { id, enabled: true });
    }
    for (const restored of [
      { name: "accounts", pluginId: ACCOUNTS_PLUGIN_ID, operationIds: [BROKER_OPERATION_ID, SIGN_IN_OPERATION_ID], before: accountsBefore },
      { name: "omp", pluginId: OMP_PLUGIN_ID, operationIds: [INTERACTIVE_HANDOFF_OPERATION_ID], before: ompBefore },
    ]) {
      phase = `reopen-${restored.name}-review`;
      const previous = restored.before.installation;
      check(previous?.enabled && previous.ready, `reopen-${restored.name}-previous-installation-unready`);
      const redeployment = { deploymentId: randomUUID(), pluginId: restored.pluginId,
        targets: [{ machineId: target.machineId, platform: "linux-x64" }], operationIds: restored.operationIds };
      const reviewed = JobDeploymentReviewSchema.parse(await ownerAction(hub, "engine.jobs.reviewDeployment", redeployment));
      const reviewedTarget = reviewed.targets[0];
      check(reviewed.approvable && reviewedTarget?.approvable && reviewedTarget.installationRevision === previous.revision &&
        reviewedTarget.artifactSha256 === previous.artifactSha256 &&
        canonicalJobJson(reviewedTarget.resourceBindings) === canonicalJobJson(previous.resourceBindings) &&
        reviewedTarget.consents.every(value => value.approved), `reopen-${restored.name}-pins-or-authority-changed`);
      phase = `reopen-${restored.name}-apply`;
      await ownerAction(hub, "engine.jobs.applyDeployment", { request: redeployment, reviewDigest: reviewed.reviewDigest });
      phase = `reopen-${restored.name}-ready`;
      await waitFor(async () => {
        const current = JobDeploymentSchema.parse(await ownerAction(hub, "engine.jobs.readDeployment",
          { deploymentId: redeployment.deploymentId }));
        check(!current.targets.some(item => ["refused", "needs_review", "cancelled", "superseded"].includes(item.state)),
          `reopen-${restored.name}-deployment-refused`);
        return current.targets.every(value => value.state === "ready");
      }, 480000, 100);
      const installed = JobDescriptionSchema.parse(await ownerAction(hub, "engine.jobs.describe",
        { machineId: target.machineId, pluginId: restored.pluginId }));
      check(canonicalJobJson(installed.installation) === canonicalJobJson(previous), `reopen-${restored.name}-installed-pins-changed`);
      if (restored.pluginId === ACCOUNTS_PLUGIN_ID) {
        // Disable hides governed jobs. Native apply waits for the old workload
        // to release its lifetime; reapproval restores authority to read its
        // exact final receipt, never infer completion from an empty projection.
        phase = "reopen-broker-stop-receipt";
        const stopped = PublicJobSchema.parse(await ownerAction(hub, "engine.jobs.status", { node: brokerNode }));
        check(stopped.jobId === brokerJobBefore.jobId && ["cancelled", "exited"].includes(stopped.state) &&
          stopped.result?.jobId === brokerJobBefore.jobId && stopped.result.startedAt !== null &&
          stopped.result.finishedAt !== null, "reopen-broker-stop-receipt-missing");
        phase = "reopen-broker-ready";
        await waitFor(async () => {
          const current = InstanceServiceDescriptionSchema.parse(await ownerAction(hub, "engine.services.describeInstance",
            { serviceId: BROKER_SERVICE_ID }));
          check(canonicalJobJson(current.configuration) === canonicalJobJson(brokerBefore.configuration), "reopen-broker-configuration-changed");
          return current.state === "ready";
        }, 60000, 50);
      }
    }
    // Unknown survives; no onEnable recovery is allowed to hand out a runtime.
    phase = "claim-reopen";
    const retained = await call("prepareInteractiveHandoff", request);
    check(retained.state === "unknown" && retained.claimId === winner.claimId &&
      retained.session.sessionId === winner.session.sessionId && !("runtime" in retained), "reopened-claim-replayed");
    phase = "canvas-connect";
    canvas = await connect(server, { containerId: target.containerId, token: server.ownerKey, reconnect: false });
    phase = "terminal-open";
    const terminal = await canvas.openTerminal({ elementId: winner.claimId, machineId: target.machineId, cols: 120, rows: 40, runtime: winner.runtime });
    terminalId = terminal.id;
    terminalHome = terminal.containerId;
    clean(terminal, "terminal-info-leaked-draft");
    check(terminal.status === "running" && terminal.machineId === target.machineId &&
      canonicalJobJson(terminal.session) === canonicalJobJson(winner.session), "terminal-association-mismatch");
    phase = "terminal-home-connect";
    home = await connect(server, { containerId: terminalHome, token: server.ownerKey, reconnect: false });
    const capture = (message: { terminalId: string; data: string }) => {
      if (message.terminalId !== terminalId) return;
      const text = base64ToText(message.data);
      screen = (screen + text).slice(-256000);
      if (text.includes("\x1b[6n")) home!.sendTerminalInput(terminalId!, "\x1b[1;1R");
      if (text.includes("\x1b[c")) home!.sendTerminalInput(terminalId!, "\x1b[?1;2c");
      if (text.includes("\x1b]11;?")) home!.sendTerminalInput(terminalId!, "\x1b]11;rgb:0000/0000/0000\x1b\\");
    };
    unsubscribe.push(home.on("terminal_snapshot", capture), home.on("terminal_output", capture));
    home.attachTerminal(terminalId);
    phase = "editor-prefill";
    await waitFor(() => { if (receiverFailure) throw receiverFailure; return screen.includes(canary); }, 60000, 20);
    check(Number(posts) === 0 && discoveries > 0, "init-model-boundary");
    // The public claim remains unknown after a successful create whose report
    // was lost. This retry is correlation only, never another runtime.
    phase = "claim-create-loss";
    const unknown = await call("prepareInteractiveHandoff", request);
    check(unknown.state === "unknown" && unknown.session.sessionId === winner.session.sessionId && !("runtime" in unknown), "create-loss-replayed");
    const report = { claimId: winner.claimId, state: "clientReported" as const, terminalId };
    phase = "claim-report";
    const reported = await call("prepareInteractiveHandoff", { ...request, report });
    check(reported.state === "clientReported" && reported.verification === "unverified" && !("runtime" in reported), "client-report-certified");
    phase = "claim-report-retry";
    check(canonicalJobJson(await call("prepareInteractiveHandoff", { ...request, report })) === canonicalJobJson(reported), "report-retry-changed");
    clean(reported, "report-leaked-draft");
    phase = "public-terminal-list";
    const listed = await ownerAction(hub, "core.terminals.listAll", {});
    clean(listed, "terminal-list-leaked-draft");
    check(TerminalsResponseSchema.parse(listed).terminals.some(value => value.id === terminalId && value.homeId === terminalHome), "terminal-list-missing");
    phase = "public-job-list";
    const runs = await ownerAction(hub, "engine.jobs.listRuns", { machineId: target.machineId, pluginId: OMP_PLUGIN_ID,
      operationId: INTERACTIVE_HANDOFF_OPERATION_ID, limit: 10 });
    clean(runs, "job-list-leaked-draft");
    const jobs = ListJobRunsResultSchema.parse(runs).runs.flatMap(({ job }) => job?.terminal?.terminalId === terminalId ? [job] : []);
    check(jobs.length === 1, "terminal-job-not-unique");
    const job = jobs[0]!;
    phase = "public-job-status";
    const publicJob = await ownerAction(hub, "engine.jobs.status", { node: { kind: "job", machineId: target.machineId,
      operationId: INTERACTIVE_HANDOFF_OPERATION_ID, jobId: job.jobId } });
    clean(publicJob, "job-leaked-draft");
    check(PublicJobSchema.parse(publicJob).state === "started", "terminal-job-not-started");
    phase = "public-error-canary";
    const error = await dispatch(hub, hub.ownerKey, actionDoor("reviewInteractiveHandoff"), { ...input, prompt: canary });
    check(!error.ok, "invalid-prompt-admitted");
    clean(error, "error-leaked-draft");
    phase = "public-trace-canary";
    const traces = await ownerAction(hub, "core.events.list", { kind: "trace", limit: 100 });
    clean(traces, "trace-leaked-draft");
    const events = z.object({ events: z.array(z.object({ door: z.string().nullable() })) }).parse(traces).events;
    for (const door of [actionDoor("reviewInteractiveHandoff"), actionDoor("prepareInteractiveHandoff"), "core.terminals.open"])
      check(events.some(event => event.door === door), "trace-evidence-missing");
    phase = "editor-clear";
    screen = "";
    home.sendTerminalInput(terminalId, "\x15");
    await waitFor(() => screen.length > 0, 30000, 20);
    phase = "editor-first-edit";
    screen = "";
    home.sendTerminalInput(terminalId, `\x1b[200~${edited}\x1b[201~`);
    await waitFor(() => screen.includes(edited), 30000, 20);
    check(Number(posts) === 0, "edit-inferred");
    phase = "editor-first-send";
    sends = 1;
    home.sendTerminalInput(terminalId, "\r");
    await waitFor(() => { if (receiverFailure) throw receiverFailure; return screen.includes("NATIVE-HANDOFF-FIRST-COMPLETE"); }, 60000, 20);
    check(Number(userStreams) === 1, "send-duplicated");
    phase = "editor-second-edit";
    screen = "";
    home.sendTerminalInput(terminalId, `\x1b[200~${continued}\x1b[201~`);
    await waitFor(() => screen.includes(continued), 30000, 20);
    check(Number(userStreams) === 1, "continuation-auto-submitted");
    phase = "editor-second-send";
    sends = 2;
    home.sendTerminalInput(terminalId, "\r");
    await waitFor(() => { if (receiverFailure) throw receiverFailure; return screen.includes("NATIVE-HANDOFF-SECOND-COMPLETE"); }, 60000, 20);
    check(Number(userStreams) === 2 && posts === userStreams + titles, "inference-accounting");
    // Reconnect with the same credential and use current public TerminalInfo,
    // not the reported id or a private transcript path, to correlate a reopen.
    phase = "public-terminal-reopen";
    const reopened = await connect(server, { containerId: terminalHome, token: server.ownerKey, reconnect: false });
    try {
      const observed = reopened.terminals.get(terminalId);
      check(observed?.status === "running" && observed.containerId === terminalHome && observed.machineId === target.machineId &&
        canonicalJobJson(observed.session) === canonicalJobJson(winner.session), "public-reopen-correlation");
      clean(observed, "reopened-info-leaked-draft");
    } finally { reopened.close(); }
  } catch (error) {
    if (error instanceof NativeHandoffProofFailure) throw error;
    // Preserve only fixture-owned phase names and bounded observations. Never
    // serialize exceptions, terminal text, request bodies or native state.
    if (phase.startsWith("editor-")) {
      const code = screen.split(/\r?\n/)
        .find(line => /^omp_(?:resume|sdk|restricted|material|agent_tools|harness)_[a-z_]{1,48}$/.test(line));
      if (code) throw new NativeHandoffProofFailure(code.replaceAll("_", "-"));
      throw new NativeHandoffProofFailure(`${phase}-failed-d${Math.min(discoveries, 9)}-p${Math.min(posts, 9)}-u${Math.min(userStreams, 9)}-o${Number(screen.length > 0)}`);
    }
    throw new NativeHandoffProofFailure(`${phase}-failed`);
  } finally {
    let cleanupFailed = false;
    for (const off of unsubscribe) off();
    if (terminalId && terminalHome) try {
      home ??= await connect(server, { containerId: terminalHome, token: server.ownerKey, reconnect: false });
      home.killTerminal(terminalId);
      await waitFor(() => !home!.terminals.has(terminalId!), 30000, 50);
    } catch { cleanupFailed = true; }
    home?.close();
    canvas?.close();
    if (originalServices) try {
      const current = ServiceConfigurationReadSchema.parse(await ownerAction(hub, "engine.services.readConfiguration", { machineId: target.machineId }));
      await ownerAction(hub, "engine.services.configureConfiguration", { machineId: target.machineId,
        expectedRevision: current.configuration.revision, policies: originalServices.policies });
    } catch { cleanupFailed = true; }
    await gateway.stop(true);
    if (credential) try {
      await call("disableCredential", { containerId: target.containerId, ...credential });
    } catch { cleanupFailed = true; }
    check(!cleanupFailed, "cleanup-failed");
  }
}
