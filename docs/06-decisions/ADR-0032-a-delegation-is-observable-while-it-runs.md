# ADR-0032: a delegation is observable while it runs

**Date:** 2026-08-17
**Status:** Accepted (2026-08-17, by the user — streamed status block, panes to agent_settled, cap of 8)
**Driver:** the operator asked to watch sub-agents work instead of waiting on a one-word tool call, and
explicitly did **not** ask for children that outlive the call. This changes what a delegation *shows*, and on
the herdr path it changes when a pane is destroyed, so it is recorded. Companion to ADR-0031, which decides
*where* a child runs; this decides *whether you can see it*.

## Context

**A delegation is a black box for as long as it takes.** Both tools discard the update callback pi hands them
(`extensions/delegation.ts:116` and `:171` — the parameter is spelled `_onUpdate`), so the parent's screen
shows the bare word `delegate` from the call until the result, up to `DEFAULT_TIMEOUT_MS` of ten minutes
(`src/run-child.ts:59`). A `delegate_all` of eight children shows the same one word for all eight.

**On the herdr path the pane is real but unobservable in practice.** `runHerdrPane` closes the tab in a
`finally` the instant the child settles (`src/run-herdr.ts:204-221`). A child that takes twenty seconds has a
pane for twenty seconds, and nothing tells the operator it exists or what it is called, so switching to it in
time is a matter of luck. `PI_GRANTS_HERDR_KEEP_PANE=1` is the existing escape hatch and it goes too far the
other way — panes survive to process exit, which is exactly why it is off by default: a fan-out of eight leaks
eight, and `docs/probes/g16-herdr` records that an orphaned pane is not trivially closable afterwards.

So the two halves of the operator's request fail for unrelated reasons: the parent shows nothing because a
callback is dropped, and the pane vanishes because a `finally` is scoped to one tool call.

### Measured for this decision

**Progress is expressible.** `onUpdate` is `(partialResult: AgentToolResult) => void`
(`pi-agent-core/dist/types.d.ts:337`), and pi surfaces partial results as a `tool_execution_update` event
carrying `partialResult`, so calling it re-renders the tool's own block in place. Nothing needs a custom
renderer.

**`runChild` does not stream.** It accumulates into `text` and settles on `close`
(`src/run-child.ts:104-147`). But `capture` is the single funnel for both stdout and stderr — added for the
output cap — so one optional callback there covers the whole surface.

**`turn_end` is the wrong hook, and this is the part worth writing down.** `TurnEndEvent`
(`pi-coding-agent/dist/core/extensions/types.d.ts:557`) carries `turnIndex`, `message`, `toolResults` and
fires at the end of **each provider round-trip** — no later than the `finally` that already closes the pane.
Designing "keep it until the parent's turn ends" against `turn_end` would have changed nothing at all.

The hook that means it is **`agent_settled`** (`types.d.ts:547`): *"Fired after an agent run has fully settled
and no automatic retry, compaction, or queued continuation will run."* Independent corroboration that this is
the right boundary: herdr's own pi integration drives its busy/idle display from `agent_start` and
`agent_settled` (`~/.pi/agent/extensions/herdr-agent-state.ts:260,270`), so it is already what "the parent
stopped working" means to the thing displaying the panes.

## Options considered

### Option A — status lines only

One line per child, updated as it moves: the definition, its herdr agent name, its pane id, its state. Cheap,
executor-independent, and enough to switch to a pane deliberately instead of by luck.

**Rejected as insufficient, not as wrong.** It assumes the operator leaves pi to do the observing. The request
was to observe *in pi*.

### Option B — status lines plus streamed child output (CHOSEN)

The same lines, and the child's output appears in the parent's transcript as it is produced. On the process
executor that is `capture` calling a new optional `onOutput`; on the herdr path it is `waitForSettled` also
polling `agent read` and piping the tail through. Costs an extra herdr round-trip per poll per child — eight
children at the existing 750ms `POLL_INTERVAL_MS` is roughly eleven reads a second — and puts a fan-out's
worth of interleaved terminal text in the transcript.

Chosen because it answers the request literally and because it is the half that works on **both** executors. A
subprocess child has no pane; streaming is the only observability it can ever have.

### Option C — keep panes via the existing `PI_GRANTS_HERDR_KEEP_PANE=1`, document it, change no code

The genuinely cheap option, and it deserves a fair hearing: the machinery exists, and the operator's immediate
complaint would be answered by two environment variables and a paragraph in the README.

Rejected on two counts. It keeps panes until **process exit**, so a long session accumulates every pane it ever
opened — the reason the flag is off by default, unchanged. And it does nothing for the subprocess executor or
for the parent's screen, so the black box remains a black box wherever herdr is absent.

### Option D — let children outlive the tool call so panes can be revisited afterwards

Rejected by the operator directly ("i do not care if they outlive the tool call"), and it is the right call:
this is ADR-0026's territory, where a late approval starts nothing, results need collecting by id, ids dangle
across a compaction, and the parent can exit before its children. ADR-0026 decided the gating rule and
deliberately implemented none of it because no workload needed it. This workload still does not.

## Decision

**A governed child's output is streamed to the parent as it is produced, on both executors; and on the herdr
path its pane survives until the agent run settles.**

**Streaming.** `runChild` takes an optional `onOutput`, invoked from `capture`. `runHerdrPane` polls
`agent read` inside `waitForSettled` and reports the tail. `delegate` and `delegate_all` forward both to
`onUpdate`. Each child's line names its herdr agent and pane id when it has one, so switching to it is a
deliberate act.

**The rendered shape is a status block redrawn in place, with a three-line tail per child** — chosen by the
operator 2026-08-17 over a one-line-per-child variant and over an interleaved chronological stream:

```
delegate_all  2 children · herdr panes

review   agent review-d0.1   pane w7:t12   running  0:42
  3 findings so far: unchecked nil at
  session.ts:88, missing expiry compare…
  Reading packages/auth/test/session.test.ts…

debug    agent debug-d0.2    pane w7:t13   running  0:42
  Test fails only with TZ=UTC. Narrowing.
  Found it: Date parsing assumes local tz.
```

Three properties of that shape are load-bearing rather than cosmetic. **Fixed height** — four lines per child,
so the eight-pane cap is ~32 lines and the block cannot grow without bound. **No braiding** — each child's
text stays under its own header, which is what the rejected chronological option could not offer. **The pane
id is on screen while the child is alive**, which is the entire difference between a pane you can switch to
and one you find out about after it closes.

What it gives up, stated because R-48's rule applies to a display as much as to a listing: **output older
than the last three lines is not in the transcript.** It is in the pane while the pane lives, and in the
returned result afterwards. The block must not imply it is showing everything.

**Pane lifetime.** `cleanup()` stops closing the tab — it still stops the agent and still removes the staged
system-prompt directory. The pane stays in the `src/pane-reaper.ts` registry, and a new `agent_settled` hook
sweeps it.

**The sweep is asynchronous, and the synchronous one stays for `exit` only.** `reapOpenPanes` is
`execFileSync` with a six-second total budget because an `exit` handler cannot await
(`src/pane-reaper.ts:22,86`). Reusing it at `agent_settled` would freeze pi for up to six seconds every time
the operator gets their prompt back. Both drain the same `Map`, keyed by tab id, so a double close remains
impossible.

**At most eight panes are open at once** (`MAX_CHILDREN_PER_CALL`). Opening the ninth closes the oldest and
says so. This bound is not decoration: `delegate_all` is capped per call and the fan-out budget bounds a
subtree, but a plain blocking `delegate` **spends nothing from that budget** by design
(`extensions/delegation.ts:122-124`), so thirty sequential `delegate` calls in one agent run would otherwise
hold thirty panes open until it settled. Whatever gets closed early is stated rather than silently dropped,
which is R-48's rule.

**The executor in force is disclosed** at session start and in `/grants`, which today name the grant, depth,
ledger, approvals and catalog and say nothing about where children run
(`extensions/grants.ts:224`, `extensions/grants-command.ts:300-311`). This is the sentence ADR-0031 depends on
to claim its probe is not silent, so it ships with it or ADR-0031 does not stand.

### Deliberate non-goals

**The child does not outlive the tool call.** No background mode, no result-by-id, no child registry. The turn
still owns every child, so the parent cannot exit before them, the tool-call signal stays live, and there are
no ids to dangle across a compaction. ADR-0026 is untouched.

**No signal handler is installed.** R-62's reasoning is unchanged and still absolute: a listener here
suppresses Node's default termination, and pi uses SIGINT to interrupt a turn — so "cancel this delegation"
would become "exit pi", on every session rather than the opt-in ones.

**The streamed text is not the result.** The tool's result remains what the child produced at settle.
Streaming is display only, and the two must not be conflated: a truncated or partial stream that could be read
as the answer is R-03's defect — a missing result indistinguishable from an empty one — with a new cause.

## AMENDED 2026-08-17 — two sentences of this decision were false, and one of them was a governance claim

Six independent reviewers attacked the implementation. Two findings falsify text above rather than merely
correcting code, so they are recorded here instead of being quietly fixed.

**1. "The agent is still stopped when its call ends" is FALSE. `herdr agent stop` does not exist.** Measured
against herdr 0.7.5, which lists `list get read send-keys prompt rename focus wait attach start explain`; the
phantom command exits 0, so nothing noticed. `docs/probes/g16-herdr` asserted it worked, in a rerun block that was
never run — that probe now carries a falsification note.

This mattered more than a stray call. **Closing the tab is the only kill herdr offers**, so "the pane survives its
tool call" and "the child has stopped" cannot both be true. Before this ADR the `finally` closed the tab and the
question never arose. After it, a child that timed out or was aborted **kept running with its grant** after its
result had been reported to the orchestrator. That is a governance failure, not untidiness.

**The decision is narrowed accordingly**: a child that **settled** keeps its pane, which is the whole feature; a
child that did **not** settle — timeout, abort, failed start, failed prompt, unreadable pane — has its tab closed
at once, because that is the only way to stop it. The non-goal "the child does not outlive the tool call" is now
enforced by mechanism rather than asserted.

**A second consequence, and it was a shipping blocker.** herdr binds an agent name to its **tab** and frees it
only on close. Names derive from the ledger child id, which is constant (`d0.1`) for every plain blocking
`delegate` — so once panes outlived their calls, the **first** delegation of a turn worked and every later one
failed with `agent_name_taken`, on the executor ADR-0031 had just made the default. Names are now uniquified
inside `runHerdrPane`, next to the constraint they serve.

**2. The eight-pane cap was argued from sequential delegates only, and killed concurrent siblings.** This ADR
justifies the cap by "thirty sequential `delegate` calls". pi executes tool calls **in parallel** by default, so
one assistant message can hold `delegate_all(8)` *and* a `delegate` — and the trim closed the oldest pane whether
or not its child was still working. Measured: two `delegate_all(8)` in one message killed **8 of 16 children
mid-work**, each reported as "could not be started" with its partial output discarded, while the ledger recorded
all sixteen as provisioned.

**The cap may now reclaim only settled panes.** If every open pane is live it is exceeded rather than enforced —
a pane too many costs an operator a keystroke; a killed child costs them the work.

**3. "Output older than the last three lines … is in the pane while the pane lives, and in the returned result
afterwards" is false on the herdr path** whenever the pane scrolls or exceeds the output cap: the result is a
fresh `readPane`, i.e. the tail. Streamed output can vanish from both. The result now says so when it is
truncated, which is the honest version of the claim.

**4. The streaming design was wrong about its own substrate.** `agent read` returns a **snapshot of a bounded
terminal**, and the implementation diffed it as an append-only stream. Scrolling and cap-truncation both break
that diff permanently: measured **51 MiB streamed for ~600 bytes of real output**, and the append-shaped join
fabricated lines the child never printed. The herdr path now reports a bounded snapshot the consumer *replaces*.
"Bounded by the existing `maxOutputBytes` cap" above was true per read and false cumulatively.

**5. A pre-existing defect surfaced underneath all of this: the herdr executor could never start a definition
spawn at all.** herdr requires an agent name matching `[a-z][a-z0-9_-]{0,31}`, and this package builds
`<definition>-<childId>` where a child id is hierarchical (`d0.1`). The **dot** is outside the grammar, so
`agent start review-d0.1` was rejected with `invalid_agent_name` — from the day the executor was written, invisible
because the unit fake accepts any name and the integration suite never reaches a real spawn. Found by running two
real spawns against the live daemon while verifying the fix above; names are now sanitised and both start.

That is not this ADR's defect, but it is this ADR's business: it means the pane executor had **never** worked for
the `agent:` path, so nothing that follows about pane lifetime had ever run in anger before this branch.

## What this makes untrue

`docs/SPEC.md:394-395` describes `runHerdrPane` as owning no child lifecycle beyond the call, and the
`PI_GRANTS_HERDR_KEEP_PANE` row at `:438` describes the only way a pane survives. Both change.

The module headers of `src/run-herdr.ts` and `src/pane-reaper.ts` both state that the pane is closed in a
`finally`. That was the premise of R-62's analysis and it is no longer how the normal path works — the
`finally` stops closing tabs, and `agent_settled` becomes the ordinary close point with `exit` as the backstop.

## Consequences

**Positive.** The operator watches work happen without leaving pi, and gets a name to switch to when they want
the terminal. Both executors improve; the subprocess path gains the only observability it can have.

**Negative — the transcript carries interleaved output from up to eight children.** Bounded by the existing
`maxOutputBytes` cap, but readability during a wide fan-out is untested and is the first thing likely to need
revisiting.

**Negative — more herdr traffic.** Roughly eleven `agent read` calls a second at full fan-out, on top of the
`agent get` polling already there. Both share `POLL_INTERVAL_MS`, so there is one number to tune.

**Negative — panes now accumulate within an agent run.** Capped at eight, swept at `agent_settled`, and still
orphaned by SIGKILL exactly as before. ADR-0031 is what makes that common rather than rare, and carries that
debt.

**Neutral — nothing about governance changes.** Not the grant, not the depth bound, not the fan-out budget,
not the gate, not the ledger's decisions. `--tools` remains the enforcement point and a pane remains a
terminal rather than a boundary (`docs/SPEC.md:42`).

## Revisit trigger

- **A fan-out whose streamed output makes the transcript unusable.** Then streaming needs collapsing, or a
  per-child cap rather than the global byte cap.
- **Any report of a streamed partial being taken for a final result.** That is R-03 reopened with this as its
  cause, and it would mean the display/result separation is not visible enough in the rendering.
- **`openPaneCount()` non-zero after `agent_settled` in ordinary use.** The async sweep's budget is then in the
  wrong place, or something is opening panes the registry never learns about.
- **The eight-pane cap being hit in real work.** It bounds a case that should be rare; if it is not rare, the
  right fix is probably making a blocking `delegate` spend from the fan-out budget after all, which is a
  change to ADR-0008's cardinality companion and wants its own decision.
