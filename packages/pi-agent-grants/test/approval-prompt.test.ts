import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createApprovalGate,
  createApprovalGateProvider,
  timeoutMsFromEnv,
  type ApprovalUI,
} from "../src/approval-prompt.ts";

// The third argument is captured, not discarded: `opts.timeout` is the only reason an unattended dialog
// eventually denies, and `opts.signal` is the only reason a cancelled turn does not orphan one. Dropping
// them from the `select` call is silent unless a test looks.
const recordingUI = (answer: string | undefined) => {
  const calls: Array<{
    title: string;
    options: string[];
    opts?: { timeout?: number; signal?: AbortSignal };
  }> = [];
  const ui: ApprovalUI = {
    select: async (title, options, opts) => {
      calls.push({ title, options, opts });
      return answer;
    },
    notify: () => {},
  };
  return { ui, calls };
};

const req = (over = {}) => ({
  capability: "tool:write",
  subject: "docs-writer",
  path: "interceptor" as const,
  task: "fix the docs typos",
  ...over,
});

test("with no interactive user the gate denies without asking", async () => {
  const { ui, calls } = recordingUI("Allow once");
  const gate = createApprovalGate({ ui, hasUI: false, mode: "print" });
  const outcome = await gate.request(req());
  assert.equal(outcome.scope, null);
  assert.equal(outcome.kind, "no-ui", "nobody was there to ask — not a human declining");
  assert.equal(calls.length, 0, "no dialog is attempted when there is nobody to see it");
});

test("the no-human refusal names the cause AND the fix", async () => {
  const { ui } = recordingUI(undefined);
  const gate = createApprovalGate({ ui, hasUI: false, mode: "print" });
  const outcome = await gate.request(req());
  assert.match(outcome.reason ?? "", /tool:write/);
  assert.match(outcome.reason ?? "", /print/, "says which mode it was in");
  assert.match(outcome.reason ?? "", /pre-approve/i, "says what to do about it");
});

test("dismissing the dialog denies", async () => {
  const { ui } = recordingUI(undefined);
  const gate = createApprovalGate({ ui, hasUI: true, mode: "tui" });
  const outcome = await gate.request(req());
  assert.equal(outcome.scope, null);
  assert.equal(outcome.kind, "dismissed", "a timeout/dismissal/abort is not a person declining");
});

test("choosing deny denies", async () => {
  const { ui, calls } = recordingUI("Deny");
  const gate = createApprovalGate({ ui, hasUI: true, mode: "tui" });
  const outcome = await gate.request(req());
  assert.equal(outcome.scope, null);
  assert.equal(outcome.kind, "declined", "only an explicit Deny is a human actually saying no");
  assert.equal(calls[0].options[0], "Deny", "deny is first, so the safe answer is the default");
});

test("allow once yields the once scope", async () => {
  const { ui } = recordingUI("Allow once");
  const gate = createApprovalGate({ ui, hasUI: true, mode: "tui" });
  const outcome = await gate.request(req());
  assert.equal(outcome.scope, "once");
  assert.equal(outcome.kind, "granted");
});

test("an unrecognised choice denies as an error, not as a decline or a dismissal", async () => {
  // Cannot happen through the real dialog (the option list is closed), but a caller supplying a plain
  // object per ApprovalUI could return anything — this must still fail closed and be labelled honestly.
  const { ui } = recordingUI("some string the dialog never offered");
  const gate = createApprovalGate({ ui, hasUI: true, mode: "tui" });
  const outcome = await gate.request(req());
  assert.equal(outcome.scope, null);
  assert.equal(outcome.kind, "error");
  assert.match(outcome.reason ?? "", /unrecognised/i);
});

test("a throwing select denies as an error, not as a decline or a dismissal", async () => {
  const ui: ApprovalUI = {
    select: async () => {
      throw new Error("dialog backend exploded");
    },
    notify: () => {},
  };
  const gate = createApprovalGate({ ui, hasUI: true, mode: "tui" });
  const outcome = await gate.request(req());
  assert.equal(outcome.scope, null);
  assert.equal(outcome.kind, "error");
  assert.match(outcome.reason ?? "", /dialog failed/i);
});

test("the interceptor path offers always; the delegate path does not", async () => {
  const a = recordingUI("Deny");
  await createApprovalGate({ ui: a.ui, hasUI: true, mode: "tui" }).request(req());
  assert.equal(a.calls[0].options.length, 4);

  const b = recordingUI("Deny");
  await createApprovalGate({ ui: b.ui, hasUI: true, mode: "tui" }).request(req({ path: "delegate" }));
  assert.equal(b.calls[0].options.length, 3);
  assert.ok(!b.calls[0].options.some((o) => /always/i.test(o)));
});

test("the prompt shows the task, so the human sees what they are approving", async () => {
  const { ui, calls } = recordingUI("Deny");
  await createApprovalGate({ ui, hasUI: true, mode: "tui" }).request(req());
  const shown = `${calls[0].title}`;
  assert.match(shown, /tool:write/);
  assert.match(shown, /docs-writer/);
  assert.match(shown, /fix the docs typos/, "the task is shown for context");
});

test("when task is absent the prompt has no stray task line", async () => {
  const { ui, calls } = recordingUI("Deny");
  await createApprovalGate({ ui, hasUI: true, mode: "tui" }).request(req({ task: undefined }));
  const shown = `${calls[0].title}`;
  assert.ok(!shown.includes("task:"), "no task line when task is absent");
});

test("single-flight: two concurrent requests for the same key raise ONE dialog", async () => {
  let calls = 0;
  let release: (v: string) => void = () => {};
  const pending = new Promise<string>((r) => (release = r));
  const ui: ApprovalUI = {
    select: async () => {
      calls += 1;
      return pending;
    },
    notify: () => {},
  };
  const gate = createApprovalGate({ ui, hasUI: true, mode: "tui" });
  const both = Promise.all([gate.request(req()), gate.request(req())]);
  release("Allow once");
  const [a, b] = await both;
  assert.equal(calls, 1, "the second request awaited the first dialog");
  assert.equal(a.scope, "once");
  assert.equal(b.scope, "once");
});

test("different keys prompt separately", async () => {
  let calls = 0;
  const ui: ApprovalUI = {
    select: async () => {
      calls += 1;
      return "Allow once";
    },
    notify: () => {},
  };
  const gate = createApprovalGate({ ui, hasUI: true, mode: "tui" });
  await Promise.all([gate.request(req()), gate.request(req({ capability: "tool:bash" }))]);
  assert.equal(calls, 2);
});

test("the timeout and the abort signal actually reach ui.select", async () => {
  // Deleting `{ timeout, signal }` from the select call changes no other assertion in this file, yet it
  // removes the dialog's only self-termination: an unattended prompt would wait forever and a cancelled
  // turn would leave one orphaned. So it is asserted directly.
  const { ui, calls } = recordingUI("Deny");
  const controller = new AbortController();
  const gate = createApprovalGate({ ui, hasUI: true, mode: "tui", timeoutMs: 45_000 });
  await gate.request(req({ signal: controller.signal }));

  assert.equal(calls[0].opts?.timeout, 45_000, "the configured timeout is handed to the dialog");
  assert.equal(calls[0].opts?.signal, controller.signal, "the caller's signal is handed to the dialog");
});

test("no configured timeout is passed through as no timeout, not as a default invented here", async () => {
  const { ui, calls } = recordingUI("Deny");
  await createApprovalGate({ ui, hasUI: true, mode: "tui" }).request(req({ signal: undefined }));
  assert.equal(calls[0].opts?.timeout, undefined);
  assert.equal(calls[0].opts?.signal, undefined);
});

test("single-flight survives the CALLER's pattern: a fresh gate per invocation still raises ONE dialog", async () => {
  // The wiring builds a gate per invocation, because the gate's options come from that call's
  // ExtensionContext. A gate owning its queue privately therefore de-duplicates nothing across
  // invocations — which is the production case: two concurrent delegations are two invocations. This test
  // exercises that shape (two separate gates), not the easier one (one gate reused).
  let calls = 0;
  let release: (v: string) => void = () => {};
  const pending = new Promise<string>((r) => (release = r));
  const ui: ApprovalUI = {
    select: async () => {
      calls += 1;
      return pending;
    },
    notify: () => {},
  };

  const gateFor = createApprovalGateProvider();
  const options = { ui, hasUI: true, mode: "tui" };
  const first = gateFor(options).request(req()); // invocation 1 — its own gate object
  const second = gateFor(options).request(req()); // invocation 2 — a DIFFERENT gate object
  release("Allow once");
  const [a, b] = await Promise.all([first, second]);

  assert.equal(calls, 1, "the second invocation awaited the first invocation's dialog");
  assert.equal(a.scope, "once");
  assert.equal(b.scope, "once");
});

test("two independently created gates do NOT share a queue — the provider is what shares it", async () => {
  // The negative half, so the test above cannot pass for the wrong reason: this is the old behaviour, and
  // it is exactly what the production wiring used to do on every call.
  let calls = 0;
  let release: (v: string) => void = () => {};
  const pending = new Promise<string>((r) => (release = r));
  const ui: ApprovalUI = {
    select: async () => {
      calls += 1;
      return pending;
    },
    notify: () => {},
  };
  const options = { ui, hasUI: true, mode: "tui" };
  const both = Promise.all([
    createApprovalGate(options).request(req()),
    createApprovalGate(options).request(req()),
  ]);
  release("Allow once");
  await both;
  assert.equal(calls, 2, "separate gates each raise their own dialog — the stacked-dialog failure");
});

test("a provider's queue is released once the dialog resolves, so a later request asks again", async () => {
  const gateFor = createApprovalGateProvider();
  const { ui, calls } = recordingUI("Allow once");
  await gateFor({ ui, hasUI: true, mode: "tui" }).request(req());
  await gateFor({ ui, hasUI: true, mode: "tui" }).request(req());
  assert.equal(calls.length, 2, "single-flight de-duplicates concurrency, it does not cache answers");
});

test("the timeout env var is read in seconds and converted to milliseconds", () => {
  assert.equal(timeoutMsFromEnv("30"), 30_000);
  assert.equal(timeoutMsFromEnv(undefined), 120_000, "default is two minutes");
  assert.equal(timeoutMsFromEnv("0"), undefined, "zero means wait indefinitely");
  assert.equal(timeoutMsFromEnv("banana"), undefined, "unparseable means wait rather than guess");
});
