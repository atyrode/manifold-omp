# OMP session resumption

The `atyrode.omp` plugin owns OMP transcript discovery and terminal resumption. An operator does not need an Agent or an Agent Run credential to resume a conversation.

## Operator doors

- **`atyrode.omp.listSessions`** — `{ machineId }` returns an array of `{ id, title, cwd, updatedAt }`. The UUID and cwd come from the transcript header, the title comes from OMP's title slot or legacy header, and `updatedAt` is the file's modification time in epoch milliseconds. No message body or filesystem transcript path is returned.
- **`atyrode.omp.resumeSession`** — `{ machineId, sessionId, containerId?, accountPool?, overlay? }` returns `{ machineId, sessionId, runtime }`, where `runtime` is a native machine-only terminal descriptor. The session must already exist. Neither preparation nor the native worker creates a replacement transcript when the UUID is missing.

These names use the existing root-plugin camelCase convention (`prepareSession`, `prepareSignIn`); the SDK does not allow dotted local action names.

Both doors require workspace-wide operator/owner authority and the admitted machine operation's native permissions and consent. A container-scoped credential is refused. Runtime preparation does not create a terminal or confer terminal/container authority. If `containerId` is supplied it is checked, but the returned descriptor remains machine-only; terminal placement must independently authorize its actual destination.

### Defaults and explicit selection

When `overlay` is omitted, resume uses the **current plugin defaults**, not historical transcript configuration or personal OMP settings. Supplied overlay keys replace the corresponding top-level default values, including whole maps and arrays. The effective configuration must include a default model.

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

Agent-bound and operator resume share one OMP argv builder for `--session-dir`, the header-resolved `--session` file and the sealed `--config`. The Agent adds RPC mode and its admission context. Operator resume gives OMP the terminal directly, with a fixed child environment and no Run credential or private Agent control descriptor.

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
OMP_VERIFY_SYSTEMD_MODE=user bun run verify
```

`system.json` is an explicit native runtime-tool library declaration for the host. Verify creates its own disposable delegated user-systemd cgroup; it does not install a fleet daemon or expose real credential values. A failing native gate is not equivalent to successful packaging. PR #27 records the clean-base comparison for the pre-existing `packed-broker-worker-refused` failure.
