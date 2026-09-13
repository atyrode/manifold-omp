import { DefaultsSchema, OverlaySchema, type ActionInput, type Defaults, type Overlay } from "../api/index.ts";
import { OmpRefusal, type OmpContext } from "./machine-server.ts";

const defaultsKey = "defaults/v1";
export async function readDefaults(ctx: OmpContext): Promise<Defaults> {
  const raw = await ctx.storage.get(defaultsKey);
  return raw === null ? { revision: 0, overlay: {}, updatedAt: null, updatedBy: null } : DefaultsSchema.parse(JSON.parse(raw));
}
export async function writeDefaults(ctx: OmpContext, args: ActionInput<"writeDefaults">): Promise<Defaults> {
  if (!ctx.auth.isRoot || ctx.auth.containerScope !== null) throw new OmpRefusal("defaults_owner_required");
  const raw = await ctx.storage.get(defaultsKey);
  const current = raw === null ? 0 : DefaultsSchema.parse(JSON.parse(raw)).revision;
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
