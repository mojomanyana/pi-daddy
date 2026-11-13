import assert from "node:assert/strict";
import { test } from "node:test";
import { registerDashboardLive } from "../extensions/dashboard-live.ts";
import { observedPurpose, toolPurpose } from "../src/products/activity-summary.ts";
import { activityStoryItems } from "../src/products/dashboard-activity.ts";

test("shipped ecosystem tools describe their purpose without private inputs or invented tool aliases", () => {
  const privateArgs = {
    get query(): never {
      throw Error("Private query must not be inspected");
    },
    get question(): never {
      throw Error("Private question must not be inspected");
    },
    get summary(): never {
      throw Error("Private note must not be inspected");
    },
    get reference(): never {
      throw Error("Private reference must not be inspected");
    },
    get prompt(): never {
      throw Error("Private prompt must not be inspected");
    },
    get model(): never {
      throw Error("Model selection must not affect labels");
    },
    get url(): never {
      throw Error("Source URL must not be inspected");
    },
  };
  for (const [tool, expected] of [
    ["bookie_search", "Search project memory"],
    ["bookie_remember", "Save a project note"],
    ["bookie_checkpoint", "Prepare a project handoff for review"],
    ["bookie_context_prepare", "Prepare selected project context"],
    ["bookie_reference_read", "Read a saved result"],
    ["research_sources", "List selected research sources"],
    ["research_read", "Read a research source"],
    ["research_brief", "Save a research brief"],
    ["scout_research", "Research a public question"],
    ["scout_brief_read", "Read a saved research brief"],
    ["skill_check_run", "Run skill evaluations"],
  ]) {
    assert.equal(observedPurpose(tool!, privateArgs, true), expected);
    assert.equal(observedPurpose(tool!, privateArgs, false), expected);
  }
  for (const tool of ["scout_search", "harness_run", "bookie_unknown", "__proto__", "constructor"]) {
    assert.equal(
      toolPurpose(tool, privateArgs),
      "Use a project tool",
      "only exact registered tool names are recognized",
    );
  }
});

test("only known public action enums refine a tool label; unknown and private actions remain generic", () => {
  for (const [tool, action, expected] of [
    ["bookie_write", "amend", "Update a project note"],
    ["bookie_context_read", "revalidate", "Recheck selected project context"],
    ["bookie_work", "schema", "Read the task-list format guide"],
    ["skill_author", "question", "Ask the next skill design question"],
    ["skill_author", "review-controls", "Review the example judgments"],
    ["skill_author", "contract-review", "Check evaluation criteria against the task"],
    ["skill_improvement", "propose", "Record a skill improvement proposal"],
    ["jev_advice", "status", "Check optional JEV availability"],
    ["jev_advice", "evaluate", "Ask JEV for optional advice"],
    ["jev_advice", "link-outcome", "Link an outcome to earlier JEV advice"],
  ])
    assert.equal(toolPurpose(tool!, { action }), expected);

  for (const action of [
    "__proto__",
    "constructor",
    "https://private.example/token=secret",
    {
      toString() {
        throw Error("Do not coerce actions");
      },
    },
  ]) {
    assert.equal(toolPurpose("skill_author", { action }), "Work on a skill draft");
    assert.equal(toolPurpose("jev_advice", { action }), "Check optional JEV advice");
  }
  assert.equal(toolPurpose("bookie_context_read"), "Read selected project context");
  assert.equal(toolPurpose("bookie_work", { action: "read" }), "Read the project task list");
  assert.equal(toolPurpose("skill_author", null), "Work on a skill draft");
});

test("ecosystem labels reach current work and history without changing failure status or exposing result contents", () => {
  const hooks = new Map<string, (event: any, ctx: any) => void>();
  const ctx = { sessionManager: { getSessionId: () => "session" } };
  const owner = { sessionId: "session", cwd: "/work" };
  const snapshot = registerDashboardLive(
    { on: (name: string, handler: any) => hooks.set(name, handler) } as never,
    () => owner,
  );
  const emit = (name: string, event: any) => hooks.get(name)!(event, ctx);
  emit("agent_start", {});
  for (const [tool, action, expected, isError] of [
    ["bookie_search", undefined, "Search project memory", false],
    ["scout_research", undefined, "Research a public question", true],
    ["skill_author", "review-controls", "Review the example judgments", false],
    ["jev_advice", "evaluate", "Ask JEV for optional advice", false],
  ] as const) {
    emit("tool_execution_start", {
      toolName: tool,
      toolCallId: tool,
      args: {
        action,
        query: "PRIVATE QUERY",
        question: "PRIVATE QUESTION",
        summary: "PRIVATE NOTE",
        url: "https://private.example/token=secret",
        dashboardSummary: "PRIVATE LABEL",
      },
    });
    assert.equal(snapshot().turn?.label, expected);
    emit("tool_execution_end", { toolName: tool, toolCallId: tool, isError, result: "PRIVATE RESULT" });
  }
  emit("agent_end", {});
  const view = snapshot();
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|private.example|token=secret/);
  const rows = activityStoryItems(view.activity, "owner", false);
  assert.equal(rows.find((row) => row.label === "Research a public question")?.status, "failed");
  assert.equal(rows.find((row) => row.label === "Search project memory")?.status, "finished");
  assert.ok(rows.every((row) => !["needs-you", "approval-wait"].includes(row.status)));
});
