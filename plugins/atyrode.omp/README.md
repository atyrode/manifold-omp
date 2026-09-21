# OMP session resumption

The `atyrode.omp` plugin owns OMP transcript discovery and terminal resumption. An operator does not need an Agent or an Agent Run credential to resume a conversation.

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

Ordinary fresh launches retain the existing published CLI path. Restricted launches and explicit resumes invoke a separately packaged SDK host in a sanitized child, without Run credentials or the private Agent control descriptor. Bun starts from trusted inputs with environment-file, automatic-install and workspace-bunfig loading disabled. Ordinary SDK resume still loads permitted project settings through the public settings API before applying the sealed runtime overlay. Public `SessionManager.open` and session context APIs inspect persisted state before constructing an agent; held-file identity is rechecked before construction. Operator resume uses exported `InteractiveMode` and renders the saved history; admitted ordinary Agent resume uses the publisher's concrete RPC mode and governed admission context. Cancellation reaches the child and SDK disposal; the parent retains its kill deadline. No resume failure falls through to a new session.

## Restricted automation

Session review, prepare, one-shot and operator resume accept `automation: { mode: "restricted", toolNames, delegation: "disabled" }`. The exported `RESTRICTED_TOOL_NAMES` deliberately supports only `read`, `grep`, `glob`, `bash`, `edit`, and `write`; names must be exact and unique. The native SDK's `restrictToolNames` enforces the registry. Unknown modes/tools, duplicate names and OMP task/advisor delegation requests refuse; no Code-side tool filter or alternate registry exists.

Review always returns effective `automation` (`{ mode: "ordinary" }` or the restricted policy) and binds it with skills into the digest. Omission is ordinary, including on resume: restrictions and optional skill selections are explicit per launch, not inferred from transcripts. Restricted mode disables ambient skills, rules, project context, extensions, custom tools, templates and slash discovery, MCP/LSP/IRC and OMP task/advisor spawning. Only deliberately selected sealed skills are loaded through `loadSkillsFromDir`; they remain instruction/resource content, not authority. Omitted or disabled restricted skills load none.

Restricted Agent harness admission refuses `omp_restricted_harness_unsupported`: its governed `manifold` host tool is outside the supported six-tool policy. Plan-YOLO, enabled task advisor/prewalk, enabled top-level advisor/prewalk and retry model fallback refuse `omp_restricted_delegation_unsupported` rather than forwarding to an unrestricted CLI. Passive task model routing remains configuration, not spawn authority. Agent resume with Plan-YOLO refuses `omp_resume_plan_unsupported` rather than ignoring that option. Restricted automation and strict resume require the exact SDK-aware OMP18.2.7 deployment and named runtime inputs; incompatible owners refuse `omp_sdk_runtime_unsupported`.

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

Skills never enter durable overlays/defaults or Agent profiles. A harness launch may supply the same choice in its `OmpHarnessTargetSchema` target; fresh independent launches start with no optional selection. Resume may supply a new explicit selection; no historical selection is guessed from transcript text. Restricted tools, broker ceilings and native OS/network authority are unchanged. Selection/disable requests require the exact hash-pinned published OMP 18.2.7 runtime and skill-aware immutable-input operation; older/incompatible owners refuse.

## Repository gate

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

The credential and ordinary CLI baseline stays at **18.1.14**. `plugins/package.json`, `plugins/bun.lock`, `plugins/runtime-artifacts.json`, and the existing integrity-pinned `patches/@oh-my-pi%2Fpi-ai@18.1.14.patch` retain the shipped graph from `origin/main` revision `0f648cda9330fe6bef81b57d9e1f6f045b62bbaf`. The patch SHA-256 remains `ef3aaf1d847e1cc2729819b695e28c96ac697561987a49f4951c566141c8c40d`. Broker and gateway use that retained implementation directly; no candidate wrapper or new credential reconciliation algorithm is interposed.

The separately invoked `sdkHost` alone uses unpatched published **18.2.7**, under the independent `plugins/sdk-host/` package and frozen lock. Stock print and RPC implementations are public deep exports from `@oh-my-pi/pi-coding-agent`. `proxy-agent@8.0.1` closes Puppeteer's optional peer import; its PAC dependency is explicitly pinned to `quickjs-wasi@2.2.0`. This graph has no `patchedDependencies`; any such declaration refuses preparation.

`bun run deps:prepare` prepares both graphs independently with Bun 1.4.2, fresh caches, frozen locks, disabled lifecycle scripts, and private copied dependency trees. Each graph owns its full-tree receipt, lock pin, SDK version, loader digest and native artifact identity. Cross-graph receipt reuse, dependency escape and installed-byte changes refuse packaging. There is no workspace hoisting between roots. Packaging is install-free and credential-free; it reads only prepared trees, owned sources and committed runtime data. The baseline and SDK-host compiler projects resolve their respective actual package graphs; SDK-only type paths are scoped to the SDK project, never global aliases.

The retained baseline broker owns its service-bearer and optional legacy SHA-256 ingress, control/quiesce authorization, refresh draining, persistence and canonical credential authority. Those obligations remain covered by the full credential scenarios, including mutation ordering, restart, ingress, shutdown, quiescence and gateway revocation. The separate SDK-host graph does not claim to repair published 18.2.7 credential behavior.

The packer executes the complete publisher-shipped legacy-Pi virtual-module helper from a temporary private copy, adapting its monorepo directory assumptions to the installed package manifests. Virtual imports resolve explicitly from that prepared tree, not the caller's working directory. It retains the publisher's recursive exports, lazy loaders and compatibility shims rather than substituting an empty virtual module. The shipped `dist/docs-index.generated.txt` supplies `PI_DOCS_EMBED`.

The SDK archive declares and hashes the five emitted HTML/template/changelog assets, collected license notices, and the optional PAC path's actual `quickjs.wasm`. A local bundle-time adapter relocates only QuickJS's default WASM file read to the declared worker asset directory; no optional implementation is replaced with a stub. Puppeteer's exact-version Apache notices come from the coding-agent publisher's aggregate notices. QuickJS's published package and release tag contain MIT metadata but no standalone license/copyright notice: the archive states that omission, includes canonical MIT terms, and preserves the pinned QuickJS-NG engine's publisher notice.

Credential workers pair with the external **18.1.14** `pi-natives` artifact at `/runtime/bin/pi-natives`; the ordinary `omp` binary also retains its reviewed **18.1.14** artifact. The SDK host pairs only with the external **18.2.7** `sdk-pi-natives` artifact at `/runtime/bin/sdk-pi-natives`, with separate `sdk-pi-natives-licenses` sidecar targets. Baseline inventory, benchmark and harness workers retain the shipped refusal if they unexpectedly import a native addon; no baseline addon is mounted into their root operations. One alias never ambiguously denotes two versions. SDK-host metadata lives in `plugins/sdk-host/runtime-artifacts.json`; only its native artifact is attached, not its newer stock CLI binary.

Every embedded worker, asset and notice counts toward the existing **16 MiB aggregate base64 limit**, with duplicate asset rejection and final plugin JSON verification before atomic publication. Arbitrary-cwd packaging remains supported. Successful packaging alone does not establish optional browser/PAC/ML execution, ARM64 runtime behavior or end-to-end native admission; the credential gate and packaged SDK-host strict-refusal proof must both pass.

Published 18.2.7 credential rollback remains tracked by [#72](https://github.com/atyrode/manifold-omp/issues/72). This split retains one existing private baseline patch; it neither introduces a new OMP fork nor ports that patch to the published SDK-host graph. Moving credential workers forward requires the preserved authority contracts to pass against a qualified published release.
