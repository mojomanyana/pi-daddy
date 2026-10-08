import assert from "node:assert/strict";
import { test } from "node:test";
import { createApprovalGate, timeoutMsFromEnv, type ApprovalUI } from "../src/governance/approval-prompt.ts";

const request = { capability: "tool:write", subject: "build", path: "definition" as const };
function pendingUI() {
  let release!: (choice: string | undefined) => void;
  let signal: AbortSignal | undefined;
  let calls = 0;
  const ui: ApprovalUI = {
    notify() {},
    select: (_title, _options, opts) => {
      calls++;
      signal = opts?.signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  return { ui, release: (choice?: string) => release(choice), signal: () => signal, calls: () => calls };
}

test("interactive approval has no implicit two-minute expiry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dialog = pendingUI();
  const gate = createApprovalGate({
    ui: dialog.ui,
    hasUI: true,
    mode: "tui",
    timeoutMs: () => timeoutMsFromEnv(undefined),
  });
  let settled = false;
  const pending = gate.request(request).then((value) => {
    settled = true;
    return value;
  });
  t.mock.timers.tick(600_000);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(dialog.signal()?.aborted, false);
  dialog.release("Allow once");
  assert.equal((await pending).scope, "once");
});

test("explicit expiry denies promptly, closes the UI, rejects late approval and allows a new prompt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dialog = pendingUI();
  const gate = createApprovalGate({ ui: dialog.ui, hasUI: true, mode: "tui", timeoutMs: 1000 });
  const pending = gate.request(request);
  t.mock.timers.tick(1000);
  const expired = await pending;
  assert.equal(expired.kind, "expired");
  assert.equal(expired.scope, null);
  assert.match(expired.reason!, /Retry the delegation/);
  assert.equal(dialog.signal()?.aborted, true);
  dialog.release("Allow for this session");
  const retry = gate.request(request);
  assert.equal(dialog.calls(), 2);
  dialog.release("Allow once");
  assert.equal((await retry).scope, "once");
});

test("caller cancellation ends its own dialog even if the UI ignores its signal", async () => {
  const dialog = pendingUI();
  const controller = new AbortController();
  const gate = createApprovalGate({ ui: dialog.ui, hasUI: true, mode: "tui" });
  const pending = gate.request({ ...request, signal: controller.signal });
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.kind, "aborted");
  assert.equal(outcome.scope, null);
  assert.equal(dialog.signal()?.aborted, true);
  dialog.release("Allow once");
});

test("a canceled single-flight waiter returns without canceling the owner's approval", async () => {
  const dialog = pendingUI();
  const controller = new AbortController();
  const gate = createApprovalGate({ ui: dialog.ui, hasUI: true, mode: "tui" });
  const owner = gate.request(request);
  const waiter = gate.request({ ...request, signal: controller.signal });
  controller.abort();
  assert.equal((await waiter).kind, "aborted");
  assert.equal(dialog.signal()?.aborted, false);
  assert.equal(dialog.calls(), 1);
  dialog.release("Allow for this session");
  assert.equal((await owner).scope, "session");
});

test("dismissal and explicit denial remain separate from expiry and cancellation", async () => {
  for (const [answer, kind] of [
    [undefined, "dismissed"],
    ["Deny", "declined"],
  ] as const) {
    const gate = createApprovalGate({ ui: { notify() {}, select: async () => answer }, hasUI: true, mode: "tui" });
    const outcome = await gate.request(request);
    assert.equal(outcome.kind, kind);
    assert.equal(outcome.scope, null);
  }
});
