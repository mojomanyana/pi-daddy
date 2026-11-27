#!/usr/bin/env bash
set -eu
here=$(cd -- "$(dirname -- "$0")" && pwd)
root=$(cd -- "$here/../.." && pwd)
bash "$here/pilot-deps.sh"
if [[ "${1:-}" == "--verify-bookie" ]]; then
  shift
  bookie=$(node "$here/pilot-checkouts.mjs" bookie)
  [[ -n "$bookie" ]] || { echo "Set PI_BOOKIE_CHECKOUT to your Bookie checkout." >&2; exit 1; }
  tests="$bookie/packages/pi-extension/test"
  node --test "$tests/automatic-review-sync.test.mjs" "$tests/producer-bridge.test.mjs" \
    "$root/packages/pi-daddy/test/project-memory-owner.test.ts" "$here/capture-resume.test.mjs"
  node --test --test-name-pattern='a conflicting Bookie|optional task broker' "$root/packages/pi-daddy/test/task-dispatch.test.ts"
fi
node "$root/node_modules/typescript/bin/tsc" -p "$root/packages/pi-daddy/tsconfig.json"
workspace=$(node "$here/prepare-pilot.mjs" --print-workspace)
cd -- "$workspace"
export PI_DADDY_LEAN_TOOLS="${PI_DADDY_LEAN_TOOLS:-0}"
printf '%s\n' "Starting the ecosystem in $PWD. Use /ecosystem-status to check registered components."
pilot_session_args() {
  while (( $# )); do
    case "$1" in
      -c|--continue|-r|--resume|/pilot-capture-check|/ecosystem-status) shift ;;
      --session) [[ $# -ge 2 && "$2" != -* ]] || return 1; shift 2 ;;
      *) return 1 ;;
    esac
  done
}
if [[ -t 0 && -t 1 ]] && pilot_session_args "$@"; then
  set -- /pilot-activate "$@"
fi
exec pi -e "$here/pilot-status.mjs" "$@"
