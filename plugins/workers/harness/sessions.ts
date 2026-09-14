import { constants, closeSync, fstatSync, openSync, readSync, readdirSync, writeSync } from "node:fs";
import { z } from "zod";
import { OmpSessionSummarySchema, type OmpSessionSummary } from "../../api/index.ts";

export const SESSIONS_ROOT = "/home/job/omp-sessions";
export const SESSION_LIMIT = 4096;
export const SESSION_INVENTORY_BYTES = 1024 * 1024;
const headerLimit = 16384;
export const SessionIdSchema = OmpSessionSummarySchema.shape.id;
const headerSchema = z.object({
  type: z.literal("session"), version: z.literal(3), id: SessionIdSchema,
  cwd: z.string(), timestamp: z.iso.datetime(), title: z.string().optional(),
});
const titleSchema = z.object({
  type: z.literal("title"), v: z.literal(1), title: z.string(),
  updatedAt: z.string(), pad: z.string(), source: z.enum(["auto", "user"]).optional(),
});

/** All child opens are relative to a held directory, with no symlink traversal.
 * The native location binding, not the model or a transcript path, chooses root. */
export function openSessionsRoot(root = SESSIONS_ROOT): number {
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  if (!fstatSync(fd).isDirectory()) { closeSync(fd); throw new Error("invalid_sessions_root"); }
  return fd;
}

function metadataAt(root: number, name: string): OmpSessionSummary | null {
  let fd: number;
  try { fd = openSync(`/proc/self/fd/${root}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return null;
    const bytes = Buffer.alloc(Math.min(stat.size, headerLimit));
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count);
      if (read === 0) break;
      count += read;
    }
    const prefix = bytes.subarray(0, count);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let offset = 0;
    const nextLine = (): unknown => {
      const newline = prefix.indexOf(10, offset);
      if (newline === -1 && stat.size > count) throw new Error("session_metadata_limit");
      const end = newline === -1 ? count : newline;
      const line = prefix.subarray(offset, end);
      offset = end + 1;
      try { return JSON.parse(decoder.decode(line)); } catch { return null; }
    };
    // Decode only the physical title/header lines, never message bodies or a
    // partial UTF-8 sequence from a message at the edge of the bounded prefix.
    let value = nextLine();
    const slot = titleSchema.safeParse(value);
    if (slot.success) value = nextLine();
    const header = headerSchema.safeParse(value);
    if (!header.success) return null;
    const title = slot.success ? slot.data.title : header.data.title;
    return { id: header.data.id, title: title || null, cwd: header.data.cwd, updatedAt: Math.floor(stat.mtimeMs) };
  } finally { closeSync(fd); }
}

export function listSessionSummaries(root: number): OmpSessionSummary[] {
  const names = readdirSync(`/proc/self/fd/${root}`);
  if (names.length > SESSION_LIMIT * 4) throw new Error("session_inventory_limit");
  const ids = new Set<string>();
  const sessions: OmpSessionSummary[] = [];
  let bytes = 3; // Array brackets and the worker's trailing newline.
  for (const name of names.sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.jsonl$/.test(name)) continue;
    const metadata = metadataAt(root, name);
    if (!metadata) continue;
    if (ids.has(metadata.id)) throw new Error("ambiguous_session");
    ids.add(metadata.id);
    if (ids.size > SESSION_LIMIT) throw new Error("session_inventory_limit");
    // Oversized metadata is refused, not shortened or silently hidden.
    const summary = OmpSessionSummarySchema.parse(metadata);
    bytes += Buffer.byteLength(JSON.stringify(summary)) + (sessions.length ? 1 : 0);
    if (bytes > SESSION_INVENTORY_BYTES) throw new Error("session_inventory_limit");
    sessions.push(summary);
  }
  return sessions;
}

export function resolveSessionFile(root: number, sessionId: string): string | null {
  const id = SessionIdSchema.parse(sessionId);
  const names = readdirSync(`/proc/self/fd/${root}`);
  if (names.length > SESSION_LIMIT * 4) throw new Error("session_inventory_limit");
  let match: string | null = null;
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.jsonl$/.test(name) || metadataAt(root, name)?.id !== id) continue;
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
