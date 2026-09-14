import { constants, closeSync, fstatSync, openSync, readSync, readdirSync, writeSync } from "node:fs";
import { z } from "zod";

export const SESSIONS_ROOT = "/home/job/omp-sessions";
export const SESSION_LIMIT = 4096;
const headerLimit = 16384;
export const SessionIdSchema = z.uuid();
const headerSchema = z.object({ type: z.literal("session"), version: z.literal(3), id: SessionIdSchema, cwd: z.string(), timestamp: z.iso.datetime() });

/** All child opens are relative to a held directory, with no symlink traversal.
 * The native location binding, not the model or a transcript path, chooses root. */
export function openSessionsRoot(root = SESSIONS_ROOT): number {
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  if (!fstatSync(fd).isDirectory()) { closeSync(fd); throw new Error("invalid_sessions_root"); }
  return fd;
}

function headerAt(root: number, name: string): string | null {
  let fd: number;
  try { fd = openSync(`/proc/self/fd/${root}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return null;
    const bytes = Buffer.alloc(Math.min(stat.size, headerLimit));
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
    // OMP v18 stores an optional fixed-width title slot before the header.
    for (const line of text.split("\n").slice(0, 2)) {
      const value: unknown = JSON.parse(line);
      const header = headerSchema.safeParse(value);
      if (header.success) return header.data.id;
      if (!value || typeof value !== "object" || !("type" in value) || value.type !== "title") return null;
    }
    return null;
  } catch { return null; }
  finally { closeSync(fd); }
}

export function listSessionIds(root: number): string[] {
  const names = readdirSync(`/proc/self/fd/${root}`);
  if (names.length > SESSION_LIMIT * 4) throw new Error("session_inventory_limit");
  const ids = new Set<string>();
  for (const name of names.sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.jsonl$/.test(name)) continue;
    const id = headerAt(root, name);
    if (!id) continue;
    if (ids.has(id)) throw new Error("ambiguous_session");
    ids.add(id);
    if (ids.size > SESSION_LIMIT) throw new Error("session_inventory_limit");
  }
  return [...ids];
}

export function resolveSessionFile(root: number, sessionId: string): string | null {
  const id = SessionIdSchema.parse(sessionId);
  const names = readdirSync(`/proc/self/fd/${root}`);
  if (names.length > SESSION_LIMIT * 4) throw new Error("session_inventory_limit");
  let match: string | null = null;
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.jsonl$/.test(name) || headerAt(root, name) !== id) continue;
    if (match) throw new Error("ambiguous_session");
    match = name;
  }
  return match;
}

/** The launcher creates the actual OMP header exclusively before invoking OMP.
 * Reusing an existing UUID is not implicitly a resume. */
export function createSessionFile(root: number, sessionId: string, cwd: string, now = new Date()): string {
  const id = SessionIdSchema.parse(sessionId);
  const name = `${id}.jsonl`;
  const fd = openSync(`/proc/self/fd/${root}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: now.toISOString() })}\n`);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  } finally { closeSync(fd); }
  return name;
}

/** Resume is an explicit reviewed mode. A missing conversation never silently
 * becomes a fresh one, and a fresh launch never overwrites an existing journal. */
export function prepareSessionFile(root: number, sessionId: string, cwd: string, resume: boolean): string {
  if (!resume) return createSessionFile(root, sessionId, cwd);
  const file = resolveSessionFile(root, sessionId);
  if (file === null) throw new Error("session_unavailable");
  return file;
}
