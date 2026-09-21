import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillCatalogContentsSchema, type JobInputBinding, type SkillCatalogEntry } from "../api/index.ts";
import { readSkillCatalog, resolveSkills, writeSkillCatalog } from "../atyrode.omp/skills.ts";
import type { OmpContext } from "../atyrode.omp/machine-server.ts";
import { validateSkillInputs } from "../workers/harness/skills.ts";

const target = { machineId: "owner", containerId: "room" };
function entry(id: string, conflicts: string[] = []): SkillCatalogEntry {
  return { id, name: id, title: id, purpose: "Reviewed instructions", revision: "one",
    source: { jobId: `source-${id}`, output: "skill", sha256: "a".repeat(64) },
    license: { spdx: "MIT" }, review: { reviewedBy: "owner", reviewedAt: 1, reference: "review-1" }, conflicts };
}
function fixture() {
  const storage = new Map<string, string>();
  const state = { sourceAvailable: true, sha256: "a".repeat(64), owner: true, scope: null as string | null, compare: true };
  const ctx = {
    pluginId: "atyrode.omp", now: () => 1, outsideScope: async () => null,
    auth: { principal: { id: "owner" }, caps: ["*"], get isRoot() { return state.owner; },
      get containerScope() { return state.scope; }, allows: async () => true },
    storage: { get: async (key: string) => storage.get(key) ?? null,
      compareAndSet: async (key: string, expected: string | null, next: string) => {
        if (!state.compare || (storage.get(key) ?? null) !== expected) return false;
        storage.set(key, next); return true;
      } },
    jobs: { inspectInputs: async ({ inputs }: { inputs: JobInputBinding[] }) => {
      if (!state.sourceAvailable) throw new Error("input_authority_refused");
      return { inputs: inputs.map(input => ({ ...input, sha256: state.sha256, files: 2, bytes: 4096 })) };
    } },
  } as unknown as OmpContext;
  return { ctx, state };
}

test("catalog CAS is machine-scoped, owner-only, and cannot reuse a content revision for changed bytes", async () => {
  const { ctx, state } = fixture();
  const initial = { machineId: target.machineId, expectedRevision: 0, skills: [entry("alpha")], sets: [] };
  state.scope = target.containerId;
  await expect(writeSkillCatalog(ctx, initial)).rejects.toThrow("skill_catalog_owner_required");
  state.scope = null;
  const written = await writeSkillCatalog(ctx, initial);
  expect(written.revision).toBe(1);
  await expect(writeSkillCatalog(ctx, initial)).rejects.toThrow("stale_skill_catalog");
  expect((await readSkillCatalog(ctx, { ...target, machineId: "other" })).skills).toEqual([]);
  await expect(writeSkillCatalog(ctx, { ...initial, expectedRevision: 1,
    skills: [{ ...entry("alpha"), source: { ...entry("alpha").source, sha256: "b".repeat(64) } }] }))
    .rejects.toThrow("skill_revision_changed");
  state.compare = false;
  await expect(writeSkillCatalog(ctx, { ...initial, expectedRevision: 1, sets: [{ id: "set", title: "Set", skillIds: ["alpha"] }] }))
    .rejects.toThrow("stale_skill_catalog");
  expect((await readSkillCatalog(ctx, target)).sets).toEqual([]);
});

test("set and explicit selection canonicalize while conflicting names and declared conflicts refuse", async () => {
  const { ctx } = fixture();
  await writeSkillCatalog(ctx, { machineId: target.machineId, expectedRevision: 0,
    skills: [entry("alpha"), entry("beta"), entry("gamma", ["alpha"]), { ...entry("alias"), name: "alpha" }],
    sets: [{ id: "pair", title: "Pair", skillIds: ["beta", "alpha"] }] });
  const select = { mode: "select" as const, expectedCatalogRevision: 1, skillIds: ["alpha", "alpha"], setIds: ["pair", "pair"] };
  const reviewed = await resolveSkills(ctx, target.machineId, select);
  expect(reviewed.selected.map(skill => skill.id)).toEqual(["alpha", "beta"]);
  expect(await resolveSkills(ctx, target.machineId, { ...select, skillIds: ["beta", "alpha"], setIds: [] })).toEqual(reviewed);
  for (const other of ["gamma", "alias"])
    await expect(resolveSkills(ctx, target.machineId, { ...select, skillIds: ["alpha", other], setIds: [] })).rejects.toThrow("skill_conflict");
  await expect(resolveSkills(ctx, target.machineId, { ...select, expectedCatalogRevision: 0 })).rejects.toThrow("stale_skill_catalog");
  expect(await resolveSkills(ctx, target.machineId)).toEqual({ mode: "preserve", catalogRevision: null, selected: [] });
  expect(await resolveSkills(ctx, target.machineId, { mode: "disabled" })).toEqual({ mode: "disabled", catalogRevision: null, selected: [] });
});

test("catalog reads and selected launches recheck native source authority and sealed digests", async () => {
  const { ctx, state } = fixture();
  await writeSkillCatalog(ctx, { machineId: target.machineId, expectedRevision: 0, skills: [entry("alpha")], sets: [] });
  const select = { mode: "select" as const, expectedCatalogRevision: 1, skillIds: ["alpha"], setIds: [] };
  state.sha256 = "b".repeat(64);
  await expect(readSkillCatalog(ctx, target)).rejects.toThrow("skill_source_changed");
  await expect(resolveSkills(ctx, target.machineId, select)).rejects.toThrow("skill_source_changed");
  state.sha256 = "a".repeat(64); state.sourceAvailable = false;
  await expect(readSkillCatalog(ctx, target)).rejects.toThrow();
  await expect(resolveSkills(ctx, target.machineId, select)).rejects.toThrow();
});

test("catalog rejects dangling sets and bounds aggregate storage independently of per-field limits", async () => {
  expect(SkillCatalogContentsSchema.safeParse({ skills: [entry("alpha")], sets: [{ id: "bad", title: "Bad", skillIds: ["missing"] }] }).success).toBe(false);
  const { ctx } = fixture();
  await expect(writeSkillCatalog(ctx, { machineId: target.machineId, expectedRevision: 0,
    skills: Array.from({ length: 64 }, (_, index) => ({ ...entry(`skill-${index}`), purpose: "a".repeat(2048) })), sets: [] }))
    .rejects.toThrow("input_too_large");
});

test("immutable skill boundary preserves resources but refuses another identity, links and unexpected mounts", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-skill-boundary-"));
  const skill = join(root, "optionalSkill0", "alpha");
  try {
    mkdirSync(join(skill, "resources"), { recursive: true });
    writeFileSync(join(root, "skillRuntime"), JSON.stringify({ mode: "selected", names: ["alpha"] }));
    writeFileSync(join(skill, "SKILL.md"), "---\nname: alpha\ndescription: Reviewed alpha\n---\nUse resources/data.txt\n");
    writeFileSync(join(skill, "resources", "data.txt"), "reviewed data");
    validateSkillInputs(root);
    expect(readFileSync(join(skill, "resources", "data.txt"), "utf8")).toBe("reviewed data");
    writeFileSync(join(skill, "resources", "SKILL.md"), "unreviewed identity");
    expect(() => validateSkillInputs(root)).toThrow("skill_input_multiple");
    rmSync(join(skill, "resources", "SKILL.md"));
    symlinkSync("/etc/passwd", join(skill, "resources", "link"));
    expect(() => validateSkillInputs(root)).toThrow("skill_input_invalid");
    rmSync(join(skill, "resources", "link"));
    writeFileSync(join(skill, "SKILL.md"), "---\nname: beta\ndescription: Changed identity\n---\nbody\n");
    expect(() => validateSkillInputs(root)).toThrow("skill_identity_changed");
    writeFileSync(join(root, "skillRuntime"), JSON.stringify({ mode: "disabled", names: [] }));
    expect(() => validateSkillInputs(root)).toThrow("skill_input_changed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
