import assert from "node:assert/strict";
import { test, after } from "node:test";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
import { acquireInitiativeCoordinator } from "../src/governance/initiative-coordinator.ts";
import { initiativeDashboard } from "../extensions/initiative-dashboard.ts";
after(cleanupTempDirs);
test("terminal initiative refresh never replays semantic owner checks or renews fact timestamps", async () => {
  const root = await tempDir("initiative-display-");
  const task = { taskId: "TSK-one", taskRevision: "a".repeat(64), effectScope: "local" as const };
  const identity = { initiativeId: "bookie:v/p", taskId: task.taskId, taskRevision: task.taskRevision };
  let checks = 0,
    allowed = true,
    now = 1000;
  const coordinator = await acquireInitiativeCoordinator(
    root,
    { initiativeId: identity.initiativeId, owner: { sessionId: "owner", cwd: root }, expectedRevision: null },
    {
      assertAuthority() {
        checks++;
        if (!allowed) throw Error("scope revoked");
      },
      resolveAttempt: async () => "unknown",
    },
  );
  const display = initiativeDashboard(coordinator, [task], () => now);
  try {
    const baseline = checks;
    for (let i = 0; i < 20; i++) await display.refresh();
    assert.equal(checks, baseline, "display must not initiate even one semantic owner read");
    assert.equal(display.snapshot()!.items[1].state, "unavailable");
    assert.match(display.snapshot()!.items[1].details![3], /Not yet observed/);
    const revision = coordinator.revision();
    const observed = await coordinator.observe(identity, task);
    display.record(identity, observed, revision);
    await display.refresh();
    const originalTime = display.snapshot()!.observedAt,
      afterRead = checks;
    now += 300000;
    await display.refresh();
    assert.equal(checks, afterRead);
    assert.equal(display.snapshot()!.observedAt, originalTime, "redraw cannot make old facts fresh");
    assert.equal(display.snapshot()!.items[1].state, "unavailable");
    assert.match(display.snapshot()!.items[1].details![3], /stale/);
    await coordinator.claim(task);
    await display.refresh();
    assert.equal(display.snapshot()!.items[1].state, "unavailable");
    assert.match(display.snapshot()!.items[1].details![3], /stale/);
    const current = await coordinator.observe(identity, task);
    display.record(identity, current, coordinator.revision());
    await display.refresh();
    display.invalidate(identity);
    assert.equal(display.snapshot()!.items[1].state, "unavailable", "invalidation is visible before another refresh");
    allowed = false;
    const beforeRedraw = checks;
    await display.refresh();
    assert.equal(checks, beforeRedraw);
    await assert.rejects(coordinator.claim(task), /revoked/);
    assert.ok(checks > beforeRedraw, "real execution authority still revalidates");
  } finally {
    display.close();
    await coordinator.close();
  }
});
