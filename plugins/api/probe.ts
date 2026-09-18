import { z } from "zod";
import { modelId, ThinkingLevelSchema, epochMilliseconds, identifier } from "./contracts.ts";

export const OMP_VERSION = "18.1.14" as const;
export const PROBE_MODEL_LIMIT = 256;
const number = z.number().finite().nonnegative();
const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();
export const ProbeIdentitySchema = z.strictObject({ provider: identifier, id: modelId, api: identifier });
export type ProbeIdentity = z.infer<typeof ProbeIdentitySchema>;
export const ProbeIdentitiesSchema = z.array(ProbeIdentitySchema).min(1).max(PROBE_MODEL_LIMIT);
export const InventoryModelSchema = ProbeIdentitySchema.extend({
  inputCostPerMillion: number, outputCostPerMillion: number, contextWindow: limit, maxTokens: limit,
  reasoning: z.boolean(), thinkingLevels: z.array(ThinkingLevelSchema).max(6), images: z.boolean(),
});
export const InventoryReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("inventory"), ompVersion: z.literal(OMP_VERSION),
  observedAt: epochMilliseconds, models: z.array(InventoryModelSchema).max(PROBE_MODEL_LIMIT),
});
export type InventoryReceipt = z.infer<typeof InventoryReceiptSchema>;
type InventoryModel = z.infer<typeof InventoryModelSchema>;
export const ProbeCandidateSchema = ProbeIdentitySchema.extend({ key: identifier });
export type ProbeCandidate = z.infer<typeof ProbeCandidateSchema>;
export const BenchmarkInputSchema = z.strictObject({
  schemaVersion: z.literal(1), inventoryObservedAt: epochMilliseconds, ompVersion: z.literal(OMP_VERSION),
  candidates: z.array(ProbeCandidateSchema).min(1).max(PROBE_MODEL_LIMIT),
});
export type BenchmarkInput = z.infer<typeof BenchmarkInputSchema>;
export const ProbeRefusalSchema = z.enum(["invalid_input", "unsupported_version", "invalid_observation", "ambiguous_identity", "missing_probe", "inconclusive_probe", "insufficient_ladder", "cancelled", "timeout", "output_limit", "target_failed"]);
export type ProbeRefusal = z.infer<typeof ProbeRefusalSchema>;
export class ProbeError extends Error {
  constructor(readonly code: ProbeRefusal) { super(`probe_${code}`); }
}
export const ProbeFailureReceiptSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal("refused"), code: ProbeRefusalSchema });
const metricShape = { tokensPerSecond: number, timeToFirstTokenMs: number };
export const BenchmarkResultSchema = z.discriminatedUnion("status", [
  ProbeCandidateSchema.extend({ status: z.literal("reachable"), ...metricShape }),
  ProbeCandidateSchema.extend({ status: z.enum(["not_found", "client_blocked", "unresolved", "unmatched"]), tokensPerSecond: z.null(), timeToFirstTokenMs: z.null() }),
]);
export const BenchmarkReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("benchmark"), ompVersion: z.literal(OMP_VERSION),
  inventoryObservedAt: epochMilliseconds, startedAt: epochMilliseconds, completedAt: epochMilliseconds,
  results: z.array(BenchmarkResultSchema).min(1).max(PROBE_MODEL_LIMIT),
}).refine(value => value.completedAt >= value.startedAt && value.startedAt >= value.inventoryObservedAt);
export type BenchmarkReceipt = z.infer<typeof BenchmarkReceiptSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown, code: ProbeRefusal = "invalid_observation"): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProbeError(code);
  return result.data;
}
export function probeAddress(value: Pick<ProbeIdentity, "provider" | "id">): string { return `${value.provider}/${value.id}`; }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function unique<T extends ProbeIdentity>(models: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  const folded = new Set<string>();
  for (const model of models) {
    const address = probeAddress(model);
    // OMP resolution folds case; case-only variants and API aliases are ambiguous.
    if (folded.has(address.toLowerCase())) throw new ProbeError("ambiguous_identity");
    folded.add(address.toLowerCase()); out.set(address, model);
  }
  return out;
}

export function parseBenchmarkInput(value: unknown): BenchmarkInput {
  const input = parse(BenchmarkInputSchema, value, "invalid_input");
  unique(input.candidates);
  if (new Set(input.candidates.map(candidate => candidate.key)).size !== input.candidates.length) throw new ProbeError("ambiguous_identity");
  // A COLON IS ONLY AMBIGUOUS WHEN THE SUFFIX IS A LEVEL, and this is the rule the run path
  // already applies: `atyrode.omp/execution.ts:163-171` takes an id as written and strips a
  // trailing `:suffix` ONLY when it parses as a `ThinkingLevel`, because a colon both ends an
  // OpenRouter model id (`deepseek/x:free`) and introduces a level (`anthropic/y:high`).
  // Rejecting every colon here contradicted that: it barred from benchmarking — and therefore
  // from any derived catalog — the entire set of ids a provider spells with a variant, whose
  // suffix is not a level and resolves unambiguously. `model:high` stays rejected, because that
  // selector really does name two things.
  if (input.candidates.some(candidate => {
    const separator = candidate.id.lastIndexOf(":");
    return separator > 0 && ThinkingLevelSchema.safeParse(candidate.id.slice(separator + 1)).success;
  })) throw new ProbeError("invalid_input");
  return input;
}
export function parseOmpVersion(raw: string): typeof OMP_VERSION {
  if (raw.trim() !== `omp/${OMP_VERSION}`) throw new ProbeError("unsupported_version");
  return OMP_VERSION;
}

// v18.1.14 models-cli.ts toModelJson does NOT emit api or version. API is joined
// only from exact, sealed native models configuration identities, never spelling.
// Other providers may use opaque IDs or sentinel prices; neither defines a Code candidate.
const RawInventoryModelSchema = z.object({
  provider: identifier, id: z.string().min(1).max(512), selector: z.string().max(650),
  contextWindow: limit, maxTokens: limit, reasoning: z.boolean(),
  thinking: z.array(ThinkingLevelSchema).max(6).nullable(), input: z.array(z.enum(["text", "image"])).max(2),
  cost: z.object({ input: number, output: number, cacheRead: number, cacheWrite: number }),
});
const RawInventorySchema = z.object({
  models: z.array(RawInventoryModelSchema.pick({ provider: true, id: true, selector: true }).passthrough()).max(16384),
});
export function parseInventoryObservation(raw: unknown, identitiesValue: unknown, observedAt: number, version: string): InventoryReceipt {
  if (version !== OMP_VERSION) throw new ProbeError("unsupported_version");
  const identities = unique(parse(ProbeIdentitiesSchema, identitiesValue, "invalid_input"));
  const rawModels = parse(RawInventorySchema, raw).models;
  unique(rawModels.map(({ provider, id }) => ({ provider, id, api: "unreported" })));
  const models: InventoryModel[] = [];
  for (const rawModel of rawModels) {
    if (rawModel.selector !== probeAddress(rawModel)) throw new ProbeError("ambiguous_identity");
    const identity = identities.get(rawModel.selector);
    if (!identity) continue; // Inventory is explicitly limited to the sealed permission set.
    const model = parse(RawInventoryModelSchema, rawModel);
    if ((!model.reasoning && (model.thinking?.length ?? 0) > 0) || new Set(model.thinking ?? []).size !== (model.thinking?.length ?? 0)) throw new ProbeError("invalid_observation");
    models.push({ ...identity, inputCostPerMillion: model.cost.input, outputCostPerMillion: model.cost.output,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning,
      thinkingLevels: [...(model.thinking ?? [])].sort((a, b) => ThinkingLevelSchema.options.indexOf(a) - ThinkingLevelSchema.options.indexOf(b)),
      images: model.input.includes("image") });
  }
  models.sort((a, b) => compare(probeAddress(a), probeAddress(b)));
  return parse(InventoryReceiptSchema, { schemaVersion: 1, kind: "inventory", ompVersion: OMP_VERSION, observedAt, models });
}

const RawRunSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), ttftMs: number, generationTps: number, tokensPerSecond: number, challenge: z.literal("chat") }),
  z.object({ ok: z.literal(false), error: z.string().max(65536), challenge: z.literal("chat").optional() }),
]);
const distribution = z.object({ mean: number, min: number, p50: number, p95: number, max: number });
const RawBenchmarkSchema = z.object({
  runs: z.literal(1), maxTokens: z.literal(4), profile: z.literal("chat"), failures: z.number().int().nonnegative(),
  models: z.array(z.object({ selector: z.string().max(650), model: z.string().max(650),
    results: z.array(RawRunSchema).length(1), stats: z.object({ ttftMs: distribution, generationTps: distribution, tokensPerSecond: distribution }).nullable(),
  })).max(PROBE_MODEL_LIMIT),
});
export function parseBenchmarkObservation(raw: unknown, inputValue: unknown, startedAt: number, completedAt: number): BenchmarkReceipt {
  const input = parseBenchmarkInput(inputValue);
  const report = parse(RawBenchmarkSchema, raw);
  const expected = new Map(input.candidates.map(candidate => [probeAddress(candidate), candidate]));
  const rows = new Map<string, typeof report.models[number]>();
  for (const row of report.models) {
    if (!expected.has(row.selector) || rows.has(row.selector)) throw new ProbeError("ambiguous_identity");
    rows.set(row.selector, row);
  }
  if (report.failures !== report.models.filter(row => !row.results[0]!.ok).length) throw new ProbeError("invalid_observation");
  const results = input.candidates.map(candidate => {
    const row = rows.get(probeAddress(candidate));
    const failure = (status: "not_found" | "client_blocked" | "unresolved" | "unmatched") => ({ ...candidate, status, tokensPerSecond: null, timeToFirstTokenMs: null });
    if (!row || row.model !== probeAddress(candidate)) return failure("unmatched");
    const run = row.results[0]!;
    if (!run.ok) {
      if (row.stats !== null) throw new ProbeError("invalid_observation");
      // Raw error text is inspected privately and is never retained in receipts.
      if (/claude_code_version_too_old/i.test(run.error)) return failure("client_blocked");
      if (/\b(?:not_found_error|model_not_found|not_found)\b/i.test(run.error)) return failure("not_found");
      return failure("unresolved");
    }
    if (!row.stats || row.stats.generationTps.mean !== run.generationTps || row.stats.ttftMs.mean !== run.ttftMs) return failure("unresolved");
    return { ...candidate, status: "reachable" as const, tokensPerSecond: run.generationTps, timeToFirstTokenMs: run.ttftMs };
  });
  return parse(BenchmarkReceiptSchema, { schemaVersion: 1, kind: "benchmark", ompVersion: OMP_VERSION,
    inventoryObservedAt: input.inventoryObservedAt, startedAt, completedAt, results });
}
