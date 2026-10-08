import { test } from "bun:test";
import { runIsolatedSdkScenario } from "./fixtures/isolated-sdk.ts";

test("a broker store keeps its custody id across restarts and loses it with a purge or a replaced database", async () => {
  await runIsolatedSdkScenario(new URL("./fixtures/broker-custody.scenario.ts", import.meta.url));
}, 30_000);
