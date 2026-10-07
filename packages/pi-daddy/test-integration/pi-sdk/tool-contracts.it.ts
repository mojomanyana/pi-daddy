import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { createFixture } from "./fixture-harness.ts";
import { FINAL, MODEL, PROVIDER, textStep, toolStep } from "./scripted-provider.ts";

// Breaks if the wrapper stops forwarding preparation before validation or native isError.
test("Pi 1.0.4 prepares raw arguments before validation and preserves native error", async () => {
  const calls: unknown[] = [];
  const fixture = await createFixture({
    next: (_request, index) => (index === 0 ? toolStep("normalized", { value: "17" }) : textStep()),
    extension: () => (pi) => {
      pi.registerTool({
        name: "normalized",
        label: "normalized",
        description: "fixture",
        parameters: Type.Object({ value: Type.Number() }),
        prepareArguments(raw) {
          calls.push(["prepare", raw]);
          return { value: Number((raw as { value: string }).value) };
        },
        async execute(_id, args) {
          calls.push(["execute", args]);
          return { content: [{ type: "text", text: "native failure" }], details: { value: args.value }, isError: true };
        },
      });
      pi.on("tool_call", (event) => {
        calls.push(["hook", event.input]);
      });
    },
  });
  try {
    await fixture.session.prompt("exercise tool");
    assert.deepEqual(calls, [
      ["prepare", { value: "17" }],
      ["hook", { value: 17 }],
      ["execute", { value: 17 }],
    ]);
    const result = fixture.events.find((event) => event.type === "tool_execution_end");
    assert.equal(result.isError, true);
    assert.equal(result.result.isError, true);
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.requests[0].model.provider, PROVIDER);
    assert.equal(fixture.requests[0].model.id, MODEL);
    assert.equal(fixture.requests[0].options?.reasoning, "high");
    assert.equal(fixture.events.at(-1).type, "agent_settled");
    assert.equal(
      fixture.events.filter((e) => e.type === "message_end" && e.message.role === "assistant").at(-1).message.content[0]
        .text,
      FINAL,
    );
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

// Breaks if invalid prepared values bypass schema validation.
test("Pi rejects invalid prepared arguments without invoking hooks or execution", async () => {
  let executed = false;
  let hooked = false;
  const fixture = await createFixture({
    next: (_request, index) => (index === 0 ? toolStep("invalid", {}) : textStep()),
    extension: () => (pi) => {
      pi.registerTool({
        name: "invalid",
        label: "invalid",
        description: "fixture",
        parameters: Type.Object({ value: Type.Number() }),
        prepareArguments: () => ({ value: "still invalid" }) as never,
        async execute() {
          executed = true;
          return { content: [], details: {} };
        },
      });
      pi.on("tool_call", () => {
        hooked = true;
      });
    },
  });
  try {
    await fixture.session.prompt("invalid args");
    assert.equal(executed, false);
    assert.equal(hooked, false);
    assert.equal(fixture.events.find((e) => e.type === "tool_execution_end").isError, true);
  } finally {
    await fixture.close();
  }
});

for (const mode of ["returned", "thrown", "blocked", "post-hook"] as const) {
  // Breaks if an adapter forwards result.isError instead of the final sibling status.
  test(`nested ${mode} failure survives forwarding`, async () => {
    let outcome: any;
    const fixture = await createFixture({
      next: (_request, index) => (index === 0 ? toolStep("outer", {}) : textStep()),
      extension: () => (pi) => {
        pi.registerTool({
          name: "inner",
          label: "inner",
          description: "fixture",
          exposure: "codemode",
          parameters: Type.Object({}),
          async execute() {
            if (mode === "thrown") throw new Error("thrown fixture");
            return {
              content: [{ type: "text", text: "inner result" }],
              details: { preserved: true },
              structuredContent: { preserved: true },
              ...(mode === "returned" ? { isError: true } : {}),
            };
          },
        });
        pi.registerTool({
          name: "outer",
          label: "outer",
          description: "fixture",
          parameters: Type.Object({}),
          async execute(_id, _args, _signal, _update, ctx) {
            outcome = await ctx.executeTool("inner", {});
            return { ...outcome.result, isError: outcome.isError };
          },
        });
        pi.on("session_start", () => {
          pi.setActiveTools(["outer"]);
        });
        pi.on("tool_call", (e) => {
          if (mode === "blocked" && e.toolName === "inner") return { block: true, reason: "blocked fixture" };
        });
        pi.on("tool_result", (e) => {
          if (mode === "post-hook" && e.toolName === "inner") return { isError: true };
        });
      },
    });
    try {
      await fixture.session.prompt("nested failure");
      assert.equal(outcome.isError, true);
      if (mode !== "returned") assert.equal(outcome.result.isError, undefined);
      assert.equal(fixture.events.find((e) => e.type === "tool_execution_end" && e.toolName === "outer").isError, true);
      const nested = fixture.events.find((e) => e.type === "tool_execution_end" && e.toolName === "inner");
      assert.equal(nested.parentToolCallId, "call-1");
      if (mode === "returned" || mode === "post-hook")
        assert.deepEqual(outcome.result.structuredContent, { preserved: true });
      assert.deepEqual(fixture.session.getActiveToolNames(), ["outer"]);
      assert.ok(fixture.session.getCallableToolNames().includes("inner"));
    } finally {
      await fixture.close();
    }
  });
}

// Breaks if active tools are mistakenly treated as the complete callable authority surface.
test("deactivation does not revoke codemode/deferred; model-only and hidden are not nested callable", async () => {
  let callable: string[] = [];
  let nested: any[] = [];
  const fixture = await createFixture({
    next: (_request, index) => (index === 0 ? toolStep("outer", {}) : textStep()),
    extension: () => (pi) => {
      for (const exposure of ["direct", "model-only", "codemode", "deferred", "hidden"] as const) {
        pi.registerTool({
          name: exposure,
          label: exposure,
          description: "fixture",
          exposure,
          parameters: Type.Object({}),
          async execute() {
            return { content: [], details: { exposure } };
          },
        });
      }
      pi.registerTool({
        name: "outer",
        label: "outer",
        description: "fixture",
        parameters: Type.Object({}),
        async execute(_id, _args, _signal, _update, ctx) {
          callable = ctx.tools.map((tool) => tool.name);
          for (const name of ["direct", "model-only", "codemode", "deferred", "hidden"])
            nested.push(await ctx.executeTool(name, {}));
          return { content: [], details: {} };
        },
      });
      pi.on("session_start", () => {
        pi.setActiveTools(["outer", "model-only"]);
      });
    },
  });
  try {
    await fixture.session.prompt("exposures");
    assert.deepEqual([...callable].sort(), ["codemode", "deferred", "outer"]);
    assert.deepEqual(
      nested.map((outcome) => outcome.isError),
      [true, true, false, false, true],
    );
  } finally {
    await fixture.close();
  }
});

// Breaks if a forwarding adapter duplicates nested usage already recorded by Pi.
test("nested usage is aggregated once when the forwarding result omits copied usage", async () => {
  const usage = {
    input: 5,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const fixture = await createFixture({
    next: (_request, index) => (index === 0 ? toolStep("outer", {}) : textStep()),
    extension: () => (pi) => {
      pi.registerTool({
        name: "inner",
        label: "inner",
        description: "usage fixture",
        exposure: "codemode",
        parameters: Type.Object({}),
        async execute() {
          return { content: [], details: {}, usage };
        },
      });
      pi.registerTool({
        name: "outer",
        label: "outer",
        description: "usage forwarding fixture",
        parameters: Type.Object({}),
        async execute(_id, _args, _signal, _update, ctx) {
          const outcome = await ctx.executeTool("inner", {});
          const { usage: _nestedUsage, ...result } = outcome.result;
          return { ...result, isError: outcome.isError };
        },
      });
    },
  });
  try {
    await fixture.session.prompt("nested usage");
    const result = fixture.events.find((e) => e.type === "message_end" && e.message.role === "toolResult").message;
    assert.equal(result.usage.totalTokens, 5);
    assert.equal(result.nestedCalls.calls.length, 1);
  } finally {
    await fixture.close();
  }
});
