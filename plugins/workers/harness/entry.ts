import { closeSync, writeSync } from "node:fs";
import { openWorkerContext, type WorkerContext } from "@manifold/sdk/worker";
import { listSessionSummaries, openSessionsRoot } from "./sessions.ts";
import { runOmpHarness, runOmpNative, runOmpResume } from "./runtime.ts";

const controller = new AbortController();
const cancel = () => controller.abort();
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
let context: WorkerContext | undefined;
let success = false;
try {
  context = openWorkerContext({ signal: controller.signal });
  await context.ready;
  if (context.signal.aborted) throw new Error("harness_cancelled");
  if (process.argv[2] === "sessions") {
    const root = openSessionsRoot();
    try {
      const bytes = Buffer.from(`${JSON.stringify(listSessionSummaries(root))}\n`);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(1, bytes, offset, bytes.length - offset);
    } finally { closeSync(root); }
    success = true;
  } else if (process.argv[2] === "launch") {
    success = await runOmpHarness(context.signal);
  } else if (process.argv[2] === "resume") {
    success = await runOmpResume(context.signal);
  } else if (process.argv[2] === "native") {
    success = await runOmpNative(context);
  } else throw new Error("invalid_harness_operation");
} catch {
  // No exception, provider diagnostic, path or environment reaches public output.
  writeSync(2, "omp_harness_failed\n");
} finally {
  context?.close();
  process.off("SIGTERM", cancel);
  process.off("SIGINT", cancel);
}
process.exit(success ? 0 : 1);
