import { describe, expect, test } from "bun:test";
import { projectAccounts } from "../api/accounts.ts";
import { normalizeBrokerUsage } from "../api/usage.ts";
import { OmpDataError } from "../api/errors.ts";

const scope = "fixture/broker-scope";
const now = 1_700_000_000_000;
const metadata = { credentials: [
  { id: 1, provider: "openai-codex", identityKey: "alice@example.test", credential: { type: "oauth", email: "alice@example.test" } },
  { id: 2, provider: "openai-codex", identityKey: "bob@example.test", credential: { type: "oauth", email: "bob@example.test" } },
] };
const accounts = projectAccounts(metadata, scope, now, now);

test("account metadata refuses duplicated identity, slot confusion and credential-bearing records", () => {
  for (const credentials of [
    [metadata.credentials[0], metadata.credentials[0]],
    [metadata.credentials[0], { ...metadata.credentials[0], id: 8 }],
    [{ ...metadata.credentials[0], identityKey: null }],
    [{ id: 3, provider: "openai", identityKey: "invented", credential: { type: "api_key" } }],
    [{ id: 3, provider: "openai", identityKey: null, credential: { type: "api_key", key: "private-fixture" } }],
    [{ ...metadata.credentials[0], credential: { type: "oauth", accessToken: "private-fixture" } }],
    [{ ...metadata.credentials[0], disabled: "false" }],
  ]) expect(() => projectAccounts({ credentials }, scope, now, now)).toThrow(OmpDataError);
});

test("account observations expire only elapsed blocks and never invent observation freshness", () => {
  const observation = projectAccounts({ credentials: [{
    id: 10, provider: "new-provider", identityKey: null, credential: { type: "api_key" },
    blocks: [{ blockScope: "", blockedUntilMs: now }, { blockScope: "tier:future", blockedUntilMs: now + 1 }],
  }] }, scope, now, now);
  expect(observation.accounts[0]!.blocks).toEqual([{ scope: "tier:future", until: now + 1 }]);
  expect(observation.accounts[0]!.reference).toEqual({ kind: "credential", scope, provider: "new-provider", credentialId: 10 });
  expect(projectAccounts(null, scope, null, now).status).toBe("unavailable");
  expect(projectAccounts(metadata, scope, null, now).status).toBe("stale");
  expect(() => projectAccounts(metadata, scope, now + 1, now)).toThrow(OmpDataError);
});

const brokerReport = {
  provider: "openai-codex", fetchedAt: now - 10,
  metadata: { email: "ALICE@example.test", accountId: "provider-account-uuid", endpoint: "https://provider.invalid" },
  limits: [{ id: "openai-codex:primary", label: "5 Hour", scope: { provider: "openai-codex", windowId: "5h" },
    window: { id: "5h", label: "5 Hour", resetsAt: now + 60_000, durationMs: 18_000_000 },
    amount: { unit: "percent", usedFraction: 0.7 }, status: "ok" }],
};

test("malformed provider verdicts are refused rather than interpreted as permission to use capacity", () => {
  for (const status of ["allowed", { allowed: true }]) {
    const raw = { generatedAt: now, reports: [{ ...brokerReport, limits: [{ ...brokerReport.limits[0]!, status }] }] };
    expect(() => normalizeBrokerUsage(raw, accounts, now)).toThrow(OmpDataError);
  }
});

describe("OMP-owned broker metadata and usage boundaries", () => {
  test("joins native broker metadata, preserves source times and drops secret/error bodies", () => {
    const raw = { generatedAt: now, reports: [{ ...brokerReport,
      raw: { accessToken: "PRIVATE" }, notes: ["PRIVATE provider error body"],
      metadata: { ...brokerReport.metadata, authorization: "PRIVATE" },
      resetCredits: { availableCount: 1, credits: [{ status: "available", expiresAt: new Date(now + 50_000).toISOString() }] },
    }] };
    const normalized = normalizeBrokerUsage(raw, accounts, now)!;
    expect(normalized.accounts[0]!.credentialId).toBe(1);
    expect(normalized.accounts[0]!.windows[0]!.observedAt).toBe(now - 10);
    expect(normalized.accounts[0]!.resetCredits).toEqual({ available: 1, expiresAt: [now + 50_000] });
    expect(JSON.stringify(normalized)).not.toContain("PRIVATE");
  });

  test("leaves ambiguous email unknown but accepts explicit same-scope identity and org qualification", () => {
    const shared = projectAccounts({ credentials: [
      { id: 1, provider: "anthropic", identityKey: "email:shared@example.test|org:a", credential: { type: "oauth", email: "shared@example.test" } },
      { id: 2, provider: "anthropic", identityKey: "email:shared@example.test|org:b", credential: { type: "oauth", email: "shared@example.test" } },
    ] }, scope, now, now);
    const report = { provider: "anthropic", fetchedAt: now, limits: [], metadata: { email: "shared@example.test" } };
    expect(normalizeBrokerUsage({ generatedAt: now, reports: [report] }, shared, now)!.accounts).toEqual([]);
    const org = normalizeBrokerUsage({ generatedAt: now, reports: [{ ...report, metadata: { ...report.metadata, orgId: "b" } }] }, shared, now)!;
    expect(org.accounts.map(account => account.credentialId)).toEqual([2]);
    const exact = normalizeBrokerUsage({ generatedAt: now, reports: [{ ...report,
      metadata: { accountId: "email:shared@example.test|org:a" } }] }, shared, now)!;
    expect(exact.accounts.map(account => account.credentialId)).toEqual([1]);
  });

  test("refuses duplicate matched reports, keeps missing identity unknown, and honors amount precedence", () => {
    expect(() => normalizeBrokerUsage({ generatedAt: now, reports: [brokerReport, brokerReport] }, accounts, now)).toThrow(OmpDataError);
    const unmapped = { ...brokerReport, metadata: {} };
    expect(normalizeBrokerUsage({ generatedAt: now, reports: [unmapped] }, accounts, now)!.accounts).toEqual([]);
    const overage = { ...brokerReport, limits: [{ ...brokerReport.limits[0]!, amount: { unit: "tokens", used: 12, limit: 10 } }] };
    expect(normalizeBrokerUsage({ generatedAt: now, reports: [overage] }, accounts, now)!.accounts[0]!.windows[0]!.usedFraction).toBe(1.2);
  });

  test("an exact identity cannot override conflicting email or organization evidence", () => {
    const conflict = { ...brokerReport, metadata: { accountId: "alice@example.test", email: "bob@example.test" } };
    expect(normalizeBrokerUsage({ generatedAt: now, reports: [conflict] }, accounts, now)!.accounts).toEqual([]);
  });

  test("native disabled API-key facts target only their concrete slot", () => {
    const keys = projectAccounts({ credentials: [
      { id: 10, provider: "openai", identityKey: null, credential: { type: "api_key" } },
      { id: 11, provider: "openai", identityKey: null, credential: { type: "api_key" } },
    ] }, scope, now, now);
    const normalized = normalizeBrokerUsage({ generatedAt: now, reports: [], disabledCredentials: [
      { id: 11, provider: "openai", type: "api_key", disabledAtMs: now - 100, cause: "PRIVATE" },
    ] }, keys, now)!;
    expect(normalized.accounts.map(account => ({ id: account.credentialId, status: account.status })))
      .toEqual([{ id: 11, status: "credential_disabled" }]);
  });

  test("health reports stay tied to exact accounts without disclosing raw cause text", () => {
    const normalized = normalizeBrokerUsage({ generatedAt: now, reports: [], disabledCredentials: [
      { provider: "openai-codex", accountId: "alice@example.test", disabledAtMs: now - 100, cause: "PRIVATE refresh token" },
    ], accountsWithoutUsage: [{ provider: "openai-codex", email: "bob@example.test" }] }, accounts, now)!;
    const result = normalized;
    expect(Object.fromEntries(result.accounts.map(account => [account.credentialId, account.status])))
      .toEqual({ 1: "credential_disabled", 2: "no_usage" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
});
