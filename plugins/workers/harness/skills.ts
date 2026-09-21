import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { parseFrontmatter } from "@oh-my-pi/pi-utils/frontmatter";
import { z } from "zod";
import { SkillCatalogEntrySchema } from "../../api/skills.ts";

export const SkillRuntimeSchema = z.strictObject({
  mode: z.enum(["preserve", "selected", "disabled"]),
  names: z.array(SkillCatalogEntrySchema.shape.name).max(15),
}).refine(value => new Set(value.names).size === value.names.length &&
  (value.mode === "selected" || value.names.length === 0));
function readImmutable(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new Error("skill_input_invalid");
    const bytes = Buffer.alloc(stat.size + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== stat.size) throw new Error("skill_input_changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
  } finally { closeSync(fd); }
}
/** Validate isolation and reviewed identity only. Discovery/loading remains exclusively OMP's.
 * The hub mounts each digest-checked sealed output read-only; no copies or acquired content.
 */
export function validateSkillInputs(inputRoot = "/inputs") {
  const runtime = SkillRuntimeSchema.parse(JSON.parse(readImmutable(`${inputRoot}/skillRuntime`, 4096)));
  const mounted = readdirSync(inputRoot).filter(name => name.startsWith("optionalSkill")).sort();
  const expected = runtime.names.map((_, index) => `optionalSkill${index}`).sort();
  if (JSON.stringify(mounted) !== JSON.stringify(expected)) throw new Error("skill_input_changed");
  for (let index = 0; index < runtime.names.length; index++) {
    const name = runtime.names[index]!;
    const root = `${inputRoot}/optionalSkill${index}`;
    if (!lstatSync(root).isDirectory()) throw new Error("skill_input_invalid");
    const children = readdirSync(root);
    if (children.length !== 1 || children[0] !== name) throw new Error("skill_input_invalid");
    const skillRoot = `${root}/${name}`;
    if (!lstatSync(skillRoot).isDirectory()) throw new Error("skill_input_invalid");
    let bytes = 0;
    let files = 0;
    let entries = 0;
    function walk(directory: string, depth: number): void {
      if (depth > 32) throw new Error("skill_input_limit");
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++entries > 8192) throw new Error("skill_input_limit");
        const path = `${directory}/${entry.name}`;
        const stat = lstatSync(path);
        if (stat.isDirectory()) walk(path, depth + 1);
        else if (stat.isFile()) {
          bytes += stat.size;
          if (++files > 4096 || bytes > 16 * 1024 * 1024) throw new Error("skill_input_limit");
          if (entry.name === "SKILL.md" && directory !== skillRoot) throw new Error("skill_input_multiple");
        } else throw new Error("skill_input_invalid");
      }
    }
    walk(skillRoot, 0);
    const path = `${skillRoot}/SKILL.md`;
    const { frontmatter } = parseFrontmatter(readImmutable(path, 1024 * 1024), { source: path });
    const nativeName = typeof frontmatter.name === "string" ? frontmatter.name.trim() || name : name;
    if (nativeName !== name || frontmatter.enabled === false ||
      typeof frontmatter.description !== "string" || !frontmatter.description.trim())
      throw new Error("skill_identity_changed");
  }
  return runtime;
}
