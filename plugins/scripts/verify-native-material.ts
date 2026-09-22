import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { JobDeploymentReviewSchema, JobDeploymentSchema, PublicJobSchema, ServiceConfigurationReadSchema, canonicalJobJson } from "@manifold/protocol";
import { ownerAction } from "../../../manifold/packages/plugin-kit/src/hub.ts";
import { waitFor } from "../../../manifold/packages/testkit/src/index.ts";
import { MATERIAL_SESSION_OPERATION_ID, OMP_PLUGIN_ID, RUNS_LOCATION_ID, parseSessionArchive } from "../api/index.ts";

function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`native-material-${code}`);
}
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown) => hash(canonicalJobJson(value));

/** Control-plane verification only. Executes the installed OMP operation unchanged,
 * with real sealed producer inputs and a governed loopback synthetic model service. */
export async function verifyNativeMaterial({ root, target, hub, producerJobId, materialText }: {
  root: string;
  target: { machineId: string };
  hub: Parameters<typeof ownerAction>[0];
  producerJobId: string;
  materialText: string;
}): Promise<void> {
  let calls = 0;
  let serviceFailure = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/v1/models") return Response.json({ object: "list", data: [{
        id: "openai/gpt-5", object: "model", owned_by: "openai", api: "openai-completions",
        display_name: "Synthetic native material model", context_length: 200000, max_output_tokens: 8192, input_modalities: ["text"],
      }] });
      check(request.method === "POST" && path === "/v1/pi/stream", "service-route");
      const body = await request.json() as { modelId: string; context: { tools?: unknown[]; messages: { role: string; content?: unknown; toolCallId?: string; isError?: boolean }[] } };
      check(body.modelId === "fixture/openai/gpt-5" && (body.context.tools ?? []).length === 0, "tools");
      const context = JSON.stringify(body.context);
      check(context.includes(materialText.replaceAll("\n", "\\n")) && !context.includes("NATIVE-CONFIG-SECRET-SENTINEL") &&
        !context.includes("UNREVIEWED-SENTINEL"), "input-boundary");
      calls++;
      check(calls <= 2, "extra-inference");
      const tools = calls === 1;
      if (!tools) for (const id of ["read-secret", "run-shell", "spawn-task"])
        check(body.context.messages.some(message => message.role === "toolResult" && message.toolCallId === id && message.isError),
          "forbidden-tool-executed");
      const content: ({ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, string> })[] = tools ? [
        { type: "toolCall", id: "read-secret", name: "read", arguments: { path: "/home/job/.omp/agent/models.yml" } },
        { type: "toolCall", id: "run-shell", name: "bash", arguments: { command: "cat /home/job/.omp/agent/config.yml" } },
        { type: "toolCall", id: "spawn-task", name: "task", arguments: { task: "Read shared runs and prior sessions" } },
      ] : [{ type: "text", text: "NATIVE-MATERIAL-COMPLETE" }];
      const message = {
        role: "assistant", api: "openai-completions", provider: "fixture", model: "openai/gpt-5", content,
        stopReason: tools ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const events: unknown[] = [{ type: "start", partial: message }];
      message.content.forEach((content, contentIndex) => {
        if (content.type === "toolCall") events.push({ type: "toolcall_start", contentIndex, partial: message },
          { type: "toolcall_end", contentIndex, toolCall: content, partial: message });
        else events.push({ type: "text_start", contentIndex, partial: message },
          { type: "text_delta", contentIndex, delta: content.text, partial: message },
          { type: "text_end", contentIndex, content: content.text, partial: message });
      });
      events.push({ type: "done", reason: message.stopReason, message });
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } });
    } catch {
      serviceFailure = true;
      return Response.json({ error: "synthetic-material-refused" }, { status: 400 });
    }
  } });
  try {
    const operation = (method: "GET" | "POST", path: string) => ({
      kind: "http-proxy", method, path, request: method === "POST" ? { kind: "json", disclosure: "full" } : { kind: "none" },
      response: { kind: "stream", disclosure: "full", contentTypes: ["application/json", "text/event-stream"], headers: [] },
      timeoutMs: 30000, maxRequestBytes: 2 * 1024 * 1024, maxResponseBytes: 1024 * 1024,
      ...(method === "POST" ? { meter: { kind: "pi-native-usage" } } : {}),
    });
    const previous = ServiceConfigurationReadSchema.parse(await ownerAction(hub, "engine.services.readConfiguration", { machineId: target.machineId }));
    check(!previous.configuration.policies.some(policy => policy.serviceId === "omp"), "unexpected-existing-service");
    await ownerAction(hub, "engine.services.configureConfiguration", { machineId: target.machineId, expectedRevision: previous.configuration.revision,
      policies: [...previous.configuration.policies, { serviceId: "omp", revision: "1", origin: `http://127.0.0.1:${server.port}`, allowLoopbackHttp: true,
        maxConcurrent: 1, operations: { models: operation("GET", "/v1/models"), stream: operation("POST", "/v1/pi/stream") } }] });
    await mkdir(join(root, "runtime", "omp", "runs"), { recursive: true, mode: 0o700 });
    const request = { deploymentId: randomUUID(), pluginId: OMP_PLUGIN_ID,
      targets: [{ machineId: target.machineId, platform: "linux-x64" }], operationIds: [MATERIAL_SESSION_OPERATION_ID] };
    const review = JobDeploymentReviewSchema.parse(await ownerAction(hub, "engine.jobs.reviewDeployment", request));
    check(review.approvable, "deployment-review-refused");
    await ownerAction(hub, "engine.jobs.applyDeployment", { request, reviewDigest: review.reviewDigest });
    await waitFor(async () => {
      const value = JobDeploymentSchema.parse(await ownerAction(hub, "engine.jobs.readDeployment", { deploymentId: request.deploymentId }));
      check(!value.targets.some(item => ["refused", "needs_review", "cancelled", "superseded"].includes(item.state)), "deployment-refused");
      return value.targets.every(item => item.state === "ready");
    }, 480000, 100);
    const input = {
      config: JSON.stringify({ extensions: [], disabledProviders: [], extendedContext: false, startup: { setupWizard: false },
        modelRoles: { default: "fixture/openai/gpt-5" }, defaultThinkingLevel: "off", skills: { enabled: false } }),
      models: JSON.stringify({ providers: { fixture: { baseUrl: "http://invalid.example", apiKey: "NATIVE-CONFIG-SECRET-SENTINEL",
        transport: "pi-native", discovery: { type: "proxy" } } } }),
      accountPool: "{}", hasPrompt: true, prompt: "Summarise the supplied material only.", planYolo: false,
      skillRuntime: JSON.stringify({ mode: "disabled", names: [] }), disableSkills: true,
      automation: JSON.stringify({ mode: "restricted", toolNames: [], delegation: "disabled" }), resumeOverrides: "{}",
      isolation: JSON.stringify({ mode: "material-only", file: "transcript-map.json", sha256: hash(materialText), bytes: Buffer.byteLength(materialText) }),
    };
    for (const source of ["material-extra", "material"] as const) {
      const jobId = randomUUID();
      const node = { kind: "job", machineId: target.machineId, operationId: MATERIAL_SESSION_OPERATION_ID, jobId };
      await ownerAction(hub, "engine.jobs.execute", { machineId: target.machineId, pluginId: OMP_PLUGIN_ID,
        operationId: MATERIAL_SESSION_OPERATION_ID, jobId, input,
        limits: { ...review.machine.operations[MATERIAL_SESSION_OPERATION_ID]!.limits, inference: { calls: 2 } },
        inputs: [{ name: "material", from: { jobId: producerJobId, output: source } }],
        outputs: [{ name: "session", locationId: RUNS_LOCATION_ID, components: [jobId] }] });
      const result = await waitFor(async () => {
        const value = PublicJobSchema.parse(await ownerAction(hub, "engine.jobs.status", { node }));
        return value.result ? value : false;
      }, 90000, 50);
      check(!serviceFailure, "synthetic-service-failed");
      if (source === "material-extra") {
        check(result.result!.exitCode !== 0 && calls === 0, "extra-material-inferred");
        continue;
      }
      check(result.state === "exited" && result.result!.exitCode === 0 && calls === 2, "execution-failed");
      check(result.operationId === MATERIAL_SESSION_OPERATION_ID &&
        result.installationRevision === review.targets[0]!.installationRevision &&
        digest(result.inputs) === digest([{ name: "material", from: { jobId: producerJobId, output: source } }]) &&
        result.result!.usage?.inference?.calls === 2 && result.result!.limits.inference?.calls === 2, "provenance");
      const output = result.result!.outputs.find(value => value.name === "session");
      check(output && output.bytes < 4 * 1024 * 1024, "transcript-missing");
      const archive = Buffer.alloc(output.bytes);
      let offset = 0;
      while (offset < archive.length) {
        const page = await ownerAction(hub, "engine.jobs.output", { node: { kind: "output", machineId: target.machineId,
          operationId: MATERIAL_SESSION_OPERATION_ID, jobId, outputId: output.outputId }, offset,
          maxBytes: Math.min(65536, archive.length - offset) }) as { data: string };
        const bytes = Buffer.from(page.data, "base64");
        check(bytes.length > 0 && offset + bytes.length <= archive.length, "transcript-page");
        bytes.copy(archive, offset);
        offset += bytes.length;
      }
      check(hash(archive) === output.sha256, "transcript-digest");
      const receipt = parseSessionArchive(archive, "/outputs/session", 0, "fixture/openai/gpt-5");
      check(receipt.finalMessage === "NATIVE-MATERIAL-COMPLETE", "receipt");
      check(archive.includes(Buffer.from("NATIVE-MATERIAL-WITNESS")) &&
        !archive.includes(Buffer.from("NATIVE-CONFIG-SECRET-SENTINEL")), "retention-boundary");
    }
  } finally { await server.stop(true); }
}
