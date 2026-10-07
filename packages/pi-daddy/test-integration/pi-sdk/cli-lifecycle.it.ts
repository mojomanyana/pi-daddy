import assert from "node:assert/strict";
import test from "node:test";
import { runScenario } from "./capture.ts";
import { FINAL } from "./scripted-provider.ts";

for (const scenario of ["success", "error", "nested", "retry", "stop-then-error"]) {
  // Breaks if stable CLI lifecycle semantics change or scripted calls fail to exercise the real runtime.
  test(`actual CLI JSON lifecycle: ${scenario}`, async () => {
    const result = await runScenario(scenario);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.ok(!result.jsonl.includes("/home/"));
    const events = result.events;
    const messages = events.filter((e) => e.type === "message_end");
    assert.deepEqual(
      messages.slice(0, 2).map((e) => e.message.role),
      ["system", "user"],
    );
    const assistants = messages.filter((e) => e.message.role === "assistant");
    const terminal = assistants.at(-1).message;
    assert.equal(terminal.stopReason, ["error", "stop-then-error"].includes(scenario) ? "error" : "stop");
    assert.equal(terminal.thinkingLevel, "high");
    if (terminal.stopReason === "stop") assert.equal(terminal.content[0].text, FINAL);
    assert.deepEqual(events.at(-1), { type: "agent_settled" });
    assert.equal(events.filter((e) => e.type === "agent_settled").length, 1);
    if (scenario === "retry") {
      assert.deepEqual(
        events.filter((e) => e.type === "agent_end").map((e) => e.willRetry),
        [true, false],
      );
      assert.ok(events.some((e) => e.type === "auto_retry_end"));
    }
    if (scenario === "stop-then-error") {
      assert.deepEqual(
        assistants.map((e) => e.message.stopReason),
        ["stop", "error"],
      );
      assert.deepEqual(
        events.filter((e) => e.type === "agent_end").map((e) => e.willRetry),
        [false, false],
      );
    }
    if (scenario === "nested") {
      const inner = events.find((e) => e.type === "tool_execution_end" && e.toolName === "fixture_inner");
      assert.equal(inner.parentToolCallId, "call-1");
      assert.equal(inner.isError, true);
      assert.equal(inner.result.isError, undefined);
      assert.equal(inner.result.content[0].text, "nested fixture failure");
    }
  });
}
