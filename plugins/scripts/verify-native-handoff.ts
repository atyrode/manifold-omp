import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { base64ToText, type SessionClient } from "@manifold/sdk";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import {
  JobDeploymentReviewSchema, JobDeploymentSchema, JobDescriptionSchema, ListJobRunsResultSchema,
  PublicJobSchema, ServiceConfigurationReadSchema, ServicePolicySchema, TerminalsResponseSchema, canonicalJobJson,
} from "@manifold/protocol";
import { dispatch, ownerAction } from "../../../manifold/packages/plugin-kit/src/hub.ts";
import { connect, waitFor, type TestServer } from "../../../manifold/packages/testkit/src/index.ts";
import {
  INTERACTIVE_HANDOFF_OPERATION_ID, OMP_PLUGIN_ID, actionDoor,
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
    await ownerAction(hub, "engine.services.configureConfiguration", { machineId: target.machineId,
      expectedRevision: originalServices.revision, policies: [...originalServices.policies.filter(value => value.serviceId !== "omp"), policy] });
    const policyDigest = createHash("sha256").update(canonicalJobJson(policy)).digest("hex");
    await waitFor(async () => {
      const native = JobDescriptionSchema.parse(await ownerAction(hub, "engine.jobs.describe", { machineId: target.machineId, pluginId: OMP_PLUGIN_ID }));
      return native.connected && native.resources?.services.omp === policyDigest;
    }, 30000, 50);
    await mkdir(join(root, "state", "omp", "sessions"), { recursive: true, mode: 0o700 });
    const deployment = { deploymentId: randomUUID(), pluginId: OMP_PLUGIN_ID,
      targets: [{ machineId: target.machineId, platform: "linux-x64" }], operationIds: [INTERACTIVE_HANDOFF_OPERATION_ID] };
    const nativeReview = JobDeploymentReviewSchema.parse(await ownerAction(hub, "engine.jobs.reviewDeployment", deployment));
    check(nativeReview.approvable, "deployment-review-refused");
    await ownerAction(hub, "engine.jobs.applyDeployment", { request: deployment, reviewDigest: nativeReview.reviewDigest });
    await waitFor(async () => {
      const current = JobDeploymentSchema.parse(await ownerAction(hub, "engine.jobs.readDeployment", { deploymentId: deployment.deploymentId }));
      check(!current.targets.some(item => ["refused", "needs_review", "cancelled", "superseded"].includes(item.state)), "deployment-refused");
      return current.targets.every(value => value.state === "ready");
    }, 480000, 100);
    const review = await call("reviewInteractiveHandoff", input);
    clean(review, "review-leaked-draft");
    const request = { ...input, reviewDigest: review.reviewDigest };
    const prepared = await Promise.all(Array.from({ length: 4 }, () => call("prepareInteractiveHandoff", request)));
    const winner = prepared.find(value => value.state === "claimed");
    check(winner?.state === "claimed" && prepared.filter(value => "runtime" in value).length === 1, "claim-not-single-winner");
    check(prepared.every(value => value.claimId === winner.claimId && value.session.sessionId === winner.session.sessionId), "claim-association-changed");
    for (const value of prepared) if (value.state !== "claimed") clean(value, "retry-leaked-draft");
    // Reopen the real isolate/storage lifecycle before any terminal exists.
    // Unknown survives; no onEnable recovery is allowed to hand out a runtime.
    await ownerAction(hub, "engine.plugins.setEnabled", { id: OMP_PLUGIN_ID, enabled: false });
    await ownerAction(hub, "engine.plugins.setEnabled", { id: OMP_PLUGIN_ID, enabled: true });
    const retained = await call("prepareInteractiveHandoff", request);
    check(retained.state === "unknown" && retained.claimId === winner.claimId &&
      retained.session.sessionId === winner.session.sessionId && !("runtime" in retained), "reopened-claim-replayed");
    canvas = await connect(server, { containerId: target.containerId, token: server.ownerKey, reconnect: false });
    const terminal = await canvas.openTerminal({ elementId: winner.claimId, machineId: target.machineId, cols: 120, rows: 40, runtime: winner.runtime });
    terminalId = terminal.id;
    terminalHome = terminal.containerId;
    clean(terminal, "terminal-info-leaked-draft");
    check(terminal.status === "running" && terminal.machineId === target.machineId &&
      canonicalJobJson(terminal.session) === canonicalJobJson(winner.session), "terminal-association-mismatch");
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
    await waitFor(() => { if (receiverFailure) throw receiverFailure; return screen.includes(canary); }, 60000, 20);
    check(Number(posts) === 0 && discoveries > 0, "init-model-boundary");
    // The public claim remains unknown after a successful create whose report
    // was lost. This retry is correlation only, never another runtime.
    const unknown = await call("prepareInteractiveHandoff", request);
    check(unknown.state === "unknown" && unknown.session.sessionId === winner.session.sessionId && !("runtime" in unknown), "create-loss-replayed");
    const report = { claimId: winner.claimId, state: "clientReported" as const, terminalId };
    const reported = await call("prepareInteractiveHandoff", { ...request, report });
    check(reported.state === "clientReported" && reported.verification === "unverified" && !("runtime" in reported), "client-report-certified");
    check(canonicalJobJson(await call("prepareInteractiveHandoff", { ...request, report })) === canonicalJobJson(reported), "report-retry-changed");
    clean(reported, "report-leaked-draft");
    const listed = await ownerAction(hub, "core.terminals.listAll", {});
    clean(listed, "terminal-list-leaked-draft");
    check(TerminalsResponseSchema.parse(listed).terminals.some(value => value.id === terminalId && value.homeId === terminalHome), "terminal-list-missing");
    const runs = await ownerAction(hub, "engine.jobs.listRuns", { machineId: target.machineId, pluginId: OMP_PLUGIN_ID,
      operationId: INTERACTIVE_HANDOFF_OPERATION_ID, limit: 10 });
    clean(runs, "job-list-leaked-draft");
    const jobs = ListJobRunsResultSchema.parse(runs).runs.flatMap(({ job }) => job?.terminal?.terminalId === terminalId ? [job] : []);
    check(jobs.length === 1, "terminal-job-not-unique");
    const job = jobs[0]!;
    const publicJob = await ownerAction(hub, "engine.jobs.status", { node: { kind: "job", machineId: target.machineId,
      operationId: INTERACTIVE_HANDOFF_OPERATION_ID, jobId: job.jobId } });
    clean(publicJob, "job-leaked-draft");
    check(PublicJobSchema.parse(publicJob).state === "started", "terminal-job-not-started");
    const error = await dispatch(hub, hub.ownerKey, actionDoor("reviewInteractiveHandoff"), { ...input, prompt: canary });
    check(!error.ok, "invalid-prompt-admitted");
    clean(error, "error-leaked-draft");
    const traces = await ownerAction(hub, "core.events.list", { kind: "trace", limit: 100 });
    clean(traces, "trace-leaked-draft");
    const events = z.object({ events: z.array(z.object({ door: z.string().nullable() })) }).parse(traces).events;
    for (const door of [actionDoor("reviewInteractiveHandoff"), actionDoor("prepareInteractiveHandoff"), "core.terminals.open"])
      check(events.some(event => event.door === door), "trace-evidence-missing");
    screen = "";
    home.sendTerminalInput(terminalId, "\x15");
    await waitFor(() => screen.length > 0, 30000, 20);
    screen = "";
    home.sendTerminalInput(terminalId, `\x1b[200~${edited}\x1b[201~`);
    await waitFor(() => screen.includes(edited), 30000, 20);
    check(Number(posts) === 0, "edit-inferred");
    sends = 1;
    home.sendTerminalInput(terminalId, "\r");
    await waitFor(() => { if (receiverFailure) throw receiverFailure; return screen.includes("NATIVE-HANDOFF-FIRST-COMPLETE"); }, 60000, 20);
    check(Number(userStreams) === 1, "send-duplicated");
    screen = "";
    home.sendTerminalInput(terminalId, `\x1b[200~${continued}\x1b[201~`);
    await waitFor(() => screen.includes(continued), 30000, 20);
    check(Number(userStreams) === 1, "continuation-auto-submitted");
    sends = 2;
    home.sendTerminalInput(terminalId, "\r");
    await waitFor(() => { if (receiverFailure) throw receiverFailure; return screen.includes("NATIVE-HANDOFF-SECOND-COMPLETE"); }, 60000, 20);
    check(Number(userStreams) === 2 && posts === userStreams + titles, "inference-accounting");
    // Reconnect with the same credential and use current public TerminalInfo,
    // not the reported id or a private transcript path, to correlate a reopen.
    const reopened = await connect(server, { containerId: terminalHome, token: server.ownerKey, reconnect: false });
    try {
      const observed = reopened.terminals.get(terminalId);
      check(observed?.status === "running" && observed.containerId === terminalHome && observed.machineId === target.machineId &&
        canonicalJobJson(observed.session) === canonicalJobJson(winner.session), "public-reopen-correlation");
      clean(observed, "reopened-info-leaked-draft");
    } finally { reopened.close(); }
  } catch (error) {
    throw error instanceof NativeHandoffProofFailure ? error : new NativeHandoffProofFailure("fixture-failed");
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
