import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { ActivityTimelineRecorder, activityTaskKey, defaultActivityTimelinePath, detailForTimeline, parseActivityTimeline } from "../src/products/activity-timeline.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("shared child recorder links an extension-disabled governed child without changing its grant", async () => {
  const cwd = await tempDir("activity-child-");
  const recorder = new ActivityTimelineRecorder(cwd, {});
  await recorder.childStarted("exec-child", "root:session-a", "review", "inspect the change");
  await recorder.childFinished("exec-child", "root:session-a", "review", "final text", "completed");
  const timeline = parseActivityTimeline(await readFile(defaultActivityTimelinePath(cwd), "utf8"));
  assert.equal(timeline.tasks[0]?.id, "exec-child");
  assert.equal(timeline.tasks[0]?.parentTaskId, "root:session-a");
  assert.equal(timeline.tasks[0]?.status, "finished");
});

test("exact prompt and final are loaded only by a validated task reference", async () => {
  const cwd = await tempDir("activity-detail-");
  const recorder = new ActivityTimelineRecorder(cwd, { PI_DADDY_ACTIVITY_ROOT: "root-a" });
  await recorder.start("submitted prompt"); await recorder.finish("exact final");
  const path = defaultActivityTimelinePath(cwd);
  const timeline = parseActivityTimeline(await readFile(path, "utf8"));
  const task = timeline.tasks[0]!, key = activityTaskKey(task.rootId, task.id);
  assert.equal((await detailForTimeline(path, key, "prompt")).text, "submitted prompt");
  assert.equal((await detailForTimeline(path, key, "final")).text, "exact final");
  await assert.rejects(detailForTimeline(path, "../secret", "final"), /TIMELINE_DETAIL_INVALID/);
});

test("detail selection binds root plus task and rejects an ambiguous task-id shorthand", async () => {
  const cwd = await tempDir("activity-detail-roots-"), path = defaultActivityTimelinePath(cwd);
  const first = new ActivityTimelineRecorder(cwd, { PI_DADDY_ACTIVITY_ROOT: "root-a" });
  const second = new ActivityTimelineRecorder(cwd, { PI_DADDY_ACTIVITY_ROOT: "root-b" });
  await first.childStarted("same-task", undefined, "one", "first prompt"); await first.childFinished("same-task", undefined, "one", "first final", "completed");
  await second.childStarted("same-task", undefined, "two", "second prompt"); await second.childFinished("same-task", undefined, "two", "second final", "completed");
  const timeline = parseActivityTimeline(await readFile(path, "utf8"));
  const firstKey = activityTaskKey("root-a", "same-task"), secondKey = activityTaskKey("root-b", "same-task");
  assert.notEqual(firstKey, secondKey);
  assert.equal((await detailForTimeline(path, firstKey, "prompt")).text, "first prompt");
  assert.equal((await detailForTimeline(path, firstKey, "final")).text, "first final");
  assert.equal((await detailForTimeline(path, secondKey, "prompt")).text, "second prompt");
  assert.equal((await detailForTimeline(path, secondKey, "final")).text, "second final");
  await assert.rejects(detailForTimeline(path, "same-task", "prompt"), /TIMELINE_DETAIL_INVALID/);
});

test("observation-off writes neither metadata nor private content", async () => {
  const cwd = await tempDir("activity-off-");
  const recorder = new ActivityTimelineRecorder(cwd, { PI_DADDY_ACTIVITY_TIMELINE: "off" });
  await recorder.start("private prompt");
  await assert.rejects(readFile(defaultActivityTimelinePath(cwd), "utf8"), { code: "ENOENT" });
});
