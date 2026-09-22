import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { forwardOmpOutput, OmpProgressObserver, OMP_PROGRESS_FRAME_BYTES, type ReportOmpProgress } from "../workers/harness/progress.ts";

type Progress = Parameters<ReportOmpProgress>[0];
const line = (event: unknown) => Buffer.from(`${JSON.stringify(event)}\n`);
const start = { type: "message_start", message: { role: "assistant", content: [], stopReason: "stop" } };

test("only observed assistant streams enter the model stage; lifecycle ends clear it without disclosing event fields", () => {
  const progress: Progress[] = [];
  const observer = new OmpProgressObserver(value => progress.push(value));
  observer.observe(line({ type: "session", timestamp: 123, calls: 55 }));
  observer.observe(line({ type: "message_start", message: { role: "user", content: "private prompt" } }));
  expect(progress).toEqual([]);
  observer.observe(line({ type: "turn_start" }));
  observer.observe(line({ ...start, message: { ...start.message, stopReason: "aborted", errorMessage: "private gate refusal" } }));
  observer.observe(line({ ...start, message: { ...start.message, stopReason: "error", errorMessage: "private provider diagnostic" } }));
  expect(progress.map(value => value.stage)).toEqual(["running"]);
  observer.observe(line(start));
  observer.observe(line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "private response" } }));
  observer.observe(line({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } }));
  expect(progress.map(value => value.stage)).toEqual(["running", "at the model"]);
  observer.observe(line({ type: "message_end", message: { role: "assistant", content: "private response" } }));
  observer.observe(line({ type: "tool_execution_start", toolName: "private tool", args: { password: "private argument" } }));
  observer.observe(line({ type: "tool_execution_end", result: "private output" }));
  observer.observe(line({ type: "message_end", message: { role: "toolResult", content: "private output" } }));
  observer.observe(line(start));
  observer.observe(line({ type: "message_update", assistantMessageEvent: { type: "error", reason: "private failure" } }));
  observer.observe(line({ type: "agent_end", messages: ["private transcript"] }));
  observer.end();
  expect(progress).toEqual([
    { stage: "running", message: "OMP lifecycle continuing." },
    { stage: "at the model", message: "Assistant stream started." },
    { stage: "running", message: "OMP lifecycle continuing." },
    { stage: "running tools", message: "Tool lifecycle observed." },
    { stage: "running", message: "OMP lifecycle continuing." },
    { stage: "at the model", message: "Assistant stream started." },
    { stage: "running", message: "OMP lifecycle continuing." },
    { stage: "finishing", message: "Agent turn ended." },
    { stage: "stopped", message: "OMP output ended." },
  ]);
});

test("frame limit is inclusive across fragmented UTF-8 and overflow cannot leave a stale model claim", () => {
  const progress: Progress[] = [];
  const observer = new OmpProgressObserver(value => progress.push(value));
  const prefix = Buffer.from('{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"stop"},"ignored":"é');
  const suffix = Buffer.from('"}\r');
  const boundary = Buffer.concat([prefix, Buffer.alloc(OMP_PROGRESS_FRAME_BYTES - prefix.length - suffix.length, 120), suffix]);
  for (let offset = 0; offset < boundary.length; offset += 1) observer.observe(boundary.subarray(offset, offset + 1));
  expect(progress).toEqual([]);
  observer.observe(Buffer.from("\n"));
  expect(progress.map(value => value.stage)).toEqual(["at the model"]);
  observer.observe(Buffer.from('{"type":"message_end","message":{"role":"assistant","content":"'));
  const largeChunk = Buffer.alloc(997, 120);
  for (let count = 0; count < 2000; count++) observer.observe(largeChunk);
  expect(progress.at(-1)).toEqual({ stage: "running", message: "OMP stage unavailable." });
  observer.observe(Buffer.from('"}}\n'));
  observer.observe(line(start));
  expect(progress.map(value => value.stage)).toEqual(["at the model", "running", "at the model"]);
  // An unterminated event is never accepted, even when syntactically complete.
  observer.observe(Buffer.from('{"type":"agent_end"}'));
  observer.end();
  expect(progress.at(-1)).toEqual({ stage: "stopped", message: "OMP output ended." });
});

test("malformed, non-JSON and invalid UTF-8 frames lose observation and recover at the next record", () => {
  const progress: Progress[] = [];
  const observer = new OmpProgressObserver(value => progress.push(value));
  for (const malformed of [Buffer.from('{"type":"message_end",}\n'), Buffer.from("not JSON\n"), Buffer.from("null\n"), Buffer.from([0xff, 10])]) {
    observer.observe(line(start));
    observer.observe(malformed);
    expect(progress.at(-1)).toEqual({ stage: "running", message: "OMP stage unavailable." });
  }
  observer.observe(line({ type: "tool_execution_start" }));
  observer.observe(Buffer.alloc(OMP_PROGRESS_FRAME_BYTES + 1, 120));
  expect(progress.at(-1)).toEqual({ stage: "running", message: "OMP stage unavailable." });
  observer.observe(Buffer.from("\n"));
  observer.observe(line(start));
  expect(progress.at(-1)?.stage).toBe("at the model");
});

test("relay preserves every byte, waits for a blocked destination, and does not end parent stdout", async () => {
  const bytes = Buffer.concat([line(start), Buffer.alloc(2 * OMP_PROGRESS_FRAME_BYTES + 1, 120), Buffer.from('\n{"type":"agent_end"}\n'), Buffer.from([0xff, 0, 13])]);
  const chunks = [bytes.subarray(0, 97), bytes.subarray(97, 400), bytes.subarray(400)];
  const received: Buffer[] = [];
  let release: (() => void) | undefined;
  const blocked = Promise.withResolvers<void>();
  const destination = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    received.push(Buffer.from(chunk));
    if (received.length === 1) { release = callback; blocked.resolve(); }
    else callback();
  } });
  let settled = false;
  const source = new Readable({ read() {} });
  source.push(chunks[0]);
  const forwarding = forwardOmpOutput(source, destination, () => {
    throw new Error("private reporting failure");
  }, new AbortController().signal).then(() => { settled = true; });
  await blocked.promise;
  expect(settled).toBe(false);
  expect(Buffer.concat(received)).toEqual(chunks[0]);
  source.push(chunks[1]);
  source.push(chunks[2]);
  source.push(null);
  release!();
  await forwarding;
  expect(Buffer.concat(received)).toEqual(bytes);
  expect(destination.writableEnded).toBe(false);
  destination.end();
});

test("relay leaves child exit status intact and drains its final bytes", async () => {
  const bytes = Buffer.concat([line(start), Buffer.from('not-json\n'), line({ type: "agent_end" })]);
  const child = spawn(process.execPath, ["-e", `process.stdout.write(Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64"), () => process.exit(7))`], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const received: Buffer[] = [];
  const progress: Progress[] = [];
  const destination = new Writable({ write(chunk, _encoding, callback) { received.push(Buffer.from(chunk)); callback(); } });
  await forwardOmpOutput(child.stdout!, destination, value => progress.push(value), new AbortController().signal);
  expect(await exited).toBe(7);
  expect(Buffer.concat(received)).toEqual(bytes);
  expect(progress.at(-1)?.stage).toBe("stopped");
  destination.end();
});

test("a failed destination closes the child read pipe rather than hanging the relay", async () => {
  const source = Readable.from([line(start), Buffer.alloc(OMP_PROGRESS_FRAME_BYTES, 120)]);
  const destination = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("broken stdout")); } });
  await expect(forwardOmpOutput(source, destination, () => {}, new AbortController().signal)).rejects.toThrow();
  expect(source.destroyed).toBe(true);
});

test("cancellation does not wait for a blocked stdout write or close parent stdout", async () => {
  const controller = new AbortController();
  const source = new Readable({ read() {} });
  source.push(line(start));
  const blocked = Promise.withResolvers<void>();
  let release: (() => void) | undefined;
  const destination = new Writable({ write(_chunk, _encoding, callback) {
    release = callback;
    blocked.resolve();
  } });
  const forwarding = forwardOmpOutput(source, destination, () => {}, controller.signal);
  await blocked.promise;
  const rejected = expect(forwarding).rejects.toThrow("harness_cancelled");
  controller.abort();
  await rejected;
  expect(source.destroyed).toBe(true);
  expect(destination.destroyed).toBe(false);
  expect(destination.writableEnded).toBe(false);
  release!();
  destination.end();
});
