#!/usr/bin/env bash
set -eu
here=$(cd -- "$(dirname -- "$0")" && pwd)
root=$(cd -- "$here/../.." && pwd)
scout=$(node "$here/pilot-checkouts.mjs" scout)
[[ -n "$scout" ]] || { echo "Set PI_SCOUT_CHECKOUT to your Scout checkout." >&2; exit 1; }
live=0
full=0
for option in "$@"; do
  case "$option" in
    --live) live=1 ;;
    --full) full=1 ;;
    *) echo "Usage: bash check-ecosystem.sh [--full] [--live]" >&2; exit 2 ;;
  esac
done
cd -- "$root"
bash "$here/pilot-deps.sh"
node node_modules/typescript/bin/tsc -p packages/pi-daddy/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/pi-daddy/tsconfig.check.json
node --test benchmarks/harvest/*.test.mjs packages/pi-daddy/test/{decision-classifier,session-harvest,web-dashboard,ecosystem-setup-config}.test.ts "$scout"/tests/{research-model,worker-failure}.test.mjs
node "$here/check-stack.mjs"
if ((full)); then
  failed=0
  (cd packages/pi-daddy && node scripts/unit-tests.ts) || failed=1
  (cd "$scout" && node --test tests/*.test.mjs) || failed=1
  (cd packages/pi-daddy && npm run test:integration:ci) || failed=1
  if ((failed)); then echo "At least one full suite failed. See its test output." >&2; exit 1; fi
fi
if ((live)); then
  exec bash "$here/try-settings.sh" -e "$here/live-classifier-check.mjs" "Run a short ecosystem check. Use scout_research once with https://nodejs.org/api/fs.html to check the birthtime fallback, then read its brief if one was saved. Use delegate for one read-only Principal review of Scout model selection in $scout/extension/worker.ts. Use a Bookie read-only task or memory lookup for this workspace and inspect one available Skill Harness check or its status. Report one row per component with the actual tool, result, and any missing grant, model, or prerequisite. Mark partial results explicitly. Leave project files unchanged."
fi
