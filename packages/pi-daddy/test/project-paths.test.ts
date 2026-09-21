import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { test } from "node:test";
import * as paths from "../src/kernel/project-paths.ts";

const packageRoot = join(import.meta.dirname, "..");

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

// ADR-0076 PR 3c: one module spells the state locations. Production change that breaks this: a `.pi` path
// literal in CODE anywhere else in shipped modules (a new file location nobody put in project-paths.ts).
// Comments are skipped. pi's own locations (`.pi/skills`, `.pi/settings.json`, `~/.pi/agent`) are pi's, not
// ours, and may be named in operator-facing text; they are allowed by the regex below.
const PI_OWN_LOCATION = /\.pi\/(skills|settings\.json|agent)\b|~\/\.pi\b|\.pi\/agent/;
test("no shipped module outside project-paths.ts spells a pi-daddy .pi path", async () => {
  const offenders: string[] = [];
  for (const file of [...(await walk(join(packageRoot, "src"))), ...(await walk(join(packageRoot, "extensions")))]) {
    if (file.endsWith(`kernel${sep}project-paths.ts`) || file.includes(`${sep}vendor${sep}`)) continue;
    const source = await readFile(file, "utf8");
    let inBlock = false;
    source.split("\n").forEach((line, i) => {
      let code = line;
      if (inBlock) {
        const close = code.indexOf("*/");
        if (close === -1) return;
        code = code.slice(close + 2);
        inBlock = false;
      }
      const open = code.indexOf("/*");
      if (open !== -1) {
        const close = code.indexOf("*/", open + 2);
        if (close === -1) {
          inBlock = true;
          code = code.slice(0, open);
        } else code = code.slice(0, open) + code.slice(close + 2);
      }
      code = code.replace(/\/\/.*$/, "");
      if (!/["'`]\.pi["'`/]/.test(code) && !/\.pi\//.test(code)) return;
      if (PI_OWN_LOCATION.test(code) && !/grants|work|learning|activity|pi-daddy/.test(code)) return;
      offenders.push(`${file.slice(packageRoot.length + 1)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("every project path lives under <cwd>/.pi/pi-daddy and every user path under <agent>/pi-daddy", () => {
  const cwd = "/work/proj";
  const env = { PI_CODING_AGENT_DIR: "/home/u/.pi/agent" };
  const projectFns = [
    paths.projectSettingsPath,
    paths.projectGitignorePath,
    paths.projectLedgerPath,
    paths.activityTimelinePath,
  ];
  const seen = new Set<string>();
  for (const fn of projectFns) {
    const p = fn(cwd);
    assert.ok(p.startsWith("/work/proj/.pi/pi-daddy/"), p);
    assert.ok(!seen.has(p), `two helpers share ${p}`);
    seen.add(p);
  }
  assert.equal(paths.grantStorePath(cwd, env), `/home/u/.pi/agent/pi-daddy/grants/${paths.projectFileName(cwd)}`);
  assert.equal(paths.approvalsPath(cwd, env), `/home/u/.pi/agent/pi-daddy/approvals/${paths.projectFileName(cwd)}`);
  assert.equal(paths.workspaceLeasesDir(env), "/home/u/.pi/agent/pi-daddy/workspace-leases");
  assert.equal(paths.legacyUserGrantStorePath(cwd, env), `/home/u/.pi/agent/grants/${paths.projectFileName(cwd)}`);
  assert.equal(
    paths.legacyUserApprovalsPath(cwd, env),
    `/home/u/.pi/agent/grants-approvals/${paths.projectFileName(cwd)}`,
  );
  assert.equal(paths.legacyProjectLedgerPath(cwd), "/work/proj/.pi/grants.jsonl");
  assert.match(paths.projectFileName("/a/b/cosmic-platform-backend"), /^cosmic-platform-backend-[0-9a-f]{16}\.json$/);
  assert.ok(paths.isUnderPiProjectDir("/x/.pi/pi-daddy/work.jsonl"));
  assert.ok(!paths.isUnderPiProjectDir("/home/u/.local/state/pi-daddy/x"));
  assert.match(paths.PROJECT_GITIGNORE_CONTENT, /^\*$/m);
  assert.match(paths.PROJECT_GITIGNORE_CONTENT, /^!settings\.json$/m);
});
