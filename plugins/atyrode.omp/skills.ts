import { InspectJobInputsResultSchema } from "@manifold/protocol";
import {
  SkillCatalogSchema, skillInputBindings, type SkillCatalog, type SkillCatalogEntry,
  type SkillReview, type SkillSelection, type ActionInput, type Target,
} from "../api/index.ts";
import { authorizeTarget, callerCapabilityRefusal, OmpRefusal, type OmpContext } from "./machine-server.ts";

const key = (machineId: string) => `skills/v1/${encodeURIComponent(machineId)}`;
async function machineAuthority(ctx: OmpContext, machineId: string) {
  const refused = await callerCapabilityRefusal(ctx, "machines:run", { kind: "machine", machineId });
  if (refused) throw new OmpRefusal(refused);
}
async function storedCatalog(ctx: OmpContext, machineId: string): Promise<SkillCatalog> {
  const raw = await ctx.storage.get(key(machineId));
  return raw === null ? { revision: 0, skills: [], sets: [], updatedAt: null, updatedBy: null }
    : SkillCatalogSchema.parse(JSON.parse(raw));
}
/** Metadata-only native inspection reuses bound-input read/export authority, never output bytes. */
async function authorizeSources(ctx: OmpContext, machineId: string, skills: readonly SkillCatalogEntry[]) {
  for (let offset = 0; offset < skills.length; offset += 15) {
    const selected = skills.slice(offset, offset + 15);
    const inputs = skillInputBindings({ mode: "selected", catalogRevision: 0, selected });
    const inspected = InspectJobInputsResultSchema.parse(await ctx.jobs.inspectInputs({ machineId, inputs }));
    if (inspected.inputs.length !== inputs.length) throw new OmpRefusal("skill_source_changed");
    for (let index = 0; index < selected.length; index++) {
      const skill = selected[index]!;
      const source = inspected.inputs[index]!;
      if (source.name !== inputs[index]!.name || source.from.jobId !== skill.source.jobId ||
        source.from.output !== skill.source.output || source.sha256 !== skill.source.sha256 ||
        source.files < 1 || source.files > 4096 || source.bytes < 1 || source.bytes > 16 * 1024 * 1024)
        throw new OmpRefusal("skill_source_changed");
    }
  }
}
export async function readSkillCatalog(ctx: OmpContext, target: Target): Promise<SkillCatalog> {
  await authorizeTarget(ctx, target);
  await machineAuthority(ctx, target.machineId);
  const catalog = await storedCatalog(ctx, target.machineId);
  await authorizeSources(ctx, target.machineId, catalog.skills);
  return catalog;
}
export async function writeSkillCatalog(ctx: OmpContext, args: ActionInput<"writeSkillCatalog">): Promise<SkillCatalog> {
  if (!ctx.auth.isRoot || ctx.auth.containerScope !== null) throw new OmpRefusal("skill_catalog_owner_required");
  await machineAuthority(ctx, args.machineId);
  const raw = await ctx.storage.get(key(args.machineId));
  const previous = raw === null ? null : SkillCatalogSchema.parse(JSON.parse(raw));
  const current = previous?.revision ?? 0;
  if (current !== args.expectedRevision || current === Number.MAX_SAFE_INTEGER) throw new OmpRefusal("stale_skill_catalog");
  const next = SkillCatalogSchema.parse({ skills: args.skills, sets: args.sets,
    revision: current + 1, updatedAt: ctx.now(), updatedBy: ctx.auth.principal.id });
  const encoded = JSON.stringify(next);
  if (Buffer.byteLength(encoded) > 65536) throw new OmpRefusal("input_too_large");
  for (const skill of next.skills) {
    const prior = previous?.skills.find(entry => entry.id === skill.id && entry.revision === skill.revision);
    if (prior && (prior.source.jobId !== skill.source.jobId || prior.source.output !== skill.source.output ||
      prior.source.sha256 !== skill.source.sha256 || prior.name !== skill.name))
      throw new OmpRefusal("skill_revision_changed");
  }
  await authorizeSources(ctx, args.machineId, next.skills);
  if (!await ctx.storage.compareAndSet(key(args.machineId), raw, encoded)) throw new OmpRefusal("stale_skill_catalog");
  return next;
}
export async function resolveSkills(ctx: OmpContext, machineId: string, selection?: SkillSelection): Promise<SkillReview> {
  if (selection === undefined) return { mode: "preserve", catalogRevision: null, selected: [] };
  if (selection.mode === "disabled") return { mode: "disabled", catalogRevision: null, selected: [] };
  await machineAuthority(ctx, machineId);
  const catalog = await storedCatalog(ctx, machineId);
  if (catalog.revision !== selection.expectedCatalogRevision) throw new OmpRefusal("stale_skill_catalog");
  const ids = new Set(selection.skillIds);
  for (const id of selection.setIds) {
    const set = catalog.sets.find(set => set.id === id);
    if (!set) throw new OmpRefusal("skill_set_missing");
    for (const skillId of set.skillIds) ids.add(skillId);
  }
  const selected = [...ids].sort().map(id => {
    const skill = catalog.skills.find(skill => skill.id === id);
    if (!skill) throw new OmpRefusal("skill_missing");
    return skill;
  });
  if (selected.length > 15) throw new OmpRefusal("skill_selection_limit");
  const names = new Set<string>();
  for (const skill of selected) {
    if (names.has(skill.name) || skill.conflicts.some(id => ids.has(id))) throw new OmpRefusal("skill_conflict");
    names.add(skill.name);
  }
  await authorizeSources(ctx, machineId, selected);
  return { mode: "selected", catalogRevision: catalog.revision, selected };
}
