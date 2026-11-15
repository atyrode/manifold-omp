import { join } from "node:path";
import { expect, test } from "bun:test";

const driver = join(import.meta.dir, "rpc-input-driver.ts");

// Each child reads a real stdin pipe this test never closes: the claimed input can end only by cancellation.
async function cancelRealStdin(mode: "preaborted" | "constructed" | "pending", frame?: string) {
  const child = Bun.spawn([process.execPath, driver, mode], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  try {
    if (frame !== undefined) {
      child.stdin.write(frame);
      child.stdin.flush();
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    let exit: number;
    try { exit = await child.exited; } finally { clearTimeout(timer); }
    expect(child.signalCode).toBeNull();
    expect(exit).toBe(0);
    return JSON.parse(await new Response(child.stdout).text());
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

test("cancellation before construction errors RPC input with the exact reason and releases stdin", async () => {
  expect(await cancelRealStdin("preaborted")).toEqual({
    parked: false, settled: "rejected", identity: true, release: true, unlocked: true, unhandled: 0,
  });
});

test("cancellation after construction, before any consumer, errors unread RPC input and releases stdin", async () => {
  expect(await cancelRealStdin("constructed")).toEqual({
    parked: false, settled: "rejected", identity: true, release: true, unlocked: true, unhandled: 0,
  });
});

test("cancellation during a parked read on open stdin errors RPC input with the exact reason, never EOF", async () => {
  const frame = `${JSON.stringify({ id: "before", type: "get_state" })}\n`;
  expect(await cancelRealStdin("pending", frame)).toEqual({
    frame, parked: true, settled: "rejected", identity: true, release: true, unlocked: true, unhandled: 0,
  });
});
