import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatManifoldUri, MachineHalfSchema, type Cap, type ManifoldRef } from "@manifold/protocol";
import {
  ACCOUNTS_PLUGIN_ID, BROKER_SERVICE_ID, OMP_PLUGIN_ID, OmpHarnessProfileSchema, PreparedHarnessSessionSchema,
} from "../api/index.ts";
import { prepareHarnessSession } from "../atyrode.omp/execution.ts";
import { digestOf, type OmpContext } from "../atyrode.omp/machine-server.ts";
import manifest from "../atyrode.omp/manifest.json";
import { openSessionsRoot, prepareSessionFile, resolveSessionFile } from "../workers/harness/sessions.ts";
import { materializeJobInputs } from "../../../manifold/packages/agent/src/job-inputs.ts";

function launchFixture() {
  const machineId = "fixture-machine";
  const operationId = `${OMP_PLUGIN_ID}.harness`;
  const machine = MachineHalfSchema.parse(manifest.machine);
  const pins = { installationRevision: "fixture-installation", artifactSha256: "a".repeat(64), resourceBindingDigest: "b".repeat(64) };
  const consent = (cap: Cap, ref: ManifoldRef) => ({ cap, node: formatManifoldUri(ref), enabled: true, revision: "fixture-consent" });
  const operation = { kind: "operation" as const, machineId, operationId };
  const description = {
    machineId, pluginId: OMP_PLUGIN_ID, connected: true, platforms: ["linux-x64"], admissionPublicKey: "fixture-public-key",
    retainedInstallations: [],
    installation: { revision: pins.installationRevision, artifactSha256: pins.artifactSha256, enabled: true, ready: true, purgeRequested: false },
    operations: { [operationId]: { ready: true, reason: null, resourceBindingDigest: pins.resourceBindingDigest } },
    consents: [
      ...(["machines:run", "jobs:read", "jobs:input", "network:host"] as const).map(cap => consent(cap, operation)),
      ...machine.operations[operationId]!.locations.map(location => consent(`locations:${location.access}`, { kind: "location", machineId, locationId: location.locationId })),
    ],
  };
  const owner = { machineId, name: "Fixture", online: true };
  const broker = { serviceId: BROKER_SERVICE_ID, revision: "fixture-broker", machineId };
  let denied: string | undefined;
  const ctx = {
    pluginId: OMP_PLUGIN_ID,
    auth: { principal: { id: "fixture-sponsor", kind: "human" }, caps: ["*"], containerScope: null, isRoot: true,
      allows: async (cap: string) => cap !== denied },
    outsideScope: async () => null,
    now: () => 1,
    newId: async () => randomUUID(),
    storage: { get: async () => null },
    jobs: {
      describe: async () => description,
      describeDeployment: async () => ({ installation: { revision: pins.installationRevision, artifactSha256: pins.artifactSha256, machine }, deployment: null }),
    },
    services: {
      describeInstance: async () => ({ serviceId: BROKER_SERVICE_ID, owner, defaultOwner: owner, connected: true, state: "ready", reason: null,
        configuration: { revision: broker.revision, pluginId: ACCOUNTS_PLUGIN_ID, enabled: true, policySha256: "c".repeat(64) } }),
      readInstance: async () => ({ ok: true, result: { credentials: [{ id: 7, provider: "anthropic", identityKey: "fixture-identity", credential: { type: "oauth", email: "fixture@example.invalid" } }] } }),
      describe: async () => ({ connected: true, machineId, services: [{ serviceId: "omp", revision: "1", policySha256: "d".repeat(64), operations: ["models", "stream"].map(operationId => ({ operationId, ready: true })) }] }),
    },
  } as unknown as OmpContext;
  return {
    ctx, deny: (cap: string) => { denied = cap; },
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
