import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ActivityTimelineRecorder, defaultActivityTimelinePath, detailForTimeline, parseActivityTimeline } from "../src/activity-timeline.ts";

test("shared child recorder links an extension-disabled governed child without changing its grant", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "activity-child-"));
  const recorder = new ActivityTimelineRecorder(cwd, {});
  await recorder.childStarted("exec-child", "root:session-a", "review", "inspect the change");
  await recorder.childFinished("exec-child", "root:session-a", "review", "final text", "completed");
  const timeline = parseActivityTimeline(await readFile(defaultActivityTimelinePath(cwd), "utf8"));
  assert.equal(timeline.tasks[0]?.id, "exec-child");
  assert.equal(timeline.tasks[0]?.parentTaskId, "root:session-a");
  assert.equal(timeline.tasks[0]?.status, "finished");
});

test("exact prompt and final are loaded only by a validated task reference", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "activity-detail-"));
  const recorder = new ActivityTimelineRecorder(cwd, { PI_DADDY_ACTIVITY_ROOT: "root-a" });
  await recorder.start("submitted prompt"); await recorder.finish("exact final");
  const path = defaultActivityTimelinePath(cwd);
  const timeline = parseActivityTimeline(await readFile(path, "utf8"));
  const taskId = timeline.tasks[0]!.id;
  assert.equal((await detailForTimeline(path, taskId, "prompt")).text, "submitted prompt");
  assert.equal((await detailForTimeline(path, taskId, "final")).text, "exact final");
  await assert.rejects(detailForTimeline(path, "../secret", "final"), /TIMELINE_DETAIL_UNAVAILABLE/);
});

test("observation-off writes neither metadata nor private content", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "activity-off-"));
  const recorder = new ActivityTimelineRecorder(cwd, { PI_DADDY_ACTIVITY_TIMELINE: "off" });
  await recorder.start("private prompt");
  await assert.rejects(readFile(defaultActivityTimelinePath(cwd), "utf8"), { code: "ENOENT" });
});
