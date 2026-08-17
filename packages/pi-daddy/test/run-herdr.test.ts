/**
 * `runHerdrPane` — the herdr executor (ADR-0016 point 6).
 *
 * Every rule here is tested against an INJECTED `exec`, so the suite stays fast, pi-free and herdr-free.
 * The facts the fake reproduces were measured against real herdr 0.7.5 in `docs/probes/g16-herdr` — argv
 * delivered verbatim, env carried on the pane rather than the agent, and `wait --until idle` matching the
 * pre-existing state.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runHerdrPane, splitSystemPrompt, type HerdrExec } from "../src/run-herdr.ts";
import { MAX_OPEN_PANES, openPaneCount, reapOpenPanes, reapOpenPanesAsync, trackPane, trimOpenPanes } from "../src/pane-reaper.ts";
import { MAX_CHILDREN_PER_CALL } from "../src/fanout.ts";

interface FakeOptions {
  /** `state_change_seq` reported by `agent start`, i.e. the state BEFORE prompting. */
  startSeq?: number;
  /** Statuses returned by successive `agent get` calls. */
  getSequence?: Array<{ agent_status: string; state_change_seq: number }>;
  output?: string;
  failAt?: string;
}

function fakeHerdr(options: FakeOptions = {}) {
  const calls: string[][] = [];
  const gets = [...(options.getSequence ?? [{ agent_status: "idle", state_change_seq: 99 }])];

  const exec: HerdrExec = async (args) => {
    calls.push(args);
    const verb = args.slice(0, 2).join(" ");
    if (options.failAt && verb.startsWith(options.failAt)) {
      return { code: 1, stdout: JSON.stringify({ id: "x", error: { code: "boom", message: "it broke" } }), stderr: "" };
    }
    if (verb === "tab create") {
      return { code: 0, stdout: JSON.stringify({ id: "x", result: { root_pane: { pane_id: "w1:p9", tab_id: "w1:t9" } } }), stderr: "" };
    }
    if (verb === "agent start") {
      return {
        code: 0,
        stdout: JSON.stringify({ id: "x", result: { agent: { state_change_seq: options.startSeq ?? 10 }, argv: ["pi", ...args.slice(args.indexOf("--") + 1)] } }),
        stderr: "",
      };
    }
    if (verb === "agent prompt") return { code: 0, stdout: JSON.stringify({ id: "x", result: { ok: true } }), stderr: "" };
    if (verb === "agent get") {
      const next = gets.length > 1 ? gets.shift()! : gets[0];
      return { code: 0, stdout: JSON.stringify({ id: "x", result: { agent: next } }), stderr: "" };
    }
    if (verb === "agent read") {
      return { code: 0, stdout: JSON.stringify({ id: "x", result: { output: options.output ?? "the child's answer" } }), stderr: "" };
    }
    return { code: 0, stdout: JSON.stringify({ id: "x", result: { type: "ok" } }), stderr: "" };
  };

  return { exec, calls, verbs: () => calls.map((c) => c.slice(0, 2).join(" ")) };
}

/**
 * Drain the pane registry between tests.
 *
 * **Needed as of ADR-0032**, and its absence was a real failure while implementing it. Panes used to be closed
 * inside `runHerdrPane`, so the module-level registry was empty by the time each test returned. They now survive
 * the tool call by design, so every test that runs one leaves an entry — and the reaper tests further down were
 * asserting against panes their predecessors had left behind.
 *
 * `reapOpenPanes` with a no-op exec empties the map without needing herdr, which is what this suite is for.
 */
afterEach(() => void reapOpenPanes(() => {}));

const request = (over: Partial<Parameters<typeof runHerdrPane>[0]> = {}) => ({
  args: ["--no-session", "--no-extensions", "--tools", "read"],
  prompt: "review the diff",
  env: { PI_GRANTS_GRANT: "tool:read", PI_GRANTS_DEPTH: "1" },
  cwd: "/repo",
  name: "child-1",
  ...over,
});

test("the grant travels on the PANE, because agent start has no --env", () => {
  // Measured: `herdr agent start --help` has no --env; `tab create` does, and a pane's environment reaches
  // the shell that launches the agent. Put the env on the agent and the child silently loses its grant.
  const fake = fakeHerdr();
  return runHerdrPane(request({ exec: fake.exec })).then(() => {
    const create = fake.calls.find((c) => c[0] === "tab" && c[1] === "create")!;
    assert.ok(create.includes("--env"));
    assert.ok(create.includes("PI_GRANTS_GRANT=tool:read"), "the grant must be set on the pane");
    assert.ok(create.includes("PI_GRANTS_DEPTH=1"));
    const start = fake.calls.find((c) => c[0] === "agent" && c[1] === "start")!;
    assert.ok(!start.includes("--env"), "agent start does not accept it, so it must not be sent there");
  });
});

test("argv is passed after `--`, and the task is NOT in it", async () => {
  // Stronger than the direct-spawn path: there, a model-authored task has to be defended from pi's argv
  // parser (`neutralisePrompt`). Here it is delivered as a prompt, so no parser ever sees it.
  const fake = fakeHerdr();
  await runHerdrPane(request({ exec: fake.exec }));

  const start = fake.calls.find((c) => c[0] === "agent" && c[1] === "start")!;
  const after = start.slice(start.indexOf("--") + 1);
  assert.deepEqual(after, ["--no-session", "--no-extensions", "--tools", "read"]);
  assert.ok(!start.includes("review the diff"), "the task must not reach argv");

  const prompt = fake.calls.find((c) => c[0] === "agent" && c[1] === "prompt")!;
  assert.equal(prompt[3], "review the diff");
});

test("R-33: a pre-existing idle state does not count as completion", async () => {
  // The measured trap. `agent start` reports seq 10 and the agent is ALREADY idle at seq 10; a naive wait
  // returns instantly and the caller merges an empty result. Settling requires seq to advance.
  const fake = fakeHerdr({
    startSeq: 10,
    getSequence: [
      { agent_status: "idle", state_change_seq: 10 }, // stale — must be ignored
      { agent_status: "working", state_change_seq: 11 },
      { agent_status: "idle", state_change_seq: 12 }, // genuinely settled
    ],
  });

  const result = await runHerdrPane(request({ exec: fake.exec }));
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
  assert.match(result.text, /the child's answer/);
  assert.ok(fake.verbs().filter((v) => v === "agent get").length >= 3, "it must keep polling past the stale state");
});

test("R-33: `agent wait` is never used, because its contract cannot express 'after this point'", async () => {
  const fake = fakeHerdr();
  await runHerdrPane(request({ exec: fake.exec }));
  assert.ok(!fake.verbs().includes("agent wait"));
});

test("a FAILED run stops its agent and leaves the pane for the reaper", async () => {
  // **Rewritten for ADR-0032, which reverses what this asserted.** It used to require `tab close` on the
  // failure path, because the pane was scoped to the tool call. Panes now belong to the AGENT RUN and are swept
  // at `agent_settled` — and a failed child is exactly the one whose pane an operator most wants to read, so
  // closing it here would destroy the evidence.
  //
  // What survives from the original intent, and is asserted below: the agent is stopped (a pane outliving the
  // call must not mean a governed child keeps working), and the pane is TRACKED so nothing leaks.
  const fake = fakeHerdr({ failAt: "agent prompt" });
  const before = openPaneCount();
  const result = await runHerdrPane(request({ exec: fake.exec }));

  assert.match(String(result.spawnError), /prompt failed/);
  assert.ok(fake.verbs().includes("agent stop"), "the agent must still stop on the failure path");
  assert.ok(!fake.verbs().includes("tab close"), "but the pane survives for inspection (ADR-0032)");
  assert.equal(openPaneCount(), before + 1, "and it is tracked, so agent_settled or exit will reap it");

  await reapOpenPanesAsync(fakeHerdr().exec);
  assert.equal(openPaneCount(), before, "nothing leaks");
});

test("keepPane leaves the pane for a human to inspect", async () => {
  const fake = fakeHerdr();
  await runHerdrPane(request({ exec: fake.exec, keepPane: true }));
  assert.ok(!fake.verbs().includes("tab close"));
  assert.ok(fake.verbs().includes("agent stop"), "the agent still stops; only the pane survives");
});

test("an already-aborted signal creates nothing at all", async () => {
  const fake = fakeHerdr();
  const result = await runHerdrPane(request({ exec: fake.exec, signal: AbortSignal.abort() }));

  assert.equal(result.aborted, true);
  assert.deepEqual(fake.calls, [], "a pane must not be created for a run that was already cancelled");
});

test("a timeout still returns whatever the child produced, labelled", async () => {
  // R-03: a missing result must never be indistinguishable from an empty one.
  const fake = fakeHerdr({
    startSeq: 5,
    getSequence: [{ agent_status: "working", state_change_seq: 6 }],
    output: "partial findings so far",
  });

  const result = await runHerdrPane(request({ exec: fake.exec, timeoutMs: 30 }));
  assert.equal(result.timedOut, true);
  assert.match(result.text, /partial findings so far/);
});

test("a BLOCKED agent is reported as a failure, not as an answer", async () => {
  // pi is waiting for a human in a pane nobody may be watching. Returning its screen as though it were a
  // completed review is exactly the silent-success failure this project keeps closing.
  const fake = fakeHerdr({
    startSeq: 1,
    getSequence: [{ agent_status: "blocked", state_change_seq: 2 }],
  });

  const result = await runHerdrPane(request({ exec: fake.exec }));
  assert.equal(result.code, 1, "a non-zero code is what makes the caller treat this as a failure");
  assert.match(result.text, /BLOCKED waiting for a human/);
});

test("oversized output keeps the TAIL and says it was truncated", async () => {
  const fake = fakeHerdr({ output: `${"x".repeat(5000)}THE-ANSWER` });
  const result = await runHerdrPane(request({ exec: fake.exec, maxOutputBytes: 100 }));

  assert.equal(result.truncated, true);
  assert.match(result.text, /THE-ANSWER$/, "a terminal's useful content is its most recent output");
});

test("a non-JSON reply is a spawn error, not an empty answer", async () => {
  const exec: HerdrExec = async () => ({ code: 127, stdout: "herdr: command not found", stderr: "" });
  const result = await runHerdrPane(request({ exec }));

  assert.match(String(result.spawnError), /unparseable herdr reply/);
  assert.equal(result.text, "", "and it must not be reported as the child's output");
});

test("a multi-line system prompt is staged to a FILE, because herdr types argv into a shell", async () => {
  // Measured: herdr rejects it outright — `invalid_agent_argument: agent arguments cannot be encoded
  // safely for the target shell`. Every `delegate({agent})` spawn would fail on this path, since a
  // SKILL.md body is always multi-line. pi reads a path there as readily as literal text.
  const fake = fakeHerdr();
  const body = "# Tiny Review\n\nYou review code cold.\nNever edit.";
  await runHerdrPane(request({ exec: fake.exec, args: ["--tools", "read", "--append-system-prompt", body] }));

  const start = fake.calls.find((c) => c[0] === "agent" && c[1] === "start")!;
  const at = start.indexOf("--append-system-prompt");
  assert.ok(at > 0, "the flag is still passed");
  assert.ok(!start[at + 1].includes("\n"), "but its value must be a single-line path, not the body");
  assert.match(start[at + 1], /grants-herdr-.*system-prompt\.md$/);
  assert.ok(!start.some((a) => a.includes("Never edit")), "the body must not appear in argv at all");
});

test("splitSystemPrompt leaves argv alone when there is no system prompt", () => {
  const out = splitSystemPrompt(["--tools", "read"]);
  assert.deepEqual(out.args, ["--tools", "read"]);
  assert.equal(out.systemPrompt, undefined);
});

test("a plan carrying --print is refused, naming the flag", async () => {
  // Found by the first end-to-end run: --print makes pi exit before herdr can detect an interactive
  // agent, and herdr's own error for that is opaque. A caller/executor mismatch should read like one.
  const fake = fakeHerdr();
  const result = await runHerdrPane(request({ exec: fake.exec, args: ["--print", "--tools", "read"] }));

  assert.match(String(result.spawnError), /--print/);
  assert.deepEqual(fake.calls, [], "and nothing is created for a plan that cannot work");
});

test("agent start is retried while a fresh pane is still reaching its shell prompt", async () => {
  // Measured, and invisible until automated: `tab create` returns before the pane's shell is at a prompt,
  // and `agent start` requires one. Driving it by hand hid this entirely — the think-time between two
  // commands exceeded the shell's startup — and the first scripted run failed every time.
  let starts = 0;
  const inner = fakeHerdr();
  const exec: HerdrExec = async (args) => {
    if (args[0] === "agent" && args[1] === "start" && ++starts <= 2) {
      return {
        code: 1,
        stdout: JSON.stringify({ error: { code: "agent_pane_busy", message: "agent target pane w1:p9 is not an available shell" } }),
        stderr: "",
      };
    }
    return inner.exec(args);
  };

  const result = await runHerdrPane(request({ exec }));
  assert.equal(result.spawnError, undefined, "a pane that is merely slow must not fail the delegation");
  assert.equal(starts, 3, "it retries until the shell is ready");
});

test("a non-busy start error fails immediately instead of retrying to the deadline", async () => {
  // Retrying a real failure would turn a clear error into a timeout, which is strictly worse to debug.
  let starts = 0;
  const inner = fakeHerdr();
  const exec: HerdrExec = async (args) => {
    if (args[0] === "agent" && args[1] === "start") {
      starts += 1;
      return {
        code: 1,
        stdout: JSON.stringify({ error: { code: "invalid_agent_argument", message: "cannot be encoded safely" } }),
        stderr: "",
      };
    }
    return inner.exec(args);
  };

  const result = await runHerdrPane(request({ exec, timeoutMs: 5000 }));
  assert.match(String(result.spawnError), /cannot be encoded safely/);
  assert.equal(starts, 1, "no retry for an error that will never clear");
});

test("agent read returns RAW terminal text, not a JSON envelope", async () => {
  // The one command that breaks the pattern. Parsing it as JSON turned every successful read into
  // "unparseable herdr reply" — reporting the child's actual answer as a failure to read it. The unit fake
  // had been written to the envelope shape, so it agreed with the bug; only the end-to-end run disagreed.
  const inner = fakeHerdr();
  const exec: HerdrExec = async (args) =>
    args[0] === "agent" && args[1] === "read"
      ? { code: 0, stdout: "$ pi --tools read\n\nGOVERNED\n", stderr: "" }
      : inner.exec(args);

  const result = await runHerdrPane(request({ exec }));
  assert.match(result.text, /GOVERNED/);
  assert.ok(!result.text.includes("unparseable"), "raw text must not be reported as a read failure");
});

test("a JSON error reply from agent read is still recognised as an error", async () => {
  // Accepting raw text must not swallow a genuine failure: an error reply here IS JSON.
  const inner = fakeHerdr();
  const exec: HerdrExec = async (args) =>
    args[0] === "agent" && args[1] === "read"
      ? { code: 1, stdout: JSON.stringify({ error: { code: "agent_not_found", message: "gone" } }), stderr: "" }
      : inner.exec(args);

  const result = await runHerdrPane(request({ exec }));
  assert.match(result.text, /could not read the agent pane: gone/);
});

test("a completed run leaves its pane for agent_settled, and the sweep clears it", async () => {
  // **Rewritten for ADR-0032, which reverses what this asserted.** It used to require the registry to be empty
  // after a normal run, because `cleanup` closed the tab. That is precisely the behaviour ADR-0032 removes: a
  // pane destroyed the instant its child settles is unobservable, since a twenty-second child's pane is gone
  // before anyone can switch to it.
  //
  // The property that MATTERS is unchanged and is what this now asserts: the registry does not grow without
  // bound. One delegation leaves exactly one pane, and the sweep clears it.
  const before = openPaneCount();
  await runHerdrPane(request({ exec: fakeHerdr().exec }));
  assert.equal(openPaneCount(), before + 1, "the pane is kept, and tracked");

  assert.equal((await reapOpenPanesAsync(fakeHerdr().exec)).length, 1, "the agent_settled sweep closes it");
  assert.equal(openPaneCount(), before);
  assert.deepEqual(reapOpenPanes(() => {}), [], "and the exit backstop then has nothing left to do");
});

test("a pane orphaned by a killed process is closed by the reaper", async () => {
  // `finally` covers a thrown error and a timeout, NOT the process being killed — the gap this closes.
  // Simulated by tracking a pane and never running cleanup, which is precisely what a kill leaves behind.
  const closed: string[][] = [];
  trackPane({ tab: "w1:t42", name: "orphan" });
  assert.equal(openPaneCount(), 1);

  assert.deepEqual(reapOpenPanes((args) => void closed.push(args)), ["w1:t42"]);
  assert.deepEqual(closed, [["agent", "stop", "orphan"], ["tab", "close", "w1:t42"]], "the agent is stopped before its tab goes away");
  assert.equal(openPaneCount(), 0, "and a reaped pane is not reaped twice");
});

test("one pane herdr refuses to close does not strand the others", async () => {
  // At exit there is nowhere to report a failure, so the only useful behaviour is to keep going. Failing
  // the whole sweep on the first stuck pane would turn one orphan into eight.
  trackPane({ tab: "stuck", name: "a" });
  trackPane({ tab: "fine", name: "b" });
  const closed = reapOpenPanes((args) => {
    if (args[0] === "tab" && args[2] === "stuck") throw new Error("herdr says no");
  });
  assert.deepEqual(closed, ["fine"], "the closable pane is reported, the stuck one is not claimed");
  assert.equal(openPaneCount(), 0, "both are dropped: a pane we cannot close is not retried forever");
});

test("R-65: a pane herdr REFUSED to close stays tracked, so the reaper still has it", async () => {
  // The single failure the reaper exists for was the one that disabled it. `defaultExec` RESOLVES with
  // `{code: 1}` on failure and never rejects, so `cleanup`'s `.catch` was dead code: a refused close looked
  // exactly like a successful one and the pane was dropped from the registry. Confirmed by an independent
  // pass before this test was written.
  const before = openPaneCount();
  const inner = fakeHerdr();
  const exec: HerdrExec = async (args) =>
    args[0] === "tab" && args[1] === "close"
      ? { code: 1, stdout: JSON.stringify({ error: { code: "tab_busy", message: "no" } }), stderr: "" }
      : inner.exec(args);

  await runHerdrPane(request({ exec }));
  assert.equal(openPaneCount(), before + 1, "a pane we failed to close must remain the reaper's problem");
  assert.deepEqual(reapOpenPanes(() => {}), ["w1:t9"], "and the reaper must try it again at exit");
  assert.equal(openPaneCount(), before);
});

test("R-65: the exit sweep is bounded in TOTAL, not per call", async () => {
  // Measured against a hung herdr: 8 panes x 2 calls x 5s was 80 SECONDS of silent hang at shutdown, and
  // `timeout` is not even a hard bound (spawnSync SIGTERMs, then waits). A pane left open is the right
  // thing to degrade to; a shell that will not exit is not.
  for (let i = 0; i < 8; i += 1) trackPane({ tab: `w1:t${i}`, name: `a${i}` });
  let clock = 0;
  // Every call "takes" 2s of the fake clock, so the 6s budget must stop the sweep partway.
  const closed = reapOpenPanes(() => { clock += 2000; }, () => clock);
  assert.ok(closed.length < 8, `the budget must stop the sweep, closed ${closed.length}`);
  assert.ok(openPaneCount() > 0, "and what it did not reach stays tracked rather than being silently dropped");
  reapOpenPanes(() => {});
});

test("ADR-0032: the pane's output is reported while the child is still running", async () => {
  // The production change that breaks this: reading the pane only after `waitForSettled` returns, which is what
  // made a herdr child a black box for its whole run.
  const seen: string[] = [];
  const fake = fakeHerdr({
    getSequence: [
      { agent_status: "working", state_change_seq: 11 },
      { agent_status: "working", state_change_seq: 12 },
      { agent_status: "idle", state_change_seq: 13 },
    ],
    output: "partial progress",
  });
  await runHerdrPane({ ...request(), exec: fake.exec, pollIntervalMs: 1, onOutput: (chunk) => seen.push(chunk) });
  assert.ok(seen.length > 0, "nothing was reported before the child settled");
  assert.ok(fake.verbs().filter((v) => v === "agent read").length >= 2, "the pane must be read while it runs");
});

test("ADR-0032: only the NEW suffix is reported, because `agent read` returns the whole terminal", async () => {
  // Reporting the reply verbatim on every poll would repeat the entire buffer once per interval: the block
  // would show the child's first line forever and the transcript would grow quadratically.
  const seen: string[] = [];
  let call = 0;
  const growing = ["line one\n", "line one\nline two\n", "line one\nline two\nline three\n"];
  const fake = fakeHerdr({
    getSequence: [
      { agent_status: "working", state_change_seq: 11 },
      { agent_status: "working", state_change_seq: 12 },
      { agent_status: "idle", state_change_seq: 13 },
    ],
  });
  const exec: HerdrExec = async (args) => {
    if (args.slice(0, 2).join(" ") === "agent read") {
      const body = growing[Math.min(call++, growing.length - 1)];
      return { code: 0, stdout: JSON.stringify({ id: "x", result: { output: body } }), stderr: "" };
    }
    return fake.exec(args);
  };
  await runHerdrPane({ ...request(), exec, pollIntervalMs: 1, onOutput: (chunk) => seen.push(chunk) });
  const streamed = seen.join("");
  assert.equal(streamed.match(/line one/g)?.length, 1, `"line one" reported more than once: ${JSON.stringify(streamed)}`);
});

test("ADR-0032: a rewritten terminal reports the whole buffer rather than nothing", async () => {
  // A cleared screen or a spinner means the new text is NOT a superstring of the old. Reporting nothing there
  // would silently stop the stream for the rest of the run.
  const seen: string[] = [];
  let call = 0;
  const rewritten = ["aaaa\n", "bbbb\n", "bbbb\n"];
  const fake = fakeHerdr({
    getSequence: [
      { agent_status: "working", state_change_seq: 11 },
      { agent_status: "idle", state_change_seq: 12 },
    ],
  });
  const exec: HerdrExec = async (args) => {
    if (args.slice(0, 2).join(" ") === "agent read") {
      return { code: 0, stdout: JSON.stringify({ id: "x", result: { output: rewritten[Math.min(call++, 2)] } }), stderr: "" };
    }
    return fake.exec(args);
  };
  await runHerdrPane({ ...request(), exec, pollIntervalMs: 1, onOutput: (chunk) => seen.push(chunk) });
  assert.match(seen.join(""), /bbbb/);
});

test("ADR-0032: the pane id reaches the caller as soon as it exists, so a human can switch to a LIVE child", async () => {
  const ids: string[] = [];
  const fake = fakeHerdr();
  await runHerdrPane({ ...request(), exec: fake.exec, onPane: (paneId) => ids.push(paneId) });
  assert.deepEqual(ids, ["w1:p9"]);
});

test("ADR-0032: an onOutput that throws does not break the run", async () => {
  const fake = fakeHerdr();
  const out = await runHerdrPane({
    ...request(),
    exec: fake.exec,
    pollIntervalMs: 1,
    onOutput: () => {
      throw new Error("renderer exploded");
    },
  });
  assert.equal(out.code, 0);
});

test("ADR-0032: a completed child's pane is left OPEN, so a human can still read it", async () => {
  // The production change that breaks this: putting `tab close` back in cleanup's finally. That is what made a
  // twenty-second child's pane vanish before anyone could switch to it — the pane was real and unobservable.
  const fake = fakeHerdr();
  await runHerdrPane({ ...request(), exec: fake.exec, pollIntervalMs: 1 });
  assert.ok(!fake.verbs().includes("tab close"), "the pane must not be closed at the end of the tool call");
  assert.equal(openPaneCount(), 1, "and it must stay TRACKED, so agent_settled can reap it");

  await reapOpenPanesAsync(fake.exec);
  assert.equal(openPaneCount(), 0);
});

test("ADR-0032: the agent is still stopped even though the pane stays", async () => {
  // The pane outliving the call must not mean a governed child keeps running in it.
  const fake = fakeHerdr();
  await runHerdrPane({ ...request(), exec: fake.exec, pollIntervalMs: 1 });
  assert.ok(fake.verbs().includes("agent stop"));
  await reapOpenPanesAsync(fake.exec);
});

test("ADR-0032: a ninth pane closes the OLDEST, and the cap is the fan-out per-call limit", async () => {
  // A plain blocking `delegate` spends nothing from the fan-out budget (delegation.ts), so pane count is
  // otherwise unbounded within one agent run: thirty sequential delegates would hold thirty panes until it
  // settled. The production change that breaks this: dropping the trim.
  for (let i = 0; i < MAX_OPEN_PANES + 1; i += 1) trackPane({ tab: `w1:t${i}`, name: `child-${i}` });
  const fake = fakeHerdr();

  const closed = await trimOpenPanes(fake.exec);

  assert.deepEqual(closed, ["w1:t0"], "the OLDEST pane is the one to go");
  assert.equal(openPaneCount(), MAX_OPEN_PANES);
  await reapOpenPanesAsync(fake.exec);
});

test("ADR-0032: the pane cap equals MAX_CHILDREN_PER_CALL, so the two cannot drift", async () => {
  assert.equal(MAX_OPEN_PANES, MAX_CHILDREN_PER_CALL);
});

test("ADR-0032: a pane herdr REFUSES to close stays tracked, so exit tries again", async () => {
  // R-62's lesson, kept: untracking a pane we did not close disables the one thing built for that failure. The
  // async sweep must not be more forgiving of itself than the sync one is.
  trackPane({ tab: "w1:t1", name: "child-1" });
  const fake = fakeHerdr({ failAt: "tab close" });

  await reapOpenPanesAsync(fake.exec);

  assert.equal(openPaneCount(), 1, "a pane that was not closed must remain the reaper's problem");
  await reapOpenPanesAsync(fakeHerdr().exec);
  assert.equal(openPaneCount(), 0);
});

test("ADR-0032: keepPane still means the reaper never touches it", async () => {
  // `PI_GRANTS_HERDR_KEEP_PANE=1` means "not even at agent_settled" — an operator who asked to keep a pane for
  // inspection must not have it swept when their prompt comes back.
  const fake = fakeHerdr();
  await runHerdrPane({ ...request(), exec: fake.exec, pollIntervalMs: 1, keepPane: true });
  assert.equal(openPaneCount(), 0, "a kept pane must be untracked, so nothing reaps it");
  assert.ok(!fake.verbs().includes("tab close"));
});
