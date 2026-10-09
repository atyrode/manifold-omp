import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { parseSessionArchive } from "../../api/session.ts";
import { createSessionFile, listSessionSummaries, openSessionsRoot } from "../../workers/harness/sessions.ts";
import { ustar } from "../../test/fixtures/ustar.ts";

const cwd = "/home/job/workspace";
const assistant = (text: string, stopReason: AssistantMessage["stopReason"], total: number, errorMessage?: string): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic",
  model: "claude-haiku-5-5", stopReason, timestamp: Date.now(), ...(errorMessage ? { errorMessage } : {}),
  usage: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2, totalTokens: 33,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } },
});

/** The transcript the pinned SDK itself writes, not a hand-made fixture of an older one. */
async function transcript(write: (manager: SessionManager) => void): Promise<{ id: string; name: string; body: string }> {
  const directory = mkdtempSync(join(tmpdir(), "omp-session-records-"));
  const manager = SessionManager.create(cwd, directory);
  try {
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "summarise the repository" }], timestamp: Date.now() });
    write(manager);
    await manager.flush();
    const file = manager.getSessionFile()!;
    return { id: manager.getSessionId(), name: basename(file), body: readFileSync(file, "utf8") };
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the pinned SDK's transcript reads back as the receipt the session door seals", async () => {
  const written = await transcript(manager => {
    manager.appendMessage(assistant("first turn", "stop", 0.25));
    manager.appendMessage(assistant("the repository builds one plugin", "stop", 0.5));
  });
  expect(parseSessionArchive(ustar([[written.name, written.body]]), "/outputs/session", 0, "anthropic/claude-haiku-5-5")).toEqual({
    sessionId: written.id, sessionPath: `/outputs/session/${written.name}`, model: "anthropic/claude-haiku-5-5",
    finalMessage: "the repository builds one plugin",
    usage: { input: 20, output: 40, cacheRead: 2, cacheWrite: 4, cost: 0.75 },
    exitCode: 0, failure: null, configuredModel: "anthropic/claude-haiku-5-5",
  });
});

test("the pinned SDK's last errored turn is the receipt's failure", async () => {
  const written = await transcript(manager => manager.appendMessage(assistant("", "error", 0, "model_not_found")));
  expect(parseSessionArchive(ustar([[written.name, written.body]]), "/outputs/session", 1, "anthropic/claude-haiku-5-5"))
    .toMatchObject({ sessionId: written.id, finalMessage: "", failure: "model_not_found" });
});

test("a launcher-created header opens in the pinned SDK as that session, and its journal lists it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-session-header-"));
  const id = randomUUID();
  try {
    // The job's workspace exists where the SDK host opens it; the SDK reads a missing cwd as the process's.
    const root = openSessionsRoot(directory);
    let name: string;
    try { name = createSessionFile(root, id, directory); }
    finally { closeSync(root); }
    const manager = await SessionManager.open(join(directory, name), directory, undefined, { throwIfMissing: true });
    try {
      expect([manager.getSessionId(), manager.getSessionFile(), manager.getCwd(), manager.getEntries().length])
        .toEqual([id, join(directory, name), directory, 0]);
      manager.appendMessage(assistant("resumed", "stop", 0));
      await manager.flush();
    } finally { await manager.close(); }
    const listing = openSessionsRoot(directory);
    try { expect(listSessionSummaries(listing).map(session => session.id)).toEqual([id]); }
    finally { closeSync(listing); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
