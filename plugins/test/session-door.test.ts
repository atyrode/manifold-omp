import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { JobDescriptionSchema, JobFollowSnapshotSchema, MachineHalfSchema, type Cap } from "@manifold/protocol";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
  BROKER_SERVICE_ID,
  ACCOUNTS_PLUGIN_ID,
  INVENTORY_OPERATION_ID,
  LAUNCH_OPERATION_ID,
  OMP_PLUGIN_ID,
  RUNS_LOCATION_ID,
  SESSION_GUEST_PATH,
  PROMPT_MAX_BYTES,
  SESSION_OPERATION_ID,
  MATERIAL_SESSION_OPERATION_ID,
  SESSION_OUTPUT_NAME,
  createOmpClient,
  exactModelScope,
  type ActionInput,
  type ActionReply,
  type OmpAction,
  type JobInputBinding,
  type PublicJob,
} from "../api/index.ts";
import { digestOf, type OmpContext } from "../atyrode.omp/machine-server.ts";
import { handlers as rootHandlers } from "../atyrode.omp/server.ts";
import rootManifest from "../atyrode.omp/manifest.json";
import sdkRuntimeArtifacts from "../sdk-host/runtime-artifacts.json";
import { OPENROUTER_LISTING_TEMPLATE } from "../workers/gateway/template.ts";
import { ProbeModelsConfigSchema } from "../workers/probe/inputs.ts";

type JobInput = Record<string, string | number | boolean>;
type JobNode = { kind: "job"; machineId: string; operationId: string; jobId: string };
type PostedJob = {
  jobId: string;
  operationId: string;
  input: JobInput;
  outputs: { name: string; locationId: string; components: string[] }[];
  inputs?: JobInputBinding[];
  limits?: PublicJob["limits"];
};
type JobOverrides = {
  state?: "exited" | "started" | "cancelled" | "interrupted";
  exitCode?: number | null;
  door?: string;
  inputs?: JobInputBinding[];
  limits?: PublicJob["limits"] | null;
  resultLimits?: PublicJob["limits"];
};
interface OmpClient {
  call<K extends OmpAction>(name: K, input: ActionInput<K>): Promise<ActionReply<K>>;
}
interface Fixture {
  ctx: OmpContext;
  client: OmpClient;
  posted: PostedJob[];
  cancelled: string[];
  seal(jobId: string, archive: Buffer): void;
  /** What the session process wrote to its standard error, as the owner sealed it. */
  said(jobId: string, stderr: string): void;
  amend(jobId: string, overrides: JobOverrides): void;
  state: { gatewayRevision: string };
}

const target = { containerId: "fixture-room", machineId: "fixture-machine" };
const pins = {
  installationRevision: "fixture-installation",
  artifactSha256: "a".repeat(64),
  resourceBindingDigest: "b".repeat(64),
};
const owner = { machineId: target.machineId, name: "Fixture owner", online: true };
const broker = {
  serviceId: BROKER_SERVICE_ID,
  revision: "fixture-broker",
  machineId: owner.machineId,
};
const scope = digestOf(broker);
const session = {
  ...target,
  expectedDefaultsRevision: 0,
  accountPool: {
    anthropic: [{ scope, credentialId: 7, identityKey: "fixture-identity" }],
  },
  overlay: { modelRoles: { default: "anthropic/claude-sonnet-4-5" } },
  prompt: "summarise the repository",
  planYolo: false,
};
const machine = MachineHalfSchema.parse(rootManifest.machine);
const launch = machine.operations[LAUNCH_OPERATION_ID]!;
const oneShot = machine.operations[SESSION_OPERATION_ID]!;

/** How the owner turns a reviewed argv template plus one job's input into a command line. */
function argvFor(operation: typeof launch, input: JobInput): string[] {
  return operation.argv
    .filter((slot) => !slot.when || input[slot.when.input] === slot.when.equals)
    .map((slot) => ("literal" in slot ? slot.literal : String(input[slot.input])));
}

/** Canonical POSIX ustar, as `JobOutputStore.seal` writes it: lexical files, two zero blocks. */
function ustar(members: readonly (readonly [string, string])[]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of members) {
    const content = Buffer.from(body, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    const octal = (value: number, offset: number, length: number) =>
      header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
    octal(0o600, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(content.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = 0x30;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

// A transcript in the shape omp 18.1.14 writes under --session-dir.
const sessionId = "01a0a008-88ed-7186-b28f-6356df68f8ed";
const stem = `2026-09-14T13-08-29-037Z_${sessionId}`;
const transcriptName = `${stem}.jsonl`;
function assistant(text: string, tokens: number, cost: number): string {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: {
        input: tokens,
        output: tokens * 2,
        cacheRead: 1,
        cacheWrite: 2,
        totalTokens: tokens * 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
      stopReason: "stop",
    },
  });
}
const transcript = [
  JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-09-14T13:08:29.037Z" }),
  JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-09-14T13:08:29.037Z",
    cwd: "/home/job/workspace",
  }),
  JSON.stringify({
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "summarise the repository" }] },
  }),
  assistant("first turn", 10, 0.25),
  assistant("the repository builds one plugin", 20, 0.5),
  JSON.stringify({ type: "custom", customType: "session_exit", data: { kind: "normal" } }),
  "",
].join("\n");
const receipt = {
  sessionId,
  sessionPath: `${SESSION_GUEST_PATH}/${transcriptName}`,
  model: "anthropic/claude-sonnet-4-5",
  finalMessage: "the repository builds one plugin",
  usage: { input: 30, output: 60, cacheRead: 2, cacheWrite: 4, cost: 0.75 },
  exitCode: 0,
  failure: null,
  // The receipt carries what was asked for beside what answered; here they agree.
  configuredModel: "anthropic/claude-sonnet-4-5",
};

function publicJob(
  jobId: string,
  operationId: string,
  inputDigest: string,
  overrides: JobOverrides = {},
): PublicJob {
  const state = overrides.state ?? "exited";
  const exitCode = overrides.exitCode === undefined ? 0 : overrides.exitCode;
  return {
    jobId,
    machineId: target.machineId,
    operationId,
    pluginId: OMP_PLUGIN_ID,
    ...pins,
    inputDigest,
    ...(overrides.inputs === undefined ? {} : { inputs: overrides.inputs }),
    ...(overrides.limits == null ? {} : { limits: overrides.limits }),
    state,
    nextInputSeq: null,
    result:
      state === "exited"
        ? {
            jobId,
            requestDigest: "c".repeat(64),
            ownerId: "fixture-owner",
            ownerGeneration: 1,
            state,
            exitCode,
            reason: null,
            startedAt: 1,
            finishedAt: 2,
            usage: null,
            limits: overrides.resultLimits ?? overrides.limits ?? {
              timeoutMs: launch.limits.timeoutMs,
              memoryBytes: launch.limits.memoryBytes,
              processes: launch.limits.processes,
              outputBytes: launch.limits.outputBytes,
            },
            outputs: [],
          }
        : null,
    authority: {
      origin: {
        kind: "action",
        traceId: "fixture-trace",
        door: `${OMP_PLUGIN_ID}.${overrides.door ?? "runSession"}`,
      },
      requester: "fixture-owner",
      executor: null,
      decision: null,
    },
  };
}

function fixture(): Fixture {
  const storage = new Map<string, string>();
  const archives = new Map<string, Buffer>();
  const jobs = new Map<string, PublicJob>();
  const doors = new Map<string, string>();
  const bound = new Map<string, JobInputBinding[] | undefined>();
  const posted: PostedJob[] = [];
  const cancelled: string[] = [];
  const state = { gatewayRevision: "1" };
  let ids = 0;
  const consents: { node: string; cap: Cap; enabled: boolean; revision: string }[] = [];
  for (const operationId of Object.keys(machine.operations))
    for (const cap of ["machines:run", "jobs:read", "jobs:input", "network:host"] as const)
      consents.push({
        node: `manifold://machine/${target.machineId}/operation/${operationId}`,
        cap,
        enabled: true,
        revision: "fixture-consent",
      });
  for (const locationId of Object.keys(machine.locations))
    for (const cap of ["locations:read", "locations:write", "locations:create"] as const)
      consents.push({
        node: `manifold://machine/${target.machineId}/location/${locationId}`,
        cap,
        enabled: true,
        revision: "fixture-consent",
      });
  const native = JobDescriptionSchema.parse({
    machineId: target.machineId,
    pluginId: OMP_PLUGIN_ID,
    connected: true,
    platforms: ["linux-x64"],
    admissionPublicKey: "-----BEGIN PUBLIC KEY----- fixture",
    retainedInstallations: [],
    consents,
    operations: Object.fromEntries(
      Object.keys(machine.operations).map((operationId) => [
        operationId,
        { ready: true, reason: null, resourceBindingDigest: pins.resourceBindingDigest },
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
  /** Replace a job, keeping the identity and any sealed outputs the run already has. */
  const advance = (jobId: string, overrides: JobOverrides) => {
    const job = jobs.get(jobId)!;
    const next = publicJob(jobId, job.operationId, job.inputDigest, {
      door: doors.get(jobId)!,
      ...(bound.get(jobId) === undefined ? {} : { inputs: bound.get(jobId)! }),
      limits: job.limits,
      ...overrides,
    });
    if (next.result && job.result) next.result.outputs = job.result.outputs;
    jobs.set(jobId, next);
    return next;
  };
  const ctx = {
    pluginId: OMP_PLUGIN_ID,
    auth: {
      principal: { id: "fixture-owner", kind: "human" },
      containerScope: null,
      caps: ["*"] as Cap[],
      isRoot: true,
      allows: async () => true,
    },
    outsideScope: async () => false,
    now: () => 1,
    newId: async () => `job-${(ids += 1)}`,
    storage: {
      get: async (key: string) => storage.get(key) ?? null,
      set: async (key: string, value: string) => void storage.set(key, value),
      compareAndSet: async (key: string, expected: string | null, value: string) => {
        if ((storage.get(key) ?? null) !== expected) return false;
        storage.set(key, value);
        return true;
      },
      delete: async (key: string) => void storage.delete(key),
    },
    jobs: {
      describe: async () => native,
      describeDeployment: async () => ({
        installation: {
          revision: pins.installationRevision,
          artifactSha256: pins.artifactSha256,
          machine,
        },
        deployment: null,
      }),
      execute: async (args: PostedJob) => {
        posted.push(args);
        const door =
          args.operationId === INVENTORY_OPERATION_ID ? "startInventory" : "runSession";
        doors.set(args.jobId, door);
        bound.set(args.jobId, args.inputs);
        // The hub echoes the bindings it admitted, and nothing when there were none.
        const job = publicJob(args.jobId, args.operationId, digestOf(args.input), {
          door,
          ...(args.inputs === undefined ? {} : { inputs: args.inputs }),
          limits: args.limits,
        });
        jobs.set(args.jobId, job);
        return job;
      },
      status: async (node: JobNode) => {
        const job = jobs.get(node.jobId);
        if (!job) throw new Error("unknown job");
        return job;
      },
      // The hub makes cancelling a settled job a no-op rather than a refusal.
      cancel: async (node: JobNode) => void cancelled.push(node.jobId),
      output: async (args: {
        node: { jobId: string; outputId: string };
        offset: number;
        maxBytes: number;
      }) => {
        const archive = archives.get(args.node.outputId)!;
        const data = archive.subarray(args.offset, args.offset + args.maxBytes);
        return {
          jobId: args.node.jobId,
          outputId: args.node.outputId,
          seq: args.offset,
          data: data.toString("base64"),
          eof: args.offset + data.length === archive.length,
        };
      },
    },
    services: {
      describeInstance: async () => ({
        serviceId: BROKER_SERVICE_ID,
        defaultOwner: owner,
        owner,
        configuration: {
          revision: broker.revision,
          pluginId: ACCOUNTS_PLUGIN_ID,
          enabled: true,
          policySha256: "d".repeat(64),
        },
        connected: true,
        state: "ready",
        reason: null,
      }),
      readInstance: async () => ({
        ok: true,
        result: {
          credentials: [
            {
              id: 7,
              provider: "anthropic",
              identityKey: "fixture-identity",
              credential: { type: "oauth", email: "fixture@example.invalid" },
            },
          ],
        },
      }),
      describe: async () => ({
        machineId: target.machineId,
        connected: true,
        services: [
          {
            serviceId: "omp",
            revision: state.gatewayRevision,
            policySha256: "e".repeat(64),
            operations: ["models", "stream"].map((operationId) => ({
              operationId,
              readable: true,
              invocable: true,
              ready: true,
              reason: null,
              ...(operationId === "stream" ? {
                meter: { kind: "pi-native-usage" as const },
                prices: { models: { "anthropic/claude-sonnet-4-5": { inputPerMillion: 3_000_000, outputPerMillion: 15_000_000 } } },
              } : {}),
            })),
          },
        ],
      }),
    },
  } as unknown as OmpContext;
  return {
    ctx,
    client: createOmpClient(async (door, input) =>
      rootHandlers[door.slice(OMP_PLUGIN_ID.length + 1)]!(ctx, input),
    ),
    posted,
    cancelled,
    /** Attach a sealed transcript to the job's declared `session` output. */
    seal(jobId, archive) {
      const job = jobs.get(jobId)!;
      const outputId = `${jobId}-${SESSION_OUTPUT_NAME}`;
      archives.set(outputId, archive);
      job.result!.outputs = [
        {
          outputId,
          name: SESSION_OUTPUT_NAME,
          sha256: createHash("sha256").update(archive).digest("hex"),
          bytes: archive.length,
          files: 1,
        },
      ];
    },
    said(jobId, stderr) {
      const job = jobs.get(jobId)!;
      const outputId = `${jobId}-stderr`;
      const bytes = Buffer.from(stderr, "utf8");
      archives.set(outputId, bytes);
      job.result!.outputs.push({
        outputId,
        name: "stderr",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        files: 1,
      });
    },
    amend: advance,
    state,
  };
}

async function reviewDigestOf(client: OmpClient, input: ActionInput<"reviewSession"> = session): Promise<string> {
  const reviewed = await client.call("reviewSession", input);
  if ("refused" in reviewed) throw new Error(reviewed.refused);
  return reviewed.reviewDigest;
}
async function run(f: Fixture): Promise<PublicJob> {
  const job = await f.client.call("runSession", {
    ...session,
    reviewDigest: await reviewDigestOf(f.client),
  });
  if ("refused" in job) throw new Error(job.refused);
  return job;
}


test("runSession posts the reviewed session as a one-shot job that retains its transcript", async () => {
  const f = fixture();
  const job = await run(f);
  const posted = f.posted[0]!;
  expect(f.posted).toHaveLength(1);
  expect(job.jobId).toBe(posted.jobId);
  expect(job.operationId).toBe(SESSION_OPERATION_ID);
  expect(job.authority.origin.door).toBe(`${OMP_PLUGIN_ID}.runSession`);
  expect(posted.outputs).toEqual([
    { name: SESSION_OUTPUT_NAME, locationId: RUNS_LOCATION_ID, components: [posted.jobId] },
  ]);
  expect(job.inputDigest).toBe(digestOf(posted.input));
});


test("runSession refuses a stale review", async () => {
  const f = fixture();
  expect(await f.client.call("runSession", { ...session, reviewDigest: "f".repeat(64) })).toEqual({
    refused: "omp_review_changed",
  });
  expect(f.posted).toEqual([]);
});

test("runSession refuses a resource that moved after the review matched", async () => {
  const f = fixture();
  const reviewDigest = await reviewDigestOf(f.client);
  const describe = f.ctx.services.describe;
  let seen = 0;
  // Two preparations run per call; re-pin the gateway between them.
  f.ctx.services.describe = (async (args: { machineId: string }) => {
    if ((seen += 1) === 2) f.state.gatewayRevision = "2";
    return describe(args);
  }) as typeof describe;
  expect(await f.client.call("runSession", { ...session, reviewDigest })).toEqual({
    refused: "omp_resources_changed",
  });
  expect(f.posted).toEqual([]);
});

test("runSession refuses when the one-shot operation itself is re-bound", async () => {
  const f = fixture();
  const reviewDigest = await reviewDigestOf(f.client);
  const describe = f.ctx.jobs.describe;
  let seen = 0;
  // Each preparation observes launch then the one-shot; re-bind only the one-shot's
  // resources, during the second preparation, so the content review still matches.
  f.ctx.jobs.describe = (async (args: { machineId: string; pluginId: string }) => {
    const native = JobDescriptionSchema.parse(await describe(args));
    if ((seen += 1) < 4) return native;
    native.operations![SESSION_OPERATION_ID]!.resourceBindingDigest = "9".repeat(64);
    return native;
  }) as typeof describe;
  expect(await f.client.call("runSession", { ...session, reviewDigest })).toEqual({
    refused: "omp_resources_changed",
  });
  expect(f.posted).toEqual([]);
});

test("runSession refuses a session with no prompt, which could never end by itself", async () => {
  const f = fixture();
  const silent = { ...session, prompt: "" };
  expect(
    await f.client.call("runSession", {
      ...silent,
      reviewDigest: await reviewDigestOf(f.client, silent),
    }),
  ).toEqual({ refused: "omp_prompt_required" });
  expect(f.posted).toEqual([]);
});

test("readSession summarises the retained transcript of a finished run", async () => {
  const f = fixture();
  const job = await run(f);
  f.seal(job.jobId, ustar([[transcriptName, transcript]]));
  const read = await f.client.call("readSession", { ...target, jobId: job.jobId });
  if ("refused" in read) throw new Error(read.refused);
  expect(read.job.jobId).toBe(job.jobId);
  expect(read.session).toEqual(receipt);
});

test("readSession reads past the artifact directory omp writes beside the transcript", async () => {
  const f = fixture();
  const job = await run(f);
  // A tool-using run roots its artifact store at `<transcript without .jsonl>/`.
  f.seal(
    job.jobId,
    ustar([
      [`${stem}/0.bash.log`, "$ ls\nplugins\n"],
      [`${stem}/1.eval.log`, "ok\n"],
      [`${stem}/__advisor.jsonl`, '{"type":"note"}\n'],
      [transcriptName, transcript],
    ]),
  );
  const read = await f.client.call("readSession", { ...target, jobId: job.jobId });
  if ("refused" in read) throw new Error(read.refused);
  expect(read.session).toEqual(receipt);
});

test("readSession refuses an archive holding more than one transcript", async () => {
  const f = fixture();
  const job = await run(f);
  f.seal(
    job.jobId,
    ustar([
      [transcriptName, transcript],
      ["2026-09-14T14-00-00-000Z_01a0a009-0000-7000-8000-000000000000.jsonl", transcript],
    ]),
  );
  expect(await f.client.call("readSession", { ...target, jobId: job.jobId })).toEqual({
    refused: "omp_invalid_session",
  });
});

test("readSession answers an unfinished run with its state and no receipt", async () => {
  const f = fixture();
  const job = await run(f);
  f.amend(job.jobId, { state: "started", exitCode: null });
  const read = await f.client.call("readSession", { ...target, jobId: job.jobId });
  if ("refused" in read) throw new Error(read.refused);
  // "Not yet" and "never" are different answers: a poller reads the difference here.
  expect(read.session).toBeNull();
  expect(read.job.state).toBe("started");
  expect(read.job.result).toBeNull();
});

test("readSession answers a failed run with its exit code and no receipt", async () => {
  const f = fixture();
  const job = await run(f);
  f.seal(job.jobId, ustar([[transcriptName, transcript]]));
  f.amend(job.jobId, { exitCode: 3 });
  const read = await f.client.call("readSession", { ...target, jobId: job.jobId });
  if ("refused" in read) throw new Error(read.refused);
  expect(read.session).toBeNull();
  expect(read.job.state).toBe("exited");
  expect(read.job.result?.exitCode).toBe(3);
});

test("readSession answers a run whose transcript was never sealed", async () => {
  const f = fixture();
  const job = await run(f);
  // The owner refuses a seal it cannot complete; the run still exited cleanly.
  const read = await f.client.call("readSession", { ...target, jobId: job.jobId });
  if ("refused" in read) throw new Error(read.refused);
  expect(read.session).toBeNull();
  expect(read.job.result?.exitCode).toBe(0);
});

/**
 * #43: FOUR SESSIONS THAT PRODUCED NOTHING, AND WHY EACH ONE PRODUCED NOTHING.
 *
 * Measured on the preview: six one-shots in one container, a shared 1 MiB run destination
 * with 8 KiB free. Two sealed a transcript; four died on ENOSPC mid-transcript and came back
 * as `exited`, `exitCode: 1`, no output and `reason: null` — the same answer as a session
 * that ran and said nothing, which is how a conductor reported reviews that never reached a
 * model as reviews that had nothing to say. A caller cannot act on an absence, so every one
 * of these answers carries the word for the fact that stopped it, and no two facts share a
 * word.
 */
test("a session stopped by its destination is distinguishable from one that ran", async () => {
  const contended = fixture();
  const starved = await run(contended);
  // What the owner seals for a run whose transcript never landed: the process's own last
  // words, and an exit status that says nothing about whose fault it was.
  contended.amend(starved.jobId, { exitCode: 1 });
  contended.said(
    starved.jobId,
    "ENOSPC: no space left on device, write\n  at writeTextSync (/$bunfs/root/omp-linux-x64)\n",
  );
  const denied = await contended.client.call("readSession", {
    ...target,
    jobId: starved.jobId,
  });
  if ("refused" in denied) throw new Error(denied.refused);
  expect(denied.session).toBeNull();
  expect(denied.silence).toBe("omp_session_destination_full");

  const served = fixture();
  const finished = await run(served);
  served.seal(finished.jobId, ustar([[transcriptName, transcript]]));
  const receipted = await served.client.call("readSession", {
    ...target,
    jobId: finished.jobId,
  });
  if ("refused" in receipted) throw new Error(receipted.refused);
  expect(receipted.session).toEqual(receipt);
  expect(receipted.silence).toBeNull();

  // The other ways to have no receipt are not that one, and are not each other.
  const words: string[] = [];
  for (const overrides of [
    { state: "started" as const, exitCode: null },
    { exitCode: 1 },
    { exitCode: 0 },
    { state: "cancelled" as const, exitCode: null },
  ]) {
    const f = fixture();
    const job = await run(f);
    f.amend(job.jobId, overrides);
    const read = await f.client.call("readSession", { ...target, jobId: job.jobId });
    if ("refused" in read) throw new Error(read.refused);
    expect(read.session).toBeNull();
    words.push(read.silence!);
  }
  expect(words).not.toContain("omp_session_destination_full");
  expect(new Set(words).size).toBe(words.length);
});

/**
 * A model that was never reached leaves a receipt shaped exactly like an agent that ran and
 * chose to say nothing: a model, an empty final message and no usage. Measured on the
 * preview while the gateway could not read its provider's catalog — every session sealed a
 * transcript whose last turn was `stopReason: "error"`, and the receipt threw that away.
 */
test("a receipt carries the ending the transcript recorded", async () => {
  const f = fixture();
  const job = await run(f);
  const failed = [
    JSON.stringify({ type: "session", version: 3, id: sessionId }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [],
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash:free",
        stopReason: "error",
        errorMessage: "gateway_unavailable",
      },
    }),
    "",
  ].join("\n");
  f.seal(job.jobId, ustar([[transcriptName, failed]]));
  const read = await f.client.call("readSession", { ...target, jobId: job.jobId });
  if ("refused" in read) throw new Error(read.refused);
  expect(read.silence).toBeNull();
  expect(read.session?.finalMessage).toBe("");
  expect(read.session?.usage).toBeNull();
  expect(read.session?.failure).toBe("gateway_unavailable");
  // The turn that failed names the model the agent was about to use, which is not the one this
  // session configured. That mismatch is REPORTED rather than refused, because the ending is
  // the fact worth having, and both names are present so it is still auditable (#49).
  expect(read.session?.model).toBe("openrouter/deepseek/deepseek-v4-flash:free");
  expect(read.session?.configuredModel).toBe("anthropic/claude-sonnet-4-5");
});

/**
 * A withdrawn model was replaced by a published PAID one and the receipt named only the
 * substitute, so the single artifact anyone audits could attest to a run nobody configured —
 * and a model-exclusivity claim proved by reading `model` off persisted receipts would have
 * believed it. With `modelFallback: false` no path may resolve to another model, so a receipt
 * that names one is refused (#49).
 */
test("a session that served under a model it was not configured with is refused", async () => {
  const f = fixture();
  const job = await run(f);
  const substituted = [
    JSON.stringify({ type: "session", version: 3, id: sessionId }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answered under another model" }],
        provider: "openrouter",
        model: "openai/gpt-5.5",
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
        stopReason: "end_turn",
      },
    }),
    "",
  ].join("\n");
  f.seal(job.jobId, ustar([[transcriptName, substituted]]));
  expect(await f.client.call("readSession", { ...target, jobId: job.jobId })).toEqual({
    refused: "omp_model_substituted",
  });
});

/**
 * The substitution itself, before any receipt: a one-shot configured with a model only the
 * live listing carries ran `anthropic/claude-opus-4-8` when the gateway answered discovery after
 * OMP's 10 s budget, and `openrouter/openai/gpt-5.5` when it did not answer at all (#49). OMP
 * binds a one-shot's model once, at startup, so the job's own configuration has to leave it
 * nothing but the configured model — and nothing to resolve by a resembling name.
 */
test("a one-shot pins its configured live-listed model, so discovery timing cannot substitute another", async () => {
  const f = fixture();
  f.ctx.services.readInstance = async () => ({ type: "service_result", requestId: "fixture-request", ok: true, result: { credentials: [
    { id: 7, provider: "anthropic", identityKey: "fixture-identity", credential: { type: "oauth", email: "fixture@example.invalid" } },
    { id: 8, provider: "openrouter", identityKey: null, credential: { type: "api_key" } },
  ] } });
  const configured = "openrouter/stealth/space-bunny-alpha:medium";
  // The premise: the pinned SDK catalog does not carry it, only the gateway's live listing does.
  expect(getBundledModels("openrouter").some(model => model.id === "stealth/space-bunny-alpha")).toBe(false);
  const live = { ...session,
    accountPool: { ...session.accountPool, openrouter: [{ scope, credentialId: 8, identityKey: null }] },
    overlay: { modelRoles: { default: configured }, retry: { enabled: true, modelFallback: false } } };
  const reviewDigest = await reviewDigestOf(f.client, live);
  const job = await f.client.call("runSession", { ...live, reviewDigest });
  if ("refused" in job) throw new Error(job.refused);
  const posted = f.posted[0]!.input;
  const config: { modelRoles: { default: string }; enabledModels?: string[] } = JSON.parse(String(posted.config));
  const models: { providers: Record<string, { discovery: { timeoutMs?: number } }> } = JSON.parse(String(posted.models));

  // Startup may select exactly the configured model, the scope the SDK host also admits.
  expect(config.modelRoles.default).toBe(configured);
  expect(config.enabledModels).toEqual([exactModelScope(configured)]);
  // A slow gateway is waited for past OMP's 10 s default instead of being given up on.
  const pooled = Object.values(models.providers);
  for (const provider of pooled) expect(provider.discovery.timeoutMs).toBeGreaterThan(10_000);
  // The listing names the model but not how it reasons, so its `:medium` is pinned from the same
  // template the gateway serves it with, under the provider the listing reaches it through.
  const template = OPENROUTER_LISTING_TEMPLATE?.thinking;
  expect(template?.efforts.map(String)).toContain("medium");
  for (const provider of pooled)
    expect(provider).toMatchObject({ modelOverrides: { "openrouter/stealth/space-bunny-alpha": { reasoning: true, thinking: template } } });
  // The owner fills in the endpoint and bearer; the native worker admits the rest as composed.
  const bearer = "fixture-native-service-bearer-0000000000000001";
  expect(ProbeModelsConfigSchema.safeParse({ providers: Object.fromEntries(Object.entries(models.providers).map(
    ([name, provider]) => [name, { ...provider, baseUrl: "http://127.0.0.1:42123", apiKey: bearer }])) }).success).toBe(true);

  // An operator's terminal from the same review keeps its full `/model` picker.
  const terminal = await f.client.call("prepareSession", { ...live, reviewDigest });
  if ("refused" in terminal) throw new Error(terminal.refused);
  expect(JSON.parse(String(terminal.runtime.input.config)).enabledModels).toBeUndefined();
});

/**
 * Every provider a session registers makes its own `models` call through the service proxy, each
 * one an authorization the owner has to decide (atyrode/manifold#841), and the gateway lists every
 * model its pool reaches under each of them. So a one-shot registers, and hands its gateway, only
 * the providers its configuration names; a terminal from the same review keeps the whole pool.
 */
test("a one-shot registers and hands its gateway only the providers its configuration names", async () => {
  const f = fixture();
  f.ctx.services.readInstance = async () => ({ type: "service_result", requestId: "fixture-request", ok: true, result: { credentials: [
    { id: 7, provider: "anthropic", identityKey: "fixture-identity", credential: { type: "oauth", email: "fixture@example.invalid" } },
    { id: 8, provider: "openrouter", identityKey: null, credential: { type: "api_key" } },
  ] } });
  const pool = { ...session.accountPool, openrouter: [{ scope, credentialId: 8, identityKey: null }] };
  const posted = async (modelRoles: Record<string, string>) => {
    const reviewed = await f.client.call("reviewSession", { ...session, accountPool: pool, overlay: { modelRoles } });
    if ("refused" in reviewed) throw new Error(reviewed.refused);
    // The review covers the pool the caller chose; the one-shot is placed with part of it.
    expect(reviewed.accountPool).toEqual(pool);
    const input = { ...session, accountPool: pool, overlay: { modelRoles }, reviewDigest: reviewed.reviewDigest };
    const job = await f.client.call("runSession", input);
    if ("refused" in job) throw new Error(job.refused);
    const terminal = await f.client.call("prepareSession", input);
    if ("refused" in terminal) throw new Error(terminal.refused);
    const placed = (runtime: JobInput) => ({
      providers: Object.keys(JSON.parse(String(runtime.models)).providers).sort(),
      disabled: ["anthropic", "openrouter"].filter(provider =>
        JSON.parse(String(runtime.config)).disabledProviders.includes(provider)),
      accountPool: JSON.parse(String(runtime.accountPool)),
    });
    return { oneShot: placed(f.posted.at(-1)!.input), terminal: placed(terminal.runtime.input) };
  };

  expect(await posted({ default: "openrouter/openai/gpt-5.5" })).toEqual({
    // The gateway still holds every credential of the provider that serves the configured model.
    oneShot: { providers: ["openrouter"], disabled: ["anthropic"], accountPool: { openrouter: pool.openrouter } },
    terminal: { providers: ["anthropic", "openrouter"], disabled: [], accountPool: pool },
  });
  // A role the operator configured for another provider keeps that provider.
  expect((await posted({ default: "openrouter/openai/gpt-5.5", smol: "anthropic/claude-haiku-4-5" })).oneShot)
    .toEqual({ providers: ["anthropic", "openrouter"], disabled: [], accountPool: pool });
});

/**
 * Startup is not the one-shot's last selection. A task agent, the advisor, the plan hand-off and
 * compaction resolve a model role later, against the session's whole catalog, where an unset role
 * is not the default model (an enabled advisor with no model of its own fell to OMP's reasoning
 * list) and a workspace's `.omp/config.yml` may name any model for any role (#49). The job's own
 * configuration outranks the workspace's, so it names a model for every chat role.
 */
test("a one-shot holds every model role its configuration leaves unset to the configured model", async () => {
  const f = fixture();
  const configured = "anthropic/claude-sonnet-4-5:medium";
  const smol = "anthropic/claude-haiku-4-5";
  const advised = { ...session, overlay: { modelRoles: { default: configured, smol }, advisor: { enabled: true },
    retry: { enabled: true, modelFallback: false } } };
  const reviewDigest = await reviewDigestOf(f.client, advised);
  const job = await f.client.call("runSession", { ...advised, reviewDigest });
  if ("refused" in job) throw new Error(job.refused);
  const roles: Record<string, string> = JSON.parse(String(f.posted[0]!.input.config)).modelRoles;
  // The chat roles of OMP 18.1.14 and of the SDK host's 18.2.7, which adds `memory`.
  for (const role of ["default", "slow", "vision", "plan", "commit", "tiny", "memory", "task", "advisor"])
    expect(roles[role]).toBe(configured);
  // A role the operator configured keeps its model.
  expect(roles.smol).toBe(smol);

  // An operator's terminal from the same review resolves its roles as OMP ordinarily does.
  const terminal = await f.client.call("prepareSession", { ...advised, reviewDigest });
  if ("refused" in terminal) throw new Error(terminal.refused);
  expect(JSON.parse(String(terminal.runtime.input.config)).modelRoles).toEqual({ default: configured, smol });
});

test("readSession refuses a transcript that does not name the session it reports", async () => {
  const f = fixture();
  const job = await run(f);
  f.seal(job.jobId, ustar([["2026-09-14T13-08-29-037Z_another-session.jsonl", transcript]]));
  expect(await f.client.call("readSession", { ...target, jobId: job.jobId })).toEqual({
    refused: "omp_invalid_session",
  });
});

test("readSession refuses a job another door placed", async () => {
  const f = fixture();
  const job = await run(f);
  f.seal(job.jobId, ustar([[transcriptName, transcript]]));
  f.amend(job.jobId, { door: "prepareSession" });
  expect(await f.client.call("readSession", { ...target, jobId: job.jobId })).toEqual({
    refused: "omp_result_unavailable",
  });
});

test("readSession refuses a job this door never posted", async () => {
  const f = fixture();
  const inventory = await f.client.call("startInventory", {
    ...target,
    expectedDefaultsRevision: 0,
    accountPool: session.accountPool,
  });
  if ("refused" in inventory) throw new Error(inventory.refused);
  expect(inventory.operationId).toBe(INVENTORY_OPERATION_ID);
  expect(await f.client.call("readSession", { ...target, jobId: inventory.jobId })).toEqual({
    refused: "omp_provenance_changed",
  });
  expect(await f.client.call("readSession", { ...target, jobId: "job-404" })).toEqual({
    refused: "omp_result_unavailable",
  });
});

test("following a retained session exposes native totals and bounded metadata without output bytes", async () => {
  const f = fixture();
  const job = await run(f);
  f.amend(job.jobId, { state: "started" });
  const usage = { calls: 7, inputTokens: 900, outputTokens: 80,
    cachedInputTokens: 100, costMicros: 4200, lastModel: session.overlay.modelRoles.default };
  const metadata = { jobId: job.jobId, requestDigest: "f".repeat(64),
    ownerId: "fixture-owner", ownerGeneration: 1 };
  const output = Buffer.from("PRIVATE_PROVIDER_OUTPUT").toString("base64");
  const snapshot = JobFollowSnapshotSchema.parse({
    jobId: job.jobId, state: "started", result: null, inferenceUsage: usage,
    seq: 8, firstSeq: 6, unavailable: { fromSeq: 1, toSeq: 5 },
    events: [
      { seq: 6, event: { type: "output", jobId: job.jobId, outputId: "stdout",
        requestId: "output-read", seq: 0, data: output, eof: false } },
      { seq: 7, event: { type: "job_progress", ...metadata, stage: "at the model", at: 1000 } },
      { seq: 8, event: { type: "inference_call", ...metadata, serviceId: "omp", operationId: "stream",
        model: usage.lastModel, inputTokens: 100, outputTokens: 10, cachedInputTokens: 0,
        costMicros: 700, elapsedMs: 200, status: 200 } },
    ],
  });
  let closed = 0;
  f.ctx.jobs.follow = async () => ({ snapshot, close: async () => { closed++; } });
  const reply = await f.client.call("followSession", { ...target, jobId: job.jobId });
  if ("refused" in reply) throw new Error(reply.refused);
  expect(reply.inferenceUsage).toEqual(usage);
  expect(reply.inferenceCalls).toEqual([{ seq: 8, model: usage.lastModel,
    inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costMicros: 700,
    elapsedMs: 200, status: 200 }]);
  expect(reply.progress).toEqual({ stage: "at the model", at: 1000 });
  expect(reply.unavailable).toEqual({ fromSeq: 1, toSeq: 5 });
  expect(JSON.stringify(reply)).not.toContain(output);
  expect(closed).toBe(1);
});

test("following a settled session recovers durable metering after the live replay was evicted", async () => {
  const f = fixture();
  const job = await run(f);
  const usage = { calls: 3, inputTokens: 1200, outputTokens: 90,
    cachedInputTokens: 0, costMicros: 6000, lastModel: session.overlay.modelRoles.default };
  const snapshot = JobFollowSnapshotSchema.parse({ jobId: job.jobId, state: job.state,
    result: job.result, inferenceUsage: usage, seq: 300, firstSeq: null,
    events: [], unavailable: { fromSeq: 1, toSeq: 300 } });
  let closed = 0;
  f.ctx.jobs.follow = async () => ({ snapshot, close: async () => { closed++; } });
  f.ctx.jobs.journal = async () => ({
    jobId: job.jobId, inferenceUsage: usage, firstSeq: 250, nextAfter: null,
    events: [{ seq: 250, at: 1000, event: { type: "inference_call", jobId: job.jobId,
      requestDigest: "f".repeat(64), ownerId: "fixture-owner", ownerGeneration: 1,
      serviceId: "omp", operationId: "stream", model: usage.lastModel,
      inputTokens: 400, outputTokens: 30, cachedInputTokens: 0, costMicros: 2000,
      elapsedMs: 250, status: 500 } }],
  });
  const reply = await f.client.call("followSession", { ...target, jobId: job.jobId });
  if ("refused" in reply) throw new Error(reply.refused);
  expect(reply.inferenceUsage?.calls).toBe(3);
  expect(reply.inferenceCalls[0]).toMatchObject({ seq: 250, status: 500, costMicros: 2000 });
  expect(reply.unavailable).toEqual({ fromSeq: 1, toSeq: 249 });
  expect(closed).toBe(1);
});

test("following refuses unretained or substituted jobs and releases a rejected snapshot", async () => {
  const f = fixture();
  const job = await run(f);
  let opened = 0;
  let closed = 0;
  f.ctx.jobs.follow = async () => {
    opened++;
    return { snapshot: JobFollowSnapshotSchema.parse({
      jobId: "another-job", state: "started", result: null, inferenceUsage: null,
      seq: 0, firstSeq: null, events: [], unavailable: null,
    }), close: async () => { closed++; } };
  };
  expect(await f.client.call("followSession", { ...target, jobId: "job-404" }))
    .toEqual({ refused: "omp_result_unavailable" });
  expect(opened).toBe(0);
  expect(await f.client.call("followSession", { ...target, jobId: job.jobId }))
    .toEqual({ refused: "omp_provenance_changed" });
  expect(closed).toBe(1);
});

test("cancelSession ends a running session and answers its job", async () => {
  const f = fixture();
  const job = await run(f);
  f.amend(job.jobId, { state: "started", exitCode: null });
  const ended = await f.client.call("cancelSession", { ...target, jobId: job.jobId });
  if ("refused" in ended) throw new Error(ended.refused);
  expect(f.cancelled).toEqual([job.jobId]);
  expect(ended.job.jobId).toBe(job.jobId);
  expect(ended.job.operationId).toBe(SESSION_OPERATION_ID);
});

test("cancelSession answers a settled session instead of refusing it", async () => {
  const f = fixture();
  const job = await run(f);
  f.seal(job.jobId, ustar([[transcriptName, transcript]]));
  const first = await f.client.call("cancelSession", { ...target, jobId: job.jobId });
  const second = await f.client.call("cancelSession", { ...target, jobId: job.jobId });
  if ("refused" in first || "refused" in second) throw new Error("settled cancel refused");
  expect(first.job.state).toBe("exited");
  expect(second.job.state).toBe("exited");
  // The receipt outlives the cancel: ending a finished run took nothing away.
  const read = await f.client.call("readSession", { ...target, jobId: job.jobId });
  if ("refused" in read) throw new Error(read.refused);
  expect(read.session).toEqual(receipt);
});

test("cancelSession refuses a job this door never posted", async () => {
  const f = fixture();
  const inventory = await f.client.call("startInventory", {
    ...target,
    expectedDefaultsRevision: 0,
    accountPool: session.accountPool,
  });
  if ("refused" in inventory) throw new Error(inventory.refused);
  expect(await f.client.call("cancelSession", { ...target, jobId: inventory.jobId })).toEqual({
    refused: "omp_provenance_changed",
  });
  expect(await f.client.call("cancelSession", { ...target, jobId: "job-404" })).toEqual({
    refused: "omp_result_unavailable",
  });
  const posted = await run(f);
  f.amend(posted.jobId, { door: "prepareSession" });
  expect(await f.client.call("cancelSession", { ...target, jobId: posted.jobId })).toHaveProperty("refused");
  expect(f.cancelled).toEqual([]);
});

const material: JobInputBinding = {
  name: "material",
  from: { jobId: "prepare-job-1", output: "outputs" },
};

test("runSession hands the hub the bindings it was given, verbatim", async () => {
  const f = fixture();
  const job = await f.client.call("runSession", {
    ...session,
    reviewDigest: await reviewDigestOf(f.client),
    inputs: [material],
  });
  if ("refused" in job) throw new Error(job.refused);
  expect(f.posted[0]!.inputs).toEqual([material]);
  // The door reads none of it: what the material is belongs to the caller and the prompt.
  expect(f.posted[0]!.input.material).toBeUndefined();
  expect(job.inputs).toEqual([material]);
});

test("runSession binds nothing when it was given nothing", async () => {
  const f = fixture();
  const job = await run(f);
  expect(f.posted[0]!.inputs).toBeUndefined();
  expect(job.inputs).toBeUndefined();
});

test("the review covers the session's content, never what it is handed", async () => {
  const f = fixture();
  // One digest, minted before any binding existed, spends on every placement of it.
  const bare = await reviewDigestOf(f.client);
  const first = await f.client.call("runSession", {
    ...session,
    reviewDigest: bare,
    inputs: [material],
  });
  const second = await f.client.call("runSession", {
    ...session,
    reviewDigest: bare,
    inputs: [{ name: "material", from: { jobId: "prepare-job-2", output: "outputs" } }],
  });
  const none = await f.client.call("runSession", { ...session, reviewDigest: bare });
  if ("refused" in first || "refused" in second || "refused" in none)
    throw new Error("a binding changed what the review answers for");
  expect(await reviewDigestOf(f.client)).toBe(bare);
  // Same reviewed content, three placements: the job's own input digest never moved.
  expect(new Set([first, second, none].map((job) => job.inputDigest)).size).toBe(1);
});

test("readSession and cancelSession still answer a session that was handed material", async () => {
  const f = fixture();
  const job = await f.client.call("runSession", {
    ...session,
    reviewDigest: await reviewDigestOf(f.client),
    inputs: [material],
  });
  if ("refused" in job) throw new Error(job.refused);
  f.seal(job.jobId, ustar([[transcriptName, transcript]]));
  const read = await f.client.call("readSession", { ...target, jobId: job.jobId });
  if ("refused" in read) throw new Error(read.refused);
  expect(read.session).toEqual(receipt);
  expect(read.job.inputs).toEqual([material]);
  const ended = await f.client.call("cancelSession", { ...target, jobId: job.jobId });
  if ("refused" in ended) throw new Error(ended.refused);
  expect(ended.job.inputs).toEqual([material]);
});

// Three-byte UTF-8: a character count passes three times over what the bytes cost.
const wide = "\u4e16".repeat(Math.ceil(PROMPT_MAX_BYTES / 3));

test("every operation that takes a prompt can carry one of the bound's full size", () => {
  for (const operation of Object.values(machine.operations))
    if (operation.input.prompt)
      expect(operation.input.prompt.maxLength).toBeGreaterThanOrEqual(PROMPT_MAX_BYTES);
});

test("a prompt of the full bound reaches the job", async () => {
  const f = fixture();
  const prompt = "a".repeat(PROMPT_MAX_BYTES);
  const full = { ...session, prompt };
  const job = await f.client.call("runSession", {
    ...full,
    reviewDigest: await reviewDigestOf(f.client, full),
  });
  if ("refused" in job) throw new Error(job.refused);
  // Past the schema is not enough: the hub bounds the whole input map at 64 KiB of JSON,
  // and `boundedInput` is what enforces it, so the bound has to leave room for the rest.
  expect(f.posted[0]!.input.prompt).toBe(prompt);
  expect(argvFor(oneShot, f.posted[0]!.input).at(-1)).toBe(prompt);
});

/** What a remote caller sees: the door validates its own input and answers a refusal. */
async function reviewRefusal(f: Fixture, prompt: string) {
  return rootHandlers.reviewSession!(f.ctx, { ...session, prompt });
}

test("one byte past the bound is refused", async () => {
  const f = fixture();
  const over = "a".repeat(PROMPT_MAX_BYTES + 1);
  expect(await reviewRefusal(f, over)).toEqual({ refused: "omp_invalid_request" });
  // An in-process caller using the published client fails before it dispatches at all.
  expect(f.client.call("reviewSession", { ...session, prompt: over })).rejects.toThrow();
});

test("the bound counts bytes, not characters", async () => {
  const f = fixture();
  expect(wide.length).toBeLessThan(PROMPT_MAX_BYTES);
  expect(Buffer.byteLength(wide, "utf8")).toBeGreaterThan(PROMPT_MAX_BYTES);
  expect(await reviewRefusal(f, wide)).toEqual({ refused: "omp_invalid_request" });
  // The same character count in one-byte text is accepted, which is the whole point.
  const reviewed = await f.client.call("reviewSession", {
    ...session,
    prompt: "a".repeat(wide.length),
  });
  if ("refused" in reviewed) throw new Error(reviewed.refused);
  expect(reviewed.destination).toEqual(target);
});

test("set reviews spend on the same explicit selection, but not on a changed catalog or forged optional binding", async () => {
  const f = fixture();
  const deployment = structuredClone(await f.ctx.jobs.describeDeployment({ machineId: target.machineId, pluginId: OMP_PLUGIN_ID }));
  deployment.installation!.machine = MachineHalfSchema.parse({ ...deployment.installation!.machine,
    tools: { ...deployment.installation!.machine.tools, bun: sdkRuntimeArtifacts.tools.bun, "sdk-pi-natives": sdkRuntimeArtifacts.tools["pi-natives"] } });
  f.ctx.jobs.describeDeployment = async () => deployment;
  f.ctx.jobs.inspectInputs = async ({ inputs }) => ({ inputs: inputs.map(input => ({
    ...input, sha256: "a".repeat(64), bytes: 4096, files: 1,
  })) });
  const skill = { id: "alpha", name: "alpha", title: "Alpha", purpose: "Reviewed instructions", revision: "one",
    source: { jobId: "reviewed-source", output: "skill", sha256: "a".repeat(64) },
    license: { spdx: "MIT" }, review: { reviewedBy: "owner", reviewedAt: 1, reference: "review" }, conflicts: [] };
  const catalog = await f.client.call("writeSkillCatalog", { machineId: target.machineId,
    expectedRevision: 0, skills: [skill], sets: [{ id: "pair", title: "Set", skillIds: ["alpha"] }] });
  if ("refused" in catalog) throw new Error(catalog.refused);
  const reviewed = await f.client.call("reviewSession", { ...session,
    skills: { mode: "select", expectedCatalogRevision: catalog.revision, skillIds: ["alpha"], setIds: ["pair"] } });
  if ("refused" in reviewed) throw new Error(reviewed.refused);
  const selected = { ...session, skills: { mode: "select" as const,
    expectedCatalogRevision: catalog.revision, skillIds: ["alpha"], setIds: [] }, reviewDigest: reviewed.reviewDigest };
  const prepared = await f.client.call("prepareSession", selected);
  if ("refused" in prepared) throw new Error(prepared.refused);
  expect(prepared.runtime.inputs).toEqual([{ name: "optionalSkill0", from: { jobId: "reviewed-source", output: "skill" } }]);
  expect(await f.client.call("runSession", { ...selected, inputs: [{ name: "optionalSkill0", from: { jobId: "other", output: "skill" } }] }))
    .toEqual({ refused: "omp_invalid_material_input" });
  const job = await f.client.call("runSession", { ...selected, inputs: [material] });
  if ("refused" in job) throw new Error(job.refused);
  expect(job.inputs).toEqual([material, ...prepared.runtime.inputs!]);
  const fresh = await f.client.call("reviewSession", session);
  if ("refused" in fresh) throw new Error(fresh.refused);
  expect(fresh.skills).toEqual({ mode: "preserve", catalogRevision: null, selected: [] });
  await f.client.call("writeSkillCatalog", { machineId: target.machineId, expectedRevision: catalog.revision, skills: [skill], sets: [] });
  expect(await f.client.call("prepareSession", selected)).toEqual({ refused: "omp_stale_skill_catalog" });
});

test("restricted review binds exact tools and disables ambient skills without changing ordinary launch", async () => {
  const f = fixture();
  const deployment = structuredClone(await f.ctx.jobs.describeDeployment({ machineId: target.machineId, pluginId: OMP_PLUGIN_ID }));
  deployment.installation!.machine = MachineHalfSchema.parse({ ...deployment.installation!.machine,
    tools: { ...deployment.installation!.machine.tools, bun: sdkRuntimeArtifacts.tools.bun, "sdk-pi-natives": sdkRuntimeArtifacts.tools["pi-natives"] } });
  f.ctx.jobs.describeDeployment = async () => deployment;
  const automation = { mode: "restricted" as const, toolNames: ["read" as const], delegation: "disabled" as const };
  // Code composes passive task routes even when delegation is disabled.
  const input = { ...session, overlay: { ...session.overlay,
    task: { agentModelOverrides: { task: "anthropic/claude-sonnet-4-5" }, agentAdvisor: { task: "off" as const }, prewalk: false } } };
  const reviewed = await f.client.call("reviewSession", { ...input, automation });
  if ("refused" in reviewed) throw new Error(reviewed.refused);
  expect(reviewed.automation).toEqual(automation);
  expect(reviewed.skills).toEqual({ mode: "disabled", catalogRevision: null, selected: [] });
  expect(await f.client.call("prepareSession", { ...input, automation: { ...automation, toolNames: [] }, reviewDigest: reviewed.reviewDigest }))
    .toEqual({ refused: "omp_review_changed" });
  const prepared = await f.client.call("prepareSession", { ...input, automation, reviewDigest: reviewed.reviewDigest });
  if ("refused" in prepared) throw new Error(prepared.refused);
  const job = await f.client.call("runSession", { ...input, automation, reviewDigest: reviewed.reviewDigest });
  if ("refused" in job) throw new Error(job.refused);
  const ordinary = await f.client.call("reviewSession", session);
  if ("refused" in ordinary) throw new Error(ordinary.refused);
  expect(ordinary.automation).toEqual({ mode: "ordinary" });
  expect(ordinary.skills.mode).toBe("preserve");
});

for (const platform of ["linux-x64", "linux-arm64"] as const) {
  for (const alias of ["sdk-pi-natives", "bun"] as const) {
    for (const field of ["sha256", "entrySha256"] as const) {
      test(`SDK admission refuses ${platform} ${alias} ${field} drift before dispatch`, async () => {
        const f = fixture();
        const deployment = structuredClone(await f.ctx.jobs.describeDeployment({ machineId: target.machineId, pluginId: OMP_PLUGIN_ID }));
        const machine = MachineHalfSchema.parse({ ...deployment.installation!.machine,
          tools: { ...deployment.installation!.machine!.tools, bun: sdkRuntimeArtifacts.tools.bun,
            "sdk-pi-natives": sdkRuntimeArtifacts.tools["pi-natives"] } });
        deployment.installation!.machine = machine;
        f.ctx.jobs.describeDeployment = async () => deployment;
        const input = { ...session, automation: { mode: "restricted" as const, toolNames: [], delegation: "disabled" as const } };
        const reviewDigest = await reviewDigestOf(f.client, input);
        machine.tools![alias]![platform]![field] = "f".repeat(64);
        expect(await f.client.call("reviewSession", input)).toEqual({ refused: "omp_sdk_runtime_unsupported" });
        expect(await f.client.call("runSession", { ...input, reviewDigest })).toEqual({ refused: "omp_sdk_runtime_unsupported" });
        expect(f.posted).toEqual([]);
      });
    }
  }
}

test("unsupported restricted tool, duplicate tool and delegation requests refuse rather than widen", async () => {
  const f = fixture();
  for (const automation of [
    { mode: "restricted", toolNames: ["task"], delegation: "disabled" },
    { mode: "restricted", toolNames: ["read", "read"], delegation: "disabled" },
    { mode: "restricted", toolNames: [], delegation: "enabled" },
    { mode: "ordinary", toolNames: ["read"], delegation: "disabled" },
  ]) {
    expect(await rootHandlers.reviewSession!(f.ctx, { ...session, automation })).toEqual({ refused: "omp_automation_unsupported" });
  }
  expect(await f.client.call("reviewSession", { ...session, planYolo: true,
    automation: { mode: "restricted", toolNames: [], delegation: "disabled" } }))
    .toEqual({ refused: "omp_restricted_delegation_unsupported" });
  expect(await f.client.call("reviewSession", { ...session,
    overlay: { ...session.overlay, task: { agentAdvisor: { task: "on" } } },
    automation: { mode: "restricted", toolNames: [], delegation: "disabled" } }))
    .toEqual({ refused: "omp_restricted_delegation_unsupported" });
});

test("inference ceilings cannot be changed after review or raised above declared admission limits", async () => {
  const f = fixture();
  const deployment = structuredClone(await f.ctx.jobs.describeDeployment({ machineId: target.machineId, pluginId: OMP_PLUGIN_ID }));
  deployment.installation!.machine!.operations[SESSION_OPERATION_ID]!.limits.inference = { calls: 3, costMicros: 50_000 };
  f.ctx.jobs.describeDeployment = async () => deployment;
  const input = { ...session, inferenceLimits: { calls: 2, costMicros: 20_000 } };
  const reviewDigest = await reviewDigestOf(f.client, input);
  expect(await f.client.call("runSession", {
    ...input, inferenceLimits: { calls: 3, costMicros: 20_000 }, reviewDigest,
  })).toEqual({ refused: "omp_review_changed" });
  const raised = { ...input, inferenceLimits: { calls: 4 } };
  expect(await f.client.call("runSession", {
    ...raised, reviewDigest: await reviewDigestOf(f.client, raised),
  })).toEqual({ refused: "omp_inference_limit_exceeded" });
  expect(f.posted).toEqual([]);
  const admitted = await f.client.call("runSession", { ...input, reviewDigest });
  if ("refused" in admitted) throw new Error(admitted.refused);
  expect(admitted.limits?.inference).toEqual(input.inferenceLimits);
  f.amend(admitted.jobId, { state: "started", limits: null });
  expect(await f.client.call("readSession", { ...target, jobId: admitted.jobId }))
    .toEqual({ refused: "omp_provenance_changed" });
  const stopped = await f.client.call("cancelSession", { ...target, jobId: admitted.jobId });
  if ("refused" in stopped) throw new Error(stopped.refused);
  expect(f.cancelled).toEqual([admitted.jobId]);
});

test("settled inference receipts require unchanged executed limits while cancellation bypasses only limits", async () => {
  const f = fixture();
  const input = { ...session, inferenceLimits: { calls: 2, costMicros: 20_000 } };
  const admitted = await f.client.call("runSession", {
    ...input, reviewDigest: await reviewDigestOf(f.client, input),
  });
  if ("refused" in admitted) throw new Error(admitted.refused);
  f.seal(admitted.jobId, ustar([[transcriptName, transcript]]));
  const valid = await f.client.call("readSession", { ...target, jobId: admitted.jobId });
  if ("refused" in valid) throw new Error(valid.refused);
  expect(valid.session).toEqual(receipt);
  const limits = admitted.result!.limits;
  for (const inference of [undefined, { ...input.inferenceLimits, calls: 3 }]) {
    f.amend(admitted.jobId, { resultLimits: { ...limits, inference } });
    expect(await f.client.call("readSession", { ...target, jobId: admitted.jobId }))
      .toEqual({ refused: "omp_provenance_changed" });
    const stopped = await f.client.call("cancelSession", { ...target, jobId: admitted.jobId });
    if ("refused" in stopped) throw new Error(stopped.refused);
    expect(stopped.job.jobId).toBe(admitted.jobId);
  }
  expect(f.cancelled).toEqual([admitted.jobId, admitted.jobId]);
  f.amend(admitted.jobId, { resultLimits: limits });
  const restored = await f.client.call("readSession", { ...target, jobId: admitted.jobId });
  if ("refused" in restored) throw new Error(restored.refused);
  expect(restored.session).toEqual(receipt);
  f.amend(admitted.jobId, {
    resultLimits: { ...limits, inference: undefined },
    inputs: [{ name: "material", from: { jobId: "another-job", output: "material" } }],
  });
  expect(await f.client.call("cancelSession", { ...target, jobId: admitted.jobId }))
    .toEqual({ refused: "omp_provenance_changed" });
  expect(f.cancelled).toEqual([admitted.jobId, admitted.jobId]);
});

test("bounded review refuses missing metering or unpriced configured models before dispatch", async () => {
  const f = fixture();
  const description = await f.ctx.services.describe({ machineId: target.machineId });
  const input = { ...session, inferenceLimits: { calls: 1, costMicros: 20_000 } };
  f.ctx.services.describe = async () => ({
    ...description, services: description.services.map(service => ({
      ...service, operations: service.operations.map(({ meter: _meter, prices: _prices, ...operation }) => operation),
    })),
  });
  expect(await f.client.call("reviewSession", input)).toEqual({ refused: "omp_inference_meter_unavailable" });
  f.ctx.services.describe = async () => ({
    ...description, services: description.services.map(service => ({
      ...service, operations: service.operations.map(({ prices: _prices, ...operation }) => operation),
    })),
  });
  expect(await f.client.call("reviewSession", input)).toEqual({ refused: "omp_inference_price_unknown" });
  expect(f.posted).toEqual([]);
});

test("cost review prices the served model rather than its thinking suffix", async () => {
  const f = fixture();
  const input = { ...session, inferenceLimits: { costMicros: 20_000 },
    overlay: { modelRoles: { default: "anthropic/claude-sonnet-4-5:high" } } };
  const reviewDigest = await reviewDigestOf(f.client, input);
  const admitted = await f.client.call("runSession", { ...input, reviewDigest });
  if ("refused" in admitted) throw new Error(admitted.refused);
  expect(admitted.limits?.inference?.costMicros).toBe(20_000);
  expect(await f.client.call("reviewSession", { ...input,
    overlay: { modelRoles: { default: "anthropic/claude-opus-4-1:high" } } }))
    .toEqual({ refused: "omp_inference_price_unknown" });
});

async function materialFixture() {
  const f = fixture();
  const deployment = structuredClone(await f.ctx.jobs.describeDeployment({ machineId: target.machineId, pluginId: OMP_PLUGIN_ID }));
  deployment.installation!.machine = MachineHalfSchema.parse({ ...deployment.installation!.machine,
    tools: { ...deployment.installation!.machine.tools, bun: sdkRuntimeArtifacts.tools.bun,
      "sdk-pi-natives": sdkRuntimeArtifacts.tools["pi-natives"] } });
  f.ctx.jobs.describeDeployment = async () => deployment;
  const isolation = { mode: "material-only" as const, file: "transcript-map.json", bytes: 123, sha256: "a".repeat(64) };
  return { f, deployment, input: { ...session, isolation } };
}

test("material-only reviews bind content and operation, require material, and cannot become terminal sessions", async () => {
  const { f, input } = await materialFixture();
  const review = await f.client.call("reviewSession", input);
  if ("refused" in review) throw new Error(review.refused);
  expect(review.operationId).toBe(MATERIAL_SESSION_OPERATION_ID);
  expect(review.isolation).toEqual(input.isolation);
  expect(review.automation).toEqual({ mode: "restricted", toolNames: [], delegation: "disabled" });
  expect(review.skills.mode).toBe("disabled");
  const request = { ...input, reviewDigest: review.reviewDigest };
  expect(await f.client.call("runSession", request)).toEqual({ refused: "omp_invalid_material_input" });
  expect(await f.client.call("prepareSession", request)).toEqual({ refused: "omp_material_isolation_unsupported" });
  expect(await f.client.call("runSession", { ...request, isolation: { ...input.isolation, bytes: 124 }, inputs: [material] }))
    .toEqual({ refused: "omp_review_changed" });
  expect(f.posted).toEqual([]);
  const job = await f.client.call("runSession", { ...request, inputs: [material] });
  if ("refused" in job) throw new Error(job.refused);
  expect(job.operationId).toBe(MATERIAL_SESSION_OPERATION_ID);
  f.amend(job.jobId, { state: "started" });
  f.ctx.jobs.follow = async () => ({
    snapshot: JobFollowSnapshotSchema.parse({ jobId: job.jobId, state: "started", result: null,
      inferenceUsage: null, seq: 0, firstSeq: null, events: [], unavailable: null }),
    close: async () => {},
  });
  const followed = await f.client.call("followSession", { ...target, jobId: job.jobId });
  if ("refused" in followed) throw new Error(followed.refused);
  expect(followed.job.operationId).toBe(MATERIAL_SESSION_OPERATION_ID);
  f.amend(job.jobId, { state: "exited" });
  f.seal(job.jobId, ustar([[transcriptName, transcript]]));
  const read = await f.client.call("readSession", { ...target, jobId: job.jobId });
  if ("refused" in read) throw new Error(read.refused);
  expect(read.session).toEqual(receipt);
  const cancelled = await f.client.call("cancelSession", { ...target, jobId: job.jobId });
  if ("refused" in cancelled) throw new Error(cancelled.refused);
  expect(f.cancelled).toEqual([job.jobId]);
  f.amend(job.jobId, { inputs: [{ name: "material", from: { jobId: "replacement", output: "outputs" } }] });
  expect(await f.client.call("readSession", { ...target, jobId: job.jobId })).toEqual({ refused: "omp_provenance_changed" });
  expect(await f.client.call("followSession", { ...target, jobId: job.jobId })).toEqual({ refused: "omp_provenance_changed" });
  expect(await f.client.call("cancelSession", { ...target, jobId: job.jobId })).toEqual({ refused: "omp_provenance_changed" });
  expect(f.cancelled).toEqual([job.jobId]);
});

test("material-only refuses broadened tools, selected skills, fallback and shared mounts", async () => {
  const { f, input, deployment } = await materialFixture();
  expect(await f.client.call("reviewSession", { ...input,
    automation: { mode: "restricted", toolNames: ["read"], delegation: "disabled" } }))
    .toEqual({ refused: "omp_material_isolation_unsupported" });
  expect(await f.client.call("reviewSession", { ...input, skills: { mode: "select", expectedCatalogRevision: 0, skillIds: [], setIds: [] } }))
    .toEqual({ refused: "omp_material_isolation_unsupported" });
  expect(await f.client.call("reviewSession", { ...input, overlay: { ...input.overlay, retry: { enabled: true, modelFallback: true } } }))
    .toEqual({ refused: "omp_restricted_delegation_unsupported" });
  deployment.installation!.machine.operations[MATERIAL_SESSION_OPERATION_ID]!.locations = [{ locationId: RUNS_LOCATION_ID, access: "write" }];
  expect(await f.client.call("reviewSession", input)).toEqual({ refused: "omp_material_runtime_unsupported" });
  expect(f.posted).toEqual([]);
});

test("cancellation reaches the exact admitted material job even with malformed result fields", async () => {
  const { f, input } = await materialFixture();
  const job = await f.client.call("runSession", { ...input, reviewDigest: await reviewDigestOf(f.client, input), inputs: [material] });
  if ("refused" in job) throw new Error(job.refused);
  const status = f.ctx.jobs.status.bind(f.ctx.jobs);
  f.ctx.jobs.status = async (...args) => ({ ...await status(...args), result: { malformed: true } }) as never;
  await f.client.call("cancelSession", { ...target, jobId: job.jobId });
  expect(f.cancelled).toEqual([job.jobId]);
});
