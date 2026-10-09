import { createHash, randomUUID } from "node:crypto";
import {
  JobDeploymentReviewSchema, JobDeploymentSchema, JobDescriptionSchema, ListJobRunsResultSchema, PublicJobSchema,
  ServiceConfigurationReadSchema, canonicalJobJson, type PublicJob, type ServiceConfiguration,
} from "@manifold/protocol";
import { ownerAction } from "../../../manifold/packages/plugin-kit/src/hub.ts";
import { waitFor } from "../../../manifold/packages/testkit/src/index.ts";
import {
  GATEWAY_OPERATION_ID, GATEWAY_PLUGIN_ID, OMP_PLUGIN_ID, ProbeFailureReceiptSchema, RefusalSchema,
  type AccountReference, type ActionInput, type ActionReply, type ActionResult, type OmpAction,
} from "../api/index.ts";

function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`native-inventory-${code}`);
}
/** A fixed native or OMP word, lowered to the receipt's code alphabet and bounded to fit it. */
function word(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}
const INVENTORY_OPERATION_ID = `${OMP_PLUGIN_ID}.inventory`;
/** OpenAI's catalog is large and Anthropic's carries Claude Haiku 5.5, which no OMP before 18.8.6 lists. */
const SYNTHETIC_PROVIDERS = ["openai", "anthropic"] as const;

/**
 * An inventory posted through the public doors starts the packed gateway as its job-scoped
 * runtime service under the real native owner, which refuses that child unless the inventory's
 * timeout covers the gateway's (#109). The pool holds one synthetic unpaid credential per
 * provider, and listing models makes no inference call, so no provider is contacted.
 */
export async function verifyNativeInventory({ hub, target, broker, client }: {
  hub: Parameters<typeof ownerAction>[0];
  target: { containerId: string; machineId: string };
  broker: { origin: string; bearer: string };
  client: { call<K extends OmpAction>(name: K, input: ActionInput<K>): Promise<ActionReply<K>> };
}): Promise<void> {
  async function call<K extends OmpAction>(name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
    const reply = await client.call(name, input);
    const refusal = RefusalSchema.safeParse(reply);
    if (refusal.success) check(false, `${word(name.replace(/[A-Z]/g, letter => `-${letter}`))}-${word(refusal.data.refused.slice("omp_".length))}`);
    return reply as ActionResult<K>;
  }
  async function deploy(pluginId: string, operationId: string, name: string): Promise<void> {
    const request = { deploymentId: randomUUID(), pluginId,
      targets: [{ machineId: target.machineId, platform: "linux-x64" }], operationIds: [operationId] };
    const review = JobDeploymentReviewSchema.parse(await ownerAction(hub, "engine.jobs.reviewDeployment", request));
    check(review.approvable, `${name}-review-${word(review.targets.find(item => !item.approvable)?.reason ?? "refused")}`);
    await ownerAction(hub, "engine.jobs.applyDeployment", { request, reviewDigest: review.reviewDigest });
    await waitFor(async () => {
      const value = JobDeploymentSchema.parse(await ownerAction(hub, "engine.jobs.readDeployment", { deploymentId: request.deploymentId }));
      const stuck = value.targets.find(item => ["refused", "needs_review", "cancelled", "superseded"].includes(item.state));
      check(!stuck, `${name}-deployment-${word(stuck?.state ?? "")}`);
      return value.targets.every(item => item.state === "ready");
    }, 480_000, 100);
  }
  /** Names a settled inventory's ending: the probe's own fixed refusal word when it wrote one. */
  async function ending(job: PublicJob): Promise<string> {
    const stdout = job.result?.outputs.find(output => output.name === "stdout");
    if (job.state === "exited" && job.result?.exitCode !== 0 && stdout && stdout.bytes > 0 && stdout.bytes <= 65_536) {
      const page = await ownerAction(hub, "engine.jobs.output", { node: { kind: "output", machineId: target.machineId,
        operationId: INVENTORY_OPERATION_ID, jobId: job.jobId, outputId: stdout.outputId }, offset: 0, maxBytes: stdout.bytes }) as { data: string };
      let receipt: unknown;
      try { receipt = JSON.parse(Buffer.from(page.data, "base64").toString("utf8")); } catch {}
      const refusal = ProbeFailureReceiptSchema.safeParse(receipt);
      if (refusal.success) return `refused-${word(refusal.data.code)}`;
    }
    return `${word(job.state)}-${String(job.result?.exitCode ?? "none")}`;
  }
  let originalServices: ServiceConfiguration | undefined;
  const credentials: { id: number; reference: AccountReference }[] = [];
  let inventory: PublicJob | undefined;
  let failed = false;
  try {
    // Existing broker client ingress owns these synthetic slots.
    const before = new Set((await call("accounts", {})).accounts.map(account => account.credentialId));
    for (const provider of SYNTHETIC_PROVIDERS) {
      const upload = await fetch(`${broker.origin}/v1/credential`, {
        method: "POST", headers: { authorization: `Bearer ${broker.bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ provider, credential: { type: "api_key", key: "SYNTHETIC-UNPAID-NATIVE-INVENTORY-PROOF" } }),
        signal: AbortSignal.timeout(5000),
      });
      check(upload.ok, `synthetic-${provider}-upload`);
      await upload.body?.cancel();
    }
    const accounts = (await call("accounts", {})).accounts.filter(value => !before.has(value.credentialId));
    credentials.push(...accounts.map(account => ({ id: account.credentialId, reference: account.reference })));
    check(accounts.length === SYNTHETIC_PROVIDERS.length && accounts.every(account => !account.disabled) &&
      SYNTHETIC_PROVIDERS.every(provider => accounts.some(account => account.reference.provider === provider)), "synthetic-account-unobserved");

    await deploy(GATEWAY_PLUGIN_ID, GATEWAY_OPERATION_ID, "gateway");
    originalServices = ServiceConfigurationReadSchema.parse(await ownerAction(hub, "engine.services.readConfiguration", { machineId: target.machineId })).configuration;
    const gateway = { ...target, expectedServiceRevision: originalServices.revision };
    const review = await call("reviewGateway", gateway);
    await call("configureGateway", { ...gateway, reviewDigest: review.reviewDigest });
    // Configuration admission is not native-owner acknowledgement. The inventory deployment
    // binds the owner's fingerprint of the configured gateway policy, so wait for it.
    const configured = ServiceConfigurationReadSchema.parse(await ownerAction(hub, "engine.services.readConfiguration", { machineId: target.machineId }));
    const policy = configured.configuration.policies.find(value => value.serviceId === "omp");
    check(policy?.runtime?.pluginId === GATEWAY_PLUGIN_ID && policy.runtime.operationId === GATEWAY_OPERATION_ID
      && policy.runtime.scope !== "instance", "gateway-not-job-scoped");
    const policyDigest = createHash("sha256").update(canonicalJobJson(policy)).digest("hex");
    await waitFor(async () => {
      const native = JobDescriptionSchema.parse(await ownerAction(hub, "engine.jobs.describe", { machineId: target.machineId, pluginId: OMP_PLUGIN_ID }));
      return native.connected && native.resources?.services.omp === policyDigest;
    }, 30_000, 50);
    await deploy(OMP_PLUGIN_ID, INVENTORY_OPERATION_ID, "inventory");

    inventory = await call("startInventory", { ...target, expectedDefaultsRevision: (await call("readDefaults", {})).revision,
      accountPool: Object.fromEntries(accounts.map(account => [account.reference.provider,
        [{ scope: account.reference.scope, credentialId: account.credentialId, identityKey: account.identityKey }]])) });
    const node = { kind: "job", machineId: target.machineId, operationId: INVENTORY_OPERATION_ID, jobId: inventory.jobId };
    const settled = await waitFor(async () => {
      const value = PublicJobSchema.parse(await ownerAction(hub, "engine.jobs.status", { node }));
      return value.result ? value : false;
    }, 180_000, 100);
    inventory = undefined;
    // A finished parent tears its runtime child down; give that child time to settle as well.
    let children: PublicJob[] = [];
    for (const deadline = Date.now() + 30_000; ; await Bun.sleep(100)) {
      const runs = ListJobRunsResultSchema.parse(await ownerAction(hub, "engine.jobs.listRuns", {
        machineId: target.machineId, pluginId: GATEWAY_PLUGIN_ID, operationId: GATEWAY_OPERATION_ID }));
      children = runs.runs.flatMap(run => run.job?.authority.origin.kind === "invocation"
        && run.job.authority.origin.parentJobId === settled.jobId ? [run.job] : []);
      if ((children.length > 0 && children.every(job => job.result !== null || job.state === "refused")) || Date.now() >= deadline) break;
    }
    if (children.length === 0) check(false, `gateway-not-invoked-${await ending(settled)}`);
    check(children.length === 1, "gateway-started-twice");
    // The owner admits the gateway only while the inventory's timeout covers the gateway's
    // (`parent_invocation_refused`). A refused child never starts and never serves `models`.
    const child = children[0]!;
    const result = child.result;
    // The gateway serves until its parent ends, so it never exits on its own here. The child's
    // cgroup sits inside the inventory's, and the owner SIGKILLs that whole subtree when the
    // inventory exits, before cancelling its children. If the child's own result settles first it
    // records `exited` with no exit code; if the cancel reaches it first, `cancelled`. Either is
    // that teardown; any other ending, such as the gateway's own `gateway_unavailable` exit, fails.
    const tornDown = result?.exitCode === null && ((child.state === "exited" && result.reason === null)
      || (child.state === "cancelled" && result.reason === "cancelled"));
    check(result && result.startedAt !== null && tornDown,
      `gateway-${word(child.state)}-${word(result?.reason ?? String(result?.exitCode ?? "none"))}`);
    check(settled.state === "exited" && settled.result?.exitCode === 0, `job-${await ending(settled)}`);
    const receipt = await call("readInventory", { ...target, jobId: settled.jobId });
    const addresses = receipt.inventory.models.map(model => `${model.provider}/${model.id}`);
    check(addresses.some(address => address.startsWith("openai/")) &&
      receipt.inventory.models.every(model => SYNTHETIC_PROVIDERS.some(provider => provider === model.provider)), "receipt-models");
    // The packed runtime's own `omp models --json --no-extensions` lists the model released with 18.8.6.
    check(addresses.includes("anthropic/claude-haiku-5-5"), "receipt-claude-haiku-5-5");
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    let cleanupFailed = false;
    if (inventory) try {
      await ownerAction(hub, "engine.jobs.cancel", { node: { kind: "job", machineId: target.machineId,
        operationId: INVENTORY_OPERATION_ID, jobId: inventory.jobId } });
    } catch { cleanupFailed = true; }
    if (originalServices) try {
      const current = ServiceConfigurationReadSchema.parse(await ownerAction(hub, "engine.services.readConfiguration", { machineId: target.machineId }));
      await ownerAction(hub, "engine.services.configureConfiguration", { machineId: target.machineId,
        expectedRevision: current.configuration.revision, policies: originalServices.policies });
    } catch { cleanupFailed = true; }
    for (const credential of credentials) try {
      await call("disableCredential", { containerId: target.containerId, reference: credential.reference, credentialId: credential.id });
    } catch { cleanupFailed = true; }
    // A cleanup failure must not mask the assertion that failed first.
    if (!failed) check(!cleanupFailed, "cleanup-failed");
  }
}
