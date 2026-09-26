import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AGENT_TOOL_MAX_CALLS,
  AGENT_TOOL_MAX_REQUEST_BYTES,
  WORKER_MAX_PENDING,
  AcknowledgeAgentPolicyRequestSchema,
  AgentToolRequestSchema,
  agentToolName,
  type AgentToolReply,
  type AgentToolRequest,
} from "@manifold/protocol";
import type { TJsonSchema } from "@oh-my-pi/pi-ai";
import type { CreateAgentSessionResult, CustomTool, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import {
  AgentToolParentMessageSchema,
  type AgentToolChildMessage,
} from "../agent-tools-ipc.ts";

export interface AgentToolAdapter {
  tools: CustomTool<TJsonSchema, AgentToolReply>[];
  extension: ExtensionFactory;
  assertRegistry(result: CreateAgentSessionResult): void;
  close(): void;
}

type UnknownReason = Extract<AgentToolReply, { type: "unknown" }>["reason"];
type RefusalCode = Extract<AgentToolReply, { type: "refused" }>["code"];
type ExpectedReply = { type: "describe" | "policy" | "ack" } | { type: "invoke"; door: string };
interface PendingCall {
  resolve(reply: AgentToolReply): void;
  cleanup(): void;
}

const reservedNames = ["manifold", "manifold_policy", "manifold_ack_policy"];
const emptyParameters = z.strictObject({});
const refuse = (code: RefusalCode): AgentToolReply => ({ type: "refused", code, traceId: null });
const uncertain = (reason: UnknownReason): AgentToolReply => ({ type: "unknown", reason, traceId: null });

// This channel is private to the native parent. Once send is attempted, only the
// parent can prove non-dispatch; a local transport failure must remain unknown.
class AgentToolClient {
  private readonly pending = new Map<string, PendingCall>();
  private readonly remembered = new Map<string, ExpectedReply>();
  private stopped: UnknownReason | undefined;

  constructor(private readonly runId: string, private readonly signal: AbortSignal) {
    if (signal.aborted) {
      this.stopped = "cancelled";
    } else if (!process.send || !process.connected) {
      this.stopped = "disconnected";
    } else {
      process.on("message", this.receive);
      process.on("disconnect", this.disconnected);
      process.on("error", this.disconnected);
      signal.addEventListener("abort", this.aborted, { once: true });
    }
  }

  assertOpen(): void {
    if (this.stopped !== undefined) throw new Error(`omp_agent_tools_${this.stopped}`);
  }

  call(raw: AgentToolRequest, signal?: AbortSignal): Promise<AgentToolReply> {
    if (signal?.aborted || this.signal.aborted) return Promise.resolve(refuse("cancelled"));
    if (this.stopped !== undefined) return Promise.resolve(refuse("binding_unavailable"));
    const parsed = AgentToolRequestSchema.safeParse(raw);
    if (!parsed.success) return Promise.resolve(refuse("malformed_request"));
    if (this.pending.size >= WORKER_MAX_PENDING) return Promise.resolve(refuse("saturated"));
    if (this.remembered.size >= AGENT_TOOL_MAX_CALLS) return Promise.resolve(refuse("limit_exceeded"));
    const request = parsed.data;
    const id = randomUUID();
    if (this.remembered.has(id)) {
      this.finish("protocol_error", true);
      return Promise.resolve(refuse("binding_unavailable"));
    }
    const expected: ExpectedReply = request.type === "invoke"
      ? { type: "invoke", door: request.door }
      : { type: request.type };
    const { promise, resolve } = Promise.withResolvers<AgentToolReply>();
    const cancel = () => {
      if (!this.pending.has(id)) return;
      this.settle(id, uncertain("cancelled"));
      this.send({ type: "agent_tool_cancel", id });
    };
    this.remembered.set(id, expected);
    this.pending.set(id, {
      resolve,
      cleanup: () => signal?.removeEventListener("abort", cancel),
    });
    signal?.addEventListener("abort", cancel, { once: true });
    this.send({ type: "agent_tool_call", id, request });
    return promise;
  }

  close(): void {
    this.finish("interrupted", true);
  }

  private send(message: AgentToolChildMessage): void {
    try {
      if (!process.send || !process.connected) {
        this.finish("disconnected", false);
        return;
      }
      // false is backpressure, not a failed send. Only the callback is an ack.
      process.send(message, error => {
        if (error) this.finish("disconnected", false);
      });
    } catch {
      this.finish("disconnected", false);
    }
  }

  private matches(expected: ExpectedReply, reply: AgentToolReply): boolean {
    if (reply.type === "refused" || reply.type === "unknown") return true;
    switch (expected.type) {
      case "describe": return reply.type === "description" && reply.runId === this.runId;
      case "policy": return reply.type === "policy" && reply.policy.runId === this.runId;
      case "ack": return reply.type === "result" && reply.door === "core.access.acknowledgeAgentPolicy";
      case "invoke": return reply.type === "result" && reply.door === expected.door;
    }
  }

  private readonly receive = (raw: unknown): void => {
    if (this.stopped !== undefined) return;
    try {
      const parsed = AgentToolParentMessageSchema.safeParse(raw);
      if (!parsed.success) {
        this.finish("protocol_error", true);
        return;
      }
      const { id, reply } = parsed.data;
      const expected = this.remembered.get(id);
      if (!expected || !this.matches(expected, reply)) {
        this.finish("protocol_error", true);
        return;
      }
      // Only a well-formed, correctly correlated reply for our bounded set of
      // completed/cancelled calls may be ignored. Never replay an effect.
      if (this.pending.has(id)) this.settle(id, reply);
    } catch {
      this.finish("protocol_error", true);
    }
  };

  private readonly disconnected = (): void => { this.finish("disconnected", false); };
  private readonly aborted = (): void => { this.finish("cancelled", true); };

  private settle(id: string, reply: AgentToolReply): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    pending.resolve(reply);
  }

  private finish(reason: UnknownReason, cancel: boolean): void {
    if (this.stopped !== undefined) return;
    this.stopped = reason;
    process.removeListener("message", this.receive);
    process.removeListener("disconnect", this.disconnected);
    process.removeListener("error", this.disconnected);
    this.signal.removeEventListener("abort", this.aborted);
    for (const id of this.pending.keys()) {
      if (cancel) this.send({ type: "agent_tool_cancel", id });
      this.settle(id, uncertain(reason));
    }
    this.remembered.clear();
  }
}

function checkParameters(parameters: TJsonSchema): void {
  // The SDK accepts raw JSON Schema. Keep the host's object and its references
  // intact rather than rebuilding a wrapper schema around the action arguments.
  if ((parameters.type !== undefined && parameters.type !== "object") ||
    (parameters.properties !== undefined &&
      (typeof parameters.properties !== "object" || parameters.properties === null || Array.isArray(parameters.properties))) ||
    (parameters.required !== undefined &&
      (!Array.isArray(parameters.required) || !parameters.required.every(key => typeof key === "string")))) {
    throw new Error("omp_agent_tools_parameters_invalid");
  }
}

export async function loadAgentTools(expectedRunId: string, signal: AbortSignal): Promise<AgentToolAdapter> {
  const client = new AgentToolClient(expectedRunId, signal);
  try {
    const description = await client.call({ type: "describe" });
    if (description.type !== "description" || description.runId !== expectedRunId) {
      const reason = description.type === "refused" ? description.code
        : description.type === "unknown" ? description.reason : "description_invalid";
      throw new Error(`omp_agent_tools_${reason}`);
    }
    const names = new Set(reservedNames);
    const doors = new Set<string>();
    for (const descriptor of description.tools) {
      if (descriptor.name !== agentToolName(descriptor.door)) throw new Error("omp_agent_tools_name_invalid");
      if (names.has(descriptor.name) || doors.has(descriptor.door)) {
        throw new Error("omp_agent_tools_duplicate_descriptor");
      }
      checkParameters(descriptor.parameters);
      names.add(descriptor.name);
      doors.add(descriptor.door);
    }
    for (const unavailable of description.unavailable) {
      if (doors.has(unavailable.door)) throw new Error("omp_agent_tools_duplicate_descriptor");
      doors.add(unavailable.door);
    }

    const prepared = new Map<string, { name: string; args: unknown }>();
    const consume = (id: string, name: string) => {
      const call = prepared.get(id);
      prepared.delete(id);
      return call?.name === name ? call : undefined;
    };
    let registry: CreateAgentSessionResult | undefined;
    const assertRegistry = (result: CreateAgentSessionResult): void => {
      try {
        client.assertOpen();
        // SDK customTools are separate from these public extension maps. Any
        // ambient entry here is a collision, even if SDK precedence hides it.
        for (const extension of result.extensionsResult.extensions) {
          for (const [name, tool] of extension.tools) {
            if (names.has(name) || names.has(tool.definition.name)) {
              throw new Error("omp_agent_tools_registry_collision");
            }
          }
        }
        if (!registry) {
          const agent = result.session.agent;
          const previous = agent.beforeToolCall;
          agent.beforeToolCall = async (context, signal) => {
            const name = context.tool.name;
            if (!names.has(name)) return previous?.(context, signal);
            if (prepared.has(context.toolCall.id) || prepared.size >= WORKER_MAX_PENDING)
              return { block: true, reason: "Manifold tool preparation limit reached." };
            // The public SDK hook retains the original model JSON, while its
            // args/execute parameters may be coerced, defaulted or clamped.
            // Preserve the original for the authoritative host validator rather
            // than dispatching repaired input or rejecting valid host defaults.
            const serialized = JSON.stringify(context.toolCall.arguments);
            if (typeof serialized !== "string" || Buffer.byteLength(serialized) > AGENT_TOOL_MAX_REQUEST_BYTES)
              return { block: true, reason: "Manifold tool arguments exceed the request limit." };
            const args: unknown = JSON.parse(serialized);
            const prior = await previous?.(context, signal);
            if (prior?.block) return prior;
            if (prior?.args !== undefined || !isDeepStrictEqual(args, context.toolCall.arguments))
              return { block: true, reason: "Manifold tool arguments cannot be rewritten by an extension." };
            // A later extension handler may have changed the registry after our
            // tool_call handler ran. Recheck before retaining executable input.
            guard();
            prepared.set(context.toolCall.id, { name, args });
            return prior;
          };
        }
        registry = result;
      } catch (error) {
        client.close();
        prepared.clear();
        throw error;
      }
    };
    const guard = (): void => {
      if (!registry) {
        client.close();
        throw new Error("omp_agent_tools_registry_unchecked");
      }
      assertRegistry(registry);
    };
    const extension: ExtensionFactory = api => {
      // A late extension can replace a name and bypass our tool's execute
      // closure. The public pre-call hook also fences that replacement.
      api.on("tool_call", () => {
        try { guard(); }
        catch { return { block: true, reason: "Manifold tool registry or private channel is no longer valid." }; }
      });
    };
    const present = (reply: AgentToolReply) => ({
      content: [{ type: "text" as const, text: JSON.stringify(reply) }],
      details: reply,
    });
    const tools: AgentToolAdapter["tools"] = description.tools.map(descriptor => ({
      name: descriptor.name,
      label: descriptor.title,
      description: descriptor.title,
      parameters: descriptor.parameters,
      loadMode: "essential",
      async execute(id, _params, _onUpdate, _context, executionSignal) {
        guard();
        const call = consume(id, descriptor.name);
        if (!call) return present(refuse("malformed_request"));
        return present(await client.call({ type: "invoke", door: descriptor.door, args: call.args }, executionSignal));
      },
    }));
    tools.push({
      name: "manifold_policy",
      label: "Manifold policy",
      description: "Read the bound run's current policy, exact revision and required acknowledgement digests. This does not acknowledge policy.",
      parameters: z.toJSONSchema(emptyParameters),
      loadMode: "essential",
      async execute(id, _params, _onUpdate, _context, executionSignal) {
        guard();
        const call = consume(id, "manifold_policy");
        if (!call || !emptyParameters.safeParse(call.args).success) return present(refuse("malformed_request"));
        return present(await client.call({ type: "policy" }, executionSignal));
      },
    }, {
      name: "manifold_ack_policy",
      label: "Acknowledge Manifold policy",
      description: "Explicitly acknowledge the exact policy revision and each required id/digest after reading and accepting them. Never infer acknowledgement from an action result.",
      parameters: z.toJSONSchema(AcknowledgeAgentPolicyRequestSchema),
      loadMode: "essential",
      async execute(id, _params, _onUpdate, _context, executionSignal) {
        guard();
        const call = consume(id, "manifold_ack_policy");
        const policy = AcknowledgeAgentPolicyRequestSchema.safeParse(call?.args);
        if (!policy.success) return present(refuse("malformed_request"));
        return present(await client.call({ type: "ack", policy: policy.data }, executionSignal));
      },
    });
    client.assertOpen();
    return { tools, extension, assertRegistry, close: () => { prepared.clear(); client.close(); } };
  } catch (error) {
    client.close();
    throw error;
  }
}
