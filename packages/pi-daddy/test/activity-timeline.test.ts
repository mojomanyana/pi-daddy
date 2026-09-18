import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityTimelineAliases, parseActivityTimeline, renderActivityTimeline } from "../src/activity-timeline.ts";

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
  assert.match(renderActivityTimeline(timeline, { filter: "skills", details: true }), /SKILL review.*read yes.*declared active no/);
  assert.match(renderActivityTimeline(timeline, { filter: "agents" }), /review.*completed/);
});

test("timeline groups child outcomes under a clearly-ended parent with stable short aliases", () => {
  const parent = "parent-turn", children = ["launch-a", "launch-b", "launch-c"];
  const timeline = parseActivityTimeline([
    event("task_started", { taskId: parent, model: "model-a" }),
    ...children.flatMap((taskId, index) => [
      event("task_started", { taskId, parentTaskId: parent, agent: "review" }),
      event("task_finished", { taskId, parentTaskId: parent, outcome: "failed", at: `2026-09-18T12:00:0${index}.000Z` }),
    ]),
    event("task_finished", { taskId: parent, outcome: "completed", at: "2026-09-18T12:00:09.000Z" }),
    event("skill_available", { taskId: parent, skill: { name: "unused", source: "/skills/unused", digest: "d".repeat(64) } }),
  ].map(value => JSON.stringify(value)).join("\n"));
  const aliases = new ActivityTimelineAliases();
  const output = renderActivityTimeline(timeline, { aliases, color: false });
  assert.match(output, /PARENT TURN ENDED/);
  assert.match(output, /OBSERVED CHILD FAILURES: 3 failed/);
  assert.match(output, /r1\/t1/);
  assert.match(output, /CHILD FAILED/);
  assert.doesNotMatch(output, /skill unused/, "availability-only runtime skills stay out of the default timeline");
  assert.match(renderActivityTimeline(timeline, { aliases, filter: "skills", color: false }), /SKILL unused.*available/);
  assert.equal(aliases.resolve("r1/t1"), "root-a:parent-turn");
  const narrow = renderActivityTimeline(timeline, { aliases, color: false, width: 32 });
  assert.doesNotMatch(narrow, /\u001b\[/, "color:false emits no terminal escapes");
  assert.ok(narrow.split("\n").every(line => line.length <= 32), "all activity lines honour the requested terminal width");
});

test("quiet activity history collapses with counts but preserves failed context", () => {
  const events = Array.from({ length: 5 }, (_, index) => [
    event("task_started", { taskId: `quiet-${index}`, agent: `quiet-${index}`, at: `2026-09-18T12:00:0${index}.000Z` }),
    event("task_finished", { taskId: `quiet-${index}`, at: `2026-09-18T12:01:0${index}.000Z` }),
  ]).flat();
  events.push(event("task_started", { taskId: "failed", at: "2026-09-18T12:02:00.000Z" }), event("task_finished", { taskId: "failed", outcome: "failed", at: "2026-09-18T12:03:00.000Z" }));
  const timeline = parseActivityTimeline(events.map(value => JSON.stringify(value)).join("\n"));
  const compact = renderActivityTimeline(timeline, { color: false });
  assert.match(compact, /2 quiet completed root tasks hidden/);
  assert.match(compact, /FAIL PARENT TURN FAILED/);
  assert.match(renderActivityTimeline(timeline, { color: false, history: true }), /quiet-0/);
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
