import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerActivityTimeline } from "../extensions/activity-timeline.ts";
import { ActivityTimelineRecorder, activityTaskKey, ENV_ACTIVITY_PARENT_TASK, ENV_ACTIVITY_PATH, ENV_ACTIVITY_ROOT, ENV_ACTIVITY_TASK, defaultActivityTimelinePath, detailForTimeline, parseActivityTimeline } from "../src/activity-timeline.ts";

function fixture() { const hooks = new Map<string, Function>(), tools = new Map<string, unknown>(); return { hooks, tools, api: { on: (name: string, handler: Function) => hooks.set(name, handler), registerTool: (tool: { name: string }) => tools.set(tool.name, tool) } }; }
const ctx = (cwd: string) => ({ cwd, model: { id: "test-model" }, thinkingLevel: "high", ui: { notify: () => {} } });

test("actual extension hooks record root turns, skill availability/read/declaration, and an injected leaf in one root", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "activity-hooks-")), skill = join(cwd, "skills", "review", "SKILL.md");
  await mkdir(join(cwd, "skills", "review"), { recursive: true }); await writeFile(skill, "---\nname: review\n---\nreview\n");
  const root = fixture(), state: { activityRootId?: string; activity?: { rootId: string; path: string; taskId?: string } } = { activityRootId: "root-session" };
  registerActivityTimeline(root.api as never, state);
  await root.hooks.get("session_start")!({}, ctx(cwd));
  root.hooks.get("message_end")!({ message: { role: "user", content: "finalized submitted prompt" } });
  await root.hooks.get("before_agent_start")!({ prompt: "pre-transform prompt", systemPromptOptions: { skills: [{ name: "review", filePath: skill }] } }, ctx(cwd));
  const turn = state.activity!.taskId!;
  root.hooks.get("tool_execution_start")!({ toolCallId: "read-1", args: { path: skill } });
  await root.hooks.get("tool_execution_end")!({ toolCallId: "read-1", toolName: "read", isError: false });
  const lifecycle = root.tools.get("activity_lifecycle") as { execute: Function };
  await lifecycle.execute("x", { state: "active", name: "review", source: skill, digest: "a".repeat(64) });
  root.hooks.get("message_end")!({ message: { role: "assistant", content: "root final" } });
  await root.hooks.get("agent_settled")!({}, ctx(cwd));

  const prior = Object.fromEntries([ENV_ACTIVITY_PATH, ENV_ACTIVITY_ROOT, ENV_ACTIVITY_TASK, ENV_ACTIVITY_PARENT_TASK].map(key => [key, process.env[key]]));
  Object.assign(process.env, { [ENV_ACTIVITY_PATH]: defaultActivityTimelinePath(cwd), [ENV_ACTIVITY_ROOT]: "root-session", [ENV_ACTIVITY_TASK]: "exec-leaf", [ENV_ACTIVITY_PARENT_TASK]: turn });
  try {
    const seam = new ActivityTimelineRecorder(cwd, process.env); await seam.childStarted("exec-leaf", turn, "review", "child prompt");
    const leaf = fixture(); registerActivityTimeline(leaf.api as never, undefined, false);
    await leaf.hooks.get("session_start")!({}, ctx(cwd));
    await leaf.hooks.get("before_agent_start")!({ prompt: "child must not create a second task", systemPromptOptions: { skills: [{ name: "review", filePath: skill }] } }, ctx(cwd));
    leaf.hooks.get("tool_execution_start")!({ toolCallId: "read-2", args: { path: skill } });
    await leaf.hooks.get("tool_execution_end")!({ toolCallId: "read-2", toolName: "read", isError: false });
  } finally { for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value; }

  const timeline = parseActivityTimeline(await readFile(defaultActivityTimelinePath(cwd), "utf8"));
  assert.equal(timeline.tasks.length, 2, "the observer attaches to the parent-owned child execution instead of inventing another child task");
  const task = timeline.tasks.find(value => value.id === "exec-leaf")!;
  assert.equal(task.rootId, "root-session"); assert.equal(task.parentTaskId, turn);
  assert.equal((await detailForTimeline(defaultActivityTimelinePath(cwd), activityTaskKey("root-session", turn), "prompt")).text, "finalized submitted prompt");
  assert.equal(task.skills.find(value => value.source === skill)?.available, true);
  assert.equal(task.skills.find(value => value.source === skill)?.read, true);
  assert.equal(timeline.tasks.find(value => value.id === turn)?.skills.find(value => value.digest === "a".repeat(64))?.active, true, "declared active remains distinct from observed read");
});
