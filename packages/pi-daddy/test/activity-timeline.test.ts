import assert from "node:assert/strict";
import { test } from "node:test";
import { parseActivityTimeline, renderActivityTimeline } from "../src/activity-timeline.ts";

const at = "2026-09-18T12:00:00.000Z";
const event = (kind: string, overrides: Record<string, unknown> = {}) => ({
  version: 1, id: `evt-${kind}-${Object.keys(overrides).length}`, kind, at, rootId: "root-a", taskId: "task-a", ...overrides,
});

test("unified timeline separates skill reads from declared active use and keeps parent-child activity together", () => {
  const timeline = parseActivityTimeline([
    event("task_started", { prompt: { digest: "a".repeat(64), bytes: 5, ref: `content/${"a".repeat(64)}` }, model: "model-a", thinking: "high" }),
    event("skill_read", { skill: { name: "review", source: ".pi/skills/review/SKILL.md", digest: "b".repeat(64) } }),
    event("skill_active", { skill: { name: "review", source: ".pi/skills/review/SKILL.md", digest: "b".repeat(64) } }),
    event("skill_finished", { skill: { name: "review", source: ".pi/skills/review/SKILL.md", digest: "b".repeat(64) } }),
    event("agent_started", { agentId: "child-a", parentTaskId: "task-a", agent: "review" }),
    event("agent_finished", { agentId: "child-a", parentTaskId: "task-a", outcome: "completed" }),
    event("task_finished", { final: { digest: "c".repeat(64), bytes: 4, ref: `content/${"c".repeat(64)}` } }),
  ].map(value => JSON.stringify(value)).join("\n"));

  assert.equal(timeline.tasks.length, 1);
  assert.equal(timeline.tasks[0]?.skills[0]?.read, true);
  assert.equal(timeline.tasks[0]?.skills[0]?.active, false, "finished skill is no longer active");
  assert.equal(timeline.tasks[0]?.agents[0]?.parentTaskId, "task-a");
  assert.equal(timeline.tasks[0]?.status, "finished");
  assert.match(renderActivityTimeline(timeline, { filter: "skills", details: true }), /read; not declared active/);
  assert.match(renderActivityTimeline(timeline, { filter: "agents" }), /review.*completed/);
});

test("equal task ids from separate roots never mix parent activity", () => {
  const timeline = parseActivityTimeline([event("task_started"), event("task_started", { rootId: "root-b" })].map(value => JSON.stringify(value)).join("\n"));
  assert.equal(timeline.tasks.length, 2);
  assert.notEqual(timeline.tasks[0]?.rootId, timeline.tasks[1]?.rootId);
});

test("invalid, tampered and oversized private references refuse rather than exposing a path", () => {
  const timeline = parseActivityTimeline(`${JSON.stringify(event("task_started", { prompt: { digest: "nope", bytes: 999999, ref: "../../secret" } }))}\n`);
  assert.equal(timeline.refusals.length, 1);
  assert.match(renderActivityTimeline(timeline, { details: true }), /timeline refusal/);
});
