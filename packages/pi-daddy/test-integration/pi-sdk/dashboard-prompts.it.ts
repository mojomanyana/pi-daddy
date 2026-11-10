import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { registerDashboardPrompts } from "../../extensions/dashboard-ui-prompts.ts";
import type { DashboardSourceOwner } from "../../extensions/dashboard-sources.ts";
import { createFixture } from "./fixture-harness.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("real Pi SDK question events reach the dashboard and Herdr while the native UI is pending, with no provider requests", async () => {
  let owner: DashboardSourceOwner | undefined;
  let prompts: ReturnType<typeof registerDashboardPrompts> | undefined;
  const signals: { active: boolean; label?: string }[] = [];
  const answers: unknown[] = [];
  let entered = deferred<void>(),
    answer = deferred<unknown>();
  const waitForAnswer = () => {
    entered.resolve();
    return answer.promise;
  };
  const fixture = await createFixture({
    mode: "tui",
    extension: () => (pi) => {
      prompts = registerDashboardPrompts(pi, () => owner);
      pi.on("session_start", (_event, ctx) => {
        prompts!.reset();
        owner = { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd };
      });
      pi.events.on("herdr:blocked", (event) => {
        signals.push(event as (typeof signals)[number]);
      });
      pi.registerCommand("input-probe", {
        description: "Isolated native UI probe",
        handler: async (kind, ctx) => {
          if (kind === "select") answers.push(await ctx.ui.select("Choose a day", ["Monday", "Friday"]));
          else if (kind === "confirm") answers.push(await ctx.ui.confirm("Confirm this choice", "Save Friday?"));
          else if (kind === "input") answers.push(await ctx.ui.input("Delivery note"));
          else if (kind === "editor") answers.push(await ctx.ui.editor("Edit a draft", "Draft"));
          else answers.push(await ctx.ui.custom(() => ({ render: () => ["Information only"], invalidate() {} })));
        },
      });
    },
  });
  try {
    await fixture.session.bindExtensions({
      mode: "tui",
      uiContext: {
        select: waitForAnswer,
        confirm: waitForAnswer,
        input: waitForAnswer,
        editor: waitForAnswer,
        custom: waitForAnswer,
        notify() {},
      } as unknown as ExtensionUIContext,
      onError: (error) => {
        fixture.errors.push(error);
      },
    });
    for (const [kind, value] of [
      ["select", "Friday"],
      ["confirm", false],
      ["input", undefined],
      ["editor", "Private draft"],
    ] as const) {
      entered = deferred<void>();
      answer = deferred<unknown>();
      const running = fixture.session.prompt("/input-probe " + kind);
      await entered.promise;
      await setImmediate();
      assert.equal(prompts!.snapshot()?.kind, kind);
      assert.equal(signals.at(-1)?.active, true);
      answer.resolve(value);
      await running;
      await setImmediate();
      assert.equal(prompts!.snapshot(), undefined, "answer or cancellation clears the pending input");
      assert.equal(signals.at(-1)?.active, false);
    }
    entered = deferred<void>();
    answer = deferred<unknown>();
    const info = fixture.session.prompt("/input-probe information");
    await entered.promise;
    await setImmediate();
    assert.equal(prompts!.snapshot(), undefined, "a custom information panel is not a question");
    assert.equal(signals.length, 8);
    answer.resolve(undefined);
    await info;
    await setImmediate();
    assert.deepEqual(answers, ["Friday", false, undefined, "Private draft", undefined]);
    assert.deepEqual(
      signals.map((signal) => signal.active),
      [true, false, true, false, true, false, true, false],
    );
    assert.equal(fixture.requests.length, 0);
    assert.deepEqual(fixture.errors, []);
  } finally {
    prompts?.close();
    await fixture.close();
  }
});
