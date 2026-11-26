#!/usr/bin/env bash
set -eu
here=$(cd -- "$(dirname -- "$0")" && pwd)
root=$(cd -- "$here/../.." && pwd)
if [[ ! -f "$root/node_modules/typescript/bin/tsc" ]]; then
  (cd -- "$root" && npm ci)
fi
node "$root/node_modules/typescript/bin/tsc" -p "$root/packages/pi-daddy/tsconfig.json"
workspace=$(node "$here/prepare-pilot.mjs" --print-workspace)
cd -- "$workspace"
export PI_DADDY_AUTO_MODE="${PI_DADDY_AUTO_MODE:-1}"
export PI_DADDY_LEAN_TOOLS="${PI_DADDY_LEAN_TOOLS:-0}"
printf '%s\n' "Starting the ecosystem in $PWD. Use /ecosystem-status to check registered components."
printf '%s\n' "PI_DADDY_AUTO_MODE=$PI_DADDY_AUTO_MODE (1 automatically approves Daddy tool permission requests for this session and its descendants)."
exec pi -e "$here/pilot-status.mjs" "$@"
