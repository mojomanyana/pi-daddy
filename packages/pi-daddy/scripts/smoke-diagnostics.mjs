#!/usr/bin/env node
/** Exercise the packed offline CLI without installing Pi, TypeBox or any other package. */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function runDiagnosticSmoke(tarball) {
  const root = mkdtempSync(join(tmpdir(), "pi-daddy-offline-smoke-"));
  let complete = false;
  try {
    const packageRoot = join(root, "node_modules", "pi-daddy");
    mkdirSync(packageRoot, { recursive: true });
    execFileSync("tar", ["-xzf", resolve(tarball), "--strip-components=1", "-C", packageRoot]);
    const fixture = join(root, "fixture.mjs");
    copyFileSync(new URL("./smoke-diagnostics-fixture.mjs", import.meta.url), fixture);
    const output = execFileSync(process.execPath, [fixture], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, TMPDIR: root },
      timeout: 30000,
    });
    if (!output.includes("DIAGNOSTIC_STANDALONE_SMOKE_OK")) throw new Error("offline diagnostic fixture did not finish");
    complete = true;
    return output.trim();
  } finally {
    if (complete) rmSync(root, { recursive: true, force: true });
    else console.error(`Offline diagnostic smoke evidence retained at ${root}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: node scripts/smoke-diagnostics.mjs <pi-daddy.tgz>");
  console.log(runDiagnosticSmoke(process.argv[2]));
}
