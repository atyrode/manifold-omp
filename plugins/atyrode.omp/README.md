# OMP session resumption

The `atyrode.omp` plugin owns OMP transcript discovery and terminal resumption. An operator does not need an Agent or an Agent Run credential to resume a conversation.

## Passive bundled model metadata

`atyrode.omp.readModelCatalog({ providers })` is a container-read action with no delegated native authority. The required `providers` array contains at most 64 exact provider identifiers; an empty array selects no rows. Repeated providers are harmless, request order does not affect output, and unsupported or differently cased providers return no rows rather than aliasing another provider. Reserved object-property identifiers are rejected by the shared identifier schema.

The exported `ModelCatalogSnapshotSchema` / `ModelCatalogSnapshot` describes the reply:

```typescript
{
  schemaVersion: 1,
  source: "bundled",
  ompVersion: string,
  revision: string, // lowercase SHA-256 of the complete unfiltered snapshot
  models: InventoryModel[]
}
```

`InventoryModel` and `InventoryModelSchema` are the public model metadata shared by inventory receipts and this snapshot: exact `provider`, `id`, and `api`; `inputCostPerMillion` and `outputCostPerMillion`; nullable `contextWindow` and `maxTokens`; `reasoning`; ordered `thinkingLevels`; `images`; and `quotaTier`. Prices are the SDK's base per-million-token input/output rates, not a billing quote or a representation of cache prices or long-context tiers. Thinking levels come only from the SDK's baked supported-effort metadata: a reasoning model without a controllable effort surface has an empty ladder. Image support comes from its input modalities. Unknown limits remain null.

The required `quotaTier: string | null` is the pinned SDK's `quotaTierFor(provider, id)` classification. Inventory computes it from a build-time table baked from that same function, so a receipt and this snapshot classify an identity identically. It is a static quota-scope/display classification, not an account balance, entitlement, reset window or availability claim. For example, `openai-codex/gpt-5.3-codex-spark` has tier `spark`, while ordinary Codex chat models have tier `chat`; a provider/model without an SDK classification has null, never an inferred ordinary tier. Consumers can keep special lanes out of ordinary policy ladders without inspecting model-name substrings. Benchmark receipts are unchanged.

The build-time macro projects the actual package-pinned `@oh-my-pi/pi-catalog` 18.4.12 registry, using the ordinary inventory baseline `OMP_VERSION`, not the separately packaged SDK-host version. Only chat-kind rows (the rows `omp models --json` lists; OMP 18.4 also bundles image, speech, embedding and other runner models) representable by `InventoryModelSchema` cross this boundary, and only chat-kind rows are default probe identities: unrepresentable SDK routing aliases, sentinel/unknown prices and invalid limits are omitted, never relabeled, assigned guessed limits or made free. OMP model resolution folds case, so every member of a duplicate/case-colliding provider/model address group is also omitted, including API aliases; source order never chooses a winner. Such an omission does not establish that a provider or model is unsupported at runtime. Duplicate thinking levels fail packaging.

Rows are sorted by exact `provider/id` using code-unit order. `revision` is SHA-256 over native canonical JSON (sorted object keys, order-preserving arrays) of `{ schemaVersion, source, ompVersion, models }` for the complete projected registry before filtering, including every row's `quotaTier`. It changes with those metadata facts or the OMP version, not with provider selection, accounts or defaults. The action returns at most 16,384 models. Packaging refuses a complete snapshot over that bound or half the native isolate frame budget (currently 4 MiB); it never truncates. Every filtered reply is consequently bounded too.

```typescript
import { createOmpClient } from "@atyrode/manifold-omp";

const omp = createOmpClient(dispatch); // ordinary authorized container dispatch
const metadata = await omp.call("readModelCatalog", {
  providers: ["openai-codex", "anthropic", "deepseek"],
});
if ("refused" in metadata) throw new Error(metadata.refused);
// metadata.models is policy-preview input, not permission or evidence to execute.
```

This read needs no destination, accounts, configured broker/gateway, native installation or owner approval. The server filters embedded literal data only: no SDK runtime, secret, storage, file, network or job access occurs. The response is not an inventory receipt and has no observation timestamp, availability, reachability, account quota balance or benchmark claim. Explicit inventory/benchmark jobs and ordinary reviewed session admission remain separate requirements for runtime facts and execution.

## Operator doors

- **`atyrode.omp.listSessions`** — `{ machineId }` returns an array of `{ id, title, cwd, updatedAt }`. The UUID and cwd come from the transcript header, the title comes from OMP's title slot or legacy header, and `updatedAt` is the file's modification time in epoch milliseconds. No message body or filesystem transcript path is returned.
- **`atyrode.omp.resumeSession`** — `{ machineId, sessionId, containerId?, accountPool?, overlay?, skills?, automation?, overrides?: { model?, thinking? } }` returns `{ machineId, sessionId, runtime }`, where `runtime` is a native machine-only terminal descriptor. The session must already exist. Neither preparation nor the native worker creates a replacement transcript when the UUID is missing.

These names use the existing root-plugin camelCase convention (`prepareSession`, `prepareSignIn`); the SDK does not allow dotted local action names.

Both doors require workspace-wide operator/owner authority and the admitted machine operation's native permissions and consent. A container-scoped credential is refused. Runtime preparation does not create a terminal or confer terminal/container authority. If `containerId` is supplied it is checked, but the returned descriptor remains machine-only; terminal placement must independently authorize its actual destination.

### Defaults and explicit selection

Resume preserves the persisted exact model and configured thinking selector, including `auto`, unless explicitly overridden. A bare model-only override preserves thinking; a model selector's thinking suffix is explicit, and an explicit `thinking` field takes precedence over that suffix. A thinking-only override preserves the last-active model. Current defaults and top-level `overlay` replacements configure the sealed runtime and provider pool but cannot silently replace saved model/thinking. Explicit model and thinking records are required; assistant messages are not a substitute for missing selectors. Missing, ambiguous, unavailable or incompatible state refuses before inference. The SDK's actual model and configured selector are checked after construction, and explicit overrides are durably journaled. This is not generalized same-session settings-origin readback.

When `accountPool` is omitted, resume selects **currently enabled broker credentials only for providers referenced by that effective configuration** (model roles, fallback chains and task model overrides). Disabled credentials and unrelated providers are excluded. An explicit pool is honored exactly: it is never widened, and an empty or unavailable pool is refused. The broker and gateway must already be configured and available. Native security settings are sealed after the overlay is applied.

Preparation rechecks defaults, credential selection and runtime resource pins. Resource changes refuse the request instead of silently changing the prepared runtime. Credentials are not transcript metadata or Agent model-protocol fields.

### Typed caller

```typescript
import { createOmpClient } from "@atyrode/manifold-omp";

const omp = createOmpClient(dispatch); // your ordinary authorized dispatch transport
const sessions = await omp.call("listSessions", { machineId });
if ("refused" in sessions) throw new Error(sessions.refused);
const selected = sessions[0];
if (selected) {
  const prepared = await omp.call("resumeSession", {
    machineId,
    sessionId: selected.id,
  });
  if ("refused" in prepared) throw new Error(prepared.refused);
  // Pass prepared.runtime to native terminal placement with an authorized target.
}
```

## Transcript and runtime boundaries

Inventory uses a governed read-only job on the admitted owner, not the hub filesystem. It validates job provenance, held-directory/no-follow file access, regular-file/single-link identity and unique header UUIDs. It reads at most 16 KiB of each candidate's title/header prefix, admits at most 4,096 sessions and refuses inventory over 1 MiB rather than returning partial or truncated metadata. Titles are limited to 256 characters and cwd to 1,024 characters.

Ordinary fresh launches that preserve skill discovery retain the existing published CLI path. Explicit skill selection or disable-all, restricted launches and explicit resumes invoke a separately packaged SDK host in a sanitized child, without Run credentials or the private Agent control descriptor. Bun starts from trusted inputs with environment-file, automatic-install and workspace-bunfig loading disabled. Ordinary SDK resume still loads permitted project settings through the public settings API before applying the sealed runtime overlay. Public `SessionManager.open` and session context APIs inspect persisted state before constructing an agent; held-file identity is rechecked before construction. Operator resume uses exported `InteractiveMode` and renders the saved history; admitted ordinary Agent resume uses the publisher's concrete RPC mode and governed admission context. Cancellation reaches the child and SDK disposal; the parent retains its kill deadline. No resume failure falls through to a new session.

## Restricted automation

Session review, prepare, one-shot and operator resume accept `automation: { mode: "restricted", toolNames, delegation: "disabled" }`. The exported `RESTRICTED_TOOL_NAMES` deliberately supports only `read`, `grep`, `glob`, `bash`, `edit`, and `write`; names must be exact and unique. The native SDK's `restrictToolNames` enforces the registry. Unknown modes/tools, duplicate names and OMP task/advisor delegation requests refuse; no Code-side tool filter or alternate registry exists.

Review always returns effective `automation` (`{ mode: "ordinary" }` or the restricted policy) and binds it with skills into the digest. Omission is ordinary, including on resume: restrictions and optional skill selections are explicit per launch, not inferred from transcripts. Restricted mode disables ambient skills, rules, project context, extensions, custom tools, templates and slash discovery, MCP/LSP/IRC and OMP task/advisor spawning. Only deliberately selected sealed skills are loaded through `loadSkillsFromDir`; they remain instruction/resource content, not authority. Omitted or disabled restricted skills load none.

Restricted Agent harness admission refuses `omp_restricted_harness_unsupported`: its governed `manifold` host tool is outside the supported six-tool policy. Plan-YOLO, enabled task advisor/prewalk, enabled top-level advisor/prewalk and retry model fallback refuse `omp_restricted_delegation_unsupported` rather than forwarding to an unrestricted CLI. Passive task model routing remains configuration, not spawn authority. Agent resume with Plan-YOLO refuses `omp_resume_plan_unsupported` rather than ignoring that option. Restricted automation and strict resume require the exact SDK-aware OMP 18.4.12 deployment and named runtime inputs; incompatible owners refuse `omp_sdk_runtime_unsupported`.

This is SDK tool/discovery isolation, not an OS sandbox or a claim that every stock TUI command is locked down. Native process/filesystem/network authority still governs allowed tools. In particular, permitted `bash` can launch subprocesses, including another OMP process; `delegation: "disabled"` is not a shell-process ceiling.

## Reviewed optional skills

The OMP catalog is machine-scoped, owner-managed metadata, not a Code registry or a runtime downloader. `readSkillCatalog({ containerId, machineId })` returns `{ revision, skills, sets, updatedAt, updatedBy }`; empty catalogs start at revision zero. Reads authorize the target and return owner-published metadata even when a source later becomes unavailable, so an owner can repair or remove the entry. A metadata read grants no source access. Writes reauthorize every retained source's native read/export authority, same-machine placement and sealed digest; selection and preparation reauthorize the chosen sources again. Unavailable or changed selected sources refuse rather than being substituted.

`writeSkillCatalog({ machineId, expectedRevision, skills, sets })` requires workspace-wide root/owner authority and atomically compares the catalog revision. Catalogs admit at most 64 skills and 64 sets within the existing 64 KiB encoded storage ceiling. Entries contain `{ id, name, title, purpose, revision, source, license, review, conflicts, classification? }`. `source` is exactly `{ jobId, output, sha256 }`, naming one immutable governed sealed output, never a host path or a skill body. `license` is `{ spdx, url? }`; `review` is `{ reviewedBy, reviewedAt, reference }`, with epoch-millisecond review time. `conflicts` names other skill IDs. Sets contain `{ id, title, skillIds }`. Classification is descriptive (`core` or `optional`), never automatic activation or a permission grant.

Session review/prepare/run and operator resume accept an ephemeral `skills` choice:

- Omitted: preserve ordinary permitted core/project discovery, select no optional catalog entries.
- `{ mode: "select", expectedCatalogRevision, skillIds, setIds }`: resolve the union, deduplicate and sort by stable skill ID. Refuse missing IDs, stale catalogs, more than 15 selected entries, duplicate native names and declared conflicts.
- `{ mode: "disabled" }`: disable every native skill source using the published runtime's `--no-skills` semantics, including its `skill://` advertisements.

The native review's `skills` is `{ mode: "preserve" | "selected" | "disabled", catalogRevision, selected }`. It binds effective selection, metadata, source descriptors and revision into the review digest; it never asserts actual invocation. A generic client can use `skillInputBindings(review.skills)` to verify returned job bindings. Material bindings retain their existing behavior; selected slots are appended as `optionalSkill0` through `optionalSkill14`. Each slot mounts only its own reviewed output. Nonselected sources are never mounted.

Ordinary project skill filters remain authoritative and can suppress a selected optional source. A reviewed selection is not evidence that the ordinary runtime loaded or invoked it.

Each output must have exactly one top-level directory matching the reviewed native skill name, containing `SKILL.md` plus optional resources, scripts or references. Regular-file descendants are preserved; links, special files, extra roots and secondary `SKILL.md` identities refuse before OMP starts. Bounds are 16 MiB sealed input per skill, 4,096 regular files, 8,192 entries and 32 directory levels; `SKILL.md` itself is at most 1 MiB. The boundary uses OMP's published frontmatter parser to validate the reviewed identity; only OMP's native loader discovers and loads skills. Bodies are never copied into config, receipts or catalog metadata.

Skills never enter durable overlays/defaults or Agent profiles. A harness launch may supply the same choice in its `OmpHarnessTargetSchema` target; fresh independent launches start with no optional selection. Resume may supply a new explicit selection; no historical selection is guessed from transcript text. Restricted tools, broker ceilings and native OS/network authority are unchanged. Selection/disable requests require the exact hash-pinned published OMP 18.4.12 runtime and skill-aware immutable-input operation; older/incompatible owners refuse.

## Material-only one-shot execution

`reviewSession` and `runSession` accept optional `isolation: { mode: "material-only", file, sha256, bytes }`, validated by the exported `MaterialOnlyIsolationSchema`. `file` is one safe basename, `sha256` is the exact content hash, and positive `bytes` cannot exceed exported `MATERIAL_MAX_BYTES` (1 MiB). The review names exported `MATERIAL_SESSION_OPERATION_ID` (`atyrode.omp.material-session`), binds isolation into its digest and forces disabled skills and an empty restricted tool policy. Ordinary requests remain unchanged. Terminal preparation, harness/resume, selected optional skills, nonempty tool policies, existing-Run `agentTools`, Plan-YOLO and enabled advisor/prewalk/model fallback are not supported in this mode.

Run requires exactly one same-machine sealed input binding named `material`. The trusted SDK host opens that directory and the reviewed file without following links, admits one regular single-link file only, checks exact byte count and SHA-256 with stable held identities, and decodes fatal UTF-8 before model discovery. Extra entries, links, invalid encoding, size/hash mismatch and overrun refuse; nothing is truncated. Material is injected in memory alongside the trusted prompt, not through argv or the native input map. The composed prompt-and-material message is appended verbatim to the session as one user message and never passes through the SDK's prompt text processing, which would otherwise read `@path` mentions from the sandbox (including the gateway credential file), expand commands and templates, and add model-mention and keyword notices. The published print mode then runs the one turn from a fixed trigger message that contains no `@`, no leading `/` and no keyword; any other prompt refuses `omp_material_prompt_refused`. The prompt keeps its separate 44 KiB ceiling; the combined initial system, material and trigger messages have an explicit finite bound. The native archive allowance is 1 MiB + 2 KiB for the single-file ustar header, padding and terminator; the runtime still enforces the exact content bound.

The SDK registry is closed with `restrictToolNames: true`, zero names, no custom tools/extensions, no skills, rules, project context, templates, MCP/LSP/IRC or delegation. The trusted host also checks the constructed registry is empty before inference. Config, gateway capabilities and scratch auth storage are never included in model input. The actual source-bearing initial message **is retained in the SessionManager transcript** and follows the existing classified job-output discipline; receipts are not a promise to omit initial material.

The dedicated operation declares no shared workspace, sessions or runs mounts and no working directory. Its only writable persistent result is a fresh session output lease; scratch is private tmpfs. Read and cancel address the retained operation and exact input binding, never a caller-selected replacement. Cancellation still reaches the admitted job when non-identity result metadata is malformed.

**Native prerequisite:** this operation declares its runs backing location as `{ locationId: "atyrode.omp.runs", access: "write", outputOnly: true }`. Native output-lease-only admission ([Manifold #824](https://github.com/atyrode/manifold/issues/824)) retains the backing directory privately and exposes only the fresh named output lease, never the parent mount or a broad location capability. Older owners explicitly refuse this declaration; ordinary mounted-location fallback is not permitted. The native verifier exercises real sealed producer inputs, the packaged material worker and the governed synthetic model service, separately from the packaged SDK-host proof.

## One-shot model selection

A `runSession` job binds its model once, at startup, with nobody watching. Its posted configuration therefore scopes OMP's startup selection to exactly the configured `modelRoles.default`, as an exact-match `enabledModels` glob. A configured model the session's catalog lacks at that moment — a withdrawn id, a gateway that never answered discovery — ends the run before any model call; OMP no longer resolves a model whose id merely resembles it or falls back to the machine default. Every provider the one-shot registers waits up to 60 s for the gateway's model listing instead of OMP's 10 s default, so a slow gateway start still serves the configured model. A live-listed model configured with an explicit thinking level carries its provider's pinned thinking ladder, the one the gateway serves it with, so the level applies instead of silently becoming off.

A live-listed model has no bundled row. A session learns it from the gateway's listing alone, under the configured provider, with the whole configured reference as its id; the CLI's startup scope matches a reference against a model's id as well as its `provider/id`, so it finds that row. The SDK host, which runs material-only, restricted, host-tool and skill-selecting one-shots, admits the configured model the same way: the bundled row first, then the listed row, matched exactly under the configured provider. An id the listing lacks still refuses `omp_resume_model_unavailable` before any model call.

The scope, the role pins and the provider scope below are added when the one-shot is posted, not in the reviewed content: terminals and Agent harnesses prepared from the same review keep their ordinary `/model` selection, role resolution and whole reviewed pool.

Startup is not a one-shot's last selection. Task agents (`@task`, `@smol`), an enabled advisor, the `--plan-yolo` hand-off, eval's `completion()` and compaction's role candidates resolve a model role later, against the session's whole catalog, where an unset role reaches OMP's own priority lists (`advisor` its reasoning list, `tiny` and `memory` its fast one) and a workspace's `.omp/config.yml` may name any model for any role. The posted configuration therefore also names the configured model for every chat role it leaves unset (`smol`, `slow`, `vision`, `plan`, `commit`, `tiny`, `memory`, `task`, `advisor`); its layer outranks the workspace's. A role the operator configured keeps its model, and configured fallback chains apply only when `modelFallback` is `true`. Three later selections are not role-driven and stay outside the pins: a task agent whose own definition (a workspace `.omp/agents/*.md`) names a model, a read-tool image question when the configured model takes no images, and compaction's last-resort candidate, the largest-context model available, after the configured model fails authentication or native compaction. The provider scope below bounds them by provider. `readSession` still refuses a receipt whose final model differs from the configured one when `modelFallback` is not `true`; it reads the session's own transcript, not a subagent's or a side request's.

A one-shot registers, and hands its gateway the credentials of, only the providers its configuration names: those of its model roles, fallback chains and task-agent model overrides, which for a configuration that names only a default is that model's provider. The review still covers the pool the caller chose; the posted job receives every credential that pool holds for those providers and none for any other. Each provider a session registers makes its own `models` discovery call through the native service proxy, one authorization for the owner to decide, and the gateway lists every model its pool reaches under each of them, serving a provider-qualified id with that model's own provider's credential. A whole pool therefore cost one discovery call per pool provider and let the three selections above reach a provider nobody configured. They now resolve within the configured providers or not at all: an agent definition that names another provider's model no longer resolves, and compaction's last resort is the largest-context model of the configured providers. Within a configured provider they can still choose another of its models: a text-only OpenRouter model's image question goes to an OpenRouter vision model, and OpenRouter's catalog carries its own routes to other vendors' models, served with the OpenRouter credential.

## One-shot transcripts

A one-shot's transcript is its `session` output lease, created beneath `atyrode.omp.runs`. Both ordinary and material-only one-shots use `outputOnly` admission: the owner exposes only the fresh named lease, never the backing directory as a broad writer. The runs location also declares `temporary: true`, requiring native owner RPC 43. Each job gets private raw scratch, released only after descendant closure and durable terminal-result publication; sealed transcripts remain available to `readSession`. Failed or cancelled jobs release their raw scratch under the same proof, while uncertain closure retains it and closes admission. Interactive workspaces, persistent session state and legacy raw directories are unchanged. Upgrade the owner before installing this declaration; older owners refuse it rather than falling back to retained or mounted storage.

## Gateway stream failures

The gateway answers a failure with the one opaque word `gateway_unavailable` and writes the reason to its own stderr. A failure inside a model stream keeps the upstream's numeric status, and one the upstream gave no status is sent as 503. It also carries the SDK's own classification of that status (`errorId`), the one the client computes for the same status answered over HTTP, so the session's `retry` settings retry a 5xx or 429 instead of ending the session on its first transient fault. The failure carries none of the turn's content, so the client cannot see what the turn already produced: a failure after text, a tool call, an image, a server tool or any unknown block gets no classification and ends the session as before, because a retry would produce that output again. Only a turn that produced nothing but thinking or whitespace is retried. A receipt's `failure` still reads `gateway_unavailable`.

## Explicit existing-Run tools

Only ordinary one-shot `reviewSession` and `runSession` accept `agentTools: { runId }`.
The Run must already exist and authorize the caller and concrete target. This selector
is not a grant, a credential or an Agent profile field. Review binds the exact selector
and native one-shot operation; admission rechecks authority and binds the generated
journal UUID to the job's `agentRunId`. Omitting it remains ordinary, unbound behavior.
Terminal preparation, resume, plan-yolo and restricted automation refuse the selection.
Skills and prior transcripts never establish or recover this authority.

The parent worker retains the sole private WorkerContext. The SDK receives only a
bounded child relay, fixed namespaced doors and published argument schemas, never a
general Run bearer. The model must read policy and explicitly acknowledge its exact
revision through `manifold_policy` and `manifold_ack_policy`; neither OMP nor Code
auto-acknowledges. Original model JSON reaches host validation without SDK coercion,
default insertion or extra-field deletion. Collisions and unsupported runtime
capabilities refuse rather than downgrade. Ordinary instruction discovery is unchanged.
Completed results, refusals and cancellation with unknown effect acknowledgement
remain distinct; the adapter never replays an uncertain invocation.

Upgrade the compatible Manifold host first, then the exact native source, then any
Code consumer pin. This contract requires the declared `MANIFOLD_REV` host's protocol
43, native owner RPC 41 and hardened worker contract 7 support, with SDK host 18.4.12.
Disposable unpaid native and compiled-SDK proofs do not establish live deployment,
provider spending, fleet installation or the independently tracked material-only mode.

## One-shot inference limits

`reviewSession` and `runSession` accept ephemeral `inferenceLimits`: a nonempty combination of `calls`, `inputTokens`, `outputTokens` and `costMicros`. Requested values cannot exceed the current operation's declared ceilings. Cost review requires compatible native metering and reviewed prices for every served model. Limits are bound into review, admission and retained receipt checks; cancellation still targets the same proven job if its reported limits change. Terminal preparation and Agent harnesses refuse unsupported limits, and limits are not saved in defaults or profiles.

The native proxy checks recorded usage before admitting another service call. An in-flight response can exceed token or cost thresholds, and service-call accounting is not a worst-case envelope for provider retries or charged failures. Cumulative spending and concurrent reservations require a separate ledger. Bounded live-provider acceptance remains tracked separately in [#71](https://github.com/atyrode/manifold-omp/issues/71); these fields do not establish a zero-overshoot spending guarantee.

Gateway `reviewGateway` and `configureGateway` also accept an optional `requestLimits`, for example `{ maxAttemptsPerCall: 1, maxOutputTokens: 8192 }`. Omission retains the configured policy; explicit `null` removes it. Review binds both the installed policy and the requested replacement, and requires a native operation declaring the matching sealed input. Install and approve the matching native gateway, then reconfigure legacy policies before admitting callers; a ready older gateway cannot silently acquire an unsupported input.

A configured policy currently supports direct Anthropic `anthropic-messages` models only; other provider paths refuse before inference rather than running unbounded. The native adapter uses the unchanged SDK's public custom-provider and fetch interfaces. One request's attempt budget survives provider retries and credential replay, including SDK loop-guard signal replacement. Each actual HTTP dispatch consumes admission, redirects and serialized model substitution are refused, and the serialized output ceiling cannot exceed either the policy or a known model ceiling. Provider request shaping, thinking, retries, TLS, timeouts and credentials remain SDK-owned; public model identities and usage remain canonical. With or without limits, the private ingress rejects caller credential headers before dispatch so they cannot replace or poison a selected pool credential; noncredential metadata remains allowed.

These limits do not alone establish a currency ceiling. Reserve the maximum exposure using the selected model's input context, output ceiling, applicable prices, per-call attempts, admitted calls and concurrent jobs. Include cache-write pricing and charged failures; an unknown receipt does not release its reservation. A `null` request policy preserves ordinary SDK provider behavior and supplies no provider-attempt bound.

`followSession({ containerId, machineId, jobId })` observes only a session posted through that retained target. It returns the current native job, cumulative metered usage, the latest retained progress, and bounded inference-call metadata with sequence and unavailable-prefix information. A temporary native follow subscription is closed before the reply; settled jobs recover retained events from the durable journal. Output bytes, prompts and transcript bodies are excluded. A missing progress report or an evicted event is not invented, and the cumulative meter is not reconstructed from the bounded event list.

Native one-shot CLI and SDK-host print jobs (both 18.4.12) observe their existing published JSON event stream and report only fixed, redacted stage/message pairs through the private worker context. `at the model` begins on an observed assistant `message_start`, excluding synthetic aborted/error starts; it is not inferred from cumulative calls, process launch or `turn_start`. Assistant end, tool boundaries and agent end replace that stage; stdout end reports `stopped`, not successful completion. The job's terminal status remains authoritative. Interactive and resume terminals remain direct and unobserved.

These are event-observation times assigned by the native owner's progress coalescer, not provider dispatch timestamps. No stage covers an unobserved dispatch or pre-first-event latency; coalescing may hide short phases. The observer forwards original stdout bytes in order with backpressure. Parsing uses a fixed 64 KiB scratch frame, cleared after each record; oversized, malformed, non-JSON and unterminated records never stop forwarding, and lost observation replaces an active stage with `OMP stage unavailable.` rather than leaving a stale model/tool claim. No transcript, tool arguments, provider diagnostics or event timestamps enter progress. This adds observation only, not runtime, credential, retry or inference authority.

## Retryable one-shot posting

`runSession` accepts an optional `postingKey`, validated by the exported `PostingKeySchema`: one to 128 characters from `A–Z a–z 0–9 . _ : -`, starting with a letter or digit. A caller uses its own stable name for one posting, such as its run id. OMP derives the native job id from the key, the calling principal and the target container and machine: a SHA-256 over those values and the door name, written as a UUID. The derivation is not exported. A repeated call with the same key, caller and target names the same job, and two principals using one key never share a job.

A keyed call is answered before any preparation:

- When the key's provenance is retained and the hub has the job, the call returns that job, checked against the provenance as `readSession` checks it. A retry therefore returns the posted session whatever else changed since, including the review, defaults, gateway or accounts.
- When the provenance is retained but the hub never received the job (a failure between retention and dispatch), the call dispatches the retained provenance, unchanged, under the same id and output lease. The hub answers an exact repeat of a job id with the job it already has, so the session is admitted once.
- When nothing is retained, the call reviews, prepares and posts as usual under the derived id. A call that loses the retention race to another call with the same key returns that call's job instead of `omp_job_conflict`.
- A retired key refuses `omp_posting_retired`, and so does a call whose provenance CAS loses to a retire.
- Retained provenance under the derived id that belongs to another door, principal or target refuses `omp_posting_key_conflict`.

`adoptSession({ containerId, machineId, postingKey })` returns the job a key already posted for this caller and target. It names nothing else: no review digest, defaults revision, profile or preparation input, so a caller whose defaults, profile or review changed after posting still finds the session and can read or cancel it. It never reviews, prepares, posts or executes. A key with no retained provenance, or whose provenance the hub never received, refuses `omp_posting_unknown`. The door is container-write graded because of `retire`, and delegates only `jobs:read`.

`adoptSession({ ..., retire: true })` settles a key for good:

- The hub has the key's job: the call returns it, and the caller may cancel it.
- Nothing is retained under the key: the call writes a retired marker into the key's provenance slot, by the same create-only CAS a creator's provenance write uses, and refuses `omp_posting_unknown`. That answer is final. A creator whose provenance CAS loses to the marker refuses `omp_posting_retired`, as does every later keyed `runSession` and plain adoption of the key; a later retire answers `omp_posting_unknown` again, and the session doors treat the marker's job id as unknown.
- Provenance is retained but the hub has no job: the call refuses the retryable `omp_posting_pending` and executes nothing. A retire never executes, so it can never buy a session after the caller has stopped; the caller keeps its reservation and asks again, and a later retire either finds the job or is still pending.

The provenance CAS is the creator's last step before its hub execute, and nothing that can refuse sits between them, so retained provenance always means the creator committed to that dispatch. The boundary: a creator that crashes between the CAS and the hub execute, or whose hub execute is refused, leaves the key pending under retire for good. Only a keyed `runSession` retry dispatches retained provenance, and it may be refused again.

A key with `agentTools` refuses `omp_posting_key_agent_tools_unsupported`: a Run-bound session carries a fresh random session id, so its request cannot be repeated. Calls without a key are unchanged.

## Repository gate

The SDK pin and reusable workflow reference advance together. The protocol 48 pin retains
the existing native and SDK-host contracts while making the upstream machine-core inventory
and credential-bound lifecycle metadata available to downstream consumers. Its ordinary
installed-bundle gate and preview live-state verification passed before propagation; the
local native gate below still has to prove the newly packed family, not just the host.

Use Bun **1.4.2** and a clean sibling `manifold` checkout at the revision in `plugins/MANIFOLD_REV`. From `plugins/`:

```sh
bun install --frozen-lockfile
bun run deps:prepare
bun run check
bun test
bun run pack
OMP_VERIFY_SYSTEM=/absolute/path/system.json \
OMP_VERIFY_BWRAP=/absolute/path/bwrap \
MANIFOLD_TEST_STATIC_BUSYBOX=/absolute/path/static-busybox \
OMP_VERIFY_SYSTEMD_MODE=user bun run verify
```

`system.json` is an explicit native runtime-tool library declaration for the host. Verify creates its own disposable delegated systemd cgroup and, following Manifold's runtime gate, a private user/mount namespace with a 1 MiB, 4,096-inode tmpfs for governed output leases. `unshare` must be available; the reusable CI fixture already supplies static BusyBox. No host-root mount, fleet daemon or real credential value is involved. A failing native gate is not equivalent to successful packaging.

## Published SDK packaging

The credential and ordinary CLI baseline is published **18.4.12**. `plugins/package.json`, `plugins/bun.lock`, `plugins/runtime-artifacts.json`, and the integrity-pinned `patches/@oh-my-pi%2Fpi-ai@18.4.12.patch` define that graph. The patch SHA-256 is `03a4e777694a2d86d9fb1b59349daaed8e2934b193a139734a952d448d8d8c56`. It is the 18.1.14 patch re-derived against 18.4.12's namespace modules: broker quiesce and refresher stop/join, `drainRefreshes` over the refresher's and usage service's in-flight maps, the remote store's fenced snapshot authority (mutation replies are never published, and only a stream's first frame may lower its generation), and early-abort handling in `raceSignal`. Its SDK-level bearer hashes and control routes were dropped because the native ingress owns both. OMP 18.4 moved AuthStorage operations onto namespaces (`credentials`, `keys`, `oauth`, `usage`), so native accounting wraps those namespaces, and the gateway's pool guard sits on `keys`, which the stock gateway uses to resolve every bearer. Native broker composition adds control and completion accounting through public SDK hooks; provider refresh, credential selection, leases, compare-and-set and persistence remain SDK-owned.

The separately invoked `sdkHost` alone uses unpatched published **18.4.12**, under the independent `plugins/sdk-host/` package and frozen lock. Stock print and RPC implementations are public deep exports from `@oh-my-pi/pi-coding-agent`. Explicit optional peer imports are closed by `proxy-agent@8.0.1`, `supports-color@7.2.0` and `yauzl@3.4.0`; the PAC dependency is pinned to `quickjs-wasi@2.2.0`. This graph has no `patchedDependencies`; any such declaration refuses preparation.

`bun run deps:prepare` prepares both graphs independently with Bun 1.4.2, fresh caches, frozen locks, disabled lifecycle scripts, and private copied dependency trees. Each graph owns its full-tree receipt, lock pin, SDK version, loader digest and native artifact identity. Cross-graph receipt reuse, dependency escape and installed-byte changes refuse packaging. There is no workspace hoisting between roots. Packaging is install-free and credential-free; it reads only prepared trees, owned sources and committed runtime data. The baseline and SDK-host compiler projects resolve their respective actual package graphs; SDK-only type paths are scoped to the SDK project, never global aliases.

Worker compilation uses whitespace compaction without syntax or identifier minification. A matching SDK pin does not waive byte equality: the package regression rebuilds from a private dependency copy and a separate process, compares every published byte, and reports the first differing SDK-host source span when an archive changes. Disabling only identifier minification did not hold that boundary under the protocol-48 SDK; both optional transformations remain off. Native declarations and the final artifact-size budgets still apply unchanged.

Native ingress verifies the service bearer and optional legacy SHA-256 verifiers, with a separate control-bearer check, before forwarding to a private authenticated SDK listener. Native quiesce stops SDK producers immediately. The SDK owns data-operation admission: already-admitted writes finish, while a pre-handoff request receives 503 without mutation. Native lifecycle accounting retains a raw provider operation beyond the SDK's request deadline, without letting an unrelated settled or SDK-handled failure poison drain. The full credential scenarios preserve mutation ordering, restart, ingress, shutdown, quiescence and gateway revocation assertions. The separate SDK-host graph runs no credential workers and carries no patch.

The packer executes the complete publisher-shipped legacy-Pi virtual-module helper from a temporary private copy, adapting its monorepo directory assumptions to the installed package manifests. Virtual imports resolve explicitly from that prepared tree, not the caller's working directory. It retains the publisher's recursive exports, lazy loaders and compatibility shims rather than substituting an empty virtual module. The shipped `dist/docs-index.generated.txt` supplies `PI_DOCS_EMBED`.

The SDK archive declares and hashes the five emitted HTML/template/changelog assets, collected license notices, and the optional PAC path's actual `quickjs.wasm`. A local bundle-time adapter relocates only QuickJS's default WASM file read to the declared worker asset directory; no optional implementation is replaced with a stub. Puppeteer's exact-version Apache notices come from the coding-agent publisher's aggregate notices. QuickJS's published package and release tag contain MIT metadata but no standalone license/copyright notice: the archive states that omission, includes canonical MIT terms, and preserves the pinned QuickJS-NG engine's publisher notice.

18.4's HTML export also vendors highlight.js and marked as file assets. A second exact-once adapter imports those two scripts as text, which the export template inlines either way, so the SDK archive stays within the protocol's eight declared files per artifact; their notices are in the coding-agent publisher's aggregate notices. Every `@oh-my-pi` package ships that same aggregate, so identical notice text is stated once and each later package names the section it matches. Repeated per package, it pushed the root plugin past the 16 MiB artifact budget.

Credential workers pair with the external **18.4.12** `pi-natives` artifact at `/runtime/bin/pi-natives`; the ordinary `omp` binary also uses its reviewed **18.4.12** artifact. The SDK host pairs only with the external **18.4.12** `sdk-pi-natives` artifact at `/runtime/bin/sdk-pi-natives`, with separate `sdk-pi-natives-licenses` sidecar targets. Baseline inventory, benchmark and harness workers retain the shipped refusal if they unexpectedly import a native addon; no baseline addon is mounted into their root operations. The one admitted route is 18.4's `pi-natives/path` helper, which pi-utils' logger brings into the harness: its hash-pinned bytes load the addon only on win32, a platform no worker targets. The pinned loader replacement also supplies 18.4's `missingNativeExport` helpers, keeping an absent export `undefined` as the stock loader does for a current addon. One alias never ambiguously denotes two versions. SDK-host metadata lives in `plugins/sdk-host/runtime-artifacts.json`; only its native artifact is attached, not its newer stock CLI binary.

Every embedded worker, asset and notice counts toward the existing **16 MiB aggregate base64 limit**, with duplicate asset rejection and final plugin JSON verification before atomic publication. Arbitrary-cwd packaging remains supported. Successful packaging alone does not establish optional browser/PAC/ML execution, ARM64 runtime behavior or end-to-end native admission; the credential gate and packaged SDK-host strict-refusal proof must both pass.

Credential workers moved forward with the rebased private patch only after the preserved authority scenarios (ingress, mutation ordering, restart, quiesce, shutdown) passed against it. The patch is not ported to the published SDK-host graph.
