import { test } from "bun:test";
import { runIsolatedSdkScenario } from "./fixtures/isolated-sdk";

test("real broker preserves native and old-client authorization while refusing invalid verifiers and occupied fixed ports", async () => {
  await runIsolatedSdkScenario(new URL("./fixtures/broker-ingress.scenario.ts", import.meta.url));
}, 30_000);
