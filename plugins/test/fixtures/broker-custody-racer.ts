import { createInterface } from "node:readline";
import { setTransports } from "@oh-my-pi/pi-utils/logger";

// One broker process of a first-open race. It loads the broker storage, answers `ready`, and
// for every `open <path>` line opens that store, closes it and answers its custody id (or
// `error`), so every answer means the store is at rest. Stdin's end, the parent's included,
// ends the process.
setTransports({ file: false, console: false });
// Loaded after the logging barrier, as the broker entry loads it.
const { NativeBrokerStorage } = await import("../../workers/broker/storage.ts");
const refreshOAuthCredential = async (): Promise<never> => { throw new Error("Unexpected synthetic refresh"); };
process.stdout.write("ready\n");
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.startsWith("open ")) { process.stdout.write("error\n"); continue; }
  try {
    const storage = await NativeBrokerStorage.create(line.slice(5), { refreshOAuthCredential });
    storage.close();
    process.stdout.write(`${storage.custodyId}\n`);
  } catch {
    process.stdout.write("error\n");
  }
}
