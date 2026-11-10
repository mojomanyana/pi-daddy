import assert from "node:assert/strict";
import { test } from "node:test";
import { registerDashboardPrompts } from "../extensions/dashboard-ui-prompts.ts";
import type { DashboardSourceOwner } from "../extensions/dashboard-sources.ts";
import {
  dashboardScreenState,
  renderDashboardScreen,
  type DashboardScreenOptions,
} from "../src/products/dashboard-screen.ts";

function fixture() {
  const handlers = new Map<string, (...args: any[]) => void>();
  const emitted: { active: boolean; label?: string }[] = [];
  let owner: DashboardSourceOwner | undefined = { sessionId: "session-a", cwd: "/work" };
  const ctx = { hasUI: true, mode: "tui", cwd: "/work", sessionManager: { getSessionId: () => "session-a" } };
  const pi = {
    on(name: string, fn: any) {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
    events: {
      emit(name: string, body: any) {
        assert.equal(name, "herdr:blocked");
        emitted.push(body);
      },
    },
  };
  const view = registerDashboardPrompts(pi as never, () => owner);
  const event = (type: string, kind: string, title?: string, context = ctx) =>
    handlers.get(type)?.({ reason: "ui_prompt", kind, title }, context);
  return {
    view,
    event,
    emitted,
    handlers,
    ctx,
    replace: (next: typeof owner) => {
      owner = next;
    },
  };
}

test("actual native questions appear only while open and one start/end reaches Herdr", () => {
  for (const kind of ["select", "confirm", "input", "editor"]) {
    const f = fixture();
    f.event("ui_prompt_start", kind, "Choose the next task");
    f.event("ui_prompt_start", kind, "Choose the next task"); // duplicated observation
    assert.equal(f.view.snapshot()?.label, "Choose the next task");
    assert.deepEqual(f.emitted, [{ active: true, label: "Choose the next task" }]);
    f.event("ui_prompt_end", kind, "Another title");
    assert(f.view.snapshot());
    f.event("ui_prompt_end", kind, "Choose the next task"); // answer, Escape, timeout or UI failure
    f.event("ui_prompt_end", kind, "Choose the next task");
    assert.equal(f.view.snapshot(), undefined);
    assert.deepEqual(
      f.emitted.map((x) => x.active),
      [true, false],
    );
  }
});

test("custom information, print, RPC and a different owner never become an actionable request", () => {
  const f = fixture();
  f.event("ui_prompt_start", "custom", "Information");
  f.event("ui_prompt_start", "select", "RPC", { ...f.ctx, mode: "rpc" });
  f.event("ui_prompt_start", "select", "Print", { ...f.ctx, mode: "print" });
  f.event("ui_prompt_start", "select", "No UI", { ...f.ctx, hasUI: false });
  f.event("ui_prompt_start", "select", "Other folder", { ...f.ctx, cwd: "/other" });
  f.event("ui_prompt_start", "select", "Other session", {
    ...f.ctx,
    sessionManager: { getSessionId: () => "session-b" },
  });
  assert.equal(f.view.snapshot(), undefined);
  assert.deepEqual(f.emitted, []);
});

test("new session, reload replacement and shutdown clear only our pending Herdr signal", () => {
  const f = fixture();
  f.event("ui_prompt_start", "input", "Name");
  f.replace({ sessionId: "session-b", cwd: "/other" });
  assert.equal(f.view.snapshot(), undefined);
  f.event("ui_prompt_start", "input", "Old callback");
  assert.deepEqual(
    f.emitted.map((x) => x.active),
    [true, false],
  );
  f.replace({ sessionId: "session-a", cwd: "/work" });
  f.event("ui_prompt_start", "input", "New question");
  f.handlers.get("session_shutdown")?.({}, { ...f.ctx, sessionManager: { getSessionId: () => "old-session" } });
  assert.ok(f.view.snapshot(), "late shutdown from an old session does not clear the current question");
  f.handlers.get("session_shutdown")?.({}, f.ctx);
  assert.equal(f.view.snapshot(), undefined);
  f.event("ui_prompt_start", "input", "Another question");
  f.view.close();
  assert.equal(f.view.snapshot(), undefined);
  assert.equal(f.handlers.size, 0);
  assert.deepEqual(
    f.emitted.map((x) => x.active),
    [true, false, true, false, true, false],
  );
});

test("display only bounds and cleans the prompt title and never accepts supplied answers", () => {
  const f = fixture();
  f.handlers.get("ui_prompt_start")?.(
    { reason: "ui_prompt", kind: "input", title: "Name\u001b\n" + "x".repeat(250), answer: "PRIVATE" },
    f.ctx,
  );
  const snapshot = f.view.snapshot()!;
  assert.equal(snapshot.label.length, 160);
  assert.doesNotMatch(snapshot.label, /[\u0000-\u001f]/);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|answer/);
});

function options(): DashboardScreenOptions {
  return {
    width: 90,
    height: 24,
    connected: true,
    items: [],
    screen: dashboardScreenState(),
    session: {
      rows: [],
      cost: null,
      auto: { enabled: true, source: "session" },
      pendingApprovals: [],
      observation: {
        version: 1,
        sessionId: "a",
        cwd: "/work",
        generation: "g",
        sequence: 1,
        observedAt: new Date().toISOString(),
        sources: [],
        resources: { scope: "owner-process", sampledAt: new Date().toISOString(), rssBytes: 0, hostHealth: "unknown" },
        capture: { transcripts: false, diagnostics: false },
        inputPrompt: { id: "input:1", kind: "select", label: "Choose a delivery day" },
      },
    },
  };
}
test("dashboard shows the real question once, clears it and suppresses a duplicate permission", () => {
  const o = options();
  assert.match(renderDashboardScreen(o), /Needs your input/);
  assert.equal(o.screen.items.filter((i) => i.status === "needs-you").length, 1);
  assert.match(o.screen.items[0]!.briefDetails!.join(" "), /main Pi chat/);
  o.session!.pendingApprovals.push({ id: "gate", subject: "review", capability: "tool:bash" });
  renderDashboardScreen(o);
  assert.equal(o.screen.items.filter((i) => i.status === "needs-you").length, 1);
  assert.equal(o.screen.items.find((i) => i.status === "needs-you")?.approval, true);
  o.session!.pendingApprovals = [];
  o.connected = false;
  renderDashboardScreen(o);
  assert.equal(o.screen.items.filter((i) => i.status === "needs-you").length, 0);
  o.connected = true;
  delete o.session!.observation!.inputPrompt;
  renderDashboardScreen(o);
  assert.equal(o.screen.items.filter((i) => i.status === "needs-you").length, 0);
});
