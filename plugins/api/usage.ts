import { z } from "zod";
import { epochMilliseconds, identifier, type AccountsObservation } from "./contracts.ts";
import { checkedAccountsObservation } from "./accounts.ts";
import { OmpDataError } from "./errors.ts";

const slot = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const quotaStatus = z.enum(["ok", "warning", "exhausted", "unknown"]);
const resetCredits = z.strictObject({
  available: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.array(epochMilliseconds).max(1024),
});
const publicBalance = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  total: z.string().regex(/^(?:0|[1-9]\d{0,30})(?:\.\d{1,18})?$/),
  observedAt: epochMilliseconds,
});
const usageWindow = z.strictObject({
  windowId: z.string().min(1).max(128),
  tier: z.string().min(1).max(128).nullable(),
  usedFraction: z.number().nonnegative().nullable(),
  quotaStatus: quotaStatus.nullable(),
  resetsAt: epochMilliseconds.nullable(),
  durationMs: epochMilliseconds.nullable(),
  observedAt: epochMilliseconds.nullable(),
});

/** Native sanctioned facts, not credential-bearing broker responses or error bodies. */
export const PermittedUsageSnapshotSchema = z.strictObject({
  scope: z.string().min(1).max(1024),
  observedAt: epochMilliseconds,
  accounts: z.array(z.strictObject({
    provider: identifier,
    credentialId: slot,
    identityKey: z.string().min(1).max(1024).nullable(),
    observedAt: epochMilliseconds,
    status: z.enum(["reported", "no_usage", "credential_disabled"]),
    windows: z.array(usageWindow).max(128),
    disabledAt: epochMilliseconds.optional(),
    resetCredits: resetCredits.optional(),
    balance: publicBalance.optional(),
  })).max(1024),
});
export type PermittedUsageSnapshot = z.infer<typeof PermittedUsageSnapshotSchema>;

const brokerIdentity = z.object({
  provider: identifier,
  id: slot.optional(),
  type: z.enum(["oauth", "api_key"]).optional(),
  orgId: z.string().max(1024).optional(),
  accountId: z.string().max(1024).optional(),
  email: z.string().max(512).optional(),
  metadata: z.object({
    accountId: z.string().max(1024).optional(),
    email: z.string().max(512).optional(),
    orgId: z.string().max(1024).optional(),
  }).optional(),
});

/**
 * The 18.1.14 broker's GET /v1/usage payload. Unknown report metadata, notes and
 * provider response/error bodies are deliberately stripped, never echoed.
 * Optional health arrays accept separately sanctioned native health facts.
 */
export const BrokerUsageSnapshotSchema = z.object({
  generatedAt: epochMilliseconds,
  reports: z.array(brokerIdentity.extend({
    fetchedAt: epochMilliseconds,
    limits: z.array(z.object({
      id: z.string().min(1).max(128),
      status: quotaStatus.optional(),
      scope: z.object({
        provider: identifier,
        accountId: z.string().max(1024).optional(),
        orgId: z.string().max(1024).optional(),
        tier: z.string().max(128).optional(),
        windowId: z.string().max(128).optional(),
      }),
      window: z.object({
        id: z.string().min(1).max(128),
        resetsAt: epochMilliseconds.optional(),
        durationMs: epochMilliseconds.optional(),
      }).optional(),
      amount: z.object({
        unit: z.string().max(32),
        usedFraction: z.number().nonnegative().optional(),
        remainingFraction: z.number().nonnegative().optional(),
        used: z.number().nonnegative().optional(),
        limit: z.number().nonnegative().optional(),
      }),
    })).max(128),
    resetCredits: z.object({
      availableCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      credits: z.array(z.object({
        expiresAt: z.iso.datetime({ offset: true }).optional(),
        status: z.string().max(64).optional(),
      })).max(1024).optional(),
    }).optional(),
  })).max(1024),
  disabledCredentials: z.array(brokerIdentity.extend({
    disabledAtMs: epochMilliseconds.optional(),
  })).max(1024).optional(),
  accountsWithoutUsage: z.array(brokerIdentity).max(1024).optional(),
});
export type BrokerUsageSnapshot = z.infer<typeof BrokerUsageSnapshotSchema>;

/** Join only unambiguous identities in this exact sanctioned accounts scope. */
export function normalizeBrokerUsage(
  raw: unknown, accounts: AccountsObservation, observedAtMs: number,
): PermittedUsageSnapshot | null {
  const checked = checkedAccountsObservation(accounts);
  if (!epochMilliseconds.safeParse(observedAtMs).success) throw new OmpDataError("invalid_usage");
  if (raw === null) return null;
  const parsed = BrokerUsageSnapshotSchema.safeParse(raw);
  if (!parsed.success || parsed.data.generatedAt > observedAtMs) throw new OmpDataError("invalid_usage");
  const broker = parsed.data;
  const byProvider = new Map<string, AccountsObservation["accounts"]>();
  for (const account of checked.accounts) {
    const group = byProvider.get(account.reference.provider);
    if (group) group.push(account);
    else byProvider.set(account.reference.provider, [account]);
  }
  const match = (identity: z.infer<typeof brokerIdentity>) => {
    const candidates = byProvider.get(identity.provider) ?? [];
    const accountId = identity.metadata?.accountId || identity.accountId;
    const email = (identity.metadata?.email || identity.email)?.toLowerCase();
    const org = identity.metadata?.orgId || identity.orgId;
    if (identity.accountId && identity.metadata?.accountId && identity.accountId !== identity.metadata.accountId) return undefined;
    if (identity.email && identity.metadata?.email && identity.email.toLowerCase() !== identity.metadata.email.toLowerCase()) return undefined;
    if (identity.orgId && identity.metadata?.orgId && identity.orgId !== identity.metadata.orgId) return undefined;
    const compatible = candidates.filter(account => {
      if (identity.type && account.type !== identity.type) return false;
      if (identity.id !== undefined && account.credentialId !== identity.id) return false;
      if (account.type === "api_key") return identity.id !== undefined && !email && !accountId && !org;
      const parts = account.identityKey!.split("|");
      const encodedEmail = parts.find(part => part.startsWith("email:"))?.slice(6) ??
        (parts.length === 1 && parts[0]!.includes("@") ? parts[0]! : undefined);
      const encodedAccount = parts.find(part => part.startsWith("account:"))?.slice(8);
      if (email && ((account.email && account.email.toLowerCase() !== email) ||
        (encodedEmail && encodedEmail.toLowerCase() !== email))) return false;
      if (org && !parts.includes(`org:${org}`)) return false;
      if (accountId && encodedAccount && encodedAccount !== accountId) return false;
      return true;
    });
    if (identity.id !== undefined) return compatible.length === 1 ? compatible[0] : undefined;
    if (accountId) {
      const exact = compatible.filter(account => account.identityKey === accountId ||
        account.identityKey!.split("|").includes(`account:${accountId}`));
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) return undefined;
      // A known exact identity contradicted by another dimension cannot fall back to a sibling's email.
      if (candidates.some(account => account.identityKey === accountId ||
        account.identityKey?.split("|").includes(`account:${accountId}`))) return undefined;
    }
    if (!email) return undefined;
    const matched = compatible.filter(account => account.email?.toLowerCase() === email ||
      account.identityKey!.split("|").some(part => part.toLowerCase() === `email:${email}`) ||
      account.identityKey!.toLowerCase() === email);
    return matched.length === 1 ? matched[0] : undefined;
  };
  const normalized = new Map<number, PermittedUsageSnapshot["accounts"][number]>();
  for (const report of broker.reports) {
    if (report.fetchedAt > broker.generatedAt) throw new OmpDataError("invalid_usage");
    const accountIds = new Set(report.limits.flatMap(limit => limit.scope.accountId ? [limit.scope.accountId] : []));
    const orgIds = new Set(report.limits.flatMap(limit => limit.scope.orgId ? [limit.scope.orgId] : []));
    if (accountIds.size > 1 || orgIds.size > 1) continue;
    const scopeAccount = accountIds.values().next().value;
    const scopeOrg = orgIds.values().next().value;
    const declaredAccount = report.metadata?.accountId || report.accountId;
    if ((scopeAccount && declaredAccount && scopeAccount !== declaredAccount) ||
      (scopeOrg && report.metadata?.orgId && scopeOrg !== report.metadata.orgId)) continue;
    const account = match({ ...report, metadata: {
      ...report.metadata, accountId: declaredAccount || scopeAccount, orgId: report.metadata?.orgId || scopeOrg,
    } });
    if (!account) continue;
    if (normalized.has(account.credentialId)) throw new OmpDataError("invalid_usage");
    const windows: PermittedUsageSnapshot["accounts"][number]["windows"] = [];
    for (const limit of report.limits) {
      if (limit.scope.provider !== report.provider) throw new OmpDataError("invalid_usage");
      const windowId = limit.scope.windowId || limit.window?.id || limit.id;
      if (limit.scope.windowId && limit.window?.id && limit.scope.windowId !== limit.window.id) throw new OmpDataError("invalid_usage");
      const amount = limit.amount;
      const usedFraction = amount.usedFraction ??
        (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0 ? amount.used / amount.limit :
          amount.unit === "percent" && amount.used !== undefined ? amount.used / 100 :
            amount.remainingFraction !== undefined ? Math.max(0, 1 - amount.remainingFraction) : null);
      windows.push({ windowId, tier: limit.scope.tier || null, usedFraction, quotaStatus: limit.status ?? null,
        resetsAt: limit.window?.resetsAt ?? null, durationMs: limit.window?.durationMs ?? null,
        observedAt: usedFraction === null ? null : report.fetchedAt });
    }
    normalized.set(account.credentialId, {
      provider: account.reference.provider, credentialId: account.credentialId, identityKey: account.identityKey,
      observedAt: report.fetchedAt, status: "reported", windows,
      ...(report.resetCredits ? { resetCredits: {
        available: report.resetCredits.availableCount,
        expiresAt: (report.resetCredits.credits ?? []).flatMap(credit =>
          credit.status === "available" && credit.expiresAt ? [Date.parse(credit.expiresAt)] : []),
      } } : {}),
    });
  }
  const healthSeen = new Set<number>();
  for (const [status, identities] of [
    ["no_usage", broker.accountsWithoutUsage ?? []],
    ["credential_disabled", broker.disabledCredentials ?? []],
  ] as const) {
    for (const identity of identities) {
      const account = match(identity);
      if (!account) continue;
      if (healthSeen.has(account.credentialId)) throw new OmpDataError("invalid_usage");
      healthSeen.add(account.credentialId);
      const existing = normalized.get(account.credentialId);
      if (status === "no_usage" && existing) throw new OmpDataError("invalid_usage");
      const disabledAt = "disabledAtMs" in identity ? identity.disabledAtMs : undefined;
      normalized.set(account.credentialId, {
        provider: account.reference.provider, credentialId: account.credentialId, identityKey: account.identityKey,
        observedAt: broker.generatedAt, status, windows: existing?.windows ?? [],
        ...(existing?.resetCredits ? { resetCredits: existing.resetCredits } : {}),
        ...(disabledAt !== undefined ? { disabledAt } : {}),
      });
    }
  }
  const result = PermittedUsageSnapshotSchema.safeParse({
    scope: checked.scope, observedAt: broker.generatedAt, accounts: [...normalized.values()],
  });
  if (!result.success) throw new OmpDataError("invalid_usage");
  return result.data;
}
