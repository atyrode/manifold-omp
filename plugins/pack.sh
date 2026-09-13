#!/usr/bin/env bash
# Pack only this OMP family with the selected Bun and pinned sibling Manifold SDK.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
manifold="$(cd "$here/../.." && pwd)/manifold"
selected_bun="${BUN:-bun}"

if [ ! -f "$manifold/packages/plugin-kit/src/pack.ts" ]; then
  echo "pack.sh: missing sibling Manifold SDK; use the revision in plugins/MANIFOLD_REV" >&2
  exit 1
fi
if ! bun_path="$(command -v "$selected_bun")"; then
  echo "pack.sh: select an existing Bun 1.4.2 executable with BUN; no runtime is installed by this command" >&2
  exit 1
fi
if [ "$("$bun_path" --version)" != "1.4.2" ]; then
  echo "pack.sh: Bun 1.4.2 is required; select it with BUN" >&2
  exit 1
fi
if ! git_path="$(command -v git)"; then
  echo "pack.sh: git is required to attest the pinned sibling Manifold source" >&2
  exit 1
fi

# Absolute executables are also used by pack.ts for nested invocations.
bun_path="$(cd "$(dirname "$bun_path")" && pwd)/$(basename "$bun_path")"
git_path="$(cd "$(dirname "$git_path")" && pwd)/$(basename "$git_path")"
export OMP_PACK_GIT="$git_path"
exec "$bun_path" --no-install "$here/pack.ts" "$@"
