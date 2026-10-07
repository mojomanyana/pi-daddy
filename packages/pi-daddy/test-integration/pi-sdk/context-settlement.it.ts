import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "./fixture-harness.ts";
import { FINAL, textStep } from "./scripted-provider.ts";

// Breaks if request-local context edits mutate canonical history or state.messages becomes authoritative.
test("context hooks transform the request while canonical manager and current branch own final attribution", async () => {
  const turns: any[] = [];
  const settled: any[] = [];
  let sawSystem = false;
  const fixture = await createFixture({
    extension: () => (pi) => {
      pi.on("context", (event) => {
        assert.ok(event.messages.every((m) => m.role !== "system"));
        return {
          messages: event.messages.map((message) =>
            message.role === "user" ? { ...message, content: "request-only" } : message,
          ),
        };
      });
      pi.on("context_with_system", (event) => {
        sawSystem = event.messages[0].role === "system";
      });
      pi.on("turn_end", (event, ctx) => {
        turns.push({
          entryId: event.messageEntryId,
          turnIndex: event.turnIndex,
          sessionId: ctx.sessionManager.getSessionId(),
          branch: structuredClone(ctx.sessionManager.getBranch()),
        });
      });
      pi.on("agent_settled", (_event, ctx) => {
        settled.push({
          sessionId: ctx.sessionManager.getSessionId(),
          leafId: ctx.sessionManager.getLeafId(),
          branch: structuredClone(ctx.sessionManager.getBranch()),
        });
      });
    },
  });
  try {
    await fixture.session.prompt("canonical original");
    assert.equal(sawSystem, true);
    assert.ok(
      fixture.requests[0].context.messages.some(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("request-only"),
      ),
    );
    const original = fixture.manager.getBranch().find((e) => e.type === "message" && e.message.role === "user")!;
    assert.ok(JSON.stringify(original).includes("canonical original"));
    assert.ok(!JSON.stringify(fixture.manager.getBranch()).includes("request-only"));
    fixture.session.agent.state.messages = [];
    await fixture.session.prompt("second canonical");
    assert.ok(
      fixture.requests[1].context.messages.some(
        (m) => m.role === "assistant" && m.content.some((c) => c.type === "text" && c.text === FINAL),
      ),
    );
    const firstAssistantId = turns[0].entryId;
    fixture.manager.branch(original.id);
    fixture.session.refreshContext();
    await fixture.session.prompt("new branch");
    const branch = settled.at(-1).branch;
    assert.ok(!branch.some((entry: any) => entry.id === firstAssistantId));
    assert.equal(settled.at(-1).sessionId, fixture.manager.getSessionId());
    assert.equal(settled.at(-1).leafId, turns.at(-1).entryId);
    const terminal = branch.find((entry: any) => entry.id === turns.at(-1).entryId);
    assert.equal(terminal.message.stopReason, "stop");
    assert.equal(terminal.message.content[0].text, FINAL);
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

// Breaks if agent_end is treated as success before boundary continuation and final settlement.
test("continuation can fail after an earlier stop; settlement has no outcome payload", async () => {
  const outcomes: string[] = [];
  let settlements = 0;
  const fixture = await createFixture({
    next: (_request, index) =>
      index === 0
        ? textStep("obsolete final")
        : {
            content: [{ type: "text", text: "failed partial" }],
            stopReason: "error",
            errorMessage: "later fixture failure",
          },
    extension: () => (pi) => {
      pi.on("agent_before_settle", (event) => {
        outcomes.push(event.outcome);
        if (outcomes.length === 1)
          return {
            entries: [
              { type: "custom_message", customType: "p01-continue", content: "continue fixture", display: false },
            ],
            continue: true,
          };
      });
      pi.on("agent_settled", (event) => {
        assert.deepEqual(event, { type: "agent_settled" });
        settlements++;
      });
    },
  });
  try {
    await fixture.session.prompt("boundary continuation");
    assert.deepEqual(outcomes, ["completed", "error"]);
    assert.equal(settlements, 1);
    assert.equal(fixture.requests.length, 2);
    const assistantEnds = fixture.events.filter((e) => e.type === "message_end" && e.message.role === "assistant");
    assert.deepEqual(
      assistantEnds.map((e) => e.message.stopReason),
      ["stop", "error"],
    );
    assert.equal(assistantEnds.at(-1).message.errorMessage, "later fixture failure");
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});
