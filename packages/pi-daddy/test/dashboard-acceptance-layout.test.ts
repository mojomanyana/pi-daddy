import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardAcceptanceFixture } from "./dashboard-acceptance-fixture.ts";
import { cellWidth } from "../src/products/dashboard-render.ts";
import { renderDashboardScreen } from "../src/products/dashboard-screen.ts";

for (const [width, height] of [
  [64, 40],
  [150, 40],
]) {
  test(`terminal acceptance fixture ${width} columns separates active work, saved content and real requests`, () => {
    const { options, display } = dashboardAcceptanceFixture(width!, height!);
    function frame() {
      const rendered = renderDashboardScreen(options);
      assert.equal(rendered.split("\n").length, height);
      assert.ok(rendered.split("\n").every((line) => cellWidth(line) <= width!));
      assert.doesNotMatch(rendered, /sha256:|Live status unknown|Needs attention/);
      return rendered;
    }
    const running = frame();
    assert.match(running, /In progress[\s\S]*Build the workshop form · Running/);
    assert.match(running, /Open choices[\s\S]*When should the preview open\? · Open/);
    assert.match(running, /Memory[\s\S]*Workshop Desk progress[\s\S]*Research[\s\S]*Accessible workshop forms/);
    assert.doesNotMatch(running, /Needs your/);

    options.session!.pendingApprovals.push({ id: "permission", subject: "review", capability: "tool:bash" });
    const requested = frame();
    assert.match(requested, /Needs your permission[\s\S]*review needs shell access/);
    assert.match(requested, /Open choices[\s\S]*When should the preview open\? · Open/);
    options.session!.pendingApprovals = [];

    for (const [key, content] of [
      ["component:bookie", /Dispatchers managing the queue/],
      ["component:scout-worker", /Gap: keyboard reordering/],
    ] as const) {
      options.screen.selectedKey = key;
      frame();
      display.key("return");
      assert.match(frame(), content);
      display.key("escape");
    }
    // A new owner receives retained content but no current execution or inherited permission request.
    options.session!.observation!.sessionId = "after-new";
    delete options.session!.observation!.turn;
    const resumed = frame();
    assert.match(resumed, /Open choices[\s\S]*When should the preview open/);
    assert.match(resumed, /Workshop Desk progress/);
    assert.doesNotMatch(resumed, /In progress|Needs your/);
  });
}
