import { test } from "bun:test";
import { runIsolatedSdkScenario } from "./fixtures/isolated-sdk.ts";

test("two auth-recovery refreshes of one OAuth row mint one token, as the stock broker's do", async () => {
  await runIsolatedSdkScenario(new URL("./fixtures/broker-mint-reuse.scenario.ts", import.meta.url));
}, 30_000);
