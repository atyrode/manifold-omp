import { closeSync, constants, openSync, unlinkSync, writeSync } from "node:fs";
import type { ActionRunnerResponse } from "@manifold/protocol";

export const ADMISSION_CONTEXT_PATH = "/home/job/manifold-admission.txt";
export const ADMISSION_CONTEXT_BYTES = 16 * 1024 * 1024;
const acknowledgementInstructions = "Manifold admission context follows as complete redacted protocol frames. The discovery frames contain the live action schemas. Read every required policy body before acting. Use the manifold tool with request.type=ack and the exact policy revision and acknowledgements [{id,digest}] to explicitly assent; delivery of these bytes is not acknowledgement. Omit request.runId for this run, or use an owned child runId from a child result. Credentials, session binding, and request ids belong to the harness.\n";

export interface AdmissionContextFile {
  readonly path: string;
  close(): void;
}

/** A private, ephemeral launch file, never an operation input or session artifact.
 * Frames have already crossed ActionRunner's redacting/secret-rejecting emitter. */
export function writeAdmissionContext(frames: readonly ActionRunnerResponse[], path = ADMISSION_CONTEXT_PATH): AdmissionContextFile {
  const lines = [acknowledgementInstructions];
  let bytes = Buffer.byteLength(acknowledgementInstructions);
  for (const frame of frames) {
    const line = `${JSON.stringify(frame)}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes > ADMISSION_CONTEXT_BYTES) throw new Error("harness_admission_limit");
    lines.push(line);
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let complete = false;
  try {
    for (const line of lines) {
      const data = Buffer.from(line);
      let offset = 0;
      while (offset < data.length) {
        const count = writeSync(fd, data, offset, data.length - offset);
        if (count === 0) throw new Error("harness_admission_write_failed");
        offset += count;
      }
    }
    complete = true;
  } finally {
    closeSync(fd);
    if (!complete) unlinkSync(path);
  }
  let removed = false;
  return { path, close() {
    if (removed) return;
    try { unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    removed = true;
  } };
}
