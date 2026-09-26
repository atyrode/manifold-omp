import type { PublicJob } from "@manifold/protocol";
import type { ActionInput, ActionResult } from "../api/index.ts";

/** Verification-only composition boundary; never loaded by the published runtime. */
export interface NativeToolConsumerContext {
  root: string;
  hub: { url: string; ownerKey: string };
  target: { machineId: string; containerId: string };
  installed: string[];
  input: ActionInput<"reviewSession">;
  accounts: ActionResult<"accounts">;
}
export interface NativeToolConsumer {
  input: ActionInput<"reviewSession">;
  originDoor: string;
  runSession(input: ActionInput<"runSession">): Promise<PublicJob>;
  readSession(input: ActionInput<"readSession">): Promise<ActionResult<"readSession">>;
  cancelSession(input: ActionInput<"cancelSession">): Promise<ActionResult<"cancelSession">>;
}
export interface NativeToolConsumerModule {
  createNativeToolConsumer(context: NativeToolConsumerContext): Promise<NativeToolConsumer>;
}
