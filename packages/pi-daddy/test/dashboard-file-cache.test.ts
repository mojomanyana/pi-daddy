import assert from "node:assert/strict";
import { after, test } from "node:test";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { dashboardFile, dashboardSelectedDetail } from "../src/products/dashboard-file-cache.ts";
import {
  ActivityTimelineRecorder,
  defaultActivityTimelinePath,
  parseActivityTimeline,
  activityTaskKey,
} from "../src/products/activity-timeline.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
test("metadata cache bounds reads and refreshes changed or missing files without rewriting them", async () => {
  const root = await tempDir("dashboard-cache-"),
    path = join(root, "metadata");
  await writeFile(path, "first");
  assert.equal(await dashboardFile(path, 1000), "first");
  await writeFile(path, "second");
  assert.equal(await dashboardFile(path, 1100), "first", "one second display cache is explicit");
  assert.equal(await dashboardFile(path, 2100), "second");
  await writeFile(path, "x".repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(dashboardFile(path, 3200), /exceeds 2 MiB/);
  await rm(path);
  await assert.rejects(dashboardFile(path, 4300), { code: "ENOENT" });
});
test("retained bodies are read once per explicit selection and revalidated for a new selection", async () => {
  const root = await tempDir("dashboard-selected-"),
    recorder = new ActivityTimelineRecorder(root, { PI_DADDY_ACTIVITY_ROOT: "selected-root" });
  await recorder.start("private selected prompt");
  await recorder.finish("private selected final");
  const path = defaultActivityTimelinePath(root),
    task = parseActivityTimeline(await readFile(path, "utf8")).tasks[0]!;
  const key = activityTaskKey(task.rootId, task.id),
    selection = { field: "final" as const };
  assert.equal((await dashboardSelectedDetail(selection, path, key)).text, "private selected final");
  await rm(path);
  assert.equal(
    (await dashboardSelectedDetail(selection, path, key)).text,
    "private selected final",
    "same visible snapshot does not re-read on redraw",
  );
  await assert.rejects(dashboardSelectedDetail({ field: "final" }, path, key));
});
