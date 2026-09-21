import { z } from "zod";
import { epochMilliseconds, identifier } from "./contracts.ts";
import { JobInputBindingSchema, type JobInputBinding } from "./native.ts";

const skillId = identifier;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const SkillSourceSchema = JobInputBindingSchema.shape.from.extend({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
/** Metadata only. Each sealed output contains one named skill directory and its resources. */
export const SkillCatalogEntrySchema = z.strictObject({
  id: skillId,
  name: identifier,
  title: z.string().min(1).max(256),
  purpose: z.string().min(1).max(2048),
  revision: z.string().min(1).max(128),
  source: SkillSourceSchema,
  license: z.strictObject({ spdx: z.string().min(1).max(128), url: z.url().max(2048).optional() }),
  review: z.strictObject({
    reviewedBy: z.string().min(1).max(128),
    reviewedAt: epochMilliseconds,
    reference: z.string().min(1).max(2048),
  }),
  conflicts: z.array(skillId).max(64),
  classification: z.enum(["core", "optional"]).optional(),
});
export type SkillCatalogEntry = z.infer<typeof SkillCatalogEntrySchema>;
export const SkillSetSchema = z.strictObject({
  id: skillId, title: z.string().min(1).max(256), skillIds: z.array(skillId).max(64),
});
export const SkillCatalogContentsSchema = z.strictObject({
  skills: z.array(SkillCatalogEntrySchema).max(64),
  sets: z.array(SkillSetSchema).max(64),
}).refine(({ skills, sets }) => {
  const ids = new Set(skills.map(skill => skill.id));
  return ids.size === skills.length && new Set(sets.map(set => set.id)).size === sets.length &&
    skills.every(skill => new Set(skill.conflicts).size === skill.conflicts.length &&
      skill.conflicts.every(id => id !== skill.id && ids.has(id))) &&
    sets.every(set => new Set(set.skillIds).size === set.skillIds.length && set.skillIds.every(id => ids.has(id)));
}, "skill catalog has duplicate or dangling IDs");
export const SkillCatalogSchema = SkillCatalogContentsSchema.safeExtend({
  revision, updatedAt: epochMilliseconds.nullable(), updatedBy: z.string().min(1).max(128).nullable(),
});
export type SkillCatalog = z.infer<typeof SkillCatalogSchema>;
export const SkillSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("select"), expectedCatalogRevision: revision,
    skillIds: z.array(skillId).max(64), setIds: z.array(skillId).max(64) }),
  z.strictObject({ mode: z.literal("disabled") }),
]);
export type SkillSelection = z.infer<typeof SkillSelectionSchema>;
export const SkillReviewSchema = z.strictObject({
  mode: z.enum(["preserve", "selected", "disabled"]),
  catalogRevision: revision.nullable(),
  selected: z.array(SkillCatalogEntrySchema).max(15),
}).refine(value => value.mode === "selected"
  ? value.catalogRevision !== null
  : value.catalogRevision === null && value.selected.length === 0);
export type SkillReview = z.infer<typeof SkillReviewSchema>;
/** Slot allocation is native-owned; consumers use it only to verify returned job bindings. */
export function skillInputBindings(review: SkillReview): JobInputBinding[] {
  return review.selected.map((skill, index) => ({
    name: `optionalSkill${index}`,
    from: { jobId: skill.source.jobId, output: skill.source.output },
  }));
}
