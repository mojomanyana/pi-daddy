#!/usr/bin/env bash
# Measures the whole B2 loop against the REAL principal-pi-skills package and a REAL pi process.
#
#   npm i principal-pi-skills  ->  pi-daddy init  ->  edit one ceiling  ->  pi  ->  /grants
#
# Costs no model tokens. Needs network (one npm install) and `pi` on PATH.
# Usage: bash docs/probes/b2-init-principal-pi-skills/probe.sh [workdir]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PKG="$REPO/packages/pi-daddy"
WORK="${1:-$(mktemp -d)}"
PPS_VERSION="${PPS_VERSION:-2.3.1}"

echo "== workdir: $WORK"
mkdir -p "$WORK"
cd "$WORK"
npm init -y >/dev/null 2>&1
npm install "principal-pi-skills@$PPS_VERSION" --no-audit --no-fund >/dev/null

echo
echo "== P2, re-measured: how many of the seven declare allowed-tools?"
grep -rl "allowed-tools" node_modules/principal-pi-skills/ || echo "(none)"

echo
echo "== pi-daddy init"
( cd "$PKG" && npm run build >/dev/null 2>&1 )
node "$PKG/dist/cli.js" init

echo
echo "== the generated .pi/grants.env"
cat .pi/grants.env

echo
echo "== the operator decides ONE ceiling (this is the step pi-daddy refuses to take)"
# `decide`, with the ceiling `principal-pi-skills` PR #30 settled on for it — re-derived from the skill's
# own body, not from this repository's guess. Deliberately NOT `review`: that one gets `bash` in their
# table, so it is not the read-only exemplar an earlier version of this probe and the README claimed.
python3 - <<'EDIT'
p = ".pi/skills/decide/SKILL.md"
t = open(p).read()
t = t.replace("# allowed-tools: <list the tools this skill needs, e.g. Read, Grep>", "allowed-tools: read, grep, find, ls")
open(p, "w").write(t)
EDIT
sed -i 's/^export PI_GRANTS_GRANT=.*/export PI_GRANTS_GRANT="agent:decide,tool:read,tool:grep,tool:find,tool:ls,tool:delegate"/' .pi/grants.env
grep -n "^allowed-tools\|^export PI_GRANTS_GRANT" .pi/skills/decide/SKILL.md .pi/grants.env

echo
echo "== a real pi session, driven over rpc — every ctx.ui.notify it emits"
cat > drive.mjs <<EOF
import { spawn } from "node:child_process";
const child = spawn("pi", ["--no-session", "--no-extensions", "-e", "$PKG/extensions/grants.ts", "--mode", "rpc"], {
  env: { ...process.env, PI_GRANTS_GRANT: "agent:decide,tool:read,tool:grep,tool:find,tool:ls,tool:delegate" },
  stdio: ["pipe", "pipe", "inherit"],
});
let buf = "";
child.stdout.on("data", (c) => {
  buf += String(c);
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "extension_ui_request" && e.method === "notify") console.log(\`[\${e.notifyType}] \${e.message}\`);
  }
});
child.stdin.write(JSON.stringify({ type: "prompt", id: "1", message: "/grants" }) + "\n");
setTimeout(() => { child.kill("SIGTERM"); process.exit(0); }, 8000);
EOF
node drive.mjs

echo
echo "== done. workdir kept at $WORK"
