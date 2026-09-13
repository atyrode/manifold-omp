import { z } from "zod";

export const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine(value => !["constructor", "prototype", "__proto__"].includes(value));
export const epochMilliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ThinkingLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;
export const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,511}$/);

/** Existing clients keep their loopback endpoint and verifier, never a serialized bearer. */
export const BrokerClientAccessSchema = z.strictObject({
  bind: z.string().regex(/^127\.0\.0\.1:([1-9][0-9]{3,4})$/).refine(value => {
    const port = Number(value.slice(10));
    return port >= 1024 && port <= 65535 && value === `127.0.0.1:${port}`;
  }),
  bearerSha256: z.string().length(64).regex(/^[0-9a-f]{64}$/),
});
export type BrokerClientAccess = z.infer<typeof BrokerClientAccessSchema>;

const accountScope = z.string().min(1).max(1024);
const identityKey = z.string().min(1).max(1024);
const credentialId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** An API key has no OAuth identity key; its native service-scoped credential slot is explicit. */
export const AccountReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("identity"), scope: accountScope, provider: identifier, identityKey }),
  z.strictObject({ kind: z.literal("credential"), scope: accountScope, provider: identifier, credentialId }),
]);
export type AccountReference = z.infer<typeof AccountReferenceSchema>;

export const AccountRecordSchema = z.strictObject({
  reference: AccountReferenceSchema,
  credentialId,
  type: z.enum(["oauth", "api_key"]),
  identityKey: identityKey.nullable(),
  email: z.string().max(512).nullable(),
  disabled: z.boolean(),
  blocks: z.array(z.strictObject({ scope: z.string().max(128), until: epochMilliseconds })).max(64),
});
export type AccountRecord = z.infer<typeof AccountRecordSchema>;
export const AccountsObservationSchema = z.strictObject({
  scope: accountScope,
  observedAt: epochMilliseconds.nullable(),
  status: z.enum(["fresh", "stale", "unavailable"]),
  accounts: z.array(AccountRecordSchema).max(1024),
});
export type AccountsObservation = z.infer<typeof AccountsObservationSchema>;
/** A launch freezes concrete slots and their observed identities, never an open-ended provider pool. */
export const RuntimeAccountPoolSchema = z.record(identifier, z.array(z.strictObject({
  scope: accountScope,
  credentialId,
  identityKey: identityKey.nullable(),
})).max(1024)).refine(value => Object.keys(value).length <= 64);
export type RuntimeAccountPool = z.infer<typeof RuntimeAccountPoolSchema>;
