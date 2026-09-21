import { expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatManifoldUri, MachineHalfSchema, PublicJobSchema, type Cap, type ManifoldRef } from "@manifold/protocol";
import {
  ACCOUNTS_PLUGIN_ID, BROKER_SERVICE_ID, OMP_PLUGIN_ID, OmpHarnessProfileSchema, PreparedHarnessSessionSchema,
  PreparedResumeSessionSchema, TerminalRuntimeSchema,
} from "../api/index.ts";
import { prepareHarnessSession } from "../atyrode.omp/execution.ts";
import { listSessions, resumeSession } from "../atyrode.omp/sessions.ts";
import { digestOf, type OmpContext } from "../atyrode.omp/machine-server.ts";
import manifest from "../atyrode.omp/manifest.json";
import sdkRuntimeArtifacts from "../sdk-host/runtime-artifacts.json";
import { openSessionsRoot, prepareSessionFile, resolveSessionFile } from "../workers/harness/sessions.ts";
import { materializeJobInputs } from "../../../manifold/packages/agent/src/job-inputs.ts";
import { ABSENT_MODEL_ID, UNLISTED_PUBLISHED_ID } from "./fixtures/models.ts";

function launchFixture() {
  const machineId = "fixture-machine";
  const machine = MachineHalfSchema.parse({ ...manifest.machine,
    tools: { ...manifest.machine.tools, bun: sdkRuntimeArtifacts.tools.bun, "sdk-pi-natives": sdkRuntimeArtifacts.tools["pi-natives"] } });
  const pins = { installationRevision: "fixture-installation", artifactSha256: "a".repeat(64), resourceBindingDigest: "b".repeat(64) };
  const consent = (cap: Cap, ref: ManifoldRef) => ({ cap, node: formatManifoldUri(ref), enabled: true, revision: "fixture-consent" });
  const operations = ["harness", "harness-sessions", "resume"].map(name => `${OMP_PLUGIN_ID}.${name}`);
  const description = {
    machineId, pluginId: OMP_PLUGIN_ID, connected: true, platforms: ["linux-x64"], admissionPublicKey: "-----BEGIN PUBLIC KEY----- fixture",
    retainedInstallations: [],
    installation: { revision: pins.installationRevision, artifactSha256: pins.artifactSha256, enabled: true, ready: true, purgeRequested: false },
    operations: Object.fromEntries(operations.map(operationId => [operationId, { ready: true, reason: null, resourceBindingDigest: pins.resourceBindingDigest }])),
    consents: operations.flatMap(operationId => [
      ...(["machines:run", "jobs:read", "jobs:input", "network:host"] as const).map(cap => consent(cap, { kind: "operation", machineId, operationId })),
      ...machine.operations[operationId]!.locations.map(location => consent(`locations:${location.access}`, { kind: "location", machineId, locationId: location.locationId })),
    ]),
  };
  const owner = { machineId, name: "Fixture", online: true };
  const broker = { serviceId: BROKER_SERVICE_ID, revision: "fixture-broker", machineId };
  let denied: string | undefined;
  let defaults: unknown = null;
  let inventory: unknown = [];
  let inventoryBytes = Buffer.from("[]");
  let job: unknown;
  const credentials = [{ id: 7, provider: "anthropic", identityKey: "fixture-identity", credential: { type: "oauth", email: "fixture@example.invalid" }, disabled: false }];
  const ctx = {
    pluginId: OMP_PLUGIN_ID,
    auth: { principal: { id: "fixture-sponsor", kind: "human" }, caps: ["*"], containerScope: null, isRoot: true,
      allows: async (cap: string) => cap !== denied },
    outsideScope: async () => null,
    now: () => 1,
    newId: async () => randomUUID(),
    storage: { get: async () => defaults === null ? null : JSON.stringify(defaults) },
    jobs: {
      describe: async () => description,
      describeDeployment: async () => ({ installation: { revision: pins.installationRevision, artifactSha256: pins.artifactSha256, machine }, deployment: null }),
      execute: async ({ jobId, operationId }: { jobId: string; operationId: string }) => {
        inventoryBytes = Buffer.from(JSON.stringify(inventory));
        job = PublicJobSchema.parse({
          jobId, machineId, operationId, pluginId: OMP_PLUGIN_ID, ...pins,
          inputDigest: digestOf({}), state: "exited", nextInputSeq: null,
          authority: { origin: { kind: "action", traceId: "fixture-trace", door: `${OMP_PLUGIN_ID}.listSessions` },
            requester: "fixture-sponsor", executor: null, decision: null },
          result: { jobId, requestDigest: "c".repeat(64), ownerId: "fixture-owner", ownerGeneration: 1,
            state: "exited", exitCode: 0, reason: null, startedAt: 1, finishedAt: 2, usage: null,
            limits: machine.operations[operationId]!.limits,
            outputs: [{ outputId: "fixture-output", name: "stdout", bytes: inventoryBytes.length, files: 1,
              sha256: createHash("sha256").update(inventoryBytes).digest("hex") }] },
        });
        return job;
      },
      follow: async () => ({ snapshot: { state: "exited" }, close: async () => {} }),
      status: async () => job,
      cancel: async () => {},
      output: async ({ offset, maxBytes }: { offset: number; maxBytes: number }) => ({
        jobId: PublicJobSchema.parse(job).jobId, outputId: "fixture-output", seq: offset,
        data: inventoryBytes.subarray(offset, offset + maxBytes).toString("base64"),
        eof: offset + maxBytes >= inventoryBytes.length,
      }),
    },
    services: {
      describeInstance: async () => ({ serviceId: BROKER_SERVICE_ID, owner, defaultOwner: owner, connected: true, state: "ready", reason: null,
        configuration: { revision: broker.revision, pluginId: ACCOUNTS_PLUGIN_ID, enabled: true, policySha256: "c".repeat(64) } }),
      readInstance: async () => ({ ok: true, result: { credentials } }),
      describe: async () => ({ connected: true, machineId, services: [{ serviceId: "omp", revision: "1", policySha256: "d".repeat(64), operations: ["models", "stream"].map(operationId => ({ operationId, ready: true })) }] }),
    },
  } as unknown as OmpContext;
  return {
    ctx, deny: (cap: string) => { denied = cap; },
    credentials,
    setDefaults: (overlay: unknown) => { defaults = { revision: 0, overlay, updatedAt: null, updatedBy: null }; },
    setInventory: (value: unknown) => { inventory = value; },
    input: { containerId: "fixture-container", machineId, expectedDefaultsRevision: 0,
      accountPool: { anthropic: [{ scope: digestOf(broker), credentialId: 7, identityKey: "fixture-identity" }] },
      overlay: { modelRoles: { default: "anthropic/claude-sonnet-4-5" } }, prompt: "Review the project", planYolo: false },
  };
}

test("two governed preparations bind distinct IDs to the transcripts OMP will open", async () => {
  const f = launchFixture();
  const first = await prepareHarnessSession(f.ctx, f.input);
  const second = await prepareHarnessSession(f.ctx, f.input);
  expect(first.session.sessionId).not.toBe(second.session.sessionId);
  const directory = mkdtempSync(join(tmpdir(), "omp-binding-"));
  const root = openSessionsRoot(directory);
  try {
    for (const prepared of [first, second]) {
      const operation = MachineHalfSchema.parse(manifest.machine).operations[prepared.runtime.operationId]!;
      const files = materializeJobInputs(operation, prepared.runtime.input, new Map([
        ["omp", { url: "http://127.0.0.1:12345/v1", bearer: randomBytes(32).toString("hex") }],
      ]));
      try {
        // Consume the owner-materialized input, not a copy of a server field.
        // Selecting interactive .launch omits this file and cannot run the worker.
        const sessionInput = files.find(file => file.target === "/inputs/sessionId");
        expect(sessionInput).toBeDefined();
        const filename = prepareSessionFile(root, readFileSync(sessionInput!.fd, "utf8"), "/home/job/workspace", false);
        expect(resolveSessionFile(root, prepared.session.sessionId)).toBe(filename);
        expect(operation.executable).toEqual({ runtimeTool: "bun" });
      } finally { for (const file of files) closeSync(file.fd); }
    }
    expect(() => PreparedHarnessSessionSchema.parse({ ...first, session: second.session })).toThrow();
    expect(() => PreparedHarnessSessionSchema.parse({ ...first, session: { ...first.session, machineId: "another-machine" } })).toThrow();
  } finally { closeSync(root); rmSync(directory, { recursive: true, force: true }); }
});

test("prepared harness contracts require the full nested session to match the outer binding", async () => {
  const f = launchFixture();
  const prepared = await prepareHarnessSession(f.ctx, f.input);
  expect(PreparedHarnessSessionSchema.parse(prepared).session).toEqual(prepared.session);
  for (const session of [
    undefined,
    { ...prepared.session, sessionId: randomUUID() },
    { ...prepared.session, harness: "another.harness" },
    { ...prepared.session, machineId: "another-machine" },
  ]) {
    expect(PreparedHarnessSessionSchema.safeParse({
      ...prepared, runtime: { ...prepared.runtime, session },
    }).success).toBe(false);
  }
});

test("prepared resume contracts bind the OMP plugin and resume operation without restricting generic runtimes", async () => {
  const f = launchFixture();
  const sessionId = randomUUID();
  f.setInventory([{ id: sessionId, title: null, cwd: "/home/job/workspace", updatedAt: 123 }]);
  const prepared = await resumeSession(f.ctx, {
    machineId: f.input.machineId, sessionId, overlay: f.input.overlay,
  });
  expect(PreparedResumeSessionSchema.parse(prepared).sessionId).toBe(sessionId);
  for (const changed of [
    { operationId: `${OMP_PLUGIN_ID}.launch` },
    { pluginId: "another.plugin" },
  ]) {
    const runtime = { ...prepared.runtime, ...changed };
    expect(TerminalRuntimeSchema.safeParse(runtime).success).toBe(true);
    expect(PreparedResumeSessionSchema.safeParse({ ...prepared, runtime }).success).toBe(false);
  }
});

test("a trusted resumed binding preserves its journal and never creates a missing conversation", async () => {
  const f = launchFixture();
  const first = await prepareHarnessSession(f.ctx, f.input);
  const resumed = await prepareHarnessSession(f.ctx, f.input, first.session);
  const directory = mkdtempSync(join(tmpdir(), "omp-resume-"));
  const root = openSessionsRoot(directory);
  try {
    const filename = prepareSessionFile(root, first.session.sessionId, "/home/job/workspace", false);
    appendFileSync(join(directory, filename), `${JSON.stringify({ type: "message", id: "1234abcd", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Preserve this prior conversation.", timestamp: 1 } })}\n`);
    const before = readFileSync(join(directory, filename), "utf8");
    expect(prepareSessionFile(root, resumed.session.sessionId, "/home/job/workspace", resumed.runtime.input.resume === true)).toBe(filename);
    expect(readFileSync(join(directory, filename), "utf8")).toBe(before);
    expect(resumed.reviewDigest).not.toBe(first.reviewDigest);
    expect(() => prepareSessionFile(root, randomUUID(), "/home/job/workspace", true)).toThrow("session_unavailable");
    await expect(prepareHarnessSession(f.ctx, f.input, { ...first.session, machineId: "another-machine" })).rejects.toThrow("omp_session_binding_changed");
  } finally { closeSync(root); rmSync(directory, { recursive: true, force: true }); }
});

test("harness preparation cannot bypass terminal or bound location authority", async () => {
  const f = launchFixture();
  f.deny("terminals:spawn");
  await expect(prepareHarnessSession(f.ctx, f.input)).rejects.toThrow("omp_caller_terminals_spawn_required");
  f.deny("locations:write");
  await expect(prepareHarnessSession(f.ctx, f.input)).rejects.toThrow("omp_caller_locations_write_required");
});

test("durable harness profiles cannot carry executable, environment, path or session authority", () => {
  const f = launchFixture();
  const profile = { accountPool: f.input.accountPool, overlay: f.input.overlay, planYolo: false };
  expect(OmpHarnessProfileSchema.parse(profile)).toEqual(profile);
  expect(() => OmpHarnessProfileSchema.parse({ ...profile, sessionId: randomUUID() })).toThrow();
  expect(() => OmpHarnessProfileSchema.parse({ ...profile, overlay: { ...profile.overlay, extensions: ["/tmp/model-extension"] } })).toThrow();
  expect(() => OmpHarnessProfileSchema.parse({ ...profile, env: { MANIFOLD_ORIGIN: "https://invalid.example" } })).toThrow();
});

test("operator inventory admits only bounded body-free transcript summaries", async () => {
  const f = launchFixture();
  const summary = { id: randomUUID(), title: "A prior task", cwd: "/home/job/workspace", updatedAt: 123 };
  f.setInventory([summary]);
  expect(await listSessions(f.ctx, { machineId: f.input.machineId })).toEqual([summary]);
  f.setInventory([{ ...summary, body: "Private transcript body" }]);
  await expect(listSessions(f.ctx, { machineId: f.input.machineId })).rejects.toThrow();
  f.setInventory(Array.from({ length: 4097 }, () => ({ ...summary, id: randomUUID() })));
  await expect(listSessions(f.ctx, { machineId: f.input.machineId })).rejects.toThrow();
});

test("operator inventory survives an inference-usage frame before the completion snapshot", async () => {
  const f = launchFixture();
  const summary = { id: randomUUID(), title: "A prior task", cwd: "/home/job/workspace", updatedAt: 123 };
  f.setInventory([summary]);
  const follow = f.ctx.jobs.follow;
  f.ctx.jobs.follow = async (node, listener) => {
    listener({
      type: "inference_usage",
      inferenceUsage: { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costMicros: 0, lastModel: "fixture/model" },
    });
    return follow(node, listener);
  };
  expect(await listSessions(f.ctx, { machineId: f.input.machineId })).toEqual([summary]);
});

test("operator resume refuses absent conversations before any credential selection", async () => {
  const f = launchFixture();
  const summary = { id: randomUUID(), title: null, cwd: "/home/job/workspace", updatedAt: 123 };
  f.setInventory([summary]);
  await expect(resumeSession(f.ctx, { machineId: f.input.machineId, sessionId: randomUUID() }))
    .rejects.toThrow("omp_session_unavailable");
});

test("omitted resume knobs select current configured providers and enabled credentials without terminal authority", async () => {
  const f = launchFixture();
  const summary = { id: randomUUID(), title: "Continue work", cwd: "/home/job/workspace", updatedAt: 123 };
  f.setInventory([summary]);
  f.setDefaults({ modelRoles: { default: "anthropic/claude-sonnet-4-5" }, defaultThinkingLevel: "high" });
  f.credentials.push(
    { ...f.credentials[0]!, id: 8, identityKey: "disabled-identity", disabled: true },
    { ...f.credentials[0]!, id: 9, provider: "openai", identityKey: "other-provider" },
    { ...f.credentials[0]!, id: 10, identityKey: "second-enabled" },
  );
  f.deny("terminals:spawn");
  const resumed = await resumeSession(f.ctx, { machineId: f.input.machineId, sessionId: summary.id });
  const operation = MachineHalfSchema.parse(manifest.machine).operations[resumed.runtime.operationId]!;
  const files = materializeJobInputs(operation, resumed.runtime.input, new Map([
    ["omp", { url: "http://127.0.0.1:12345/v1", bearer: randomBytes(32).toString("hex") }],
  ]));
  try {
    const configFile = files.find(file => file.target === "/home/job/.omp/agent/config.yml")!;
    const config = JSON.parse(readFileSync(configFile.fd, "utf8"));
    expect(config.modelRoles.default).toBe("anthropic/claude-sonnet-4-5");
    expect(config.defaultThinkingLevel).toBe("high");
    expect(config.disabledProviders).toContain("openai");
    expect(JSON.parse(String(resumed.runtime.input.accountPool)).anthropic.map((slot: { credentialId: number }) => slot.credentialId)).toEqual([7, 10]);
    expect(Object.keys(JSON.parse(String(resumed.runtime.input.accountPool)))).toEqual(["anthropic"]);
    expect("terminal" in resumed.runtime).toBe(false);
    const sessionFile = files.find(file => file.target === "/inputs/sessionId")!;
    expect(readFileSync(sessionFile.fd, "utf8")).toBe(summary.id);
  } finally { for (const file of files) closeSync(file.fd); }
});

test("explicit resume knobs replace defaults and never widen an explicit account pool", async () => {
  const f = launchFixture();
  const sessionId = randomUUID();
  f.setInventory([{ id: sessionId, title: null, cwd: "/home/job/workspace", updatedAt: 123 }]);
  f.setDefaults({ modelRoles: { default: "openai/gpt-5" }, defaultThinkingLevel: "low" });
  f.credentials.push({ ...f.credentials[0]!, id: 10, identityKey: "unselected-enabled" });
  const input = {
    machineId: f.input.machineId, containerId: f.input.containerId, sessionId,
    accountPool: f.input.accountPool,
    overlay: { modelRoles: { default: "anthropic/claude-sonnet-4-5" }, defaultThinkingLevel: "high" as const },
  };
  const resumed = await resumeSession(f.ctx, input);
  expect(JSON.parse(String(resumed.runtime.input.accountPool))).toEqual(f.input.accountPool);
  expect(JSON.parse(String(resumed.runtime.input.config)).modelRoles).toEqual(input.overlay.modelRoles);
  expect(JSON.parse(String(resumed.runtime.input.config)).defaultThinkingLevel).toBe("high");
  await expect(resumeSession(f.ctx, { ...input, accountPool: {} })).rejects.toThrow("omp_account_unavailable");
  f.deny("containers:write");
  await expect(resumeSession(f.ctx, input)).rejects.toThrow("omp_scope_refused");
  f.deny("locations:write");
  await expect(resumeSession(f.ctx, { machineId: input.machineId, sessionId, overlay: input.overlay }))
    .rejects.toThrow("omp_caller_locations_write_required");
});

test("a model this machine cannot serve refuses, and a colon is read for what it means", async () => {
  const f = launchFixture();
  const sessionId = randomUUID();
  f.setInventory([{ id: sessionId, title: null, cwd: "/home/job/workspace", updatedAt: 123 }]);
  const resume = (model: string) =>
    resumeSession(f.ctx, {
      machineId: f.input.machineId,
      containerId: f.input.containerId,
      sessionId,
      accountPool: f.input.accountPool,
      overlay: { modelRoles: { default: model } },
    });
  // A session used to run whatever the agent resolved instead, and the receipt named that.
  await expect(resume(`anthropic/${ABSENT_MODEL_ID}`)).rejects.toThrow("omp_model_unavailable");
  // A trailing thinking level names a level, so the model in front of it still resolves.
  const levelled = await resume("anthropic/claude-sonnet-4-5:high");
  expect(JSON.parse(String(levelled.runtime.input.config)).modelRoles.default).toBe(
    "anthropic/claude-sonnet-4-5:high",
  );
  // A trailing tier is part of the id, so stripping it would refuse a model that is served.
  await expect(resume("anthropic/claude-sonnet-4-5:free")).rejects.toThrow("omp_model_unavailable");
  // A provider whose catalog the gateway resolves live is decided by the machine, not by this
  // build's snapshot. Identity is no longer judged here, so an id the SDK never carried stops
  // at the credential question instead of being refused for not existing.
  await expect(resume(UNLISTED_PUBLISHED_ID)).rejects.toThrow("omp_account_unavailable");
});

test("operator session doors reject non-owner and container-scoped authority", async () => {
  const f = launchFixture();
  const nonOwner = { ...f.ctx, auth: { ...f.ctx.auth, isRoot: false } };
  await expect(listSessions(nonOwner, { machineId: f.input.machineId })).rejects.toThrow("omp_session_owner_required");
  const scoped = { ...f.ctx, auth: { ...f.ctx.auth, containerScope: f.input.containerId } };
  await expect(resumeSession(scoped, { machineId: f.input.machineId, sessionId: randomUUID() }))
    .rejects.toThrow("omp_session_owner_required");
});
