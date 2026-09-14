import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { JobDescriptionSchema, MachineHalfSchema, type Cap } from "@manifold/protocol";
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
  SESSION_OUTPUT_NAME,
  SESSIONS_GUEST_PATH,
  createOmpClient,
  type ActionInput,
  type ActionReply,
  type OmpAction,
  type JobInputBinding,
  type PublicJob,
} from "../api/index.ts";
import { digestOf, type OmpContext } from "../atyrode.omp/machine-server.ts";
import { handlers as rootHandlers } from "../atyrode.omp/server.ts";
import rootManifest from "../atyrode.omp/manifest.json";

type JobInput = Record<string, string | number | boolean>;
type JobNode = { kind: "job"; machineId: string; operationId: string; jobId: string };
type PostedJob = {
  jobId: string;
  operationId: string;
  input: JobInput;
  outputs: { name: string; locationId: string; components: string[] }[];
  inputs?: JobInputBinding[];
};
type JobOverrides = {
  state?: "exited" | "started";
  exitCode?: number | null;
  door?: string;
  inputs?: JobInputBinding[];
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
            limits: {
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
    amend: advance,
    state,
  };
}

async function reviewDigestOf(client: OmpClient, input = session): Promise<string> {
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

test("the interactive launch operation is untouched by the one-shot", () => {
  // A terminal must never declare the run location: its lease directory is provisioned
  // out of band, and a launch that named it would refuse before the terminal opened.
  expect(launch.outputs).toEqual([]);
  expect(launch.stdin).toBe(true);
  expect(launch.locations.map((location) => location.locationId)).toEqual([
    "atyrode.omp.workspace",
    "atyrode.omp.sessions",
  ]);
  expect(argvFor(launch, { hasPrompt: true, planYolo: false, prompt: "hi" })).toEqual([
    "--session-dir",
    SESSIONS_GUEST_PATH,
    "--config",
    "/home/job/.omp/agent/config.yml",
    "--",
    "hi",
  ]);
});

test("the one-shot operation leases a bounded run directory and never opens stdin", () => {
  expect(oneShot.outputs).toEqual([SESSION_OUTPUT_NAME]);
  // A binding can only name an input the operation declares.
  expect(oneShot.inputs).toEqual(["material"]);
  // Babel's prepare seals a material archive of up to 512 MiB; the default would have been
  // this operation's own outputBytes, which measures what it writes, not what it is handed.
  expect(oneShot.limits.inputBytes).toBe(536870912);
  expect(launch.inputs).toBeUndefined();
  // `omp -p` reads stdin to EOF before its first turn; the owner ends the pipe at spawn
  // only for an operation that declares no stdin.
  expect(oneShot.stdin).toBe(false);
  // A named output must lease a bounded tmpfs, which only the runtime anchor provides.
  expect(machine.locations[RUNS_LOCATION_ID]?.anchor).toBe("runtime");
  expect(oneShot.locations.map((location) => location.locationId)).toEqual([
    "atyrode.omp.workspace",
    RUNS_LOCATION_ID,
  ]);
  expect(oneShot.input).toEqual(launch.input);
  expect(argvFor(oneShot, { hasPrompt: true, planYolo: true, prompt: "hi" })).toEqual([
    "--session-dir",
    SESSION_GUEST_PATH,
    "--config",
    "/home/job/.omp/agent/config.yml",
    "-p",
    "--mode",
    "json",
    "--plan-yolo",
    "--",
    "hi",
  ]);
});

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
  expect(argvFor(oneShot, posted.input)).toEqual([
    "--session-dir",
    SESSION_GUEST_PATH,
    "--config",
    "/home/job/.omp/agent/config.yml",
    "-p",
    "--mode",
    "json",
    "--",
    session.prompt,
  ]);
});

test("a reviewed session composes one input, whichever way it is placed", async () => {
  const f = fixture();
  const prepared = await f.client.call("prepareSession", {
    ...session,
    reviewDigest: await reviewDigestOf(f.client),
  });
  if ("refused" in prepared) throw new Error(prepared.refused);
  const job = await run(f);
  // The review covers the content; the door covers the placement, and nothing else moves.
  expect(f.posted[0]!.input).toEqual(prepared.runtime.input);
  expect(prepared.runtime.operationId).toBe(LAUNCH_OPERATION_ID);
  expect(job.operationId).toBe(SESSION_OPERATION_ID);
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
  expect(await f.client.call("cancelSession", { ...target, jobId: posted.jobId })).toEqual({
    refused: "omp_result_unavailable",
  });
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
