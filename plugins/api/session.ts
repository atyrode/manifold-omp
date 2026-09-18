import { z } from "zod";
import { identifier, modelId } from "./contracts.ts";
import { OmpDataError } from "./errors.ts";

/** The receipt quotes the agent's last words, never the whole transcript. */
export const SESSION_MESSAGE_LIMIT = 16384;
/** A one-shot transcript archive larger than this is read through the job output, not summarised. */
export const SESSION_ARCHIVE_LIMIT = 4194304;
/** The transcript's own verdict is one line the provider wrote, never a body. */
export const SESSION_FAILURE_LIMIT = 256;
/**
 * WHY A SESSION THIS DOOR POSTED HAS NO RECEIPT — one word, in place of an absence.
 *
 * `session: null` used to answer five separate facts with the same silence: a run still
 * going, a run that exited non-zero, a run whose destination filled under it, a run whose
 * transcript the owner could not seal, and a run that never started. A caller settling a
 * claim on that answer cannot tell them apart, so every one of them reads as "the model was
 * never reached and nothing was produced" (#43). Each fact says which one it is.
 *
 * `omp_session_destination_full` is the contention: every one-shot on a machine writes its
 * transcript into the same bounded run location, and a session whose sibling filled it dies
 * on ENOSPC mid-transcript, exiting non-zero with no reason of the owner's own.
 */
export const SessionSilenceSchema = z.enum([
  "omp_session_running",
  "omp_session_destination_full",
  "omp_session_unsealed",
  "omp_session_failed",
  "omp_session_cancelled",
  "omp_session_interrupted",
  "omp_session_refused",
]);
export type SessionSilence = z.infer<typeof SessionSilenceSchema>;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().finite().nonnegative();
export const SessionUsageSchema = z.strictObject({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  cost: amount.optional(),
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;
/** Bounded summary of one governed OMP run, read from the transcript the job retained. */
export const SessionReceiptSchema = z.strictObject({
  sessionId: identifier,
  sessionPath: z.string().min(1).max(4096),
  model: modelId,
  finalMessage: z.string().max(SESSION_MESSAGE_LIMIT),
  usage: SessionUsageSchema.nullable(),
  exitCode: z.number().int(),
  /**
   * THE TRANSCRIPT'S OWN LAST VERDICT, when the agent's last turn ended in an error rather
   * than an answer: the word the provider or the gateway gave it, never this plugin's.
   *
   * A model that was never reached leaves a receipt whose `finalMessage` is empty and whose
   * `usage` is null — the shape of an agent that ran and said nothing, which is what a
   * caller then reports. The transcript knew better and this is where it says so (#43).
   */
  failure: z.string().max(SESSION_FAILURE_LIMIT).nullable(),
  /**
   * THE MODEL THE SESSION WAS CONFIGURED WITH, beside the one that answered.
   *
   * `model` is read from the transcript's last assistant turn, so it names whatever actually
   * served — which is not always what was asked for. A withdrawn id was replaced by a
   * published PAID model and the receipt showed only the substitute, so the single artifact
   * anyone audits could attest to a run nobody configured. A model-exclusivity claim proved by
   * reading `model` off persisted receipts is sound only while the two are both present and a
   * mismatch is refused rather than recorded (#49).
   *
   * `readSession` fills this from the retained provenance of the job it posted, never from the
   * transcript, so the two sides of the comparison have independent origins.
   */
  configuredModel: modelId,
});
export type SessionReceipt = z.infer<typeof SessionReceiptSchema>;

function invalid(): never {
  throw new OmpDataError("invalid_session");
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid();
  return result.data;
}
// Replacement characters keep malformed bytes out of the receipt without throwing here.
const decoder = new TextDecoder("utf-8", { fatal: false });
const BLOCK = 512;
/** The native output store's own walk bound; an archive past it is not one it sealed. */
const MAX_ARCHIVE_ENTRIES = 10000;
const transcriptName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.jsonl$/;

function field(header: Uint8Array, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
}
function octal(header: Uint8Array, start: number, length: number): number {
  const raw = field(header, start, length).trim();
  if (!/^[0-7]{1,11}$/.test(raw)) invalid();
  return Number.parseInt(raw, 8);
}
/**
 * Canonical POSIX ustar as the native output store seals it, walked whole. omp roots a
 * per-session artifact store at `<transcript without .jsonl>/`, so a run that used a tool
 * seals that directory's files beside the transcript; only the transcript is the receipt's.
 */
function transcript(archive: Uint8Array): { name: string; body: Uint8Array } {
  if (archive.byteLength < BLOCK * 3 || archive.byteLength % BLOCK !== 0) invalid();
  let found: { name: string; body: Uint8Array } | null = null;
  let offset = 0;
  let entries = 0;
  while (offset + BLOCK <= archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if ((entries += 1) > MAX_ARCHIVE_ENTRIES) invalid();
    if (header[156] !== 0x30 || field(header, 257, 6) !== "ustar") invalid();
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = octal(header, 124, 12);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (offset + BLOCK + padded > archive.byteLength) invalid();
    // Only the archive root holds the transcript; `<stem>/…` is omp's artifact store.
    if (transcriptName.test(path)) {
      if (found || size < 1) invalid();
      found = { name: path, body: archive.subarray(offset + BLOCK, offset + BLOCK + size) };
    }
    offset += BLOCK + padded;
  }
  // `seal` closes with exactly two zero blocks; anything else is not an archive it wrote.
  if (!found || archive.byteLength - offset !== BLOCK * 2) invalid();
  if (archive.subarray(offset).some((byte) => byte !== 0)) invalid();
  return found;
}

// OMP 18.1.14 session records. Unlisted keys are the agent's business, not the receipt's.
const RawTextPartSchema = z.object({ type: z.literal("text"), text: z.string() });
const RawUsageSchema = z.object({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  cost: z.object({ total: amount }).optional(),
});
const RawAssistantSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(z.unknown()).max(4096).optional(),
  provider: z.string().max(128).optional(),
  model: z.string().max(512).optional(),
  usage: RawUsageSchema.optional(),
  // omp writes the provider's own ending on every assistant turn; `error` is the one that
  // means the turn carries no answer, and `errorMessage` is the word for why.
  stopReason: z.string().max(64).optional(),
  errorMessage: z.string().max(4096).optional(),
});
const RawRecordSchema = z.object({ type: z.string().max(128) });
const RawSessionSchema = z.object({ id: z.string().max(128) });
// The role decides; the rest of the message is read again by the assistant schema.
const RawMessageSchema = z.object({
  message: z.object({ role: z.string().max(64) }).passthrough(),
});

function finalText(content: readonly unknown[]): string {
  const text: string[] = [];
  for (const part of content) {
    const parsed = RawTextPartSchema.safeParse(part);
    if (parsed.success) text.push(parsed.data.text);
  }
  return text.join("\n").slice(0, SESSION_MESSAGE_LIMIT);
}

/**
 * Summarise the ustar archive of a one-shot run's `--session-dir`. The transcript records one
 * message each, so totals here are the run's, never a streamed event's partial repetition.
 */
export function parseSessionArchive(
  archive: Uint8Array,
  sessionDirectory: string,
  exitCode: number,
  configuredModel: string,
): SessionReceipt {
  const member = transcript(archive);
  let sessionId: string | null = null;
  let model: string | null = null;
  let finalMessage = "";
  let calls = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost: number | null = null;
  let failure: string | null = null;
  for (const line of decoder.decode(member.body).split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      invalid();
    }
    const record = parse(RawRecordSchema, raw);
    if (record.type === "session") {
      if (sessionId !== null) invalid();
      sessionId = parse(RawSessionSchema, raw).id;
      continue;
    }
    if (record.type !== "message") continue;
    const message = parse(RawMessageSchema, raw).message;
    if (message.role !== "assistant") continue;
    const assistant = parse(RawAssistantSchema, message);
    finalMessage = finalText(assistant.content ?? []);
    // The LAST turn's ending is the run's: an earlier error the agent retried past is not
    // what stopped it, and a later answer supersedes it.
    failure =
      assistant.stopReason === "error"
        ? (assistant.errorMessage ?? assistant.stopReason).slice(0, SESSION_FAILURE_LIMIT)
        : null;
    if (assistant.model)
      model = assistant.provider
        ? `${assistant.provider}/${assistant.model}`
        : assistant.model;
    if (!assistant.usage) continue;
    calls += 1;
    input += assistant.usage.input;
    output += assistant.usage.output;
    cacheRead += assistant.usage.cacheRead;
    cacheWrite += assistant.usage.cacheWrite;
    if (assistant.usage.cost) cost = (cost ?? 0) + assistant.usage.cost.total;
  }
  // The archived name is the only authority on where the transcript landed.
  if (sessionId === null || model === null || !member.name.endsWith(`_${sessionId}.jsonl`))
    invalid();
  return parse(SessionReceiptSchema, {
    sessionId,
    sessionPath: `${sessionDirectory}/${member.name}`,
    model,
    finalMessage,
    usage:
      calls === 0
        ? null
        : {
            input,
            output,
            cacheRead,
            cacheWrite,
            ...(cost === null ? {} : { cost }),
          },
    exitCode,
    failure,
    configuredModel,
  });
}

/**
 * HOW A SESSION NAMES ITS DESTINATION AS THE THING THAT STOPPED IT, on its own stderr.
 *
 * A bounded output location is shared by every one-shot on the machine, and the kernel
 * enforces its ceiling on the WRITE inside the sandbox: the owner sees a process that exited
 * non-zero and reports no reason of its own, so the session's stderr is the only place the
 * fact exists. Reading a worker's stderr for the word it declined with is this family's own
 * convention — the gateway names `gateway_refused` and `catalog_pinned_only` there too.
 */
export const EXHAUSTED_DESTINATION = /ENOSPC|no space left on device/i;
