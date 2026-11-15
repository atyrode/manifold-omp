// Child process of rpc-input.test.ts: its stdin is a real pipe the test keeps open, so only
// cancellation (never EOF) can end the claimed RPC input.
import { claimRpcInput } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-input";
import { cancellableRpcInput } from "../rpc-input.ts";

const mode = process.argv[2];
if (mode !== "preaborted" && mode !== "constructed" && mode !== "pending") throw new Error("rpc input driver mode");
let unhandled = 0;
process.on("unhandledRejection", () => { unhandled++; });
const controller = new AbortController();
const reason = new Error("driver cancellation");
// Before construction: the wrapper's start observes an aborted signal.
if (mode === "preaborted") controller.abort(reason);
// The exact stream the public claim returned, held so its own lock state can be observed.
const source = claimRpcInput();
const cancellable = cancellableRpcInput(source, controller.signal);
// After construction, before any consumer: the listener start installed must error the unread input.
if (mode === "constructed") controller.abort(reason);
const reader = cancellable.input.getReader();
let frame: string | undefined;
if (mode === "pending") {
  const first = await reader.read();
  frame = first.done ? undefined : new TextDecoder().decode(first.value);
}
const read = reader.read();
let parked = false;
if (mode === "pending") {
  // Cancel only once the read is parked on the open pipe. Real pipe I/O has no fake clock and a parked
  // read has no event, so a short real wait precedes the observed `parked` fact the test asserts.
  let early = false;
  void read.then(() => { early = true; }, () => { early = true; });
  await Bun.sleep(50);
  parked = !early;
  controller.abort(reason);
}
let identity = false;
let settled: string;
try {
  settled = (await read).done ? "eof" : "data";
} catch (error) {
  settled = "rejected";
  identity = error === reason;
}
// The release outcome resolves only after the claim's cancel settled (releasing Bun's stdin reader) and
// the wrapper unlocked `source`: an unlocked source that a new reader can take proves that inner release.
const release = await cancellable.released;
const unlocked = !source.locked;
// Throws, failing the test by exit code, if `source` was still held.
source.getReader().releaseLock();
// Leave a macrotask turn for any unobserved rejection to surface before reporting.
const turn = Promise.withResolvers<void>();
setImmediate(turn.resolve);
await turn.promise;
console.log(JSON.stringify({ frame, parked, settled, identity, release: release.ok, unlocked, unhandled }));
process.exit(0);
