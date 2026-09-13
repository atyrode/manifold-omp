import { expect, test } from "bun:test";
import {
  CAPS,
  formatManifoldUri,
  JobDescriptionSchema,
  MachineHalfSchema,
  type Cap,
  type ManifoldRef,
  type ServiceConfigurationRead,
} from "@manifold/protocol";
import {
  ACCOUNTS_PLUGIN_ID,
  BROKER_OPERATION_ID,
  BROKER_SERVICE_ID,
  GATEWAY_OPERATION_ID,
  GATEWAY_PLUGIN_ID,
  OMP_PLUGIN_ID,
  PREPARE_WORKSPACE_OPERATION_ID,
  SIGN_IN_OPERATION_ID,
  createOmpClient,
} from "../api/index.ts";
import {
  currentOperation,
  describeDestination,
  operationReadiness,
  type OmpContext,
} from "../atyrode.omp/machine-server.ts";
import { handlers as accountHandlers } from "../atyrode.omp/accounts/server.ts";
import { handlers as rootHandlers } from "../atyrode.omp/server.ts";
import { handlers as gatewayHandlers } from "../atyrode.omp/gateway/server.ts";
import {
  buildGatewayPolicy,
  buildSharedBrokerPolicy,
} from "../atyrode.omp/service-policies.ts";
import rootManifest from "../atyrode.omp/manifest.json";
import accountsManifest from "../atyrode.omp/accounts/manifest.json";
import gatewayManifest from "../atyrode.omp/gateway/manifest.json";

const target = { containerId: "fixture-room", machineId: "fixture-machine" };
const pins = {
  installationRevision: "fixture-installation",
  artifactSha256: "a".repeat(64),
  resourceBindingDigest: "b".repeat(64),
};

function fixture(pluginId: string) {
  const manifest =
    pluginId === ACCOUNTS_PLUGIN_ID
      ? accountsManifest
      : pluginId === GATEWAY_PLUGIN_ID
        ? gatewayManifest
        : rootManifest;
  const machine = MachineHalfSchema.parse(manifest.machine);
  const consents: {
    node: string;
    cap: Cap;
    enabled: boolean;
    revision: string;
  }[] = [];
  for (const operationId of Object.keys(machine.operations)) {
    const node = formatManifoldUri({
      kind: "operation",
      machineId: target.machineId,
      operationId,
    });
    for (const cap of [
      "machines:run",
      "jobs:read",
      "jobs:input",
      "network:host",
    ] as const)
      consents.push({ node, cap, enabled: true, revision: "fixture-consent" });
  }
  for (const locationId of Object.keys(machine.locations))
    for (const cap of [
      "locations:read",
      "locations:write",
      "locations:create",
    ] as const)
      consents.push({
        node: formatManifoldUri({
          kind: "location",
          machineId: target.machineId,
          locationId,
        }),
        cap,
        enabled: true,
        revision: "fixture-consent",
      });
  const native = JobDescriptionSchema.parse({
    machineId: target.machineId,
    pluginId,
    connected: true,
    platforms: ["linux-x64"],
    admissionPublicKey: "-----BEGIN PUBLIC KEY----- fixture",
    retainedInstallations: [],
    consents,
    operations: Object.fromEntries(
      Object.keys(machine.operations).map((operationId) => [
        operationId,
        {
          ready: true,
          reason: null,
          resourceBindingDigest: pins.resourceBindingDigest,
        },
      ]),
    ),
    installation: {
      revision: pins.installationRevision,
      artifactSha256: pins.artifactSha256,
      enabled: true,
      ready: true,
      purgeRequested: false,
    },
  });
  const owner = {
    machineId: target.machineId,
    name: "Fixture owner",
    online: true,
  };
  const broker = {
    serviceId: BROKER_SERVICE_ID,
    owner,
    defaultOwner: owner,
    connected: true,
    state: "ready" as const,
    reason: null,
    configuration: {
      revision: "fixture-broker",
      pluginId: ACCOUNTS_PLUGIN_ID,
      enabled: true,
      policySha256: "e".repeat(64),
    },
  };
  const brokerPolicy = buildSharedBrokerPolicy({
    scope: "instance",
    pluginId: ACCOUNTS_PLUGIN_ID,
    operationId: BROKER_OPERATION_ID,
    ...pins,
    input: { clientAccess: { literal: "{}" } },
  });
  const gatewayRuntime = {
    pluginId: GATEWAY_PLUGIN_ID,
    operationId: GATEWAY_OPERATION_ID,
    ...pins,
  };
  const gatewayPolicy = buildGatewayPolicy({
    ...gatewayRuntime,
    input: { accountPool: { input: "accountPool" } },
  });
  const configuration: ServiceConfigurationRead = {
    connected: true,
    configuration: { revision: "c".repeat(64), policies: [gatewayPolicy] },
    credentialReferences: [
      {
        ref: "private-native-reference",
        origins: ["https://fixture.invalid"],
        available: true,
      },
    ],
    runtimeCandidates: [{ runtime: gatewayRuntime, ready: true, reason: null }],
  };
  const authority = {
    caps: ["*"] as Cap[],
    isRoot: true,
    allows: async (
      _cap: Exclude<Cap, "*">,
      _ref?: ManifoldRef,
    ): Promise<boolean> => true,
  };
  const effects: string[] = [];
  const mutate = async () => {
    effects.push("mutation");
    throw new Error("Observation attempted a mutation");
  };
  const ownJob = (args: { pluginId: string; machineId: string }) => {
    if (args.pluginId !== pluginId || args.machineId !== target.machineId)
      throw new Error("Cross-owner native observation");
  };
  const ctx = {
    pluginId,
    auth: {
      principal: { id: "fixture-owner", kind: "human" },
      containerScope: null,
      get caps() {
        return authority.caps;
      },
      get isRoot() {
        return authority.isRoot;
      },
      allows: (cap: Exclude<Cap, "*">, ref?: ManifoldRef) =>
        authority.allows(cap, ref),
    },
    outsideScope: async () => false,
    now: () => 1,
    newId: mutate,
    storage: {
      get: async () => null,
      set: mutate,
      compareAndSet: mutate,
      delete: mutate,
    },
    jobs: {
      describe: async (args: { pluginId: string; machineId: string }) => {
        ownJob(args);
        return native;
      },
      describeDeployment: async (args: {
        pluginId: string;
        machineId: string;
      }) => {
        ownJob(args);
        return {
          installation: {
            revision: pins.installationRevision,
            artifactSha256: pins.artifactSha256,
            machine,
          },
          deployment: null,
        };
      },
      execute: mutate,
      applyDeployment: mutate,
      install: mutate,
      consent: mutate,
    },
    services: {
      describeInstance: async () => broker,
      readInstanceConfiguration: async () => ({
        description: broker,
        policy: brokerPolicy,
      }),
      readConfiguration: async () => configuration,
      describe: async () => ({
        machineId: target.machineId,
        connected: true,
        services: [
          {
            serviceId: "omp",
            revision: "1",
            policySha256: "d".repeat(64),
            operations: ["models", "stream"].map((operationId) => ({
              operationId,
              readable: true,
              invocable: true,
              ready: true,
              reason: null,
            })),
          },
        ],
      }),
      configureInstance: mutate,
      configureConfiguration: mutate,
      readInstance: mutate,
      invokeInstance: mutate,
    },
  } as unknown as OmpContext;
  const client = createOmpClient(async (door, input) => {
    const name = door.slice(pluginId.length + 1);
    if (!door.startsWith(`${pluginId}.`))
      throw new Error("Cross-owner action dispatch");
    const handler =
      pluginId === ACCOUNTS_PLUGIN_ID
        ? accountHandlers[name]
        : pluginId === GATEWAY_PLUGIN_ID
          ? gatewayHandlers[name]
          : rootHandlers[name];
    if (!handler) throw new Error("Unknown owner action");
    return handler(ctx, input);
  });
  return {
    ctx,
    client,
    authority,
    native,
    machine,
    broker,
    configuration,
    effects,
  };
}

test("ready native root resources cannot override a denied bound location grant", async () => {
  const f = fixture(OMP_PLUGIN_ID);
  f.authority.allows = async (cap, ref) =>
    !(
      cap === "locations:create" &&
      ref?.kind === "location" &&
      ref.locationId === "atyrode.omp.workspace"
    );
  const destination = await describeDestination(f.ctx, target);
  const workspace = destination.operations.find(
    (operation) => operation.operationId === PREPARE_WORKSPACE_OPERATION_ID,
  )!;
  expect(workspace).toMatchObject({
    nativeReady: true,
    state: "refused",
    callerRefusal: "caller_locations_create_required",
  });
  expect(destination.state).toBe("refused");
  await expect(
    currentOperation(f.ctx, target.machineId, PREPARE_WORKSPACE_OPERATION_ID),
  ).rejects.toThrow("omp_caller_locations_create_required");
  expect(f.effects).toEqual([]);
});

test("account sign-in refuses the actual credential ceiling while its broker remains healthy", async () => {
  const f = fixture(ACCOUNTS_PLUGIN_ID);
  const prepared = await f.client.call("prepareSignIn", {
    containerId: target.containerId,
    expectedBrokerRevision: f.broker.configuration.revision,
  });
  expect(prepared).toMatchObject({
    machineId: target.machineId,
    runtime: { machineId: target.machineId, pluginId: ACCOUNTS_PLUGIN_ID },
  });
  const ready = await f.client.call("readAccountSetup", {});
  expect(ready).toMatchObject({
    nativeReady: true,
    canReview: true,
    canSignIn: true,
  });
  // A permissive node grant is insufficient when this credential does not carry the cap.
  f.authority.caps = CAPS.filter(
    (cap) => cap !== "*" && cap !== "network:host",
  );
  const refused = await f.client.call("readAccountSetup", {});
  expect(refused).toMatchObject({
    nativeReady: true,
    brokerState: "ready",
    state: "refused",
    canReview: false,
    canSignIn: false,
    callerRefusal: "caller_network_host_required",
  });
  expect(
    await f.client.call("prepareSignIn", {
      containerId: target.containerId,
      expectedBrokerRevision: f.broker.configuration.revision,
    }),
  ).toEqual({ refused: "omp_caller_network_host_required" });
  expect(f.effects).toEqual([]);
});

test("terminal preparation requires current spawn authority before returning a descriptor", async () => {
  const withoutSpawn = CAPS.filter(
    (cap) => cap !== "*" && cap !== "terminals:spawn",
  );
  const root = fixture(OMP_PLUGIN_ID);
  root.authority.caps = withoutSpawn;
  expect(
    await root.client.call("prepareSession", {
      ...target,
      expectedDefaultsRevision: 0,
      accountPool: {},
      overlay: {},
      prompt: "",
      planYolo: false,
      reviewDigest: "f".repeat(64),
    }),
  ).toEqual({ refused: "omp_caller_terminals_spawn_required" });
  expect(root.effects).toEqual([]);

  const accounts = fixture(ACCOUNTS_PLUGIN_ID);
  accounts.authority.caps = withoutSpawn;
  expect(
    await accounts.client.call("prepareSignIn", {
      containerId: target.containerId,
      expectedBrokerRevision: accounts.broker.configuration.revision,
    }),
  ).toEqual({ refused: "omp_caller_terminals_spawn_required" });
  expect(accounts.effects).toEqual([]);
});

test("unobservable sign-in input authority never offers a healthy broker as ready", async () => {
  const f = fixture(ACCOUNTS_PLUGIN_ID);
  f.authority.allows = async (cap, ref) => {
    if (
      cap === "jobs:input" &&
      ref?.kind === "operation" &&
      ref.operationId === SIGN_IN_OPERATION_ID
    )
      throw new Error("Authority unavailable");
    return true;
  };
  expect(await f.client.call("readAccountSetup", {})).toMatchObject({
    nativeReady: true,
    brokerState: "ready",
    state: "refused",
    canSignIn: false,
    canReview: false,
    callerRefusal: "caller_authority_unobserved",
  });
  expect(f.effects).toEqual([]);
});

test("gateway observation independently offers only the authoritative destination revision without deployment work", async () => {
  const f = fixture(GATEWAY_PLUGIN_ID);
  const setup = await f.client.call("readGatewaySetup", target);
  if ("refused" in setup) throw new Error(setup.refused);
  expect(setup.canReview).toBe(true);
  expect(setup.deployment).toBeNull();
  expect(setup.revision).not.toBe("1");
  const reviewed = await f.client.call("reviewGateway", {
    ...target,
    expectedServiceRevision: setup.revision,
  });
  expect(reviewed).toHaveProperty("reviewDigest");
  expect(
    await f.client.call("reviewGateway", {
      ...target,
      expectedServiceRevision: "1",
    }),
  ).toEqual({ refused: "omp_service_configuration_changed" });
  expect(JSON.stringify(setup)).not.toContain("private-native-reference");
  expect(f.effects).toEqual([]);
});

test("gateway service grants are checked at their bound operation rather than inferred from runtime health", async () => {
  const f = fixture(GATEWAY_PLUGIN_ID);
  f.authority.allows = async (cap, ref) =>
    !(
      cap === "services:invoke" &&
      ref?.kind === "service" &&
      ref.serviceId === BROKER_SERVICE_ID &&
      ref.operationId === "gateway-refresh"
    );
  const setup = await f.client.call("readGatewaySetup", target);
  expect(setup).toMatchObject({
    nativeReady: true,
    canReview: false,
    callerRefusal: "caller_services_invoke_required",
    operation: {
      state: "refused",
      callerRefusal: "caller_services_invoke_required",
    },
  });
  expect(
    await f.client.call("reviewGateway", {
      ...target,
      expectedServiceRevision: f.configuration.configuration.revision,
    }),
  ).toEqual({ refused: "omp_caller_services_invoke_required" });
  expect(f.effects).toEqual([]);
});

test("gateway observation refuses an owner-only revision and mismatched authoritative candidate separately", async () => {
  const f = fixture(GATEWAY_PLUGIN_ID);
  f.authority.isRoot = false;
  expect(await f.client.call("readGatewaySetup", target)).toMatchObject({
    nativeReady: true,
    revision: null,
    canReview: false,
    callerRefusal: "service_owner_required",
  });
  expect(
    await f.client.call("reviewGateway", {
      ...target,
      expectedServiceRevision: f.configuration.configuration.revision,
    }),
  ).toEqual({ refused: "omp_service_owner_required" });
  f.authority.isRoot = true;
  f.configuration.runtimeCandidates[0]!.runtime.resourceBindingDigest =
    "f".repeat(64);
  expect(await f.client.call("readGatewaySetup", target)).toMatchObject({
    nativeReady: true,
    canReview: false,
    callerRefusal: null,
    operation: { state: "refused", reason: "resources_changed" },
  });
  expect(
    await f.client.call("reviewGateway", {
      ...target,
      expectedServiceRevision: f.configuration.configuration.revision,
    }),
  ).toEqual({ refused: "omp_resources_changed" });
  expect(f.effects).toEqual([]);
});

test("a root-owned context cannot impersonate either owner observer", async () => {
  const f = fixture(OMP_PLUGIN_ID);
  expect(await accountHandlers.readAccountSetup!(f.ctx, {})).toEqual({
    refused: "omp_scope_refused",
  });
  expect(await gatewayHandlers.readGatewaySetup!(f.ctx, target)).toEqual({
    refused: "omp_scope_refused",
  });
  expect(f.effects).toEqual([]);
});

test("native failures retain their distinction when caller permission is independently refused", async () => {
  const f = fixture(OMP_PLUGIN_ID);
  f.authority.allows = async (cap) => cap !== "locations:create";
  const nativeOperation = f.native.operations![PREPARE_WORKSPACE_OPERATION_ID]!;
  nativeOperation.ready = false;
  nativeOperation.reason = "anchors_revision_changed";
  expect(
    await operationReadiness(
      f.ctx,
      f.native,
      PREPARE_WORKSPACE_OPERATION_ID,
      f.machine,
    ),
  ).toMatchObject({
    nativeReady: false,
    state: "refused",
    reason: "anchors_revision_changed",
    callerRefusal: "caller_locations_create_required",
  });
  f.native.connected = false;
  expect(
    await operationReadiness(
      f.ctx,
      f.native,
      PREPARE_WORKSPACE_OPERATION_ID,
      f.machine,
    ),
  ).toMatchObject({
    nativeReady: false,
    state: "offline",
    reason: "machine_offline",
    callerRefusal: "caller_locations_create_required",
  });
  f.native.connected = true;
  f.native.platforms = ["darwin-arm64"];
  expect(
    await operationReadiness(
      f.ctx,
      f.native,
      PREPARE_WORKSPACE_OPERATION_ID,
      f.machine,
    ),
  ).toMatchObject({
    nativeReady: false,
    state: "unsupported",
    reason: "platform_unsupported",
  });
  f.native.platforms = ["linux-x64"];
  f.native.installation = null;
  expect(
    await operationReadiness(
      f.ctx,
      f.native,
      PREPARE_WORKSPACE_OPERATION_ID,
      f.machine,
    ),
  ).toMatchObject({
    nativeReady: false,
    state: "missing",
    reason: "installation_missing",
  });
  expect(f.effects).toEqual([]);
});

test("readiness grades a retained installation's extra bound reference rather than the server manifest", async () => {
  const f = fixture(OMP_PLUGIN_ID);
  const locationId = "atyrode.omp.retained-workspace";
  f.machine.locations[locationId] = {
    anchor: "home",
    components: ["retained-workspace"],
    revision: "1",
  };
  f.machine.operations[PREPARE_WORKSPACE_OPERATION_ID]!.locations.push({
    locationId,
    access: "create",
  });
  f.native.consents.push({
    node: formatManifoldUri({
      kind: "location",
      machineId: target.machineId,
      locationId,
    }),
    cap: "locations:create",
    enabled: true,
    revision: "fixture-retained-consent",
  });
  f.authority.allows = async (cap, ref) =>
    !(
      cap === "locations:create" &&
      ref?.kind === "location" &&
      ref.locationId === locationId
    );
  expect(
    (await describeDestination(f.ctx, target)).operations.find(
      (operation) => operation.operationId === PREPARE_WORKSPACE_OPERATION_ID,
    ),
  ).toMatchObject({
    nativeReady: true,
    state: "refused",
    callerRefusal: "caller_locations_create_required",
  });
  await expect(
    currentOperation(f.ctx, target.machineId, PREPARE_WORKSPACE_OPERATION_ID),
  ).rejects.toThrow("omp_caller_locations_create_required");
  expect(f.effects).toEqual([]);
});

test("a broker hidden from a caller does not erase independent folder readiness", async () => {
  const f = fixture(OMP_PLUGIN_ID);
  f.authority.isRoot = false;
  f.authority.caps = CAPS.filter((cap) => cap !== "*");
  f.ctx.services.describeInstance = async () => {
    throw new Error("service_unauthorized");
  };
  f.ctx.services.listInstances = async () => ({
    defaultOwner: null,
    services: [],
  });
  const destination = await describeDestination(f.ctx, target);
  expect(
    destination.operations.find(
      (operation) => operation.operationId === PREPARE_WORKSPACE_OPERATION_ID,
    ),
  ).toMatchObject({ nativeReady: true, state: "ready", callerRefusal: null });
  expect(
    destination.services.find(
      (service) => service.serviceId === BROKER_SERVICE_ID,
    ),
  ).toEqual({
    serviceId: BROKER_SERVICE_ID,
    state: "refused",
    reason: "caller_authority_unobserved",
  });
});

test("visible broker state remains authoritative for a non-root caller", async () => {
  const f = fixture(OMP_PLUGIN_ID);
  f.authority.isRoot = false;
  f.authority.caps = CAPS.filter((cap) => cap !== "*");
  f.broker.owner.online = false;
  f.ctx.services.listInstances = async () => ({
    defaultOwner: null,
    services: [f.broker],
  });
  const destination = await describeDestination(f.ctx, target);
  expect(
    destination.services.find(
      (service) => service.serviceId === BROKER_SERVICE_ID,
    ),
  ).toEqual({
    serviceId: BROKER_SERVICE_ID,
    state: "offline",
    reason: "account_owner_unavailable",
  });
});

test("unrelated inventory does not invalidate broker approval but native pins and consent still do", async () => {
  const f = fixture(ACCOUNTS_PLUGIN_ID);
  f.native.resources = {
    tools: {},
    services: { "unrelated.broker": "c".repeat(64) },
    anchors: {},
    serviceDefinitions: {
      "unrelated.broker": { revision: "old", operationIds: ["metadata"] },
    },
  };
  const expectedBrokerRevision = f.broker.configuration.revision;
  const review = await f.client.call("reviewAccountRuntime", { expectedBrokerRevision });
  if ("refused" in review) throw new Error(review.refused);
  delete f.native.resources.services["unrelated.broker"];
  delete f.native.resources.serviceDefinitions["unrelated.broker"];
  const after = await f.client.call("reviewAccountRuntime", { expectedBrokerRevision });
  if ("refused" in after) throw new Error(after.refused);
  expect(after.reviewDigest).toBe(review.reviewDigest);

  const approval = { containerId: target.containerId, expectedBrokerRevision,
    reviewDigest: review.reviewDigest };
  f.native.operations![BROKER_OPERATION_ID]!.resourceBindingDigest = "f".repeat(64);
  expect(await f.client.call("promoteAccountRuntime", approval))
    .toEqual({ refused: "omp_review_changed" });
  f.native.operations![BROKER_OPERATION_ID]!.resourceBindingDigest = pins.resourceBindingDigest;
  const writer = f.native.consents.find(consent => consent.cap === "locations:write")!;
  writer.revision = "reapproved-writer";
  expect(await f.client.call("promoteAccountRuntime", approval))
    .toEqual({ refused: "omp_review_changed" });
  writer.enabled = false;
  expect(await f.client.call("promoteAccountRuntime", approval))
    .toEqual({ refused: "omp_native_consent_required" });
  expect(f.effects).toEqual([]);
});
