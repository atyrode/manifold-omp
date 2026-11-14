import type { ServerMigration } from "@manifold/plugin-kit/server";
import { DefaultsSchema, OverlaySchema, type ActionInput, type Defaults, type Overlay } from "../api/index.ts";
import { OmpRefusal, type OmpContext } from "./machine-server.ts";

const defaultsKey = "defaults/v1";
function decodeDefaults(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { throw new OmpRefusal("defaults_incompatible"); }
}
function validateDefaults(value: unknown): Defaults {
  const parsed = DefaultsSchema.safeParse(value);
  if (!parsed.success) throw new OmpRefusal("defaults_incompatible");
  return parsed.data;
}
/** The native data-version ledger runs this against an exclusive, bounded storage draft. */
export const defaultsNativeSharedRolesMigration: ServerMigration = {
  name: "2026-11-14-defaults-native-shared-roles",
  to: { major: 2, minor: 0 },
  async migrate(storage) {
    const raw = await storage.get(defaultsKey);
    if (raw === null) return;
    const value = decodeDefaults(raw);
    let changed = false;
    if (typeof value === "object" && value !== null && "overlay" in value &&
      typeof value.overlay === "object" && value.overlay !== null && "task" in value.overlay &&
      typeof value.overlay.task === "object" && value.overlay.task !== null &&
      Object.hasOwn(value.overlay.task, "agentModelOverrides")) {
      Reflect.deleteProperty(value.overlay.task, "agentModelOverrides");
      if (Object.keys(value.overlay.task).length === 0) Reflect.deleteProperty(value.overlay, "task");
      changed = true;
    }
    const defaults = validateDefaults(value);
    if (changed) {
      if (defaults.revision === Number.MAX_SAFE_INTEGER) throw new OmpRefusal("defaults_incompatible");
      // The change invalidates prior reviews without rewriting the last principal's audit fields.
      defaults.revision++;
      await storage.set(defaultsKey, JSON.stringify(defaults));
    }
  },
};
export async function readDefaults(ctx: OmpContext): Promise<Defaults> {
  const raw = await ctx.storage.get(defaultsKey);
  return raw === null ? { revision: 0, overlay: {}, updatedAt: null, updatedBy: null } : validateDefaults(decodeDefaults(raw));
}
export async function writeDefaults(ctx: OmpContext, args: ActionInput<"writeDefaults">): Promise<Defaults> {
  if (!ctx.auth.isRoot || ctx.auth.containerScope !== null) throw new OmpRefusal("defaults_owner_required");
  const raw = await ctx.storage.get(defaultsKey);
  const current = raw === null ? 0 : validateDefaults(decodeDefaults(raw)).revision;
  if (current !== args.expectedRevision || current === Number.MAX_SAFE_INTEGER) throw new OmpRefusal("stale_defaults");
  const next = DefaultsSchema.parse({ revision: current + 1, overlay: args.overlay, updatedAt: ctx.now(), updatedBy: ctx.auth.principal.id });
  const encoded = JSON.stringify(next);
  if (Buffer.byteLength(encoded) > 65536) throw new OmpRefusal("input_too_large");
  if (!await ctx.storage.compareAndSet(defaultsKey, raw, encoded)) throw new OmpRefusal("stale_defaults");
  return next;
}
export async function expectedDefaults(ctx: OmpContext, expected: number) {
  const current = await readDefaults(ctx);
  if (current.revision !== expected) throw new OmpRefusal("stale_defaults");
  return current;
}
export function effectiveOverlay(defaults: Defaults, overlay: Overlay): Overlay {
  // Replacement is intentional: omitted keys inherit, explicitly empty maps clear.
  return OverlaySchema.parse({ ...defaults.overlay, ...overlay });
}
