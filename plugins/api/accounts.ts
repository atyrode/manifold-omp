import { z } from "zod";
import { AccountsObservationSchema, epochMilliseconds, identifier, type AccountRecord, type AccountReference, type AccountsObservation } from "./contracts.ts";
import { OmpDataError } from "./errors.ts";

const nonblank = z.string().min(1).max(1024).refine(value => value.trim().length > 0);
const slot = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Only native, secret-free broker metadata may cross this seam. */
export const ProjectedBrokerSnapshotSchema = z.strictObject({
  credentials: z.array(z.strictObject({
    id: slot,
    provider: identifier,
    identityKey: nonblank.nullable(),
    credential: z.strictObject({
      type: z.enum(["oauth", "api_key"]),
      email: z.string().max(512).nullable().optional(),
    }),
    disabled: z.boolean().optional(),
    blocks: z.array(z.strictObject({
      blockScope: z.string().max(128),
      blockedUntilMs: epochMilliseconds,
    })).max(64).optional(),
  })).max(1024),
});
export type ProjectedBrokerSnapshot = z.infer<typeof ProjectedBrokerSnapshotSchema>;

function referenceKey(reference: AccountReference): string {
  return JSON.stringify([reference.scope, reference.provider, reference.kind,
    reference.kind === "identity" ? reference.identityKey : reference.credentialId]);
}

/** The caller owns freshness policy and must not pass an expired read as a fresh observation. */
export function projectAccounts(
  rawProjectedBrokerSnapshot: unknown, scope: string, observedAtMs: number | null, nowMs: number,
): AccountsObservation {
  if (!nonblank.safeParse(scope).success || !epochMilliseconds.safeParse(nowMs).success ||
    (observedAtMs !== null && (!epochMilliseconds.safeParse(observedAtMs).success || observedAtMs > nowMs))) {
    throw new OmpDataError("invalid_accounts");
  }
  if (rawProjectedBrokerSnapshot === null) return { scope, observedAt: null, status: "unavailable", accounts: [] };
  const parsed = ProjectedBrokerSnapshotSchema.safeParse(rawProjectedBrokerSnapshot);
  if (!parsed.success) throw new OmpDataError("invalid_accounts");
  const ids = new Set<number>();
  const identities = new Set<string>();
  const accounts: AccountRecord[] = [];
  for (const row of parsed.data.credentials) {
    const type = row.credential.type;
    if (ids.has(row.id) || (type === "oauth" ? row.identityKey === null : row.identityKey !== null)) {
      throw new OmpDataError("invalid_accounts");
    }
    ids.add(row.id);
    const reference: AccountReference = type === "oauth" ?
      { kind: "identity", scope, provider: row.provider, identityKey: row.identityKey! } :
      { kind: "credential", scope, provider: row.provider, credentialId: row.id };
    const key = referenceKey(reference);
    if (identities.has(key)) throw new OmpDataError("invalid_accounts");
    identities.add(key);
    const blockScopes = new Set<string>();
    const blocks: AccountRecord["blocks"] = [];
    for (const block of row.blocks ?? []) {
      if (blockScopes.has(block.blockScope)) throw new OmpDataError("invalid_accounts");
      blockScopes.add(block.blockScope);
      if (block.blockedUntilMs > nowMs) blocks.push({ scope: block.blockScope, until: block.blockedUntilMs });
    }
    blocks.sort((left, right) => right.until - left.until);
    accounts.push({ reference, credentialId: row.id, type, identityKey: row.identityKey,
      email: row.credential.email ?? null, disabled: row.disabled ?? false, blocks });
  }
  return { scope, observedAt: observedAtMs, status: observedAtMs === null ? "stale" : "fresh", accounts };
}

/** Validate stored observations too: public schemas alone cannot express cross-record identity invariants. */
export function checkedAccountsObservation(raw: AccountsObservation): AccountsObservation {
  const parsed = AccountsObservationSchema.safeParse(raw);
  if (!parsed.success) throw new OmpDataError("invalid_accounts");
  const observation = parsed.data;
  if ((observation.status === "fresh" && observation.observedAt === null) ||
    (observation.status === "unavailable" && (observation.accounts.length !== 0 || observation.observedAt !== null))) {
    throw new OmpDataError("invalid_accounts");
  }
  const projected = projectAccounts({ credentials: observation.accounts.map(account => ({
    id: account.credentialId, provider: account.reference.provider, identityKey: account.identityKey,
    credential: { type: account.type, email: account.email }, disabled: account.disabled,
    blocks: account.blocks.map(block => ({ blockScope: block.scope, blockedUntilMs: block.until })),
  })) }, observation.scope, observation.observedAt, observation.observedAt ?? 0);
  for (let index = 0; index < observation.accounts.length; index++) {
    if (referenceKey(observation.accounts[index]!.reference) !== referenceKey(projected.accounts[index]!.reference)) {
      throw new OmpDataError("invalid_accounts");
    }
  }
  return observation;
}
