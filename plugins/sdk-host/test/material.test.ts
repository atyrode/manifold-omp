import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, linkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { MATERIAL_MAX_BYTES, MaterialOnlyIsolationSchema, PROMPT_MAX_BYTES } from "../../api/index.ts";
import { materialMessage, readMaterial } from "../material.ts";

function fixture(content: string | Buffer = "source evidence") {
  const directory = mkdtempSync(join(tmpdir(), "omp-material-"));
  const file = "transcript-map.json";
  const bytes = Buffer.from(content);
  writeFileSync(join(directory, file), bytes, { mode: 0o400 });
  return { directory, file, isolation: { mode: "material-only" as const, file,
    sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length } };
}

test("material is exact fatal UTF-8 and retains BOM bytes under its own one MiB bound", () => {
  const content = "\ufeff" + "a".repeat(MATERIAL_MAX_BYTES - 3);
  const f = fixture(content);
  try {
    const loaded = readMaterial(f.isolation, f.directory);
    expect(loaded).toBe(content);
    expect(materialMessage("p".repeat(PROMPT_MAX_BYTES), loaded)).toContain(content);
    expect(() => materialMessage("p".repeat(PROMPT_MAX_BYTES + 1), loaded)).toThrow();
    expect(() => materialMessage("p", loaded + "a")).toThrow();
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("content hash, exact byte count and invalid UTF-8 refuse rather than truncate or replace", () => {
  const f = fixture(Buffer.from([0xff, 0xfe]));
  try {
    expect(() => readMaterial(f.isolation, f.directory)).toThrow();
    expect(() => readMaterial({ ...f.isolation, bytes: 1 }, f.directory)).toThrow();
    rmSync(join(f.directory, f.file));
    writeFileSync(join(f.directory, f.file), "ok");
    expect(() => readMaterial(f.isolation, f.directory)).toThrow();
    expect(() => readMaterial({ ...f.isolation, bytes: MATERIAL_MAX_BYTES + 1 }, f.directory)).toThrow();
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("extra entries, links, directories and path traversal cannot widen material authority", () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "omp-sentinel-"));
  try {
    writeFileSync(join(f.directory, "extra"), "not reviewed");
    expect(() => readMaterial(f.isolation, f.directory)).toThrow();
    rmSync(join(f.directory, "extra"));
    linkSync(join(f.directory, f.file), join(outside, "linked"));
    expect(() => readMaterial(f.isolation, f.directory)).toThrow();
    rmSync(join(outside, "linked"));
    rmSync(join(f.directory, f.file));
    writeFileSync(join(outside, "secret"), "NEVER-MODEL-INPUT");
    symlinkSync(join(outside, "secret"), join(f.directory, f.file));
    expect(() => readMaterial(f.isolation, f.directory)).toThrow();
    rmSync(join(f.directory, f.file));
    mkdirSync(join(f.directory, f.file));
    expect(() => readMaterial(f.isolation, f.directory)).toThrow();
    symlinkSync(f.directory, join(outside, "root"));
    expect(() => readMaterial(f.isolation, join(outside, "root"))).toThrow();
    for (const file of ["../secret", "/secret", ".", "..", "a/b", "a\\b"])
      expect(MaterialOnlyIsolationSchema.safeParse({ ...f.isolation, file }).success).toBe(false);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
