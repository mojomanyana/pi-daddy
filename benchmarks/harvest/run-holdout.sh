#!/usr/bin/env bash
set -eu
here=$(cd -- "$(dirname -- "$0")" && pwd)
if [[ -z ${OPENROUTER_API_KEY:-} ]]; then
  read -rsp 'OpenRouter API key: ' OPENROUTER_API_KEY
  printf '\n'
fi
export OPENROUTER_API_KEY
TMPDIR=$(cd -- "$here/../../.." && pwd)
export TMPDIR
node "$here/openrouter.mjs" --holdout --check &&
  node "$here/openrouter.mjs" --holdout --live
