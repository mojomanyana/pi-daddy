import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { registerActivityTimeline } from "../extensions/activity-timeline.ts";
import {
  ActivityTimelineRecorder,
  activityTaskKey,
  ENV_ACTIVITY_PARENT_TASK,
  ENV_ACTIVITY_PATH,
  ENV_ACTIVITY_ROOT,
  ENV_ACTIVITY_TASK,
  defaultActivityTimelinePath,
  detailForTimeline,
  parseActivityTimeline,
} from "../src/products/activity-timeline.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

function fixture() {
  const hooks = new Map<string, Function>(),
    tools = new Map<string, unknown>();
  return {
    hooks,
    tools,
    api: {
      on: (name: string, handler: Function) => hooks.set(name, handler),
      registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    },
  };
}
const ctx = (cwd: string) => ({ cwd, model: { id: "test-model" }, thinkingLevel: "high", ui: { notify: () => {} } });

test("activity recording follows the owner-reconciled episode after hook registration", async () => {
  const cwd = await tempDir("activity-episode-rebind-");
  const app = fixture();
  const state = {
    activityRootId: "root-session",
    episodeId: "episode:00000000-0000-4000-8000-000000000001",
  };
  registerActivityTimeline(app.api as never, state);
  await app.hooks.get("session_start")!({}, ctx(cwd));
  state.episodeId = "episode:00000000-0000-4000-8000-000000000002";
  await app.hooks.get("before_agent_start")!({ prompt: "turn", systemPromptOptions: {} }, ctx(cwd));
  await app.hooks.get("context")!({}, ctx(cwd));
  const records = (await readFile(defaultActivityTimelinePath(cwd), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).body);
  assert.ok(records.every((record) => record.episodeId === state.episodeId));
});

test("actual extension hooks record root turns, skill availability/read/declaration, and an injected leaf in one root", async () => {
  const cwd = await tempDir("activity-hooks-"),
    skill = join(cwd, "skills", "review", "SKILL.md");
  await mkdir(join(cwd, "skills", "review"), { recursive: true });
  await writeFile(skill, "---\nname: review\n---\nreview\n");
  const root = fixture(),
    state: { activityRootId?: string; activity?: { rootId: string; path: string; taskId?: string } } = {
      activityRootId: "root-session",
    };
  registerActivityTimeline(root.api as never, state);
  await root.hooks.get("session_start")!({}, ctx(cwd));
  await root.hooks.get("before_agent_start")!(
    { prompt: "pre-transform prompt", systemPromptOptions: { skills: [{ name: "review", filePath: skill }] } },
    ctx(cwd),
  );
  root.hooks.get("message_end")!({ message: { role: "user", content: "finalized submitted prompt" } });
  await root.hooks.get("context")!({}, ctx(cwd));
  const turn = state.activity!.taskId!;
  root.hooks.get("tool_execution_start")!({ toolCallId: "read-1", args: { path: skill } });
  await root.hooks.get("tool_execution_end")!({ toolCallId: "read-1", toolName: "read", isError: false });
  const lifecycle = root.tools.get("activity_lifecycle") as { execute: Function };
  await lifecycle.execute("x", { state: "active", name: "review", source: skill, digest: "a".repeat(64) });
  root.hooks.get("message_end")!({ message: { role: "assistant", content: "root final" } });
  await root.hooks.get("agent_settled")!({}, ctx(cwd));

  const prior = Object.fromEntries(
    [ENV_ACTIVITY_PATH, ENV_ACTIVITY_ROOT, ENV_ACTIVITY_TASK, ENV_ACTIVITY_PARENT_TASK].map((key) => [
      key,
      process.env[key],
    ]),
  );
  Object.assign(process.env, {
    [ENV_ACTIVITY_PATH]: defaultActivityTimelinePath(cwd),
    [ENV_ACTIVITY_ROOT]: "root-session",
    [ENV_ACTIVITY_TASK]: "exec-leaf",
    [ENV_ACTIVITY_PARENT_TASK]: turn,
  });
  try {
    const seam = new ActivityTimelineRecorder(cwd, process.env);
    await seam.childStarted("exec-leaf", turn, "review", "child prompt");
    const leaf = fixture();
    registerActivityTimeline(leaf.api as never, undefined, false);
    await leaf.hooks.get("session_start")!({}, ctx(cwd));
    await leaf.hooks.get("before_agent_start")!(
      {
        prompt: "child must not create a second task",
        systemPromptOptions: { skills: [{ name: "review", filePath: skill }] },
      },
      ctx(cwd),
    );
    leaf.hooks.get("tool_execution_start")!({ toolCallId: "read-2", args: { path: skill } });
    await leaf.hooks.get("tool_execution_end")!({ toolCallId: "read-2", toolName: "read", isError: false });
  } finally {
    for (const [key, value] of Object.entries(prior))
      value === undefined ? delete process.env[key] : (process.env[key] = value);
  }

  const timeline = parseActivityTimeline(await readFile(defaultActivityTimelinePath(cwd), "utf8"));
  assert.equal(
    timeline.tasks.length,
    2,
    "the observer attaches to the parent-owned child execution instead of inventing another child task",
  );
  const task = timeline.tasks.find((value) => value.id === "exec-leaf")!;
  assert.equal(task.rootId, "root-session");
  assert.equal(task.parentTaskId, turn);
  assert.equal(
    (await detailForTimeline(defaultActivityTimelinePath(cwd), activityTaskKey("root-session", turn), "prompt")).text,
    "finalized submitted prompt",
  );
  assert.equal(task.skills.find((value) => value.source === skill)?.available, true);
  assert.equal(task.skills.find((value) => value.source === skill)?.read, true);
  assert.equal(
    timeline.tasks.find((value) => value.id === turn)?.skills.find((value) => value.digest === "a".repeat(64))?.active,
    true,
    "declared active remains distinct from observed read",
  );
});

test("real Pi hook order binds consecutive finalized prompts and finals without steering leakage", async () => {
  const cwd = await tempDir("activity-current-turn-");
  const app = fixture();
  const branch: Array<{ id: string; type: string; message: { role: string; content: string } }> = [];
  const context = { ...ctx(cwd), sessionManager: { getBranch: () => branch } };
  registerActivityTimeline(app.api as never, { activityRootId: "root-current" });
  await app.hooks.get("session_start")!({}, context);
  const message = (role: string, observed: string, finalized = observed) => {
    app.hooks.get("message_end")!({ message: { role, content: observed } });
    // Later Pi message_end handlers may transform the message after our observer ran.
    branch.push({ id: String(branch.length), type: "message", message: { role, content: finalized } });
  };
  for (const prompt of ["first", "second"]) {
    await app.hooks.get("before_agent_start")!({ prompt: `expanded ${prompt}` }, context);
    message("user", `observed ${prompt}`, `finalized ${prompt}`);
    await app.hooks.get("context")!({}, context);
    message("user", `steer ${prompt}`);
    await app.hooks.get("context")!({}, context);
    message("assistant", `observed final ${prompt}`, `final ${prompt}`);
    await app.hooks.get("agent_settled")!({}, context);
    const settledBytes = await readFile(defaultActivityTimelinePath(cwd), "utf8");
    await app.hooks.get("agent_settled")!({}, context);
    assert.equal(
      await readFile(defaultActivityTimelinePath(cwd), "utf8"),
      settledBytes,
      "settlement cannot append twice",
    );
  }
  const timeline = parseActivityTimeline(await readFile(defaultActivityTimelinePath(cwd), "utf8"));
  assert.equal(timeline.tasks.length, 2);
  for (const [index, task] of timeline.tasks.entries()) {
    const name = index === 0 ? "first" : "second";
    const key = activityTaskKey(task.rootId, task.id);
    assert.equal((await detailForTimeline(defaultActivityTimelinePath(cwd), key, "prompt")).text, `finalized ${name}`);
    assert.equal((await detailForTimeline(defaultActivityTimelinePath(cwd), key, "final")).text, `final ${name}`);
  }
});

test("cancellation before context and a session boundary cannot reuse a prior prompt or final", async () => {
  const cwd = await tempDir("activity-cancel-current-");
  const app = fixture();
  registerActivityTimeline(app.api as never, { activityRootId: "root-cancel" });
  const context = ctx(cwd);
  await app.hooks.get("session_start")!({}, context);
  await app.hooks.get("before_agent_start")!({ prompt: "cancelled request" }, context);
  app.hooks.get("message_end")!({ message: { role: "user", content: "final cancelled request" } });
  await app.hooks.get("agent_settled")!({ aborted: true }, context);
  await app.hooks.get("before_agent_start")!({ prompt: "never submitted" }, context);
  await app.hooks.get("agent_settled")!({ aborted: true }, context);
  await app.hooks.get("before_agent_start")!({ prompt: "old pending session" }, context);
  await app.hooks.get("session_shutdown")!({}, context);
  await app.hooks.get("session_start")!({}, context);
  await app.hooks.get("before_agent_start")!({ prompt: "new session input" }, context);
  await app.hooks.get("context")!({}, context);
  app.hooks.get("message_end")!({ message: { role: "assistant", content: "new final" } });
  await app.hooks.get("agent_settled")!({}, context);
  const timeline = parseActivityTimeline(await readFile(defaultActivityTimelinePath(cwd), "utf8"));
  assert.equal(timeline.tasks.length, 3);
  const prompts = await Promise.all(
    timeline.tasks.map(
      async (task) =>
        (await detailForTimeline(defaultActivityTimelinePath(cwd), activityTaskKey(task.rootId, task.id), "prompt"))
          .text,
    ),
  );
  assert.deepEqual(prompts, ["final cancelled request", "never submitted", "new session input"]);
  assert.deepEqual(
    timeline.tasks.map((task) => task.status),
    ["cancelled", "cancelled", "finished"],
  );
  assert.ok(timeline.tasks.slice(0, 2).every((task) => task.final === undefined));
});

test("settlement follows Pi aborted and error outcomes while length remains a finished turn", async () => {
  const cwd = await tempDir("activity-stop-reasons-");
  const app = fixture();
  registerActivityTimeline(app.api as never, { activityRootId: "root-stop" });
  const context = ctx(cwd);
  await app.hooks.get("session_start")!({}, context);
  for (const stopReason of ["error", "length", "aborted"]) {
    await app.hooks.get("before_agent_start")!({ prompt: stopReason }, context);
    await app.hooks.get("context")!({}, context);
    app.hooks.get("message_end")!({ message: { role: "assistant", content: stopReason, stopReason } });
    await app.hooks.get("agent_settled")!({}, context);
  }
  const timeline = parseActivityTimeline(await readFile(defaultActivityTimelinePath(cwd), "utf8"));
  assert.deepEqual(
    timeline.tasks.map((task) => task.status),
    ["failed", "finished", "cancelled"],
  );
});

test("tool hooks retain names and actual cwd without arguments, outputs or inferred progress", async () => {
  const cwd = await tempDir("activity-tool-observed-"),
    app = fixture();
  registerActivityTimeline(app.api as never);
  await app.hooks.get("session_start")!({}, ctx(cwd));
  await app.hooks.get("before_agent_start")!({ prompt: "inspect", systemPromptOptions: {} }, ctx(cwd));
  await app.hooks.get("context")!({}, ctx(cwd));
  await app.hooks.get("tool_execution_start")!(
    { toolCallId: "observed", toolName: "bash", args: { command: "private-argument" } },
    ctx(cwd),
  );
  await app.hooks.get("tool_execution_end")!(
    { toolCallId: "observed", toolName: "bash", isError: true, result: "private-result" },
    ctx(cwd),
  );
  const text = await readFile(defaultActivityTimelinePath(cwd), "utf8");
  const task = parseActivityTimeline(text).tasks[0];
  assert.equal(task.cwd, cwd);
  assert.equal(task.lastEvent?.kind, "tool_finished");
  assert.equal(task.lastEvent?.tool, "bash");
  assert.equal(task.status, "active");
  assert.doesNotMatch(text, /private-argument|private-result/);
});
