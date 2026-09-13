import { ServicePolicySchema, type ServiceOperationPolicy, type ServicePolicy, type ServiceProxyOperationPolicy, type ServiceRuntime } from "@manifold/protocol";
import { BROKER_OPERATION_ID, BROKER_SERVICE_ID, ACCOUNTS_PLUGIN_ID } from "../api/index.ts";

const capabilities = { "omp-auth-broker-capabilities": "codex-meter-block-scopes" };
const stringInput = (maxBytes: number, required = true): ServiceOperationPolicy["input"][string] =>
  ({ type: "string", required, maxBytes });
function projected(method: ServiceOperationPolicy["method"], path: string, fields: string[][]): ServiceOperationPolicy {
  return { method, path, input: {}, query: {}, body: [], timeoutMs: 60_000,
    maxRequestBytes: 65_536, maxResponseBytes: 4 * 1024 * 1024, maxResultBytes: 96 * 1024,
    response: { kind: "projected-json", fields, maxArrayItems: 1024 } };
}
function proxy(method: ServiceProxyOperationPolicy["method"], path: string,
  request: ServiceProxyOperationPolicy["request"] = { kind: "none" }): ServiceProxyOperationPolicy {
  return { kind: "http-proxy", method, path, request,
    response: { kind: "stream", disclosure: "full", contentTypes: ["application/json"], headers: [] },
    timeoutMs: 60_000, maxRequestBytes: 65_536, maxResponseBytes: 4 * 1024 * 1024 };
}
function credentialProxy(method: ServiceProxyOperationPolicy["method"], suffix: string,
  request: ServiceProxyOperationPolicy["request"] = { kind: "none" }): ServiceProxyOperationPolicy {
  return { ...proxy(method, `/v1/credential/{credentialId}/${suffix}`, request),
    pathParameters: { credentialId: { format: "positive-integer", maxBytes: 16 } } };
}

/** Native projects metadata before crossing into an OMP client. Raw broker routes remain
 * confined to governed worker bindings, never browser-readable operations. */
export function buildSharedBrokerPolicy(runtime: ServiceRuntime): ServicePolicy {
  if (runtime.scope !== "instance" || runtime.pluginId !== ACCOUNTS_PLUGIN_ID || runtime.operationId !== BROKER_OPERATION_ID)
    throw new Error("Invalid shared broker runtime");
  const metadata = projected("GET", "/v1/snapshot", [
    ["credentials", "*", "id"], ["credentials", "*", "provider"], ["credentials", "*", "identityKey"],
    ["credentials", "*", "credential", "type"], ["credentials", "*", "credential", "email"],
    ["credentials", "*", "blocks", "*", "blockScope"], ["credentials", "*", "blocks", "*", "blockedUntilMs"],
  ]);
  metadata.readable = true;
  metadata.requestHeaders = capabilities;
  // 18.1.14 /v1/usage has generatedAt and reports, not snapshot credentials or
  // health tombstones. Preserve identity/quota leaves consumed by normalizeBrokerUsage.
  const usage = projected("GET", "/v1/usage", [
    ["generatedAt"], ["reports", "*", "provider"], ["reports", "*", "fetchedAt"],
    ...["accountId", "email", "orgId"].map(key => ["reports", "*", "metadata", key]),
    ["reports", "*", "limits", "*", "id"],
    ["reports", "*", "limits", "*", "status"],
    ...["provider", "accountId", "orgId", "tier", "windowId"].map(key => ["reports", "*", "limits", "*", "scope", key]),
    ...["id", "resetsAt", "durationMs"].map(key => ["reports", "*", "limits", "*", "window", key]),
    ...["unit", "usedFraction", "remainingFraction", "used", "limit"].map(key => ["reports", "*", "limits", "*", "amount", key]),
    ["reports", "*", "resetCredits", "availableCount"],
    ["reports", "*", "resetCredits", "credits", "*", "expiresAt"],
    ["reports", "*", "resetCredits", "credits", "*", "status"],
  ]);
  usage.readable = true;
  usage.timeoutMs = 300_000;
  const clearBlocks = projected("DELETE", "/v1/credential/{credentialId}/blocks", [["ok"]]);
  clearBlocks.input = { credentialId: stringInput(16) };
  clearBlocks.invocable = true;
  const disable = projected("POST", "/v1/credential/{credentialId}/disable", [["ok"]]);
  disable.input = { credentialId: stringInput(16) };
  disable.body = [{ path: ["cause"], value: { literal: "disabled by user" } }];
  disable.invocable = true;

  // These full-disclosure operations are deliberately distinct from direct reads
  // and mutations. Only the gateway's service binding admits their operation IDs.
  const snapshot = proxy("GET", "/v1/snapshot");
  snapshot.query = { wait: { type: "number", required: false, min: 0, max: 30_000, integer: true } };
  snapshot.requestHeaders = { "omp-auth-broker-capabilities": { kind: "literal", value: capabilities["omp-auth-broker-capabilities"] },
    "if-none-match": { kind: "forward", required: false, maxBytes: 32 } };
  snapshot.response.headers = ["etag"];
  const snapshotStream = proxy("GET", "/v1/snapshot/stream");
  snapshotStream.requestHeaders = { "omp-auth-broker-capabilities": { kind: "literal", value: capabilities["omp-auth-broker-capabilities"] } };
  snapshotStream.response.contentTypes = ["text/event-stream"];
  snapshotStream.timeoutMs = 300_000;
  snapshotStream.maxResponseBytes = 256 * 1024 * 1024;
  const gatewayUsage = proxy("GET", "/v1/usage");
  gatewayUsage.timeoutMs = 300_000;
  const json = { kind: "json", disclosure: "full" } as const;
  return ServicePolicySchema.parse({ serviceId: BROKER_SERVICE_ID, revision: "1", runtime,
    maxConcurrent: 16, operations: { metadata, usage, "clear-blocks": clearBlocks, disable,
      "gateway-snapshot": snapshot, "gateway-snapshot-stream": snapshotStream, "gateway-usage": gatewayUsage,
      "gateway-refresh": credentialProxy("POST", "refresh"), "gateway-disable": credentialProxy("POST", "disable", json),
      "gateway-block": credentialProxy("POST", "block", json), "gateway-clear-blocks": credentialProxy("DELETE", "blocks"),
      "gateway-usage-stale": proxy("POST", "/v1/usage/stale"), "gateway-usage-observed": proxy("POST", "/v1/usage/observed", json),
    } });
}

export function buildGatewayPolicy(gateway: ServiceRuntime): ServicePolicy {
  const models = proxy("GET", "/v1/models");
  const stream = proxy("POST", "/v1/pi/stream", { kind: "json", disclosure: "full" });
  stream.response.contentTypes = ["application/json", "text/event-stream"];
  stream.timeoutMs = 300_000;
  stream.maxRequestBytes = 16 * 1024 * 1024;
  stream.maxResponseBytes = 256 * 1024 * 1024;
  return ServicePolicySchema.parse({ serviceId: "omp", revision: "1", runtime: gateway, maxConcurrent: 16, operations: { models, stream } });
}
