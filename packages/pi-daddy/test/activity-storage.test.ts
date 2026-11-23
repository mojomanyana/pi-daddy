/** Activity storage lives outside the project git working copy so repos stay 100% clean. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { after, test } from "node:test";
import { prepareDefaultActivityStorage } from "../src/products/activity-storage.ts";
import { activityTimelinePath, piProjectDir } from "../src/kernel/project-paths.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";

after(cleanupTempDirs);

test("activity storage prepares user-scoped directory and leaves project git repo clean", async () => {
  const cwd = await tempDir("activity-storage-git-");
  const agentRoot = await tempDir("activity-storage-agent-");
  execFileSync("git", ["-C", cwd, "init", "-q"], { encoding: "utf8" });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentRoot;
  try {
    const timelinePath = activityTimelinePath(cwd);
    assert.ok(timelinePath.startsWith(agentRoot), "activity timeline must live under agent dir");
    await prepareDefaultActivityStorage(cwd, timelinePath);
    assert.equal(existsSync(piProjectDir(cwd)), false, "must not create .pi inside user git repo");
    assert.equal((await stat(dirname(timelinePath))).isDirectory(), true);
    const status = execFileSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" }).trim();
    assert.equal(status, "", "git status must remain spotless");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});
