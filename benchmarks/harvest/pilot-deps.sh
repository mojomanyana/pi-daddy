#!/usr/bin/env bash
set -eu
cd -- "$(dirname -- "$0")/../.."
if ! node --input-type=commonjs -e '
  const lock = require("./package-lock.json");
  const name = "@earendil-works/pi-coding-agent";
  require.resolve("typescript/bin/tsc");
  process.exit(require("./node_modules/" + name + "/package.json").version === lock.packages["node_modules/" + name].version ? 0 : 1);
' 2>/dev/null; then
  npm ci
fi
bookie="${PI_BOOKIE_CHECKOUT:-../bookie-pi-skills}"
if [[ -f "$bookie/packages/pi-extension/src/producer-bridge.ts" ]]; then
  (
    cd -- "$bookie"
    if [[ ! -f node_modules/typescript/bin/tsc || ! -e node_modules/pi-bookie-core/package.json ]]; then
      npm ci
    fi
    node node_modules/typescript/bin/tsc -b packages/pi-extension
    if [[ ! -d packages/core/dist/schemas ]]; then node packages/core/scripts/copy-schemas.mjs; fi
  )
fi
