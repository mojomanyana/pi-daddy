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
import { HerdrWriterCloseError, runHerdrPane, splitSystemPrompt, uniqueAgentName, type HerdrExec } from "../src/run-herdr.ts";
import { MAX_OPEN_PANES, markPaneSettled, openPaneCount, reapOpenPanes, reapOpenPanesAsync, trackPane, trimOpenPanes } from "../src/pane-reaper.ts";
import { DEFAULT_SNAPSHOT_LINES } from "../src/herdr-poll.ts";
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

test("a child that did NOT settle has its tab closed at once, because that is the only way to stop it", async () => {
  // **Rewritten, and this is a governance fix rather than tidying.** The previous version asserted the pane
  // survived a failure — which, with no `agent stop` in existence, left a governed child still WORKING with its
  // grant after its tool call had returned a result. A timeout, an abort or a failed prompt all mean "still
  // running", and the tab close is the only kill.
  //
  // The production change that breaks this: keeping the pane on a non-settled path.
  const fake = fakeHerdr({ failAt: "agent prompt" });
  const before = openPaneCount();
  const result = await runHerdrPane(request({ exec: fake.exec }));

  assert.match(String(result.spawnError), /prompt failed/);
  assert.ok(fake.verbs().includes("tab close"), "an unsettled child must be killed, and only tab close kills");
  assert.equal(openPaneCount(), before, "and its pane must not be left for a later sweep");
});

test("keepPane leaves the pane for a human to inspect, and no sweep closes it", async () => {
  // `PI_GRANTS_HERDR_KEEP_PANE=1` overrides the settled/unsettled question entirely: the operator asked to keep
  // whatever is there. It IS registered — but only so `exit` can remove the staged system prompt, which was
  // otherwise unreachable by either sweep and leaked one temp dir per kept pane (measured).
  const fake = fakeHerdr();
  await runHerdrPane(request({ exec: fake.exec, keepPane: true, pollIntervalMs: 1 }));
  assert.ok(!fake.verbs().includes("tab close"), "the operator's pane is theirs");
  assert.ok(!fake.verbs().includes("agent stop"), "and that command does not exist anyway");

  const sweeper = fakeHerdr();
  assert.deepEqual(await reapOpenPanesAsync(sweeper.exec), [], "the async sweep must not close a kept pane");
  assert.ok(!sweeper.verbs().includes("tab close"));
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
  //
  // **The assertion moved from `text` to `spawnError`, and that is the point of the change, not a concession
  // to it.** It used to assert the diagnostic came back as the child's OUTPUT — which is precisely the R-03
  // defect a reviewer measured: `code: 0` plus "could not read the agent pane" as the sub-agent's answer, which
  // an orchestrator then summarised as a completed review. herdr's own message is still carried, so nothing is
  // hidden; it is carried as a failure.
  const inner = fakeHerdr();
  const exec: HerdrExec = async (args) =>
    args[0] === "agent" && args[1] === "read"
      ? { code: 1, stdout: JSON.stringify({ error: { code: "agent_not_found", message: "gone" } }), stderr: "" }
      : inner.exec(args);

  const result = await runHerdrPane(request({ exec }));
  assert.match(String(result.spawnError), /could not be read \(gone\)/);
  assert.equal(result.text, "", "a read failure is not output");
  assert.notEqual(result.code, 0, "and it is not a success");
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
  // **One command, not two.** This asserted `agent stop` ran first, "so the agent is stopped before its tab goes
  // away" — but `herdr agent stop` does not exist (measured against 0.7.5: it prints the usage banner and exits
  // 0, which reads as success). Closing the tab is the kill, and issuing a phantom command before it bought
  // nothing but a round-trip.
  assert.deepEqual(closed, [["tab", "close", "w1:t42"]], "closing the tab is the only kill herdr offers");
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

test("ADR-0032: the pane's tail is reported while the child is still running", async () => {
  // The production change that breaks this: reading the pane only after `waitForSettled` returns, which is what
  // made a herdr child a black box for its whole run.
  const seen: string[][] = [];
  const fake = fakeHerdr({
    getSequence: [
      { agent_status: "working", state_change_seq: 11 },
      { agent_status: "working", state_change_seq: 12 },
      { agent_status: "idle", state_change_seq: 13 },
    ],
    output: "partial progress\n",
  });
  await runHerdrPane({ ...request(), exec: fake.exec, pollIntervalMs: 1, onSnapshot: (lines) => seen.push(lines) });
  assert.ok(seen.length >= 2, "nothing was reported before the child settled");
  assert.deepEqual(seen[0], ["partial progress"]);
});

test("ADR-0032: a GROWING pane reports a bounded tail, never the whole buffer", async () => {
  // **This is the 89,000x amplification, pinned.** `agent read` returns the whole terminal; the old design
  // diffed it and re-reported everything whenever the prefix test failed. The production change that breaks
  // this test: reverting to a diff, or removing the `keep` bound.
  const seen: string[][] = [];
  let poll = 0;
  const fake = fakeHerdr({
    getSequence: [
      { agent_status: "working", state_change_seq: 11 },
      { agent_status: "working", state_change_seq: 12 },
      { agent_status: "idle", state_change_seq: 13 },
    ],
  });
  const exec: HerdrExec = async (args) => {
    if (args.slice(0, 2).join(" ") === "agent read") {
      // Each read returns MORE than the last, as a real growing pane does.
      poll += 1;
      const body = Array.from({ length: poll * 50 }, (_, i) => `line ${i}`).join("\n") + "\n";
      return { code: 0, stdout: JSON.stringify({ id: "x", result: { output: body } }), stderr: "" };
    }
    return fake.exec(args);
  };
  await runHerdrPane({ ...request(), exec, pollIntervalMs: 1, onSnapshot: (lines) => seen.push(lines) });

  for (const frame of seen) {
    assert.ok(frame.length <= DEFAULT_SNAPSHOT_LINES, `a frame carried ${frame.length} lines`);
  }
  const total = seen.reduce((n, f) => n + f.join("").length, 0);
  assert.ok(total < 2000, `reported ${total} chars for a pane of thousands — the old design sent megabytes`);
});

test("ADR-0032: a SCROLLED pane shows its current tail rather than re-reporting", async () => {
  // A scrolling terminal is not an append-only log: its top lines are gone, so the old prefix test failed
  // forever and every real line was delivered once per poll. A snapshot simply shows what is there now.
  const seen: string[][] = [];
  const windows = ["a\nb\nc\n", "b\nc\nd\n", "c\nd\ne\n"];
  let poll = 0;
  const fake = fakeHerdr({
    getSequence: [
      { agent_status: "working", state_change_seq: 11 },
      { agent_status: "working", state_change_seq: 12 },
      { agent_status: "idle", state_change_seq: 13 },
    ],
  });
  const exec: HerdrExec = async (args) => {
    if (args.slice(0, 2).join(" ") === "agent read") {
      return { code: 0, stdout: JSON.stringify({ id: "x", result: { output: windows[Math.min(poll++, 2)] } }), stderr: "" };
    }
    return fake.exec(args);
  };
  await runHerdrPane({ ...request(), exec, pollIntervalMs: 1, onSnapshot: (lines) => seen.push(lines) });
  assert.deepEqual(seen[0], ["a", "b", "c"]);
  assert.deepEqual(seen[seen.length - 1], ["c", "d", "e"]);
});

test("ADR-0032: a failed pane read is a SPAWN ERROR, never the child's answer", async () => {
  // R-03, measured on the old code: the read failure's own diagnostic came back as `text` with `code: 0`, so an
  // orchestrator read "could not read the agent pane" as a completed sub-agent's report. The production change
  // that breaks this: returning `readPane`'s message as `text` again.
  const fake = fakeHerdr({ failAt: "agent read" });
  const out = await runHerdrPane({ ...request(), exec: fake.exec, pollIntervalMs: 1 });
  assert.equal(out.code, null, "a child whose answer is unknown must not report success");
  assert.match(String(out.spawnError), /could not be read/);
  assert.equal(out.text, "", "and the diagnostic must not be handed back as output");
});

test("ADR-0032: a truncated pane SAYS it was truncated in the text the model sees", async () => {
  // `truncated` was returned in the result and never surfaced, so a model got a tail with no sign a head had
  // existed. The direct executor has always flagged it.
  const fake = fakeHerdr({ output: "x".repeat(5000) });
  const out = await runHerdrPane({ ...request(), exec: fake.exec, pollIntervalMs: 1, maxOutputBytes: 1000 });
  assert.equal(out.truncated, true);
  assert.match(out.text, /exceeded the output cap/);
  assert.ok(Buffer.byteLength(out.text) < 1500, "and the cap must actually hold, in BYTES");
});

test("ADR-0032: the pane id reaches the caller as soon as it exists, so a human can switch to a LIVE child", async () => {
  const ids: string[] = [];
  const fake = fakeHerdr();
  await runHerdrPane({ ...request(), exec: fake.exec, onPane: (paneId) => ids.push(paneId) });
  assert.deepEqual(ids, ["w1:p9"]);
});

test("a Herdr child is running only after agent start and prompt both succeed", async () => {
  const events: string[] = [];
  const fake = fakeHerdr();
  await runHerdrPane({
    ...request(), exec: fake.exec, pollIntervalMs: 1,
    onPane: () => events.push("pane-created"),
    onRunning: () => events.push("running"),
  });
  assert.deepEqual(events, ["pane-created", "running"]);

  const failed: string[] = [];
  const promptFailure = fakeHerdr({ failAt: "agent prompt" });
  await runHerdrPane({ ...request(), exec: promptFailure.exec, onRunning: () => failed.push("running") });
  assert.deepEqual(failed, [], "a pane with no accepted prompt never ran the governed task");
});

test("ADR-0032: a renderer that throws does not break the run", async () => {
  // A display is not a governance control: an onSnapshot that throws must not be able to kill a governed child or
  // turn its answer into a failure.
  const fake = fakeHerdr();
  const out = await runHerdrPane({
    ...request(),
    exec: fake.exec,
    pollIntervalMs: 1,
    onSnapshot: () => {
      throw new Error("renderer exploded");
    },
  });
  assert.equal(out.code, 0);
  assert.match(out.text, /the child's answer/);
});

test("ADR-0032: an onPane that throws does not strand the pane we already created", async () => {
  const fake = fakeHerdr();
  const out = await runHerdrPane({
    ...request(),
    exec: fake.exec,
    pollIntervalMs: 1,
    onPane: () => {
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

test("a settled writer pane is closed before its workspace lease can be released", async () => {
  const fake = fakeHerdr();
  await runHerdrPane({ ...request(), exec: fake.exec, pollIntervalMs: 1, closeOnSettle: true });
  assert.ok(fake.verbs().includes("tab close"));
  assert.equal(openPaneCount(), 0);
});

test("a writer pane close failure is loud so its lease can remain held", async () => {
  const fake = fakeHerdr({ failAt: "tab close" });
  await assert.rejects(
    () => runHerdrPane({ ...request(), exec: fake.exec, pollIntervalMs: 1, closeOnSettle: true }),
    HerdrWriterCloseError,
  );
});

test("a finalizer failure cannot mask the primary Herdr failure", async () => {
  const primary = new Error("primary herdr failure");
  const fake = fakeHerdr();
  const exec: HerdrExec = async (args) => {
    const verb = args.slice(0, 2).join(" ");
    if (verb === "agent start") throw primary;
    if (verb === "tab close") {
      return { code: 1, stdout: JSON.stringify({ id: "x", error: { code: "close_failed" } }), stderr: "" };
    }
    return fake.exec(args);
  };

  await assert.rejects(
    () => runHerdrPane({ ...request(), exec, pollIntervalMs: 1, closeOnSettle: true }),
    (error: Error) => {
      assert.equal(error, primary, "the primary error object and its classification must survive");
      assert.match(error.message, /^primary herdr failure/);
      assert.match(error.message, /finalizer failed: HerdrWriterCloseError/);
      return true;
    },
  );
});

test("ADR-0032: a settled pane is marked reclaimable and closed by the sweep, WITHOUT `agent stop`", async () => {
  // **Rewritten: `herdr agent stop` does not exist.** Measured against herdr 0.7.5 — the `agent` subcommands are
  // `list get read send-keys prompt rename focus wait attach start explain`, and `agent stop` prints the usage
  // banner and exits 0, which `defaultExec` reports as success. `docs/probes/g16-herdr` asserted it worked, from a
  // *How to rerun* block that was never executed. Three call sites issued it for nothing.
  //
  // Closing the tab is the only kill herdr offers, so that is what the sweep does. The production change that
  // breaks this: reintroducing an `agent stop` call, or closing a settled pane inside the tool call.
  const fake = fakeHerdr();
  await runHerdrPane({ ...request(), exec: fake.exec, pollIntervalMs: 1 });
  assert.ok(!fake.verbs().includes("agent stop"), "a command that does not exist must not be issued");
  assert.ok(!fake.verbs().includes("tab close"), "a settled child's pane survives its call");
  assert.equal(openPaneCount(), 1);

  const closer = fakeHerdr();
  assert.deepEqual(await reapOpenPanesAsync(closer.exec), ["w1:t9"]);
  assert.ok(closer.verbs().includes("tab close"));
  assert.ok(!closer.verbs().includes("agent stop"));
});

test("ADR-0032: the trim closes the oldest SETTLED pane, and never a live one", async () => {
  // **The live-sibling defect, pinned.** pi runs tool calls in parallel by default and a plain `delegate` spends
  // nothing from the fan-out budget, so one assistant message can hold `delegate_all(8)` plus a `delegate` — and
  // the ninth pane's trim used to close the oldest entry whether or not its child was still working. Measured:
  // two `delegate_all(8)` in one message killed 8 of 16 children mid-work, partial output discarded, while the
  // ledger recorded all sixteen as provisioned.
  //
  // The production change that breaks this: dropping the `settled` check in `trimOpenPanes`.
  for (let i = 0; i < MAX_OPEN_PANES + 1; i += 1) trackPane({ tab: `w1:t${i}`, name: `child-${i}` });
  // Only the third is finished; the rest are live.
  markPaneSettled("w1:t2");
  const fake = fakeHerdr();

  const closed = await trimOpenPanes(fake.exec);

  assert.deepEqual(closed, ["w1:t2"], "the oldest SETTLED pane goes, not the oldest pane");
  assert.equal(openPaneCount(), MAX_OPEN_PANES);
});

test("ADR-0032: when every open pane is LIVE the cap is exceeded rather than a child killed", async () => {
  // The deliberate failure direction: a pane too many costs an operator a keystroke; a killed child costs them
  // the work. The production change that breaks this: trimming unsettled panes as a fallback.
  for (let i = 0; i < MAX_OPEN_PANES + 3; i += 1) trackPane({ tab: `w2:t${i}`, name: `live-${i}` });
  const fake = fakeHerdr();

  assert.deepEqual(await trimOpenPanes(fake.exec), []);
  assert.equal(openPaneCount(), MAX_OPEN_PANES + 3, "the cap yields; the children live");
  assert.ok(!fake.verbs().includes("tab close"));
});

test("ADR-0032: the trim walks PAST a pane herdr refuses to close", async () => {
  // It used to attempt `excess` panes from the front and treat a refusal as handled, so an unclosable pane sat at
  // the head forever: the cap silently stopped holding (measured: 30 panes for 30 delegates when every close was
  // refused) and the same corpse was re-attacked on every spawn — O(n^2) round-trips.
  for (let i = 0; i < MAX_OPEN_PANES + 1; i += 1) {
    trackPane({ tab: `w3:t${i}`, name: `child-${i}` });
    markPaneSettled(`w3:t${i}`);
  }
  let firstTry = true;
  const inner = fakeHerdr();
  const exec: HerdrExec = async (args) => {
    if (args[0] === "tab" && args[1] === "close" && args[2] === "w3:t0" && firstTry) {
      firstTry = false;
      return { code: 1, stdout: JSON.stringify({ id: "x", error: { message: "busy" } }), stderr: "" };
    }
    return inner.exec(args);
  };

  const closed = await trimOpenPanes(exec);

  assert.deepEqual(closed, ["w3:t1"], "it must move on and close the next settled pane instead of retrying");
  assert.equal(openPaneCount(), MAX_OPEN_PANES, "and the cap must actually hold");
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

test("a tab create that returns NO pane id closes the tab and leaks nothing", async () => {
  // **Wholly untested until now.** A reviewer deleted this branch's `tab close` + untrack — the exact leak its
  // comment says was fixed ("the one path where herdr half-succeeded was the one that leaked a tab") — and got
  // 442 tests green, because no fixture ever returned a reply without `pane_id`.
  const inner = fakeHerdr();
  const exec: HerdrExec = async (args) =>
    args[0] === "tab" && args[1] === "create"
      ? { code: 0, stdout: JSON.stringify({ id: "x", result: { root_pane: { tab_id: "w1:t77" } } }), stderr: "" }
      : inner.exec(args);

  const before = openPaneCount();
  const out = await runHerdrPane(request({ exec }));

  assert.match(String(out.spawnError), /no pane id/);
  const verbs = inner.calls.map((c) => c.slice(0, 3).join(" "));
  assert.ok(verbs.includes("tab close w1:t77"), "a half-created tab must be closed, not orphaned");
  assert.equal(openPaneCount(), before, "and nothing may stay tracked");
});

test("a malformed writer tab that cannot close retains its lease signal", async () => {
  const exec: HerdrExec = async (args) => {
    if (args[0] === "tab" && args[1] === "create") {
      return { code: 0, stdout: JSON.stringify({ id: "x", result: { root_pane: { tab_id: "w1:t77" } } }), stderr: "" };
    }
    return { code: 1, stdout: JSON.stringify({ id: "x", error: { message: "close failed" } }), stderr: "" };
  };
  await assert.rejects(() => runHerdrPane(request({ exec, closeOnSettle: true })), HerdrWriterCloseError);
});

test("a tab create that FAILS removes the staged system prompt", async () => {
  // Measured leak: this path returned without touching `promptDir`, and nothing tracked it, so neither sweep
  // could reach it — one permanent /tmp/grants-herdr-* per failed `tab create`, which is the common failure on a
  // machine where herdr is not running.
  const { readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const count = async () => (await readdir(tmpdir())).filter((n) => n.startsWith("grants-herdr-")).length;

  const before = await count();
  const out = await runHerdrPane(
    request({
      exec: fakeHerdr({ failAt: "tab create" }).exec,
      // A multi-line system prompt is what forces staging in the first place.
      args: ["--no-session", "--append-system-prompt", "line one\nline two", "--tools", "read"],
    }),
  );

  assert.match(String(out.spawnError), /tab create failed/);
  assert.equal(await count(), before, "the staged prompt must not outlive a failed tab create");
});

test("each spawn gets a UNIQUE agent name, because herdr binds a name to its tab", async () => {
  // **The regression this prevents was a shipping blocker.** herdr frees an agent name only when its tab closes,
  // and `herdr agent stop` does not exist — so once ADR-0032 kept panes alive to `agent_settled`, the second
  // `delegate` of a turn died with `agent_name_taken`. Names are built from the definition and the ledger child
  // id, and that id is constant (`d0.1`) for every plain `delegate`.
  //
  // The production change that breaks this: passing `request.name` to `agent start` again.
  const first = fakeHerdr();
  const second = fakeHerdr();
  await runHerdrPane(request({ exec: first.exec, pollIntervalMs: 1 }));
  await runHerdrPane(request({ exec: second.exec, pollIntervalMs: 1 }));

  const nameOf = (fake: ReturnType<typeof fakeHerdr>) =>
    fake.calls.find((c) => c[0] === "agent" && c[1] === "start")![2];
  assert.notEqual(nameOf(first), nameOf(second), "two spawns from one base name must not collide");
  for (const fake of [first, second]) {
    assert.match(nameOf(fake), /^child-1-\d+$/, "and the base must stay readable in the name");
  }
});

test("every agent name satisfies herdr's grammar, dotted ledger ids included", () => {
  // **A PRE-EXISTING defect, and the more serious half of the two.** herdr rejects a name that does not match
  // `[a-z][a-z0-9_-]{0,31}` — measured from its own message: "agent name must start with a lowercase letter and
  // contain only lowercase letters, digits, '-' or '_' (1-32 characters)".
  //
  // Callers build `${definition}-${childId}`, and a ledger child id is hierarchical: `d0.1`, `d0.1.2`. Those DOTS
  // are outside the grammar, so `agent start review-d0.1` has always been rejected — every `delegate({agent})` on
  // the herdr path failed at `agent start`, since the executor was written. Nothing saw it: this suite's fake
  // accepts any name, and the integration suite never reaches a real herdr spawn. It surfaced only by running two
  // real spawns against the live daemon, both of which now start.
  //
  // The production change that breaks this: passing a name through without sanitising it.
  const grammar = /^[a-z][a-z0-9_-]{0,31}$/;
  for (const base of [
    "review-d0.1", // the real shape, and the one that was rejected
    "git-ops-d0.3.2", // a grandchild
    "A_Weird.Name!!", // uppercase and punctuation
    "9leading-digit", // must not start with a digit
    "-leading-dash",
    "\u65e5\u672c\u8a9e", // sanitises to nothing, so a fallback is required
    "x".repeat(80), // must be truncated to 32
  ]) {
    const name = uniqueAgentName(base);
    assert.match(name, grammar, `${JSON.stringify(base)} produced an invalid herdr agent name: ${name}`);
  }
});
