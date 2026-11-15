import { lstatSync, type Stats } from "node:fs";
import { basename, dirname } from "node:path";
import { HeldDirectory } from "../../../manifold/packages/agent/src/job-files.ts";

/**
 * A bounded failure class for verifier reports, selected only from fixed identifiers.
 * Never echo a message, custom error name, path, environment value or workload output.
 */
export function failureClass(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "EACCES": case "EPERM": case "ENOENT": case "ENOTDIR": case "ELOOP":
    case "EXDEV": case "EBUSY": case "ENOSPC": case "EMFILE": case "ENFILE":
    case "EIO": case "EINVAL": case "EBADF": case "EINTR": case "EEXIST":
    case "ENOTEMPTY": case "EROFS": case "EPIPE": case "ETIMEDOUT":
    case "ECONNREFUSED": case "ECONNRESET": case "EADDRINUSE": case "ENOSYS":
    case "ENOMEM": case "EHOSTUNREACH": case "ENETUNREACH":
      return code.toLowerCase();
  }
  if (!(error instanceof Error)) return "unknown";
  if (error.message === "mount_escape") return "mount-escape";
  if (error.message === "directory_tree_changed") return "directory-tree-changed";
  if (error.message === "workload_unreaped") return "workload-unreaped";
  if (error.message === "directory_unheld") return "directory-unheld";
  if (error.message === "descriptor_unreleased") return "descriptor-unreleased";
  switch (error.name) {
    case "Error": case "TypeError": case "RangeError": case "SyntaxError":
    case "AggregateError": case "DOMException": case "TimeoutError": case "AbortError":
      return error.name.toLowerCase();
    default: return "unknown";
  }
}

/**
 * Removes a disposable directory this run allocated and held as private, once every workload
 * process and descriptor inside it is gone. It may contain Manifold's immutable managed groups
 * (0500 directories, 0400 files), so release goes through the core owner's own reclaim,
 * `HeldDirectory.removeTree`: no link is followed, no other mount is entered, and only owner
 * bits of owned directories it has entered are restored. The name must still be the directory
 * held at allocation, on the parent's mount; anything else is refused and left in place.
 */
export function reclaimAllocatedRoot(path: string, held: HeldDirectory): void {
  let allocated: Stats;
  try {
    allocated = held.stat();
  } finally {
    held.close();
  }
  const parent = HeldDirectory.openAbsolute(dirname(path));
  try {
    if (parent.mountId !== held.mountId) throw new Error("mount_escape");
    const named = lstatSync(`${parent.procPath}/${basename(path)}`);
    if (!named.isDirectory() || named.dev !== allocated.dev || named.ino !== allocated.ino)
      throw new Error("directory_tree_changed");
    parent.removeTree(basename(path));
  } finally {
    parent.close();
  }
}
