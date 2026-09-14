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
  SESSION_OUTPUT_NAME,
  SESSIONS_GUEST_PATH,
  createOmpClient,
  type ActionInput,
  type ActionReply,
  type OmpAction,
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
};
type SentInput = { node: JobNode; requestId: string; seq: number; data: string; eof: boolean };
type JobOverrides = {
  state?: "queued" | "started" | "exited" | "refused";
  exitCode?: number | null;
  door?: string;
  nextInputSeq?: number | null;
};
interface OmpClient {
  call<K extends OmpAction>(name: K, input: ActionInput<K>): Promise<ActionReply<K>>;
}
interface Fixture {
  ctx: OmpContext;
  client: OmpClient;
  posted: PostedJob[];
  sent: SentInput[];
  cancelled: string[];
  /** Refuse `jobs.input`, as the hub does when the cursor or the owner moved. */
  refuseInput: { value: boolean };
/** Settle without ever starting, as a job the owner refuses at preflight. */
  refuseStart: { value: boolean };
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

/** How the owner turns a reviewed argv template plus one job's input into a command line. */
function argvFor(input: JobInput): string[] {
  return launch.argv
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
    state,
    nextInputSeq: overrides.nextInputSeq ?? null,
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
  const posted: PostedJob[] = [];
  const sent: SentInput[] = [];
  const cancelled: string[] = [];
  const refuseInput = { value: false };
  const refuseStart = { value: false };
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
        // The hub admits a job; only the owner starts it, and only then is stdin open.
        const queued = publicJob(args.jobId, args.operationId, digestOf(args.input), {
          door,
          state: door === "runSession" ? "queued" : "exited",
        });
        jobs.set(args.jobId, queued);
        return queued;
      },
      status: async (node: JobNode) => {
        const job = jobs.get(node.jobId);
        if (!job) throw new Error("unknown job");
        if (job.state !== "queued") return job;
        if (refuseStart.value) return advance(node.jobId, { state: "refused" });
        return advance(node.jobId, { state: "started", nextInputSeq: 0 });
      },
      input: async (args: SentInput) => {
        if (refuseInput.value) throw new Error("job_input_not_open");
        sent.push(args);
        advance(args.node.jobId, { state: "exited" });
        return { accepted: true as const };
      },
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
    sent,
    cancelled,
    refuseInput,
    refuseStart,
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

test("the launch operation leases a bounded run directory and a one-shot argv variant", () => {
  expect(launch.outputs).toEqual([SESSION_OUTPUT_NAME]);
  // A named output must lease a bounded tmpfs, which only the runtime anchor provides.
  expect(machine.locations[RUNS_LOCATION_ID]?.anchor).toBe("runtime");
  expect(
    launch.locations.some(
      (location) => location.locationId === RUNS_LOCATION_ID && location.access === "write",
    ),
  ).toBe(true);
  // Reviewed terminal placement keeps the exact command line it had.
  expect(argvFor({ hasPrompt: true, planYolo: false, prompt: "hi" })).toEqual([
    "--session-dir",
    SESSIONS_GUEST_PATH,
    "--config",
    "/home/job/.omp/agent/config.yml",
    "--",
    "hi",
  ]);
  expect(
    argvFor({ hasPrompt: true, planYolo: true, prompt: "hi", oneShot: true }),
  ).toEqual([
    "--session-dir",
    SESSIONS_GUEST_PATH,
    "--session-dir",
    SESSION_GUEST_PATH,
    "-p",
    "--mode",
    "json",
    "--config",
    "/home/job/.omp/agent/config.yml",
    "--plan-yolo",
    "--",
    "hi",
  ]);
});

test("runSession posts the reviewed launch as a one-shot job that retains its own session", async () => {
  const f = fixture();
  const job = await run(f);
  const posted = f.posted[0]!;
  expect(f.posted).toHaveLength(1);
  expect(job.jobId).toBe(posted.jobId);
  expect(job.operationId).toBe(LAUNCH_OPERATION_ID);
  expect(job.authority.origin.door).toBe(`${OMP_PLUGIN_ID}.runSession`);
  expect(posted.outputs).toEqual([
    { name: SESSION_OUTPUT_NAME, locationId: RUNS_LOCATION_ID, components: [posted.jobId] },
  ]);
  expect(posted.input.oneShot).toBe(true);
  expect(posted.input.hasPrompt).toBe(true);
  expect(posted.input.sessionDir).toBeUndefined();
  expect(job.inputDigest).toBe(digestOf(posted.input));
  expect(argvFor(posted.input)).toEqual([
    "--session-dir",
    SESSIONS_GUEST_PATH,
    "--session-dir",
    SESSION_GUEST_PATH,
    "-p",
    "--mode",
    "json",
    "--config",
    "/home/job/.omp/agent/config.yml",
    "--",
    session.prompt,
  ]);
});

test("runSession closes the one-shot's stdin once, after the owner has started it", async () => {
  const f = fixture();
  const job = await run(f);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({
    node: {
      kind: "job",
      machineId: target.machineId,
      operationId: LAUNCH_OPERATION_ID,
      jobId: job.jobId,
    },
    seq: 0,
    data: "",
    eof: true,
  });
  expect(f.cancelled).toEqual([]);
});

test("runSession cancels and refuses a session whose stdin it cannot close", async () => {
  const refused = fixture();
  refused.refuseInput.value = true;
  const reviewDigest = await reviewDigestOf(refused.client);
  expect(await refused.client.call("runSession", { ...session, reviewDigest })).toEqual({
    refused: "omp_session_input_unavailable",
  });
  expect(refused.posted).toHaveLength(1);
  expect(refused.cancelled).toEqual([refused.posted[0]!.jobId]);

  const stalled = fixture();
  stalled.refuseStart.value = true;
  expect(
    await stalled.client.call("runSession", {
      ...session,
      reviewDigest: await reviewDigestOf(stalled.client),
    }),
  ).toEqual({ refused: "omp_session_input_unavailable" });
  expect(stalled.sent).toEqual([]);
  expect(stalled.cancelled).toEqual([stalled.posted[0]!.jobId]);
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

test("readSession refuses an unfinished run", async () => {
  const f = fixture();
  const job = await run(f);
  f.amend(job.jobId, { state: "started", exitCode: null });
  expect(await f.client.call("readSession", { ...target, jobId: job.jobId })).toEqual({
    refused: "omp_result_unavailable",
  });
});

test("readSession refuses a run that failed", async () => {
  const f = fixture();
  const job = await run(f);
  f.seal(job.jobId, ustar([[transcriptName, transcript]]));
  f.amend(job.jobId, { exitCode: 3 });
  expect(await f.client.call("readSession", { ...target, jobId: job.jobId })).toEqual({
    refused: "omp_result_unavailable",
  });
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
