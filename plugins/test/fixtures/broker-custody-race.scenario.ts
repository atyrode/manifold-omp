import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { SdkScenarioContext } from "./isolated-sdk.ts";
import { runSdkScenario } from "./isolated-sdk.ts";

const PROCESSES = 6;
const TRIALS = 32;

await runSdkScenario(async (ctx: SdkScenarioContext) => {
  // Separate processes, as a restarted broker and OMP sign-in are: one thread could never race.
  const racer = fileURLToPath(new URL("./broker-custody-racer.ts", import.meta.url));
  const children = Array.from({ length: PROCESSES }, () => spawn(process.execPath, ["--no-env-file", "--no-install", racer],
    { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "ignore"] }));
  const exited = children.map(child => new Promise<number | null>(resolve => child.once("close", resolve)));
  const lines = children.map(child => createInterface({ input: child.stdout })[Symbol.asyncIterator]());
  const answers = () => Promise.all(lines.map(async line => {
    const next = await line.next();
    return next.done ? "exited" : String(next.value);
  }));
  try {
    ctx.check((await answers()).every(answer => answer === "ready"), "racer-not-ready");
    const stored = new Set<string>();
    for (let trial = 0; trial < TRIALS; trial++) {
      const store = join(ctx.root, "state", `race-${trial}.db`);
      // Every racer waits idle at its read, so all of them open the new store at once.
      for (const child of children) child.stdin.write(`open ${store}\n`);
      const custody = await answers();
      const db = new Database(store, { readonly: true });
      let persisted: unknown;
      try { persisted = db.query<{ custody_id: unknown }, []>("SELECT custody_id FROM manifold_custody WHERE id = 1").get()?.custody_id; }
      finally { db.close(); }
      ctx.check(typeof persisted === "string" && custody.every(answer => answer === persisted), "racing-opens-disagree");
      stored.add(persisted);
    }
    ctx.check(stored.size === TRIALS, "racing-stores-share-custody");
  } finally {
    for (const child of children) child.stdin.end();
  }
  ctx.check((await Promise.all(exited)).every(code => code === 0), "racer-failed");
});
