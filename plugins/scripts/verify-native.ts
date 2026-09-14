import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ActionInput, ActionResult, OmpAction } from "../api/index.ts";
import type { TestAgent } from "../../../manifold/packages/testkit/src/index.ts";

class VerificationFailure extends Error {
  constructor(readonly code: string) { super("OMP native verification assertion failed"); }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new VerificationFailure(code);
}

process.umask(0o077);
let outcome: { ok: boolean; code?: string };
// Only verifier-owned phase identifiers cross IPC; never serialize an exception,
// native denial message, request, credential, or server output to diagnose a failure.
let phase = "isolation";
try {
  const root = process.env.OMP_VERIFY_ROOT;
  check(root && process.cwd() === join(root, "cwd") && process.env.HOME === join(root, "home")
    && process.env.PI_CODING_AGENT_DIR === join(root, "agent") && process.send, "missing-private-environment");
  // Intentional module-loading boundary: static imports would run before this
  // child verifies the launcher's empty credential environment and private HOME.
  phase = "import-pack";
  const { pack } = await import("../pack.ts");
  phase = "import-public-api";
  const { actionDoor, actionSchemas, createOmpClient, RefusalSchema, OMP_PLUGIN_ID,
    ACCOUNTS_PLUGIN_ID, GATEWAY_PLUGIN_ID, BROKER_SERVICE_ID, BROKER_OPERATION_ID, SIGN_IN_OPERATION_ID, OMP_VERSION } = await import("../api/index.ts");
  phase = "import-native-kit";
  const { installBundle } = await import("../../../manifold/packages/plugin-kit/src/install.ts");
  const { dispatch, ownerAction, roster } = await import("../../../manifold/packages/plugin-kit/src/hub.ts");
  phase = "import-native-fixture";
  const { startServer, startAgent, waitFor, createContainer, enrollMachine, mintToken } = await import("../../../manifold/packages/testkit/src/index.ts");
  phase = "import-native-protocol";
  const { JobDescriptionSchema, JobDeploymentDescriptionSchema, JobDeploymentReviewSchema,
    JobDeploymentListResultSchema, JobDeploymentSchema, ListJobRunsResultSchema, MachineHalfSchema,
    JobOwnerConfigSchema, PublicJobSchema, InstanceServiceDescriptionSchema, InstanceServiceConfigurationReadSchema,
    canonicalJobJson, machineArtifacts } = await import("@manifold/protocol");

  const expectedFamily: readonly string[] = [OMP_PLUGIN_ID, ACCOUNTS_PLUGIN_ID, GATEWAY_PLUGIN_ID];
  phase = "pack";
  const bundles = await pack(join(root, "bundles"));
  check(bundles.length === expectedFamily.length && bundles.every((bundle, index) => bundle.id === expectedFamily[index]), "unexpected-packed-family");
  phase = "server-start";
  let server = await startServer({ dataDir: join(root, "hub"), ownerKey: randomBytes(32).toString("hex"),
    env: { MANIFOLD_PLUGIN_DEV_PATHS: "1" } });
  const hub = { url: server.httpUrl, ownerKey: server.ownerKey };
  const installed: string[] = [];
  let cleanupFailed = false;
  let agent: TestAgent | undefined;
  let nativeOwner: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined;
  const digest = (value: unknown) => createHash("sha256").update(canonicalJobJson(value)).digest("hex");
  const instance = async () => InstanceServiceDescriptionSchema.parse(
    await ownerAction(hub, "engine.services.describeInstance", { serviceId: BROKER_SERVICE_ID }));
  const stopBroker = async () => {
    const current = InstanceServiceConfigurationReadSchema.parse(await ownerAction(hub, "engine.services.readInstanceConfiguration", { serviceId: BROKER_SERVICE_ID }));
    if (!current.description.configuration?.enabled) return;
    check(current.policy, "configured-broker-policy-missing");
    await ownerAction(hub, "engine.services.configureInstance", { serviceId: BROKER_SERVICE_ID,
      expectedRevision: current.description.configuration.revision, policy: current.policy, enabled: false });
    await waitFor(async () => (await instance()).state === "stopped", 30_000, 50);
  };
  try {
    phase = "baseline-roster";
    const baseline = await roster(hub);
    check(!baseline.some(row => row.manifest.id === "atyrode.code" || row.manifest.id.startsWith("atyrode.code.")), "code-present-before-install");
    for (const bundle of bundles) {
      // Track before installation so partially successful installs are also removed.
      installed.push(bundle.id);
      phase = `install-family-${expectedFamily.indexOf(bundle.id)}`;
      await installBundle({ source: bundle.file, sha256: bundle.sha256, hub, hardened: true });
    }
    phase = "installed-roster";
    const loaded = await roster(hub);
    const added = loaded.filter(row => !baseline.some(previous => previous.manifest.id === row.manifest.id));
    check(added.length === expectedFamily.length && added.every(row => expectedFamily.includes(row.manifest.id)), "standalone-roster-widened");
    for (const id of expectedFamily) {
      const row = loaded.find(entry => entry.manifest.id === id);
      check(row?.enabled && !["enable_failed", "isolate_crashed"].includes(row.lifecycle ?? ""), "family-not-serving");
    }
    // Absence is an engine-observed fact, not a grep over source or dependency text.
    phase = "code-absence";
    const absent = await dispatch(hub, hub.ownerKey, "atyrode.code.readSettings", {});
    check(!absent.ok && absent.denial.rule === "unknown_action", "code-action-still-available");

    const client = createOmpClient(async (door, args) => {
      const result = await dispatch(hub, hub.ownerKey, door, args);
      if (result.ok) return result.result;
      if (result.denial.rule === "refused") {
        const refusal = RefusalSchema.safeParse({ refused: result.denial.message });
        if (refusal.success) return refusal.data;
      }
      throw new VerificationFailure(`${phase}-transport-failed`);
    });
    async function call<K extends OmpAction>(name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
      phase = `public-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
      const reply = await client.call(name, input);
      const refusal = RefusalSchema.safeParse(reply);
      if (refusal.success) {
        const known = {
          omp_invalid_request: "invalid-request",
          omp_operation_unavailable: "operation-unavailable",
          omp_broker_unavailable: "broker-unavailable",
          omp_resources_changed: "resources-changed",
        } as const;
        const reason = Object.hasOwn(known, refusal.data.refused)
          ? known[refusal.data.refused as keyof typeof known] : "unexpected-refusal";
        throw new VerificationFailure(`${phase}-${reason}`);
      }
      return actionSchemas[name].result.parse(reply) as ActionResult<K>;
    }
    async function refused<K extends OmpAction>(name: K, input: ActionInput<K>): Promise<void> {
      phase = `public-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
      check(RefusalSchema.safeParse(await client.call(name, input)).success, `${phase}-unsafe-admission`);
    }
    // Every published public door is reachable in the real isolate. Empty args
    // may be invalid, but never substitute for the valid boundary calls below.
    for (const name of Object.keys(actionSchemas) as OmpAction[]) {
      phase = `door-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
      const door = actionDoor(name);
      check(loaded.some(row => row.actions.some(action => action.name === door)), "public-door-not-published");
      const result = await dispatch(hub, hub.ownerKey, door, {});
      check(result.ok || ["invalid_args", "refused"].includes(result.denial.rule), "public-door-not-serving");
    }

    const defaults = await call("readDefaults", {});
    const changed = await call("writeDefaults", { expectedRevision: defaults.revision,
      overlay: { prewalk: { enabled: false }, defaultThinkingLevel: "high" } });
    check(changed.revision > defaults.revision, "defaults-revision-did-not-advance");
    await refused("writeDefaults", { expectedRevision: defaults.revision, overlay: { prewalk: { enabled: true } } });
    const persisted = await call("readDefaults", {});
    check(persisted.revision === changed.revision && persisted.overlay.prewalk?.enabled === false
      && persisted.overlay.defaultThinkingLevel === "high", "stale-write-mutated-defaults");
    phase = "forbidden-defaults";
    const forbiddenOverlay = await dispatch(hub, hub.ownerKey, actionDoor("writeDefaults"), {
      expectedRevision: changed.revision, overlay: { environment: { OMP_VERIFY_FORBIDDEN: "1" } },
    });
    check(!forbiddenOverlay.ok && forbiddenOverlay.denial.rule === "invalid_args", "defaults-accepted-environment-authority");

    phase = "create-destination";
    const container = await createContainer(server, "OMP disposable verification");
    const enrollment = await enrollMachine(server, "omp-disposable-offline");
    const target = { containerId: container.id, machineId: enrollment.machineId };
    const destination = await call("describeDestination", target);
    check(destination.state === "offline" && destination.operations.every(operation => operation.state === "offline"), "offline-destination-reported-ready");
    phase = "non-owner-destination-without-broker";
    const observer = await mintToken(server, {
      principal: { kind: "human", name: "Readiness observer", color: "#336699" },
      caps: ["containers:read", "machines:run", "jobs:read", "services:read"],
    });
    const observerReply = await dispatch(hub, observer.token, actionDoor("describeDestination"), target);
    check(observerReply.ok, "broker-absence-erased-destination");
    const observerDestination = actionSchemas.describeDestination.result.parse(observerReply.result);
    check(observerDestination.operations.every(operation => operation.state === "offline")
      && observerDestination.services.some(service => service.serviceId === BROKER_SERVICE_ID
        && service.state === "refused" && service.reason === "caller_authority_unobserved"),
    "non-owner-broker-absence-misrepresented");
    const accounts = await call("accounts", {});
    check(accounts.accounts.length === 0 && accounts.status === "unavailable", "unconfigured-broker-exposed-accounts");
    const usage = await call("usage", {});
    check(usage.accounts.accounts.length === 0 && usage.snapshot === null, "unconfigured-broker-exposed-usage");
    const setup = await call("readAccountSetup", {});
    check(!setup.canSignIn && setup.revision === null, "sign-in-implicitly-configured-broker");

    const unreviewed = randomBytes(32).toString("hex");
    await refused("reviewWorkspace", { ...target, mode: "create" });
    await refused("prepareWorkspace", { ...target, mode: "create", reviewDigest: unreviewed });
    await refused("reviewGateway", { ...target, expectedServiceRevision: null });
    await refused("configureGateway", { ...target, expectedServiceRevision: null, reviewDigest: unreviewed });
    await refused("reviewAccountRuntime", { expectedBrokerRevision: null });
    await refused("promoteAccountRuntime", { containerId: container.id, expectedBrokerRevision: null, reviewDigest: unreviewed });
    await refused("prepareSignIn", { containerId: container.id, expectedBrokerRevision: "unconfigured" });
    const session = { ...target, expectedDefaultsRevision: changed.revision, accountPool: {}, overlay: {}, prompt: "", planYolo: false };
    await refused("reviewSession", session);
    await refused("prepareSession", { ...session, reviewDigest: unreviewed });
    await refused("runSession", { ...session, prompt: "verify", reviewDigest: unreviewed });
    await refused("listSessions", { machineId: target.machineId });
    await refused("resumeSession", { machineId: target.machineId, sessionId: randomUUID() });
    await refused("startInventory", { ...target, expectedDefaultsRevision: changed.revision, accountPool: {} });
    const missingJob = randomUUID();
    await refused("readInventory", { ...target, jobId: missingJob });
    await refused("readSession", { ...target, jobId: missingJob });
    // Neither read nor cancel answers a job this door never posted, whatever its state.
    await refused("cancelSession", { ...target, jobId: missingJob });
    await refused("startBenchmark", { ...target, inventoryJobId: missingJob, candidates: {
      schemaVersion: 1, inventoryObservedAt: 0, ompVersion: OMP_VERSION,
      candidates: [{ key: "offline", provider: "fixture", id: "offline", api: "fixture" }],
    } });
    await refused("readBenchmark", { ...target, inventoryJobId: missingJob, jobId: randomUUID() });
    // These contain no credential value or identity. An absent, unbound slot must
    // never become a mutation against some other available credential owner.
    const control = { containerId: container.id, reference: { kind: "credential" as const,
      scope: "unconfigured", provider: "fixture", credentialId: 1 }, credentialId: 1 };
    await refused("clearAccountBlocks", control);
    await refused("disableCredential", control);

    // Native deployment APIs inspect the ACTUAL packed declaration. An enrolled
    // offline destination supplies no resource evidence, so preparation cannot
    // be made ready or applied, even by the disposable server's root principal.
    for (const pluginId of expectedFamily) {
      phase = `native-describe-family-${expectedFamily.indexOf(pluginId)}`;
      const description = JobDescriptionSchema.parse(await ownerAction(hub, "engine.jobs.describe", { machineId: target.machineId, pluginId }));
      check(!description.connected && description.installation === null, "unprepared-native-installation-present");
      const row = loaded.find(entry => entry.manifest.id === pluginId);
      const machine = MachineHalfSchema.parse(row?.manifest.machine);
      const request = { deploymentId: randomUUID(), pluginId,
        targets: [{ machineId: target.machineId, platform: "linux-x64" }], operationIds: Object.keys(machine.operations) };
      phase = `native-review-family-${expectedFamily.indexOf(pluginId)}`;
      const review = JobDeploymentReviewSchema.parse(await ownerAction(hub, "engine.jobs.reviewDeployment", request));
      check(!review.approvable && review.targets.every(value => !value.approvable), "offline-native-review-approved");
      phase = `native-apply-family-${expectedFamily.indexOf(pluginId)}`;
      const applied = await dispatch(hub, hub.ownerKey, "engine.jobs.applyDeployment", { request, reviewDigest: review.reviewDigest });
      check(!applied.ok && applied.denial.rule === "refused", "unapprovable-native-review-applied");
      const artifact = Object.values(machine.artifacts)[0];
      check(artifact, "packed-native-artifact-missing");
      phase = `native-install-family-${expectedFamily.indexOf(pluginId)}`;
      const install = await dispatch(hub, hub.ownerKey, "engine.jobs.install", { machineId: target.machineId, pluginId,
        installationRevision: "verify-unbound", artifactSha256: artifact.sha256, machine });
      check(!install.ok && install.denial.rule === "refused", "unbound-native-installation-admitted");
      phase = `native-deployment-family-${expectedFamily.indexOf(pluginId)}`;
      const deployment = JobDeploymentDescriptionSchema.parse(await ownerAction(hub, "engine.jobs.describeDeployment", { machineId: target.machineId, pluginId }));
      check(deployment.installation === null && deployment.deployment === null, "failed-preparation-retained-installation");
      phase = `native-list-family-${expectedFamily.indexOf(pluginId)}`;
      const records = JobDeploymentListResultSchema.parse(await ownerAction(hub, "engine.jobs.listDeployments", { pluginId }));
      check(records.deployments.length === 0, "failed-review-created-deployment");
    }
    phase = "native-execution";
    const rootMachine = MachineHalfSchema.parse(loaded.find(row => row.manifest.id === OMP_PLUGIN_ID)?.manifest.machine);
    const boundedOperation = Object.entries(rootMachine.operations).find(([, operation]) =>
      !operation.stdin && Object.keys(operation.input).length === 0);
    check(boundedOperation, "bounded-workspace-operation-missing");
    const refusedJobId = randomUUID();
    const execution = await dispatch(hub, hub.ownerKey, "engine.jobs.execute", {
      machineId: target.machineId, pluginId: OMP_PLUGIN_ID, operationId: boundedOperation[0],
      jobId: refusedJobId, input: {}, outputs: [],
    });
    check(!execution.ok && execution.denial.rule === "refused", "unprepared-native-job-admitted");
    phase = "native-runs";
    const runs = ListJobRunsResultSchema.parse(await ownerAction(hub, "engine.jobs.listRuns", {
      machineId: target.machineId, pluginId: OMP_PLUGIN_ID,
    }));
    check(runs.runs.length === 0, "refused-actions-queued-native-work");
    phase = "native-status";
    const jobStatus = await dispatch(hub, hub.ownerKey, "engine.jobs.status", {
      node: { kind: "job", machineId: target.machineId, operationId: boundedOperation[0], jobId: refusedJobId },
    });
    check(!jobStatus.ok && jobStatus.denial.rule === "refused", "unprepared-job-left-runtime-state");

    const finalSetup = await call("readAccountSetup", {});
    check(finalSetup.revision === null && !finalSetup.canSignIn, "refused-actions-configured-custody");
    check((await call("readDefaults", {})).revision === changed.revision, "refused-actions-mutated-defaults");

    // Positive execution uses the installed accounts worker and its pinned native
    // tools. The only host resources admitted are the explicit system closure and
    // bubblewrap fixture; neither OMP source workers nor a host OMP are consulted.
    phase = "native-owner-resources";
    const cgroup = process.env.OMP_VERIFY_CGROUP;
    const bwrapPath = process.env.OMP_VERIFY_BWRAP;
    const systemPath = process.env.OMP_VERIFY_SYSTEM;
    check(cgroup && bwrapPath && systemPath && [cgroup, bwrapPath, systemPath].every(isAbsolute), "explicit-native-resources-required");
    const membership = (await readFile("/proc/self/cgroup", "utf8")).split("\n").find(line => line.startsWith("0::"))?.slice(3);
    check(membership?.endsWith("/supervisor") && cgroup === `/sys/fs/cgroup${membership.slice(0, -"/supervisor".length)}/workloads`
      && /\/omp-native-verify-[a-f0-9-]{36}\.service\/supervisor$/.test(membership), "owner-outside-disposable-unit");
    const bubblewrap = await realpath(bwrapPath);
    const bwrapStat = await stat(bubblewrap);
    check(bwrapStat.isFile() && (bwrapStat.mode & 0o111) !== 0 && (bwrapStat.mode & 0o6000) === 0, "invalid-bubblewrap-fixture");
    const system = JobOwnerConfigSchema.shape.runtimeTools.parse({ system: JSON.parse(await readFile(systemPath, "utf8")) });
    check(system.system?.every(bind => bind.kind === "file"), "system-closure-must-name-library-files");
    const accountMachine = MachineHalfSchema.parse(loaded.find(row => row.manifest.id === ACCOUNTS_PLUGIN_ID)?.manifest.machine);
    const controlDirectory = join(root, "owner");
    const stateDirectory = join(controlDirectory, "state");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const ownerGroup = join(cgroup, "accounts-owner");
    await mkdir(ownerGroup);
    await writeFile(join(ownerGroup, "cgroup.subtree_control"), "+cpu +memory +pids");
    const socket = join(controlDirectory, "owner.sock");
    const config = join(controlDirectory, "owner.json");
    const initialNative = JobDescriptionSchema.parse(await ownerAction(hub, "engine.jobs.describe", {
      machineId: target.machineId, pluginId: ACCOUNTS_PLUGIN_ID,
    }));
    // CA data must arrive in the reviewed bundle, not expand the native owner's
    // download authority beyond the existing binary/SDK publishers.
    const origins = new Set(["https://github.com", "https://release-assets.githubusercontent.com", "https://registry.npmjs.org"]);
    check(machineArtifacts(accountMachine).every(artifact => !artifact.url || origins.has(new URL(artifact.url).origin)),
      "packed-runtime-expanded-download-authority");
    const ownerConfiguration = JobOwnerConfigSchema.parse({
      machineId: target.machineId, admissionPublicKey: initialNative.admissionPublicKey,
      stateDirectory, delegatedCgroup: ownerGroup, bubblewrap,
      protectedDirectories: [controlDirectory], anchors: {}, runtimeTools: system,
      artifactOrigins: [...origins],
    });
    await writeFile(config, JSON.stringify(ownerConfiguration), { mode: 0o600 });

    // The instance's default service owner is native server configuration, not an
    // OMP setting. Restart only this disposable hub, keeping its authenticated
    // identity, installed bytes and port; no live instance or custody is touched.
    phase = "native-service-owner-bootstrap";
    await server.stop();
    server = await startServer({ dataDir: server.dataDir, port: server.port, ownerKey: server.ownerKey,
      env: { MANIFOLD_PLUGIN_DEV_PATHS: "1", MANIFOLD_SERVICE_OWNER_MACHINE_ID: target.machineId } });
    hub.url = server.httpUrl;
    const nativeRoot = resolve(import.meta.dir, "../../../manifold");
    nativeOwner = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "packages/agent/src/main.ts", "--terminal-host"], {
      cwd: nativeRoot, env: { ...process.env, MANIFOLD_JOB_OWNER_CONFIG: config,
        MANIFOLD_JOB_OWNER_SOCKET: socket, MANIFOLD_TERMINAL_HOST_SOCKET: `${socket}.terminal` },
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    await waitFor(async () => {
      check(nativeOwner?.exitCode === null, "native-owner-exited-before-ready");
      const sockets = await Promise.all([socket, `${socket}.terminal`].map(path => stat(path).catch(() => null)));
      return sockets.every(value => value?.isSocket());
    }, 30_000, 50);
    agent = await startAgent({ serverUrl: server.url, machineToken: enrollment.machineToken,
      name: "omp-disposable-offline", env: { MANIFOLD_JOB_OWNER_SOCKET: socket },
      existingHost: { process: nativeOwner, socketPath: `${socket}.terminal` } });
    const describeAccounts = async () => JobDescriptionSchema.parse(await ownerAction(hub, "engine.jobs.describe", {
      machineId: target.machineId, pluginId: ACCOUNTS_PLUGIN_ID,
    }));
    const eligible = await waitFor(async () => {
      const value = await describeAccounts();
      return value.connected && value.resources?.tools.system ? value : false;
    }, 30_000, 50);
    check(eligible.platforms.includes("linux-x64"), "native-owner-platform-mismatch");
    check(Object.keys(eligible.resources!.tools).length === 1, "ambient-runtime-tool-exposed");

    phase = "packed-accounts-deployment-review";
    const deploymentRequest = { deploymentId: randomUUID(), pluginId: ACCOUNTS_PLUGIN_ID,
      targets: [{ machineId: target.machineId, platform: "linux-x64" }], operationIds: [BROKER_OPERATION_ID, SIGN_IN_OPERATION_ID] };
    const reviewed = JobDeploymentReviewSchema.parse(await ownerAction(hub, "engine.jobs.reviewDeployment", deploymentRequest));
    const reviewedTarget = reviewed.targets[0];
    check(reviewed.approvable && reviewedTarget?.approvable && reviewedTarget.connected, "eligible-native-review-refused");
    check(reviewed.declarationSha256 === digest(accountMachine) && digest(reviewed.machine) === digest(accountMachine), "reviewed-declaration-not-packed");
    check(reviewedTarget.artifactSha256 === accountMachine.artifacts["linux-x64"]?.sha256
      && reviewedTarget.resourceBindings?.tools.system === eligible.resources!.tools.system, "reviewed-resource-pins-mismatch");
    const applied = JobDeploymentSchema.parse(await ownerAction(hub, "engine.jobs.applyDeployment", {
      request: deploymentRequest, reviewDigest: reviewed.reviewDigest,
    }));
    check(applied.review.reviewDigest === reviewed.reviewDigest, "applied-unreviewed-deployment");
    phase = "packed-accounts-installation";
    await waitFor(async () => {
      const current = JobDeploymentSchema.parse(await ownerAction(hub, "engine.jobs.readDeployment", { deploymentId: deploymentRequest.deploymentId }));
      // A refusal that does not name itself costs a whole CI round trip to diagnose.
      const stuck = current.targets.find(value => ["refused", "needs_review", "cancelled", "superseded"].includes(value.state));
      check(!stuck, `packed-deployment-${`${stuck?.state}-${stuck?.reason ?? "unstated"}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "").slice(0, 64)}`);
      return current.targets.every(value => value.state === "ready");
    }, 480_000, 100);
    const ready = await describeAccounts();
    check(ready.installation?.ready && ready.installation.revision === reviewedTarget.installationRevision
      && ready.installation.artifactSha256 === reviewedTarget.artifactSha256
      && digest(ready.installation.resourceBindings) === digest(reviewedTarget.resourceBindings), "installed-pins-differ-from-review");
    const grantedRights = ready.consents.filter(consent => consent.enabled).map(value => `${value.node}:${value.cap}`).sort();
    const reviewedRights = reviewedTarget.consents.map(value => `${value.node}:${value.cap}`).sort();
    check(digest(grantedRights) === digest(reviewedRights), "applied-consent-scope-differs-from-review");

    phase = "packed-broker-public-review";
    const clientBearer = `synthetic-legacy-client-${randomUUID()}`;
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
    const clientAccess = { bind: `127.0.0.1:${reservation.port}`,
      bearerSha256: new Bun.CryptoHasher("sha256").update(clientBearer).digest("hex") };
    reservation.stop(true);
    const brokerReview = await call("reviewAccountRuntime", { expectedBrokerRevision: null, clientAccess });
    check(brokerReview.ownerMachineId === target.machineId && brokerReview.broker.installationRevision === ready.installation.revision
      && brokerReview.broker.artifactSha256 === ready.installation.artifactSha256
      && brokerReview.broker.resourceBindingDigest === ready.operations?.[BROKER_OPERATION_ID]?.resourceBindingDigest, "broker-review-pins-mismatch");
    check(digest(brokerReview.clientAccess) === digest(clientAccess), "client-access-not-in-review");
    await refused("promoteAccountRuntime", { containerId: target.containerId,
      expectedBrokerRevision: null, clientAccess: null, reviewDigest: brokerReview.reviewDigest });
    check((await instance()).state === "unconfigured", "changed-client-access-mutated-custody");
    const promoted = await call("promoteAccountRuntime", { containerId: target.containerId,
      expectedBrokerRevision: null, clientAccess, reviewDigest: brokerReview.reviewDigest });
    phase = "packed-broker-worker-ready";
    await waitFor(async () => {
      const value = await instance();
      check(!["unavailable", "stopped"].includes(value.state), "packed-broker-worker-refused");
      return value.state === "ready" && value.configuration?.revision === promoted.revision;
    }, 60_000, 50);
    const retainedAccess = await call("reviewAccountRuntime", { expectedBrokerRevision: promoted.revision });
    check(digest(retainedAccess.clientAccess) === digest(clientAccess), "omitted-client-access-not-retained");
    const legacySnapshot = await fetch(`http://${clientAccess.bind}/v1/snapshot`, {
      headers: { authorization: `Bearer ${clientBearer}` }, signal: AbortSignal.timeout(5000),
    });
    check(legacySnapshot.status === 200, "unchanged-legacy-client-refused");
    await legacySnapshot.body?.cancel();
    const fresh = await call("accounts", {});
    check(fresh.status === "fresh" && fresh.observedAt !== null && fresh.accounts.length === 0, "packed-broker-metadata-not-observed");
    const freshUsage = await call("usage", {});
    check(freshUsage.accounts.status === "fresh" && freshUsage.accounts.accounts.length === 0
      && freshUsage.refreshStatus === "succeeded", "packed-broker-usage-not-observed");
    const brokerRuns = ListJobRunsResultSchema.parse(await ownerAction(hub, "engine.jobs.listRuns", {
      machineId: target.machineId, pluginId: ACCOUNTS_PLUGIN_ID, operationId: BROKER_OPERATION_ID,
    }));
    check(brokerRuns.runs.length === 1, "broker-runtime-not-single-owner");
    const brokerJob = brokerRuns.runs[0]?.job;
    check(brokerJob, "broker-runtime-job-missing");
    check(brokerJob.state === "started", `broker-runtime-state-${brokerJob.state}`);
    check(brokerJob.authority.executor?.machineId === target.machineId, "broker-executor-unproved");
    check(brokerJob.authority.decision?.allowed, "broker-decision-unproved");
    check(brokerJob.authority.origin.kind === "service" &&
      brokerJob.authority.origin.serviceId === BROKER_SERVICE_ID &&
      brokerJob.authority.origin.revision === promoted.revision, "broker-service-binding-mismatch");
    check(brokerJob.installationRevision === ready.installation.revision && brokerJob.artifactSha256 === reviewedTarget.artifactSha256
      && brokerJob.resourceBindingDigest === brokerReview.broker.resourceBindingDigest, "executed-worker-pins-mismatch");
    check(brokerJob.authority.decision.consents.every(consent => consent.artifactSha256 === brokerJob.artifactSha256
      && ready.consents.some(value => value.enabled && value.node === consent.node && value.revision === consent.revision)),
      "executed-worker-consent-mismatch");
    // Preparation returns a native descriptor only. Never launch sign-in or seed
    // an account merely to turn an empty-pool execution refusal into success.
    const signIn = await call("prepareSignIn", { containerId: target.containerId, expectedBrokerRevision: promoted.revision });
    check(signIn.machineId === target.machineId && signIn.runtime.pluginId === ACCOUNTS_PLUGIN_ID
      && signIn.runtime.operationId === SIGN_IN_OPERATION_ID && signIn.runtime.installationRevision === ready.installation.revision
      && signIn.runtime.artifactSha256 === ready.installation.artifactSha256
      && signIn.runtime.resourceBindingDigest === brokerReview.signIn.resourceBindingDigest, "prepared-sign-in-pins-mismatch");
    await refused("startInventory", { ...target, expectedDefaultsRevision: changed.revision, accountPool: {} });
    phase = "packed-broker-graceful-stop";
    await stopBroker();
    const stoppedJob = await waitFor(async () => {
      const value = PublicJobSchema.parse(await ownerAction(hub, "engine.jobs.status", {
        node: { kind: "job", machineId: target.machineId, operationId: BROKER_OPERATION_ID, jobId: brokerJob.jobId },
      }));
      return ["cancelled", "exited"].includes(value.state) && value.result ? value : false;
    }, 30_000, 50);
    check(stoppedJob.result && stoppedJob.result.startedAt !== null && stoppedJob.result.finishedAt !== null, "broker-stop-receipt-missing");
    check((await call("accounts", {})).status === "unavailable", "stopped-broker-still-readable");
    phase = "packed-broker-reviewed-recovery";
    const pausedSetup = await call("readAccountSetup", {});
    check(pausedSetup.brokerState === "disabled" && pausedSetup.canReview && !pausedSetup.canSignIn,
      "paused-broker-review-unavailable");
    const pausedRevision = (await instance()).configuration!.revision;
    await refused("prepareSignIn", { containerId: target.containerId, expectedBrokerRevision: pausedRevision });
    const recoveryReview = await call("reviewAccountRuntime", { expectedBrokerRevision: pausedRevision });
    check(digest(recoveryReview.clientAccess) === digest(clientAccess), "recovery-dropped-client-access");
    const stillPaused = await instance();
    check(stillPaused.state === "stopped" && !stillPaused.configuration!.enabled
      && stillPaused.configuration!.revision === pausedRevision, "observation-resumed-paused-broker");
    await refused("promoteAccountRuntime", { containerId: target.containerId,
      expectedBrokerRevision: promoted.revision, reviewDigest: retainedAccess.reviewDigest });
    const recovered = await call("promoteAccountRuntime", { containerId: target.containerId,
      expectedBrokerRevision: pausedRevision, reviewDigest: recoveryReview.reviewDigest });
    await waitFor(async () => {
      const value = await instance();
      return value.state === "ready" && value.configuration?.revision === recovered.revision;
    }, 60_000, 50);
    const recoveredConfiguration = InstanceServiceConfigurationReadSchema.parse(
      await ownerAction(hub, "engine.services.readInstanceConfiguration", { serviceId: BROKER_SERVICE_ID }));
    check(recoveredConfiguration.policy?.revision === "1", "recovery-changed-broker-service-contract");
    const recoveredSnapshot = await fetch(`http://${clientAccess.bind}/v1/snapshot`, {
      headers: { authorization: `Bearer ${clientBearer}` }, signal: AbortSignal.timeout(5000),
    });
    check(recoveredSnapshot.status === 200, "recovery-broke-unchanged-legacy-client");
    await recoveredSnapshot.body?.cancel();
    check((await call("accounts", {})).status === "fresh", "recovered-broker-not-readable");
    check(!(await roster(hub)).some(row => row.manifest.id === "atyrode.code" || row.manifest.id.startsWith("atyrode.code.")),
      "positive-worker-introduced-code-dependency");
  } finally {
    try { await stopBroker(); } catch { cleanupFailed = true; }
    for (const id of installed.reverse()) {
      try {
        const row = (await roster(hub)).find(entry => entry.manifest.id === id);
        if (!row) continue;
        if (row.enabled) await ownerAction(hub, "engine.plugins.setEnabled", { id, enabled: false });
        await ownerAction(hub, "engine.plugins.uninstall", { id, purge: true });
      } catch { cleanupFailed = true; }
    }
    try {
      check(!(await roster(hub)).some(row => expectedFamily.includes(row.manifest.id)), "family-retained-after-uninstall");
    } catch { cleanupFailed = true; }
    try { await agent?.stop(); } catch { cleanupFailed = true; }
    if (nativeOwner) {
      if (nativeOwner.exitCode === null) nativeOwner.kill("SIGTERM");
      if (!await Promise.race([nativeOwner.exited.then(() => true), Bun.sleep(10_000).then(() => false)])) {
        nativeOwner.kill("SIGKILL");
        await nativeOwner.exited;
        cleanupFailed = true;
      }
    }
    await server.stop();
    check(!cleanupFailed, "native-cleanup-failed");
  }
  outcome = { ok: true };
} catch (error) {
  outcome = { ok: false, code: error instanceof VerificationFailure ? error.code : `${phase}-failed` };
}
if (!process.send || !process.connected) process.exit(1);
const delivered = await new Promise<boolean>(resolve => {
  try { process.send?.(outcome, error => resolve(!error)); }
  catch { resolve(false); }
});
if (process.connected) process.disconnect?.();
process.exit(outcome.ok && delivered ? 0 : 1);
