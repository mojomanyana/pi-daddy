/** Real Git/storage regressions: no model, dispatch, index repair, or user policy rewrite. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { ActivityTimelineRecorder } from "../src/products/activity-timeline.ts";
import { prepareDefaultActivityStorage } from "../src/products/activity-storage.ts";
import {
  activityTimelinePath,
  piProjectDir,
  projectStateDir,
  projectGitignorePath,
  PROJECT_GITIGNORE_CONTENT,
} from "../src/kernel/project-paths.ts";
import { applyInit, planInit } from "../src/governance/init.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const repository = async () => {
  const cwd = await tempDir("activity-storage-git-");
  git(cwd, "init", "-q");
  return cwd;
};

test("startup preserves sufficient custom and managed policies and later actual init", async () => {
  for (const policy of [
    PROJECT_GITIGNORE_CONTENT,
    "# Existing private data policy\n/activity.jsonl\n/activity.jsonl.lock\n/content/\n/user-cache/\n",
  ]) {
    const cwd = await repository(),
      state = projectStateDir(cwd);
    await mkdir(state, { recursive: true });
    await writeFile(projectGitignorePath(cwd), policy);
    await prepareDefaultActivityStorage(cwd, activityTimelinePath(cwd));
    assert.equal(await readFile(projectGitignorePath(cwd), "utf8"), policy);
  }
  const cwd = await repository();
  await prepareDefaultActivityStorage(cwd, activityTimelinePath(cwd));
  const before = await readFile(projectGitignorePath(cwd), "utf8");
  const result = await applyInit(planInit([], cwd, []));
  assert.deepEqual(result.failed, []);
  assert.equal(await readFile(projectGitignorePath(cwd), "utf8"), before);
  git(cwd, "check-ignore", "-q", "--", join(projectStateDir(cwd), "grants.jsonl"));
  assert.throws(() => git(cwd, "check-ignore", "-q", "--", join(projectStateDir(cwd), "settings.json")));
});

test("tracked activity, content, lock and missing tracked ignore are never hidden or repaired", async () => {
  for (const name of ["activity.jsonl", "activity.jsonl.lock", "content/existing", ".gitignore"]) {
    const cwd = await repository(),
      path = join(projectStateDir(cwd), name);
    await mkdir(projectStateDir(cwd), { recursive: true });
    if (name.startsWith("content/")) await mkdir(join(projectStateDir(cwd), "content"));
    await writeFile(path, "preserve\n");
    git(cwd, "add", "--", path);
    const before = git(cwd, "ls-files", "--stage", "-z");
    if (name === ".gitignore") await rm(path);
    await assert.rejects(prepareDefaultActivityStorage(cwd, activityTimelinePath(cwd)), /tracked/u);
    assert.equal(git(cwd, "ls-files", "--stage", "-z"), before);
    if (name === ".gitignore") await assert.rejects(readFile(path), { code: "ENOENT" });
    else assert.equal(await readFile(path, "utf8"), "preserve\n");
  }
});

test("symlinked producer directories and ignore remain untouched", async () => {
  for (const selected of ["pi", "state", "ignore"]) {
    const cwd = await repository(),
      outside = await tempDir("activity-storage-outside-");
    if (selected === "pi") await symlink(outside, piProjectDir(cwd));
    else if (selected === "state") {
      await mkdir(piProjectDir(cwd));
      await symlink(outside, projectStateDir(cwd));
    } else {
      await mkdir(projectStateDir(cwd), { recursive: true });
      await writeFile(join(outside, "keep"), "original");
      await symlink(join(outside, "keep"), projectGitignorePath(cwd));
    }
    const before = await readdir(outside);
    await assert.rejects(prepareDefaultActivityStorage(cwd, activityTimelinePath(cwd)), /ordinary/u);
    assert.deepEqual(await readdir(outside), before);
    if (selected === "ignore") assert.equal(await readFile(join(outside, "keep"), "utf8"), "original");
  }
});

test("missing Git permits marker-free non-Git roles and refuses marked repository ambiguity", async () => {
  const ordinary = await tempDir("activity-no-git-role-"),
    marked = await tempDir("activity-no-git-marked-");
  await writeFile(join(marked, ".git"), "gitdir: elsewhere\n");
  const previous = process.env.PATH;
  process.env.PATH = "/nonexistent-activity-test-bin";
  try {
    const recorder = new ActivityTimelineRecorder(ordinary, {});
    await recorder.prepareStorage();
    await recorder.start("standalone public fixture");
    await recorder.finish("done");
    assert.match(await readFile(activityTimelinePath(ordinary), "utf8"), /task_finished/u);
    await assert.rejects(prepareDefaultActivityStorage(marked, activityTimelinePath(marked)), /Git policy/u);
    await assert.rejects(readFile(projectGitignorePath(marked)), { code: "ENOENT" });
    const priorGit = process.env.GIT_DIR;
    process.env.GIT_DIR = "/nonexistent-explicit-git-directory";
    try {
      await assert.rejects(prepareDefaultActivityStorage(ordinary, activityTimelinePath(ordinary)), /Git policy/u);
    } finally {
      if (priorGit === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = priorGit;
    }
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test("off and custom storage retain their prior behavior; preparation is once per recorder", async () => {
  const cwd = await repository(),
    off = new ActivityTimelineRecorder(cwd, { PI_DADDY_ACTIVITY_TIMELINE: "off" });
  await off.prepareStorage();
  await off.start("ignored");
  await assert.rejects(readFile(projectGitignorePath(cwd)), { code: "ENOENT" });
  const custom = new ActivityTimelineRecorder(cwd, { PI_DADDY_ACTIVITY_TIMELINE: "custom/activity.jsonl" });
  await custom.prepareStorage();
  await custom.start("custom");
  assert.match(await readFile(custom.path, "utf8"), /task_started/u);
  await assert.rejects(readFile(projectGitignorePath(cwd)), { code: "ENOENT" });
  const normal = new ActivityTimelineRecorder(cwd, {});
  const preparation = normal.prepareStorage();
  assert.equal(normal.prepareStorage(), preparation);
  await preparation;
  assert.equal(normal.prepareStorage(), preparation);
});
