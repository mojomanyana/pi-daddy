# Session Log

**Where things stand and what to do next.** `docs/SPEC.md` says what the product *is*; ADRs hold the
decisions; this file holds state and next actions. Newest entry on top.

---

## NEXT SESSION — read this, then pick one

**Before your first edit: `git branch --show-current`. If it says `main`, branch.** Working rule 10, and
`hooks/pre-commit` enforces it once `git config core.hooksPath hooks` is set in your clone. This line is at
the top because the rule was broken by drift, and this file is what a session actually reads first.

**State: green.** `pi-daddy` **0.17.1** — the only package. **505 unit + 44 integration tests** (measured
2026-08-18), plus an opt-in tier behind `PI_GRANTS_IT_MODEL=1`; typecheck clean, smoke clean.
**Thirty-three** ADRs decided. The three numbers above were stale by three versions until 2026-08-18 —
R-59's shape in the file `CLAUDE.md` names as the first thing to read.

**2026-08-16/17 added the pi-daddy half of the `principal-pi-skills` integration** (handoff B1/B2/B4,
ADR-0028 and ADR-0029), then **red-teamed it with five independent agents who found nine defects** — R-78
through R-82, including an RCE in the generated grant file. Read that entry before adding anything that
*generates* a file rather than reading one.

ADR-0028: `npx pi-daddy init` scaffolds definitions and a grant **without choosing a ceiling**, and session
start names what is spawnable and what is withheld. **What is left of that handoff is section A, and it is
not ours** — `principal-pi-skills` declaring `allowed-tools` on its seven skills (A1) and installing into
`skills/` as well as `agents/` (A2). Until A1 lands, `init` correctly reports `0 declaring allowed-tools`
and the operator writes seven ceilings by hand. **Do not resolve A1 from here**: the handoff's proposed
table is unresolved and self-contradicting, and the ceiling belongs to whoever wrote the skill.

**The known-open list is empty of code.** What remains needs a human: item 1 needs weeks of real usage, and
items 6 and 7 are closed by decision. See the table below before assuming otherwise.

**The four unreviewed changes were reviewed by the operator on 2026-08-14 and three produced a finding**
(R-60's guard, R-61's fourth state, R-63's twentyfold bias). **What made that review work is worth copying**:
each hypothesis was checked by execution or by grep *first*, so the operator was handed a concrete finding
with a worked example instead of "please look at this" — and two of the four were then cleared in minutes
rather than costing a pass. Write the hypotheses down; verify them before asking.

```bash
cd packages/pi-daddy && npm test && npm run typecheck && npm run test:integration && npm run test:smoke
PI_GRANTS_IT_MODEL=1 npm run test:integration   # the 4 model-driven ones — ~60s, costs money
```

**2026-08-13/14 took this from 0.9.0 to 0.12.1: nine ADRs (0017–0025) and R-38 through R-59.** The shape of
those two days matters more than the list:

- **Six changes shipped on one pair of eyes** — all verified, all tested, all documented — and the first
  red-team pass then found a defect that made two of them *inert* (`Available: none` told every model there
  were no definitions to spawn) plus a test suite rewriting the developer's real approvals file.
- **Four ADRs were written to fix that**, and the second pass found a defect that made one of them false on
  exactly the case it was written for (a fresh approval crossed to the child **unpinned**, hidden by
  lexicographic sort order).
- **Tests and documentation caught neither**, because both were written by the same reasoning that
  introduced them. Two independent agents, given the specific hypotheses to attack, caught both in minutes.

**So: get the review before shipping the next three things, not after.** That is the single most useful
sentence in this file.

**Three habits that earned their place**, all of which produced a finding this session:
1. **Verify a reported finding by execution before acting on it.** Twice the real defect was *worse* than
   reported (R-41's keyspace, R-42's scope), and once the claim was **stale by four days** and had been
   repeated by two reviewers and the assistant from a line in `CLAUDE.md` (R-59).
2. **Ask "where else does this shape appear?"** Both times a fix contained a smaller copy of the bug it
   fixed — R-38's preview, and ADR-0022's republish path — that question found it, not the tests.
3. **When a guard fails, obey it.** `test/file-size.test.ts` refused `delegate.ts` at 413 lines; the cap was
   not raised and the file was split along a seam three other modules already implied.

### Known-open — the code items are DONE. What is left needs a human, not a session.

| # | Item | Notes |
| :--- | :--- | :--- |
| 1 | **The measurement ADR-0020 asks for** — **the machinery now exists, the usage does not.** `/grants ledger` prints `N prompt · N persisted · …` and *"N of M attributed yes(es) came from the persisted store"*. | **Still the highest-value item and still only the operator can run it.** What changed: the missing piece is *use*, not tooling. ADR-0020 has a dated note; that ADR rests on an asserted fatigue argument until someone governs real work for a few weeks and reads the line. |
| ~~2~~ | ~~**R-49** — an unlocked read-modify-write can resurrect a revoked approval~~ **CLOSED 2026-08-14 (0.13.0).** | The park said *"do not harden a layer whose fate item 1 decides"* — and the fix turned out to be **reuse, not hardening**: the ledger's lock moved to `src/file-lock.ts` and both writers share it, leaving nothing extra to delete if Option 3 is ever taken. **R-61 fell out of it**: a failed revoke printed *"no persisted approval named X"* while the approval stayed in effect. |
| ~~3~~ | ~~**Background delegation** wants an ADR that cannot be written~~ **DECIDED 2026-08-14 — ADR-0026.** The blocking question is answered: a background delegation whose gates are unresolved when its tool call returns is **refused**, recorded as `gatedBlocked` with no source. A late approval starts nothing. | **Not implemented, deliberately** — what was missing was a decision, not code, and no workload yet needs it. Consequence worth knowing: background mode is only useful for **ungated** capability sets, and the remedy is operator pre-approval. |
| ~~4~~ | ~~**Pane cleanup is not leak-proof**~~ **FIXED IN PART 2026-08-14 (R-62).** Open panes are closed on `exit`. | **Not** on SIGKILL, nor a SIGTERM nothing else is listening for — Node runs no `exit` handlers there. The obvious completion is **refused with a reason**: a signal listener here suppresses Node's default termination and would turn pi's "interrupt this turn" into "exit pi", on every session rather than the opt-in ones. |
| ~~5~~ | ~~**The test suites leave a `mkdtemp` directory per test**~~ **CLOSED 2026-08-14** — `test/tmp.ts` hands out fixture directories and `after(cleanupTempDirs)` removes them; `PI_GRANTS_KEEP_TMP=1` keeps them for inspection. | A scan test fails if a suite calls `mkdtemp` directly or forgets the hook — the helper had to be *required*, not merely available. |
| 6 | **`subagents:rpc:spawn` bypasses the tripwire.** Unfixable from here. | ADR-0013 Finding 6. Nothing to do; do not re-derive it. |
| 7 | **`bash` escapes governance.** Out of scope by decision. | ADR-0012. Nothing to do; do not re-derive it. |
| — | ~~R-34, R-35…R-62~~ **ALL CLOSED or recorded with a decision.** | Do not reopen without new evidence. |

### If you want a fourth thing to pull

The thread that produced most of this session: **grep for call sites rather than trusting a reading**, then
**write a test that watches the real thing**. R-37, R-38, R-39, R-53 and R-54 were all found that way, and
every one of them was a control that read as live and was not.

### Things that look like work and are not

- **`docs/archive/`** — superseded by design, kept as evidence, **never edited to match today**. Its README
  says why each file stopped being current. Do not start there.
- **"DTCM" in archived registers and ADRs** — deliberate. Those mentions *are* the retired thesis. See
  `CLAUDE.md` and `.claude/rules/phase-gates.md` §4.
- **The phase gates** — retired. `/kickoff`, `/gate`, `/validate` and `/spec` were removed 2026-08-11.
- **The upstream pi-subagents proposal** — **dead** by ADR-0016 and archived. Do not file it.

### If you change what the product claims, write an ADR

That convention is why every reversal here was survivable, and there have been five. Then update
`docs/SPEC.md` in the same change — a spec that lags the code is worse than no spec.

---


## 2026-08-18 (review) — a twenty-line docs PR, five reviewers, eleven defects

**The rule that says every change gets a PR was itself reviewed, and it needed it.** PR #6 added working rule
10. Five independent reviewers, one lens each; **eleven findings, four of them reported independently by more
than one reviewer.** The change was twenty lines of prose in two files.

**The worst finding is that the rule forbade the merge it required.** The first draft said *"never commit to
`main`"*. Landing a PR puts a commit on `main`; so does merging locally. A fresh session reading that
literally either refuses to merge at all, or — the dangerous branch — tries to *repair* the state it thinks
it created, and the two obvious repairs are `git reset --hard HEAD~11` and `git push --force`. **A
prohibition with no recovery procedure is an invitation to destroy work.** The object of the prohibition was
simply wrong: what must be forbidden is `main` being advanced by anything other than a merged PR. Rule 10 now
names the recovery explicitly, and forbids rewriting history in it.

**Second: the rule secured the artifact of a PR, not review, while justifying itself entirely on review.**
`git switch -c x && gh pr create && gh pr merge` satisfies every word in under a minute with no reviewer. The
correctly-worded version was already in this file — *"the case for never merging a self-reviewed branch"* —
and the rule had dropped it. It is now a requirement, scoped to changes that touch behaviour.

**Third: the justifying anecdote described an event that never happened.** It claimed six reviewers across
two rounds found one critical governance flaw twice *"in work already green on four suites, manually
verified, with a PR description written"*. Two different episodes: the six-reviewer round was 0.16.0 (PR #5,
eighteen defects, two shipping blockers, and that is the one with four suites and a manual check), while the
same-flaw-twice was `delegate_chain`, two rounds of three. **And `delegate_chain` never went through a PR at
all — it is the eleven commits.** The true version is a *better* argument than the invented one: the work
with the worst governance defects is the work that skipped the PR. Rule 5 and rule 6, on the sentence doing
all the persuading.

**Fourth, and the one worth generalising: the rule was prose, in a project that promotes violated rules to
guards.** Every rule here that was *actually broken in practice* — the 400-line ceiling, the session-start
guard, the risk-register headlines (R-59, then R-72) — became a mechanical check precisely because prose had
already failed once. Rule 10 is justified by the same shape of history and shipped with nothing enforcing it:
no hook, no CI, and `main` with no branch protection (404, checked). Now `hooks/pre-commit` plus
`test/branch-guard.test.ts`, which three mutations of the hook fail. **Both remaining gaps are stated in the
rule rather than implied**, because an unstated absence reads as enforcement.

**Fifth, small and purely self-inflicted: the file lost rule 9.** Inserting the new section before the
terminology one and renumbering 9 → 11 left 1-8, 10, 11 — a gap that reads as a deleted rule, in a file whose
header boasts that the risk register cites it eighteen times. **Four of the five reviewers found this
independently**, which is a useful calibration on what a single careful read misses. Fixed by appending the
section instead, so nothing renumbered at all. `CLAUDE.md`'s summary of the file ("*nine of them*",
"documentation, evidence and terminology discipline") was falsified by the very PR editing that file, three
lines below the bullet it added.

**Then the rule broke itself during verification, and that is R-85's last paragraph.** Testing whether the
hook fires, `git stash -u` swept the still-untracked hook aside, so the commit on `main` succeeded — the
guard was absent at the exact moment it was under test. Empty, unpushed, undone with `git branch -f main
origin/main`, which is the recovery the rule prescribes; the procedure was needed within minutes of being
written. **A guard a routine command can remove is a guard with a hole.**

**Then the fixes were reviewed, and the fix had reintroduced the defect it removed.** Rule 10 says a change
touching behaviour gets an independent pass, and the fixes added a hook and a test — behaviour. So one more
reviewer, on the delta only. It returned **DO NOT MERGE**, correctly. `hooks/pre-commit` refused a
**conflicted** merge on `main`: a clean merge runs `pre-merge-commit` and never reaches the hook, but a
conflicted one finishes with a literal `git commit` that does — and in that state `git switch -c`, the recovery
the hook itself prints, is rejected by git. The only escape git offers is `git merge --quit`, which throws away
the conflict resolution. **"A prohibition with no usable recovery", removed from the prose and reintroduced in
shell one commit later.** Four more: the skip condition made *deleting the hook* report `pass 0, skipped 4`
instead of failing — rule 7 inside the file citing rule 7, and precisely R-85's recorded recurrence; the R-85
trigger flagged 87 of 89 commits *and* both genuine PR merges, because GitHub puts `#N` in a prefix not a
`(#N)` suffix; a third enforcement gap (clean cherry-pick and revert never invoke `pre-commit`) was unstated
while the commit claimed both gaps were stated; and the one git-spawning test would die on any machine with
`commit.gpgsign = true`. Two of its reported surviving mutations were also worth closing: a waiver loosened to
`[ -n ]` (so `=0` and `=false` would *disable* the guard) and a `*main*` substring match (which would refuse
`docs/maintenance`). **Seven mutations now fail the suite, measured, where the docstring had claimed four and
one of those survived.**

**What to copy from this pass.** Assigning each reviewer a single falsifiable lens produced almost no
overlap: the factual-claims reviewer found the composited anecdote, the rendering reviewer measured the
108-character wrap and cleared the two rendering worries by *actually rendering* rather than reasoning, and
the enforcement reviewer produced the finding that changed the shape of the work. **The one thing every
reviewer found was the numbering gap** — the cheapest defect in the diff, and the one a careful author had
read past four times.

## 2026-08-18 — the chain's gate was wrong TWICE, and the pattern is the lesson

Second review round on `delegate_chain`: three reviewers, one critical, four high/medium. Fixed forward. **498 unit
tests in 9.8s, pure; 44 integration; smoke clean.**

**Every defect in both rounds is the same mistake wearing different clothes: the chain reimplemented, beside an
existing rule, a decision that rule already makes.**

| round | rule bypassed | what it cost |
| :--- | :--- | :--- |
| 1 | `resolveApprovals` keys per subject | one definition's yes authorised every other; a 30-day entry keyed to `digger` satisfied `shaper` for a month |
| 2 | `shouldSeekApproval` | a step that could never run still raised a dialog, and the yes was banked — reachable by a model appending one unheld capability |
| 2 | `once` semantics (R-29) | one *Allow once* spawned three children; the dialog described step 1, step 3 had been told "…and burn the evidence" |
| 2 | the approval record (ADR-0010) | a step that ran on a human's click recorded nothing; `/grants ledger` showed it as neither attributed nor a gap |

**So the transferable rule is sharper than "write an ADR", and this is the sentence to keep:** when a decision adds a
new **caller** of an existing mechanism, the design work is enumerating every rule that mechanism's normal caller
obeys and saying which the new caller inherits. Options-weighing cannot catch this. The evidence needed was a list of
what `runOneDelegation` does before and after it delegates — and it is one function away.

**The fix found a live defect that had nothing to do with the chain.** Making `planDelegation` filter approvals by
subject closed a **second escalation on the ordinary `delegate` path**: a human's explicit "no" for one definition
overridden by a yes for another, shipped in 0.16.0. My commit had claimed the change was *"a no-op on the pre-existing
paths"* — false, because `republishable(session)` passes every subject unfiltered into the re-plan. **R-83.** The
chain was the occasion for finding it, not the cause. **R-84** records a pre-existing hole the same probe surfaced: a
single `session` yes on the `tools:` path propagates through a whole subtree unchecked.

**Three of my tests could not fail, and one class is worth naming.** `fenceHandoff.length === 1` cannot fail because
`Function.length` stops at the first *defaulted* parameter — which is precisely what the seam was. Assert behaviour,
never arity. Two shipped fixes had **no test at all** and were freely re-breakable. And `preApproved` was pinned by
nothing, because every pure test declined and the opt-in one used `allow-session`, which satisfies the gate from
session state regardless.

**And I moved a test that could not fail instead of fixing it.** The previous round's commit admitted "step N receives
step N−1's output" only pinned a ledger field; I relocated it to the integration tier verbatim, comment included, so
the call site was uncovered in *both* tiers. **Relocating a broken test launders it.**

**Purity broke twice and both times I introduced it.** Approving a gate in a wiring test makes a step spawn a real
`pi`, which always calls a model: 2m19s, then 1m54s, on ~13s of CPU. The rule is mechanical — **a wiring test that
approves is an integration test.** Now proven with `pi`/`herdr` shims first on `PATH`: 498 pass, neither binary
invoked.

**Mutation testing, four sessions running, has found what careful tests missed every time — including a test of mine
that failed unconditionally and would have read as coverage.** Verify the mutation actually bites: my first attempt at
the executor-ordering mutation moved the check somewhere harmless and proved nothing.

---

## 2026-08-17 (chain review) — the ADR itself was wrong, and that is the finding to keep

**Three reviewers, one hypothesis each. All three found real defects; two found the same critical from different
briefs.** Fixed forward on the operator's call. `npm test` **2m19s → 14.9s**.

**ADR-0033's central mechanism was not implementable, and implementing it faithfully produced a privilege path.**
The decision said *"the gate asks once, upfront, for the union"* and illustrated a dialog reading *"this chain needs
`tool:bash` for build, review, debug, git-ops"*. **That dialog cannot exist**: an approval is keyed
`capability@subject`, so one dialog means one subject. Measured consequences — `shaper` running on a yes given for
`digger`; a 30-day entry keyed to `digger` satisfying `shaper` in later sessions with **no dialog at all**; a
model-chosen `tools:` list being offered *Always allow in this project*, which a plain `delegate` is denied.

**The lesson is about the ADR process, not the code.** That decision had options weighed, a worked example, and the
operator's recorded choice — and its mechanism was still impossible, found by reviewers in under an hour and missed by
the author while implementing it faithfully. **A decision that names a mechanism must be checked against the layer
that would enforce it before it is Accepted.** One grep for where approvals are keyed would have caught it at writing
time. That sentence is now in the ADR.

**The root cause was one line in the planner, not in the chain**, and that is the more useful half. `planDelegation`
matched `approved` by bare capability name — safe only because every existing caller pre-filtered by subject
upstream. That made `approved` a footgun for any *new* caller, and this feature was the new caller. Enforcing subject
matching in the planner makes the property hold by construction; it is a no-op on the old paths. **Ask "is this safe
because of the code, or because of who happens to call it?"**

**Two defects were yesterday's, reintroduced on a new path.** The executor-refusal check ran after the gate again,
because a chain hoists its gate above `runOneDelegation` — so the ordering fixed the previous day was simply bypassed.
And a refused chain wrote no ledger line at all. **A fix applied at one call site is not a fix; ask where else the
shape appears.**

**The handoff was never verbatim.** `String.replaceAll` interprets `$` in a *replacement*, so a `build` step
summarising a shell script had `$$` and `$'…'` silently rewritten, and `$&` reinserted a literal `{previous}` — the
exact outcome `replaceAll` was chosen to prevent. No adversary needed.

**Three of my tests could not fail, and one was worse than useless:**
- Deleting the handoff entirely left all 489 green; the test that claimed to cover it only pinned `taskFrom`.
- All 11 fence tests passed with the body moved OUTSIDE the fence, because `indexOf(">>>")` latched onto a *forged*
  delimiter in the hostile text.
- My replacement for the gate test used `composeStepTask` without importing it, so it failed **unconditionally** and
  proved nothing. **Mutation-checking caught that one before it was kept** — a test that always fails looks like
  coverage in a red run and like a flake in a green one.

**And I broke the two-tier test design.** Five chain tests spawned real `pi` children calling a real model, so the
unit suite needed network and credentials and ran 66s/127s/346s while `CLAUDE.md` advertised it as *"fast, pure, no
pi, no network"*. Moved to the opt-in tier; verified the moved file really runs by executing one for real.

**Three sessions running, mutation testing has found what careful tests missed every single time.** It is no longer a
technique to remember — write the test, break the code, check the test notices, and do it before believing the test.

---

## 2026-08-17 (chain) — 0.17.0: `delegate_chain`, and a herdr suite that would have caught the blockers

**Built the integration test FIRST, deliberately.** Three of 0.16.0's defects hid behind an injected `exec` fake, so
`test-integration/herdr.it.ts` now checks herdr's own contracts against a live server: 12 tests, no model tokens,
~20s, in a workspace it creates and closes so an operator's layout is untouched. Verified it can fail — re-allowing
dots in the agent-name charset fails five of them, including the one written for that blocker.

**One thing to carry forward about `node:test`:** it evaluates a test's `{ skip }` option when the test is
**defined**, before any `before()` hook. The first version probed in `before`, so all twelve skipped and the suite
reported `pass 0` while looking perfectly healthy. Module-level `await` runs first.

**Then ADR-0033 (`delegate_chain`), accepted and shipped in five commits.** `src/chain.ts` is the handoff, pure;
`extensions/delegate-chain.ts` is the tool. Every step goes through `runOneDelegation`, so no governance rule is
re-implemented — what a chain adds is composition, one gate instead of N, a budget unit per step, and abort.

**Three defects in my own work, all caught by a test or the compiler rather than by reading:**

1. **I reused `takeBytes` for the handoff, which keeps the HEAD.** A handoff needs the tail — a summary's conclusion
   is at its end, which is why `readPane` keeps the tail too. The head-keeping version silently discarded exactly
   the part of a step's answer the next step needed. `tailBytes` now walks code points backwards.
2. **Adding `preApproved` as a seventh positional parameter put it in front of `onProgress`**, and two call sites
   silently passed a progress sink where approvals were expected. TypeScript caught it only because the types
   happen to differ — luck, not a control, and **R-28 was exactly a defect in an argument list**. The optional tail
   is now one options object, which makes the mistake unspellable.
3. **A framing sentence wrapped across two lines** put a newline in the middle of a phrase a test asserts verbatim.

**And one test of mine could not fail — found by mutation, which is the only way it could have been.** "A chain asks
ONCE for the union" declines at the gate, so the chain aborts and **no step ever runs**: dropping `preApproved`
entirely left it green, because the count was 1 from aborting rather than from the steps being satisfied. That is
precisely the shape a reviewer found on the previous branch — **a fixture that never spawns cannot test what happens
after spawning.** There is now a second test where the operator allows, all three steps run, and the count must
still be one.

**Mutation testing has earned a permanent place.** It caught the one thing six careful tests did not, twice in two
days. Write the test, then break the code and check the test notices.

---

## 2026-08-17 (review) — six reviewers, eighteen defects, two shipping blockers

**The single most valuable hour of this project so far, and the case for never merging a self-reviewed branch.**
0.16.0 was implemented, verified four ways (461 tests, typecheck, integration, smoke), manually checked against the
real herdr daemon, and had a PR written for it. Then six independent agents each got **one written hypothesis** and
no permission to fix anything. **Every one found something. None found what its hypothesis predicted.**

**Two were shipping blockers, and both came from the same root cause: an unverified line in a probe.**

`docs/probes/g16-herdr/README.md` said, in its *How to rerun* block, *"`herdr agent stop` ends the agent but leaves
the pane."* **That command does not exist.** It prints the usage banner and exits 0, which any wrapper reading only
the exit code records as success. Three call sites were built on it, and ADR-0032 built a *governance claim* on it
— "the agent is still stopped… what survives is a terminal, not a running descendant."

**The lesson is where the false line was, not that it existed.** A rerun recipe is the one place in a probe where
"measure before asserting" is easy to forget, because everything around it *was* measured. There is even a dated
correction immediately below it about a different usage mistake in the same block — which should have been the
warning. **Rule 5 needs to cover rerun instructions explicitly**, and the probe now carries a falsification note
saying so.

What it cost: a child that timed out or aborted **kept working with its grant** after its result was reported; and
because herdr frees an agent name only when its tab closes, the **second `delegate` of every turn** died with
`agent_name_taken` — on the executor ADR-0031 had just made the default. Neither was reachable by any test in the
suite, because the unit tests inject a fake `exec` that answered `agent stop` cheerfully and the integration suite
never reaches a real herdr spawn.

**Four defects were found by MUTATING production code and watching the tests stay green.** That technique earned
its place permanently:
- The `delegate_all` "one status block" test passed with a reporter per child — its fixture never spawned, so no
  sink ever fired and `frames.length === 1`. The during-run painting ADR-0032 is *about* was untested.
- The tripwire's "says which is which" test passed on the fully **inverted** message.
- Its sibling executed **zero assertions** (a conditional guard on a message containing no digits).
- Hardcoding both ledger call sites to `executor: "process"` left all 442 tests green.

**Three findings were about my own fixes creating the next defect**, which is the shape to watch:
- The R-60 guard hardcoded `grants.ts`; splitting the file under the ceiling moved ten of its thirteen controls out
  of scope, and it passed vacuously — R-60's shape inside the guard *for* R-60, in the commit whose message says
  the guard was obeyed.
- The executor disclosure was gated on `governed` rather than `mayDelegate`, so an ungoverned session would have
  relocated its children into panes in silence: ADR-0031's own rejected objection, inside its fix.
- The streaming fix bounded the *unit* count when the budget was in *bytes* — the same defect as the 1924-byte one
  it replaced, one layer down.

**And the design error worth remembering: I treated a snapshot source as a stream.** `agent read` returns the whole
terminal; diffing it as append-only broke permanently the moment a pane scrolled or passed the output cap —
measured **51 MiB streamed for 600 bytes of real output**. Four separate findings (amplification, fabricated text,
unbounded line growth, repeated real output) were all that one mistake. The fix was not a better diff; it was
admitting the substrate is a snapshot and having the consumer *replace*.

**Also found: the README was never updated.** Two reviewers independently. SPEC was corrected for every claim;
`packages/pi-daddy/README.md` — the file **npm publishes** — still said "Opt-in, never auto-detected", the exact
sentence ADR-0031 reverses and that R-62's own re-rating note on this branch calls false. **When a decision changes
behaviour, grep for the claim, not for the file you happened to be editing.**

**And then verifying the fix found a third blocker the reviewers had not reached.** Two real spawns against the
live daemon — the cheapest possible check — showed that herdr enforces an agent-name grammar
(`[a-z][a-z0-9_-]{0,31}`) that this package has always violated: names are `<definition>-<childId>` and a child id
is hierarchical (`d0.1`), so **`agent start review-d0.1` has been rejected since the executor was written**. The
herdr path had never once started a definition spawn. Both suites were green throughout, because the unit fake
accepts any name and the integration suite never reaches a real herdr spawn.

**Two probe facts falsified in one run, and both for the same reason: the probe only ever used well-formed inputs
and never executed its own cleanup advice.** Where a substrate *validates* something, a probe has to try to violate
it; where a probe gives a rerun recipe, that recipe has to have been run.

Verified fixed against real herdr: two spawns from base `review-d0.1` produce `review-d0-1-1` and `review-d0-1-2`,
and both start with real interactive pi argv.

ADR-0032 carries a five-point amendment; ADR-0031 is unaffected. R-62's re-rating stands.

---

## 2026-08-17 (later still) — 0.16.0 shipped: probed executor, visible children

**ADR-0031 and ADR-0032 accepted and implemented in twelve tasks on `feat/observable-governed-children`.**
442 unit + 32 integration tests, typecheck clean. `docs/plans/2026-08-17-observable-governed-children.md` is the
plan; ADR-0033 (chain) is deliberately still **Proposed** and un-planned — it wanted `progress.ts` and the
executor choice to exist first.

**Three guards refused something and each was obeyed rather than raised.** This is the part worth copying.

1. **`test/session-start-guard.test.ts`** refused the first version of Task 1: the new
   `await reportSessionStart` had no `try` of its own. R-60 enforced structurally, working exactly as intended.
2. **`test/file-size.test.ts`** refused `run-herdr.ts` at **404** after the output polling landed. Split to
   `src/herdr-poll.ts` along the seam the plan had named in advance — *observing* an agent versus *starting and
   cleaning up after* one. `extensions/grants.ts` was at **398** before any of this began, which is why Tasks 1
   and 2 are extractions rather than features.
3. **Two pre-existing `run-herdr` tests** asserted the pane-closes-in-`finally` contract ADR-0032 reverses. They
   were **rewritten with a note saying what changed and which property survives**, not deleted. A third failure
   was test pollution: panes now outlive each test, so the reaper tests were asserting against panes their
   predecessors left behind — fixed with an `afterEach` that drains the registry.

**Two defects were caught by review before they shipped, and both are worth remembering:**

- **The executor disclosure was gated on `session.governed`.** An ungoverned session still registers `delegate`
  and still spawns, so that version would have relocated its children into herdr panes **in silence** — which
  is ADR-0031's own rejected objection reappearing inside the fix for it. It is `session.mayDelegate` now, and
  reintroducing the old guard fails two tests (verified by doing it).
- **`PI_GRANTS_HERDR_WORKSPACE` defaulted to "let herdr choose".** herdr sets `HERDR_WORKSPACE_ID` in every pane
  it creates — measured, documented nowhere — so children were landing in a different workspace from the session
  that spawned them, making "switch between them" a workspace hop. It inherits the parent's workspace now.

**One defect the tests caught that reading did not.** `runChild`'s streaming first emitted the raw chunk, which
pushed **1924 bytes through a 1024-byte cap** on the truncating write: the cap bounded memory and not the screen
it had just been extended to protect. The fix is to derive what is streamed from `text`, so it is *by
construction* a prefix of what is returned.

**And one hazard that turned out to be false, checked before it cost anything.** `--no-extensions` does not stop
a governed child appearing as a herdr agent — `docs/probes/g16-herdr/README.md:40-47` already recorded it.

**The wiring harness now pins `PI_GRANTS_HERDR=0`, and that line is load-bearing**: unset means probe, and
`session_start` runs the probe, so without it the suite would shell out to whatever herdr is running on the
developer's machine and choose a different executor here than in CI. Two tests deliberately empty `PATH` instead
of mocking, so `defaultExec` is exercised end to end.

**Verified against the real daemon**, not only fakes: the probe answers `{ok: true}` here, unset selects herdr
panes, and `resolveWorkspace` returns `w7` — the workspace this session runs in.

**`turn_end` is not the turn-end hook.** It fires per provider round-trip, no later than the `finally` it would
have replaced. `agent_settled` is the one that means "the operator has their prompt back". Do not re-derive this.

---

## 2026-08-17 (later) — the operator ran it for real, and could not see anything

**No code changed. Three ADRs proposed (0031, 0032, 0033), all from one observation: the operator ran a real
governed fan-out and asked why nothing appeared in herdr.** Nothing was broken. `PI_GRANTS_HERDR` was unset,
which is the documented default, and they had never been told the variable existed.

**Two facts established by execution, both worth not re-deriving.**

**ADR-0030's init loop works end to end against a real project.** `~/.pi/agent/grants/bookie-pi-skills-675c4e2b56973e2f.json`
was written by `/grants init` at 10:06Z today, granting seven `agent:` ids plus six tools for
`/home/alavanja/repos/bookie-pi-skills`, and the seven scaffolded `SKILL.md` files sit in that project's
`.pi/skills/`. `/grants` in that session listed all seven as `allow` with their effective tool sets. **The
NEXT SESSION list above still implies this is unproven; it is not.**

**`principal-pi-skills@2.3.1` still declares no `allowed-tools` anywhere** — grepped the whole installed
package. **Handoff item A1 has NOT landed**, and the note above ("until A1 lands, `init` correctly reports
`0 declaring allowed-tools` and the operator writes seven ceilings by hand") remains exactly true. The seven
working definitions above are the *scaffolded* ones, not the package's.

**One thing I got wrong, and the correction is the useful part.** I identified the refused `subagent` tool as
`@tintinweb/pi-subagents`, the package ADR-0013/0016 discuss. It is not, and no such npm package is installed.
It is a **hand-installed directory drop-in** at `~/.pi/agent/extensions/subagent/` (`index.ts` 1015 lines,
`agents.ts` 126, dated 2026-08-03) which pi auto-loads in **every session on this machine** regardless of
`settings.json`. It registers a tool named `subagent` (`index.ts:462`), spawns a `pi` process per invocation,
and supports single / parallel / **chain** modes reading definitions from `~/.pi/agent/agents/`. The lesson is
the ordinary one: **a familiar name in a tripwire's allowlist is not evidence about what is installed.** The
tripwire fired correctly either way — it matches on tool *name*, which is all it ever claimed to do.

The second drop-in in that directory, `herdr-agent-state.ts`, **is** third-party and legitimate: installed and
managed by herdr (`HERDR_INTEGRATION_ID=pi`, version 6), registers **no tools** — four hooks only — so the
tripwire never sees it.

**A hypothesis checked before it was brought to the operator, and false.** `--no-extensions` (`src/spawn.ts:76`)
does **not** stop a governed child appearing as a herdr agent. `docs/probes/g16-herdr/README.md:40-47` already
records a child launched as `pi --no-session --no-extensions --tools read` with herdr emitting `agent_started`
and a live `state_change_seq`. Herdr registers the agent because `herdr agent start --kind pi` was called, not
because an extension reported in from inside the child. **The probe answered it; no new measurement was
needed.**

**`turn_end` is not the hook it sounds like.** It fires per provider round-trip
(`pi-coding-agent/dist/core/extensions/types.d.ts:557`), i.e. no later than the `finally` that already closes a
pane. `agent_settled` (`:547`) is the one that means "the operator has their prompt back" — and herdr's own pi
integration drives its busy/idle display from `agent_start`/`agent_settled`, which is independent
corroboration. Designing pane lifetime against `turn_end` would have shipped a no-op.

**R-62 has a dated note**: its L×L rating is justified by *"the herdr executor is opt-in"*, which ADR-0031
removes. Re-rate it in the change that ships 0031, not before.

**Still open, and they are decisions rather than code:** all three ADRs are **Proposed**. ADR-0031 reverses
part of ADR-0016 point 6 (which now carries a dated note pointing at it) and makes `docs/SPEC.md:398` false as
written; ADR-0032 makes `docs/SPEC.md:394-395,438` false as written. **Neither SPEC nor the risk register was
edited to match, deliberately** — the code does not do this yet, and a spec that describes unbuilt behaviour is
worse than one that lags.

---

## 2026-08-17 — five reviewers, nine defects, and the trigger I wrote and did not apply

**The independent pass on PR #2: five agents, one written hypothesis each, none of them allowed to fix
anything. Every one found something.** Nine defects, all reproduced here by execution before being acted on,
all fixed; one new decision (ADR-0029); ADR-0028 amended in four places and one of its sentences struck as
false.

**R-78 is the one to remember, and it is humbling.** R-77 — written the previous day — closed a capability
injection through a definition's **name**, and its trigger reads *"any new file this package generates whose
content includes a string taken from a third party, in a format where a separator or a quote means
something."* The `allowed-tools` **value** travels to the identical interpolation site, one line away, and
was unchecked. A package declaring `allowed-tools: Read,ext:x";touch …` produced a `.pi/grants.env` that
executed the payload when sourced — silently, exit 0, variable left plausible. **I wrote the trigger and
applied it to one of the two channels it names.** The fix is a whitelist plus a charset backstop that does
not depend on my enumeration, because the enumeration has now been incomplete twice.

**R-79 is B-I6 reintroduced.** `approval-store.ts` fixed "never write through a symlink" under ADR-0014 and
says so in a comment. A new writer in the same package, three days later, used `writeFile` after a `readFile`
presence probe — so a dangling symlink wrote outside the project, and an *unreadable* file counted as
*absent* and had its ceiling silently widened. One `open(path, "wx")` closes both.

**R-81 is R-28's shape inside the module whose header claims to have made R-28's shape inexpressible.** The
summariser deferred to the real planner and then **re-derived a category from two fields of its result** —
and `planDelegation` has six refusals that set neither. So a malformed `PI_GRANTS_MAX_DEPTH` printed "their
files are written wrong" two lines above `/grants` printing "delegation is disabled". The classification was
the second reading of the rules. It now prints the planner's own words.

**The pattern across all nine: every defect was in the half of the change nothing had attacked.** A
generated file, a CLI with no tests, a classifier written after the planner it defers to. The unit suite was
in good shape — a reviewer ran **38 mutations and 27 were killed**, and none of the 17 new tests was
decoration — which is exactly why the review had to attack somewhere else to find anything.

**ADR-0029 came from the design critic, and it is the deepest finding.** ADR-0028 said `init` "never chooses
a ceiling", which is true and beside the point: `init` chooses the **grant**, and the handoff's whole reason
a third party may safely author `allowed-tools` is that *the operator's grant independently bounds it*. A
generated union collapses those two authors into one. The generated grant is now read-only by default, with
`bash`/`write`/`edit` commented and named. The operator chose that option from three.

**Two process notes worth keeping.** A reviewer switched the working tree off the branch mid-session, and
uncommitted work by another session was sitting on `main` — the fix pass moved to a `git worktree` rather
than stashing someone else's changes. And one of the reviewers' own findings ("the summary vanished under
`PI_GRANTS_GATED=agent:x`") was **the branch switch, not a bug**; they caught it and retracted it, which is
the behaviour to want.

**353 unit + 28 integration, typecheck clean, smoke clean.** Still 0.14.0 — nothing shipped between the two
passes.

---

## 2026-08-16 — `pi-daddy init`, and a startup line that names what it will not spawn

**The pi-daddy half of the `principal-pi-skills` handoff: B1, B2 and B4, decided in ADR-0028.** Section A
belongs to the other repository and was not touched. B3 was already answered.

**`npx pi-daddy init` exists, and what makes it governance rather than convenience is what it refuses to
do.** It reads `node_modules` for packages declaring `pi.skills`, copies each declared `SKILL.md` into
`.pi/skills/`, and writes an annotated `.pi/grants.env`. A declared `allowed-tools` is copied **byte for
byte**; an undeclared one gets a **commented** placeholder and stays unspawnable; an existing file is
**kept**, because that edit is the capability decision and a second `init` run is exactly when it would be
destroyed. The generated grant authorises only what can actually be spawned.

**The tempting version was to ship the handoff's ceiling table**, and it was rejected for two reasons worth
keeping: the constraint forbids it, and *that table contradicts itself* — it gives `plan` a `Write` while
the prose beneath calls `plan` structurally incapable of modifying anything. Shipping it would have been
pi-daddy settling an open question that belongs to the skill package.

**Session start now says `1 of 7 definitions spawnable — review` and names the six it is withholding**,
grouped by reason, because a gate and an escalation have different fixes. It speaks even when **nothing** is
spawnable — the handoff proposed printing only when at least one was, which is silent for exactly the
operator in P2's state. Classified by the real planner, never by a second reading of the rules: this package
has shipped a diagnostic that disagreed with the enforcer twice (R-28, R-38).

**R-73 shipped and the smoke test caught it, which is the finding worth carrying.** `npx pi-daddy init`
printed **nothing** and exited **0** for every installed copy: npm makes a bin a symlink, so
`process.argv[1]` is the link while `import.meta.url` is the file it points at, and the "only run when
invoked directly" guard was false every time. Every in-repo test passed — they import `main` and call it,
which is the path the guard exists to exclude. **A scaffolding command that does nothing is
indistinguishable from one that found nothing to do**, which is why an `×H` sits on an otherwise trivial
defect. Same class as B-I12 (the `exports` map that worked in the tree and threw for every consumer), caught
by the same script, now twice.

**And the review question found one more, in code written the same hour.** *What does the generated file
interpolate?* — a definition's identity is its **directory name**, and `init` writes it into a
comma-separated `PI_GRANTS_GRANT`, a file the operator `source`s, and a path, all at once. A package
shipping a directory called `a,tool:bash` made `init` write
`PI_GRANTS_GRANT="agent:a,tool:bash,tool:delegate,tool:read"`: **`tool:bash` in an operator's grant,
declared by no definition and chosen by nobody**, in the one file this feature exists to make reviewable.
Reproduced against the real CLI, fixed with a name whitelist at discovery, R-77. That is the session log's
second habit — *ask where else this shape appears* — pointed at generated output instead of at parsing.

**Mutation checks found a decoration.** Thirteen production changes were named and reverted one at a time; twelve
failed exactly the test written for them, and the one that did not — deleting the containment check on a `pi.skills`
entry — failed **nothing**, because the fixture pointed at `../../../etc`, which is unreadable with or
without the guard. Rewritten to point at a real, readable definition outside the package. That is rule 7
catching the author for the third time in three sessions, and it is the cheapest check in this repository.

**Everything asserted about pi and about `principal-pi-skills@2.3.1` was re-measured** —
`docs/probes/b2-init-principal-pi-skills` runs the whole loop (`npm i` → `init` → one human edit → a real pi
session → `/grants`) and costs no model tokens. P2 is unchanged at 2.3.1: **zero of seven skills declare
`allowed-tools`**, so the README's worked example shows the honest state rather than the after-A1 one.

**332 unit + 27 integration, typecheck clean, smoke clean.** 0.14.0.

---

## 2026-08-14 (last) — the package is `pi-daddy`, and the rename went through the record

**Renamed on the way to a first publish**, which is what forced the question: `pi-agent-grants` matched
neither the repository, the workspace root, nor anything anyone calls this. `git mv` to
`packages/pi-daddy/`, `"name": "pi-daddy"`, and the workspace root became `pi-daddy-workspace` because npm
requires the root and its members to differ — given a forced choice the *published* artifact keeps the good
name.

**The operator chose to replace the old name in dated documents too, over the assistant's recommendation,
and ADR-0027 records both the decision and the disagreement.** 126 occurrences across 29 files, including
ADRs, the risk register, this log, `docs/probes/` and `docs/archive/` — the last of which is documented as
*"never edited to match today"* and has now been edited to match today.

**What that made untrue is listed in the ADR rather than glossed**: ADR-0016 now says "pi-daddy 0.7.0" and
no such version existed; probe READMEs cite a path that did not exist when the probe ran. The reasons it was
accepted: **nothing was ever published under the old name**, so no reader outside this repository holds an
artifact it refers to; git preserves every original wording and `--follow` traverses the move; and R-59 and
R-72 are both entries about the cost of two names for one thing in an orienting document.

**`.claude/rules/phase-gates.md` §2 and `CLAUDE.md` are amended rather than quietly violated.** The test that
permits this and forbids the DTCM rewrite: *does the name denote something abandoned?* "DTCM" does — those
sentences are the evidence of a retired thesis. "pi-agent-grants" did not. **Rule 4 is untouched.** A rule
that forbids what the repository already contains protects nothing; it teaches the next session to distrust
the file, which is the exact failure the retired phase-gate rule at the top of that file was rewritten to
escape.

**Verified after the move: 315 unit, 26 integration, typecheck clean, smoke clean.**

---

## 2026-08-14 (twelfth) — four agents, one hypothesis each, and the lock was letting two writers in

**The independent pass the top of this file kept asking for. Every one of the four found something, and the
worst of them broke an invariant rather than a claim.**

**R-67 — `withFileLock` admitted two holders at once.** Root cause in one sentence: `rm(lockPath)` deletes
whatever is at the path *now*, not the lock this process created. Two breaks followed — the stale-break
`stat`/`rm` gap could destroy a **live** lock, and the unconditional `finally` freed the **new** owner's,
which cascaded to processes that raced nothing and observed nothing wrong. Reproduced across **real OS
processes with no clock manipulation**: 2 of 120 trials × 16 processes under deliberate load, and the
overlap persisted for the rest of each trial. The docstring asserted the opposite in so many words, which
is what made it convincing. Fixed with a per-hold token and `removeIfOurs`.

**The fix had no failing test until the mutation check said so.** Reverting `removeIfOurs` to the
unconditional `rm` passed everything. That is rule 7 catching the author, and it is the second time in two
days — worth more than the fix.

**R-66 — eight ledger lines claimed a human was prompted; one was.** R-29 shares a non-`once` outcome across
concurrent callers, correctly; the *record* then stamped `"prompt"` on every rider. `ledger.ts` calls that
exact direction "the worst available failure", and **R-46 is the same defect one level down** — fixed across
the capability set while the concurrency case survived it untouched.

**R-64 — `source in bySource` walks the prototype.** A ledger line with `"toString"` as a source wrote a
string into a counter, made the renderer's sum a string, and **deleted the entire ADR-0020 measurement from
the report** while marking an intact ledger corrupt. Two smaller siblings beside it. All in code written the
day before.

**R-65 — the pane reaper was disabled by the one failure it exists for.** `defaultExec` *resolves* `{code:1}`
on failure, so the `.catch` was dead code and a refused close looked exactly like a successful one. Also 80
seconds of silent hang at exit, and `timeout` is not a bound: `spawnSync` SIGTERMs then waits (measured, 3s
timeout → 59.8s).

**Two agents also cleared hypotheses, and that is worth as much.** No realistic `work()` comes within two
orders of magnitude of `STALE_LOCK_MS` (measured on both filesystems); tab ids are not recycled; concurrent
tracking does not tear. Each cleared claim is now a sentence in the code stating what the threshold does and
does not guard.

**One finding went to the operator rather than being fixed:** `PI_GRANTS_FANOUT` is not a session total,
though `SPEC.md` and the README both said so — three successive `delegate_all(8)` calls in one session are
all accepted. Their call: correct the documents, because making the code match changes what a bound *means*
and would break working setups. Recorded against ADR-0008.

**ADR-0026 survived on its decision and lost most of its argument.** The critic confirmed all four
hypotheses against the reasoning: it cited ADR-0008 for an invariant ADR-0008 never states, claimed an
immunity the 120s dialog timeout already breaks, and offered a remedy (`always`) that is **structurally
unreachable for `delegate({tools})`**. Every one is now corrected in place with the correction marked, and
its revisit trigger was rewritten because the first one could not fire — ADR-0020's defect in mirror image.

**Then, and this is the part worth keeping: re-auditing the four reports against what had actually
SHIPPED found seven items reported and not fixed.** Reading a report is not acting on it, and the gap is
invisible unless you go back and tick the list off line by line. Three more risks came out of that pass —
R-69 (four causes of an unsatisfied gate, one indistinguishable record, which is the vocabulary ADR-0026
rests on), R-70 (a ledger of nothing but declines reported no declines — the quietest output for the
loudest file), R-71 (two paths orphaning a herdr pane).

**`src/ledger.ts` hit the 400-line guard during that fix and was split, not exempted** (habit 3). The seam
is the one every reporting defect has lived on: writing fails closed on one record, reading must never fail
at all on a whole damaged file.

**Verified: 315 unit, 26 integration, typecheck clean, smoke clean.** Every fix mutation-checked; every
agent finding re-verified here by execution before being acted on, and two were worse than reported. **Two
of the new controls had no failing test until the mutation check said so** — the declines block and the
lock's ownership check — which is the third and fourth time in three days that rule 7 has caught the author
rather than a contributor. It is the single highest-yield habit in this repository.

---

## 2026-08-14 (eleventh) — the operator reviewed the four unreviewed changes; three produced a finding

**The review worked, and the way it worked is the reusable part.** Four hypotheses had been written down —
one per unreviewed change — and each was *checked by execution or by grep before being put to the operator*,
so what they were asked was a concrete finding with an example rather than "please look at this". Two of the
four were cleared in minutes. Two produced defects, and one of those is the most consequential thing in this
session.

**R-63 — the ADR-0020 tally overstated the persistence layer twentyfold.** It counted `persisted` RECORDS
and reported each as a prompt avoided. Precedence is `inherited → session → persisted → prompt`, and
**`session` approvals live in memory and owe the store nothing** — so a session spawning `deploy` twenty
times under one persisted entry writes twenty records, while deleting the store would raise **one** prompt
and satisfy nineteen from the session cache. The number that decides ADR-0020's fate was wrong by 20×, in
favour of keeping the thing under evaluation.

The lesson is sharper than the bug. **That report already excluded pre-0.11.1 records specifically to avoid
inflating `prompt`** — the bias was thought about, named in a comment, and defended against in one direction
while walking into it from the other. *Excluding one known bias is not being unbiased.* It now prints
records as a stated upper bound **and** distinct `capability@subject` pairs as the closer estimate.

**R-61 gained a fourth state, because the R-61 fix contained a smaller copy of R-61.** A lock timeout
happens *before* the load, so `failed` — whose message asserts *"It is still in effect"* — was returned for
a key nobody had looked for. Third time a fix here has contained a smaller version of its own bug (R-38's
preview, ADR-0022's republish path), and the **first time it was caught while still being reviewed** rather
than by a later pass. `busy` now claims nothing about the entry.

**R-60 gained a guard test, which immediately found two more.** `test/session-start-guard.test.ts` fails on
any `await` in `session_start` without its own `catch` — the exact way R-60 was born, by *adding* a line
rather than editing one. It flagged `loadDefinitions` and `buildCatalog` on its first run. Neither throws
today; that is the point, because `verifyLedger` did not either until the day it did.

**Cleared, and worth recording as cleared** (rule 6 — say what the evidence covers): the per-call lock does
cover `planWithApprovals`, whose long window is the human dialog, where a fresh yes *should* beat an older
revoke; and no other boolean in the package is rendered as a sentence that could be false — `report.ok`,
`plan.ok`, `revokeAll` and `saveApproval` all have two values for two facts.

One documentation change came out of it: *"a revoke takes effect immediately"* claimed two things, one false
and now fixed (R-49), one **impossible** — a spawn past its gate check is not retracted by a revoke arriving
microseconds later, and no lock closes that. It now says *"at the next gate check"* and explains why.

**Verified: 305 unit, 25 integration, typecheck clean, smoke clean.** All three fixes mutation-checked.

---

## 2026-08-14 (tenth) — the known-open list, emptied of code — 0.13.0

**Four items, and the interesting part is that two of them were "parked deliberately" and the park did not
survive contact with the fix.**

**Item 1 — the ADR-0020 measurement.** That ADR names the evidence that would settle whether the persistence
layer earns its keep (`persisted` against `prompt`) and says it *"needs no new machinery"*. True of the data
and false of the answer: nothing read `approvalSources`, so the measurement needed hand-written `jq` and
therefore never happened — **R-51's shape exactly**, one layer up. `/grants ledger` now prints the tally.
The number is stated as what it measures — prompts the operator did not see — not as a verdict, because how
many prompts a person will tolerate is not something a ledger can hold. Pre-0.11.1 records are reported as
**not counted** rather than folded in: that older scalar over-claimed `prompt` (R-46), so including it would
bias the one direction this measurement must not be biased in. **Only usage produces the number.**

**Item 2 — R-49, parked as "do not harden a layer whose fate item 1 decides".** The park was right about
hardening and wrong about this fix, because it was **reuse**: the ledger's lock moved to `src/file-lock.ts`
and both writers share it, so there is no new mechanism and nothing extra to delete if Option 3 is ever
taken. Two decisions inside it, both the ledger's *opposite* and both following from what the file is —
writes lock and reads do not, and a lock this cannot take never fails your work. The test is the property:
two concurrent writes, and the expected `{b, c}` is **satisfiable only under a lock**, since unlocked leaves
either the revoked entry resurrected or the concurrent save lost.

**R-61 fell out of it, and it is the worse defect.** `revokeApproval` returned a boolean for three facts, so
a **failed write printed "no persisted approval named X"** — telling an operator performing a security
action that the approval they were revoking did not exist, while it was still in effect and still satisfying
gates. Reassuring and wrong. Now `"revoked" | "absent" | "failed"`, breaking, and `failed` says the approval
**is still in effect**.

**Item 4 — pane cleanup.** Open panes are now closed on `exit`; SIGKILL and an unlistened SIGTERM are not
covered and say so. **The obvious completion is refused**: a SIGINT/SIGTERM listener would close those cases
and *suppress Node's default termination*, taking over an application decision this package has no standing
to make — pi uses SIGINT to interrupt a turn, and a handler that re-raised would turn that into "exit pi",
on **every** session rather than the opt-in ones. A governance package quietly changing its host's interrupt
semantics is worse than the leak. Also found there: `tab create` replying without a pane id returned *before*
`cleanup` was defined, so the one path where herdr half-succeeded was the one that leaked a tab.

**Items 6 and 7 are not work.** `subagents:rpc:spawn` is unfixable from here (ADR-0013) and `bash` is out of
scope (ADR-0012). Re-deriving either wastes a session; both are in the table so nobody tries.

**Item 3 went to the operator and came back decided — ADR-0026.**
The blocking question was *what happens to an approval resolved after its tool call returned*. The answer:
**refuse the spawn**, recorded as `gatedBlocked` with no source. A late approval starts nothing, so the
effective set never depends on when a human got to the dialog. Consequence: background mode is only useful
for **ungated** capability sets, and the remedy is operator pre-approval. **Not implemented** — what was
missing was a decision, not code, and ADR-0015 had declined to decide it once already.

**Verified: 301 unit, 25 integration, typecheck clean, smoke clean.** Every fix mutation-checked — removing
the lock fails the race test alone; leaving a pane tracked fails the reaper test alone; restoring
`verifyLedger`'s rethrow fails the R-60 test alone.

**None of this is independently reviewed.** See the four hypotheses at the top of this file.

---

## 2026-08-14 (ninth) — R-60: the ledger check was silent on the worst damage there is

**Pulled the "fourth thing": grep for call sites rather than trusting a reading, then ask where else this
shape appears.** It found one, in the control shipped the session before.

`verifyLedger` **rethrows** every read error that is not `ENOENT` — right for `/grants ledger`, where an
operator asked. At session start that call sat inside `session_start`'s blanket `try/catch`, and the catch
was **empty**. So an unreadable ledger threw and cancelled every remaining control in silence.

**Confirmed by execution before writing anything down** (habit 1). A governed session with
`PI_GRANTS_LEDGER` naming a directory emitted **zero** notifications — no alarm, and not even
`grants: depth 0/2, holding [...]`, the one line that says governance is on. The same harness with an
ordinary path emitted it, so the probe was not simply broken.

This is **R-34's own shape one level down**: R-34 was *"a check an operator has to know to run is not a
control"*; R-60 is a control that does not run on the one input class it exists for. A trail nothing can
read is more damaged than a trail with a torn line, and it was the case that said nothing. The tell was an
asymmetry already in the tree: `appendRecord` is called with `strict: true`, so the first *spawn* against
that same ledger refuses loudly. Only the startup check was quiet.

Fixed in two places. The `verifyLedger` call has its own `catch` that names the path, the errno and the
remedy; the outer catch is **loud** instead of empty, and says which checks did not run rather than implying
they passed. One integration test against real pi asserts both halves — the new alarm fires **and** the
`holding [...]` line still arrives, which is what pins the discarded-controls defect rather than the message
alone. Mutation-checked: restoring the rethrow fails that test and nothing else.

**Stated rather than hidden** (rule 6): the loud outer catch has **no direct test**. Every loader inside the
hook already swallows its own filesystem errors, so after this fix nothing reachable throws past it. R-60's
trigger is written for that — any new `await` in `session_start` whose callee rethrows belongs in its own
`catch`, not the blanket one.

**Verified: 295 unit, 24 integration, typecheck clean, smoke clean.**

**Not yet reviewed independently.** The log's own loudest sentence says get the review before shipping the
next three things. This is thing one.

---

## 2026-08-14 (eighth) — the fixture directories clean up after themselves

**Known-open item 5, closed.** Every suite created a `mkdtemp` directory per test and none removed it —
4,896 under `/tmp` in one day. `test/tmp.ts` now hands them out (`tempDir`) and remembers them
(`cleanupTempDirs`), and each of the nine suites that makes fixtures registers one top-level
`after(cleanupTempDirs)`. Measured: `ls /tmp | wc -l` is **identical** before and after a full `npm test`
and a full `npm run test:integration`, where it previously grew by hundreds.

**The half that is not bookkeeping.** A helper nobody is *required* to use decays back one suite at a time,
which is exactly how the count reached 4,896 — the old `after()` in `governance.it.ts` was an empty block
whose comment said *"the OS reaps them"*. So `test/temp-hygiene.test.ts` scans `test/` and
`test-integration/` and fails on any file that calls `mkdtemp` directly or that calls `tempDir` without the
teardown hook. Same shape as `file-size.test.ts`: a constraint nobody can run is a preference.

The one property the old comment was protecting — fixtures left on disk after a failure — survives as
`PI_GRANTS_KEEP_TMP=1`, an opt-in rather than the default that leaked.

**Mutation-checked both ways** (rule 7): restoring one bare `mkdtemp(join(tmpdir(), …))` fails the scan,
and stubbing `cleanupTempDirs` to remove nothing fails the removal test. Nothing else fails in either case.

Also corrected: the `CLAUDE.md` verification block still said **250 unit / 9 integration / 3 model** — stale
by roughly forty-five tests, and the second stale-counts finding in two sessions (R-59 was the first).

**Verified: 295 unit, 23 integration, typecheck clean, smoke clean.** The four model-driven tests were not
re-run — they cost money and the change to `delegation.it.ts` is one import line, typechecked.

---

## 2026-08-14 (seventh) — session close: the untested warning, and 4,896 temp directories

**Two pieces of cleanup, one of which was a real gap.**

**The `agent:*` + ungated-`bash` warning shipped without a test.** It was added from a review finding —
*a hazard a document declares and no code detects is R-47's shape* — and then immediately became the same
thing one level down: a detector nothing verified, which by rule 7 is decoration. Two tests now: the alarm
fires for `agent:*,tool:bash` with `PI_GRANTS_GATED=""`, and — the half that keeps it worth reading — it
stays **silent** for the default configuration where `bash` is gated. Warning about a correct setup is
R-25's shape inside the warning added to prevent R-25's shape.

**The suites left 4,896 `mkdtemp` directories under `/tmp` in one day.** Every suite creates one per test
and none clean up; the harness comment says "the OS reaps them", which is true and slow. Removed at close
and recorded as item 5 — hygiene, not correctness, and an `after()` hook per suite would fix it.

Also removed: `~/.pi/agent/grants-approvals.json`, which held nothing but this project's own test fixture
(`tool:write@x`, `cwd=/tmp/grants-approvals-…`, a zeroed digest, `version: 2` — a version the loader
rejects). It was written by `npm test` before R-40 was fixed, verified inert before deletion, and the live
per-project store had never been created, so nothing real was ever stored there.

**Final state verified: 292 unit, 23 integration, 27 with `PI_GRANTS_IT_MODEL=1`, typecheck clean, smoke
clean, working tree clean.**

---

## 2026-08-14 (sixth) — the ledger check runs itself — 0.12.1

**R-34, closed on the distinction it was opened on.** That entry exists because ADR-0008 leans on the ledger
as its compensating control and nothing had ever read one back; the fix added `verifyLedger` and
`/grants ledger`, *"because a check an operator cannot run is not a control"*. What went unnoticed is that
the same sentence applies one level up: a check an operator has to **know to run** is a feature, not a
control. Nothing ran it.

`verifyLedger` now runs at session start whenever `PI_GRANTS_LEDGER` is set, and a damaged trail announces
itself as an error naming the first bad line. **Corruption only** — the escalation count stays a query.
Reporting historical attempts at every start is the fatigue shape R-25 names, and it ends with the operator
skipping the line that matters. Two tests: one that the alarm fires unasked (driving `/grants`, not
`/grants ledger`), and one that an intact ledger — *including one holding a recorded escalation attempt* —
says nothing at all.

Awaited rather than fired and forgotten: it is one read on a path that already awaits two directory scans,
and awaiting is what guarantees the warning reaches a live `ctx.ui`.

**Verified: 292 unit, 21 integration, typecheck clean, smoke clean.** Mutation-checked — stubbing the
corruption branch fails the alarm test and nothing else.

---

## 2026-08-14 (fifth) — the two decisions, and one package fewer — 0.12.0

**ADR-0024: a gated `agent:` id now asks before the definition runs.** R-47 was a gate that did nothing on
the path an operator writing it means, because `gatedBlocked` filters `requested` and a definition spawn's
`requested` is its *ceiling* — the authorising id was never a candidate. It half-worked when some other
definition passed the id down in its own `allowed-tools`, which is worse than not working.

The load-bearing implementation detail: the id is evaluated against the gate **without joining `requested`**.
A capability in `requested` flows to `effective`, which becomes the **child's** grant — so the child would
hold `agent:deploy` and could spawn `deploy` itself with nobody asked. This is the parent's authority to run
it *now*, not something the child receives. Pinned by a test that asserts the id never reaches
`PI_GRANTS_GRANT`.

This closes the gap ADR-0023 recorded against itself: `agent:*` now has its "except", so
*"any of our definitions, narrow tools, and a human in the loop for the one that ships things"* is
expressible in two variables.

**`test/file-size.test.ts` caught its author for the second time.** ADR-0024 pushed `src/delegate.ts` to 413
lines and the guard refused it, naming the remedy. The cap was not raised: the capability-id helpers moved to
`src/capabilities.ts`, and the seam was not chosen for convenience — three modules outside `delegate.ts`
already imported them, which is the evidence they were a separate concern in the wrong file. `delegate.ts`
re-exports them so the split stays internal and no caller pays for a line count it did not cause.

**ADR-0025: `pi-token-audit` is deleted**, and the reasoning matters more than the deletion. **Not because it
lied.** G10 falsified its headline on 2026-08-10 and `5c593fb` fixed it hours later — the report has said
*"% of request CHARACTERS … not a token measurement"* ever since. Both red-team reviewers said otherwise, and
so did I, three times, from a stale line in `CLAUDE.md` (R-59). Deciding on that premise would have been
right by accident.

The real argument is the one R-59 demonstrated: **a second package in a single-product repository is a second
thing every orienting document must keep true**, and the cost showed up as a fixed defect being described as
live for four days in the file every reader and every reviewer starts from. What is kept is the *finding* —
G10 stays in `docs/probes/`, where a headline that survived review, reached the session log as a verified
fact and fed ADR-0006 before anyone noticed `promptTokens` cancels is one of this project's better pieces of
evidence. The code that produced it does not have to stay installed for the lesson to stay learned.

**Verified: 292 unit, 19 integration, 23 with `PI_GRANTS_IT_MODEL=1`, typecheck clean, smoke clean.**

---

## 2026-08-14 (fourth) — the second red-team pass, over the four ADRs written that morning — 0.11.2

**Six more entries (R-53…R-58), all fixed the same session, and one of them shipped.** `architecture-critic`
and `product-strategist` reviewed ADR-0020–0023 and the R-38/R-46/R-51 work. Everything acted on was
reproduced by execution first.

**Found before dispatching, by re-reading my own change: the republish laundering hole.** `verifyInherited`
stopped a session *using* a stale-pinned approval, but `republishable` mapped over the RAW inherited keys and
re-stamped each with THIS session's digest — so a middle session that could not use an approval handed its
child a valid-looking one. ADR-0022's hole, inside ADR-0022's fix. That is the **second** time in two days a
fix has contained a smaller copy of the bug it fixed, and both were caught by asking *"where else does this
shape appear?"* rather than by tests.

**R-53, the one that shipped, and the pass ranked it first.** `planWithApprovals` re-plans with the
just-approved capabilities, and that literal carried **no digest** and **one scope for the whole set**:

- Unpinned: `verifyInherited` honours an entry with no pin *by decision* (`<delegate>` names no file; a
  pre-0.11 parent sends none), so every freshly-approved capability crossed to the child **exempt from
  ADR-0022** — false on exactly the approvals the ADR was written for. What hid it was **sort order**: both
  spellings were published and `parseInherited`'s last-write-wins let the pinned one survive. A security pin
  defended by lexicographic collation is not defended.
- One scope: `outcome.scope` was a single variable overwritten by the last capability answered, so approving
  A *once* and B *session* re-stamped A as `session` — ADR-0014's A-S1 reopened by a mixed answer.

The fix worth keeping is the third part. Attaching a digest at both call sites would have worked and would
have been the same bet that just lost, so **`inheritApprovals` now refuses to publish an unpinned entry for
any subject but `<delegate>`**. A caller that cannot produce a digest publishes nothing. Eight existing tests
failed on that change — their fixtures predated the pin — and each was updated rather than the rule relaxed.

**R-54 broke the one rule this package must never break by accident: governance is opt-in.** `resolve()` had
no `tool:*` coverage rule. `docs/SPEC.md` has always claimed the wildcard "satisfies any capability" and
`maySpawnDefinition` has always honoured it for definition ids — `resolve` disagreed with both. So with **no
`PI_GRANTS_GRANT` at all**, spawning a definition whose `allowed-tools` names `agent:worker` or
`skill:review` was refused as *"capability escalation blocked"* and recorded as an escalation attempt.
R-28's shape again: two spellings of one rule, and the enforcing one was wrong. ADR-0023 edited that exact
function and restated the false claim rather than noticing it.

**R-55: `agent:*` could not be handed down at all.** `unknownCapabilities` runs before `resolve` and the
catalog holds no wildcards, so ADR-0023's Decision was live only at the root. Wildcards are grammar, not
entries.

**R-56: `/grants ledger` manufactured an incident.** The R-51 listing shipped that morning compared digests
by **name only**, while `verifyLedger` had carried `source` all along — so two projects' same-named `deploy`
definitions read as one definition that had CHANGED, complete with the NOTE the code calls "the finding".
A diagnostic inventing an instruction change, in the one command ADR-0018 points an investigator at.

**R-57: the per-project filename was 24 bits** — and ADR-0020 deleted the `foreign-cwd` carry-through on the
premise that one file means one directory, so inside a collision R-41 returns with its mitigation gone.
Widened to 64.

**R-58: four documents described behaviour the code no longer had**, all introduced by the preceding two
days. The one this project's rules single out: `src/approval-store.ts` still said *"One file for all
projects"*, contradicted eight lines later in the same comment block. A register entry may describe what was
believed on its date; **a source comment describing present behaviour may not.** The README's opening
paragraph had also quietly re-acquired the unqualified claim a reviewer forced out of SPEC the day before.

**Two amendments to decisions, both from the strategist and both fair.** ADR-0020's revisit trigger said
*"any further defect traced to this layer"* — unfalsifiable, since every defect since would have tripped it
and none did. It is now two concrete conditions, either sufficient: **one** case of `entryVerdict` honouring
an approval it should have voided, or **two** M×M defects in that layer reaching a *released* version rather
than being caught in the session that introduced them. And ADR-0023 now records that it **shipped without
its exception**: `agent:*` makes `PI_GRANTS_GATED=agent:<name>` the only route back to per-definition
control, and R-47 is that gate being a silent no-op — so R-47's enforcement decision is no longer an
independent item.

**Cleared as sound**, which is worth as much: the republish fix, `parseInherited`/`verifyInherited`,
ADR-0021's deletion (and `sanitise`, which now has the test rule 7 requires), R-46's derived scalar, the
per-project layout, and — checked against pi's own plumbing — `cwd` canonicality, so trailing slashes and
symlinks are not reachable through the CLI.

**Verified: 287 unit, 19 integration, 23 with `PI_GRANTS_IT_MODEL=1`, typecheck clean, smoke clean.**
Mutation-checked: stubbing the digest comparison fails the R-51 test alone; replacing `sanitise` with a
plain rewrite fails the ADR-0021 test alone.

---

## 2026-08-14 (later) — the queued work: the digest becomes readable, and the ledger stops over-claiming — 0.11.1

**Three fixes from the red-team pass that needed no decision.** None changes what the product claims; each
makes an existing claim true.

**R-51 — `definitionDigest` had no reader, so ADR-0018's promise was unkeepable.** That ADR advertises that
a record answers *"did these four children run the same instructions?"* and *"has this definition changed
since?"*, and `verifyLedger` never touched the field — both questions needed hand-written `jq`, and the
second was not even reproducible with `sha256sum`, because the digest covers the body and not the
frontmatter. `verifyLedger` now groups by `name`+`sha256`, and `/grants ledger` prints each version with its
spawn count and compares it against disk:

```
  instructions 2 distinct version(s) across the recorded spawns
    docs-writer  4f2a91c8b0d3  2 spawn(s)  — current
    docs-writer  000000000000  1 spawn(s)  — CHANGED since
    NOTE docs-writer ran under more than one version of its instructions in this ledger
```

The comparison uses **the same `snapshotOf` that voids an approval**, so this listing cannot disagree with
the enforcer about whether a definition changed — the R-28 discipline applied to a new diagnostic rather
than rediscovered by it later. Two rows under one name are called out explicitly, because that is the
finding, not a formatting quirk.

**R-46 — the ledger claimed a human was asked about capabilities they never saw.** `obtainApprovals`
returned one scalar `source` for a whole set, chosen as `scope ? "prompt" : sources[approved[0]]`. Gate
`tool:bash` and `tool:write`, let a persisted entry cover `bash` while a human clicks *Allow once* for
`write`, and the record read `approvalSource: "prompt"` for both. `resolveApprovals` had always computed the
per-capability map; the defect was that it was thrown away.

The fix keeps both fields and makes one a **derived summary of the other**: `approvalSources` always, and the
scalar only when every capability shares one source — omitted rather than guessed when they differ.
`buildRecord` derives it instead of accepting it, so no call site can supply a summary that disagrees with
the map beside it. Old lines stay readable; new ones cannot lie.

**R-47 — `PI_GRANTS_GATED=agent:deploy` is a gate that gates nothing**, because `gatedBlocked` filters
`requested` and a definition spawn's `requested` is its *ceiling*, which never contains `agent:<name>` —
ADR-0017's authorisation check is a separate, ungated branch. It *does* bite when a definition passes the id
down in its own `allowed-tools`, so the flag **half-works, which is worse than not working**. A startup
warning now names it, says a human is never asked, and points at what does work (withhold the capability
from `PI_GRANTS_GRANT`). **Making it enforce is deliberately left as a decision** — that is a behaviour
change. The silence was indefensible either way.

**Verified: 283 unit, 19 integration, 23 with `PI_GRANTS_IT_MODEL=1`, typecheck clean, smoke clean.** The
R-51 test was confirmed to fail when the digest comparison is stubbed to `true`, and nothing else fails with
it.

---

## 2026-08-14 — four decisions from the red-team pass, implemented — 0.11.0

**The three open decisions and one config cliff from yesterday, answered by the user and shipped.** Four
ADRs (0020–0023), each recording the option that lost and what it would have bought. **Two are breaking.**

**ADR-0020 — one approval file per project.** The shared store could not express two checkouts holding an
approval for a same-named definition (`review`, `deploy` — the case that arises the moment an operator
reuses their own conventions), and every write touched every project's data, which is where R-41, R-42, R-43
and R-49 all came from. The obvious fix — nest by `cwd` inside one document — **lost**: it closes the
collision while leaving that shared read-modify-write intact, which is the bet that had already lost four
times. Per-project files make the collision *inexpressible*. Option 3, deleting persistence entirely, was
steelmanned properly: this file has produced **nine** recorded defects and ADR-0019 rejected deletion twelve
hours before most of that evidence existed. It lost because the cost lands on ADR-0012's default `bash`
gate, which is the one gate an operator never opted into and therefore the one most exposed to R-25 fatigue.
The old file is **ignored, not migrated**, and reported once — migration would be code that runs on exactly
one input per machine, inside the layer with nine defects.

**ADR-0021 — the task is never stored.** `taskAtApproval` is deleted rather than exempted, so
`ledger.ts`'s unqualified *"the task is not recorded, anywhere, ever"* is now true. The write path projects
every entry through a **whitelist of declared fields**, which closes the class instead of the instance: no
future field can reach disk by riding on a parsed object. Option 2 — show the pinned body digest instead —
lost on ordering: R-51 says nothing reads digests yet, so the line would have invited an operator to act on
a value no tool can help them with.

**ADR-0022 — an inherited approval names its instructions.** `PI_GRANTS_APPROVED` now publishes
`capability@subject#sha256` and the child verifies it against the definition **it** loaded. A republished key
carries *this* session's digest rather than the one it received, so a stale pin cannot travel another hop —
the hole this closes rather than moves. An unpinned entry is still honoured (`<delegate>` has no file to
hash; a pre-0.11 parent sends none), and that asymmetry with `entryVerdict` is deliberate and argued: a live
parent in the same tree is a much shorter chain to trust than a 30-day-old file. `key#` with nothing after it
is dropped rather than guessed at.

**ADR-0023 — `agent:*`.** The configuration *"may spawn any of our definitions, but never hand over
`write`"* was unexpressible, and the only workaround was `tool:*` — **the ergonomic option was the least
safe one on the menu**, which is R-25's shape. `agent:*` confers no tool authority. It is the **only**
wildcard rule in `resolve()` and is deliberately not generalised to `<ns>:*`, so a namespace added later
cannot silently acquire one. Prefix globs (`agent:review-*`) were rejected on ADR-0016's reasoning about
`Bash(git:*)`: a security control implemented by string-matching is wrong at the edges.

**Three implementation notes worth keeping.**

1. **`AGENT_WILDCARD` lives in `resolve.ts`, not beside `WILDCARD` in `pi-tools.ts`** — because `resolve.ts`
   has *no imports at all* and `pi-tools.ts` imports `Capability` from it, so the obvious placement would
   have made the dependency circular. Worth preserving: the one module where an escalation could be
   introduced is the one whose behaviour is fully determined by its arguments.
2. **Two unit tests written yesterday had to be re-targeted**, not deleted. They pinned the `foreign-cwd`
   carry-through that 0.10.2 needed and ADR-0020 removes; the property they were really about — one
   project's approvals cannot affect another's — is now asserted against the layout instead of the logic.
3. **A regex ate its own helper.** A bulk edit rewriting `writeFile(approvalsPath(cwd), …)` into
   `stage(cwd, …)` also rewrote the body of `stage` itself, giving it an infinite recursion that hung
   `npm test` with no output. Read what a bulk edit matched before running the suite on it.

**Verified: 282 unit, 17 integration, 21 with `PI_GRANTS_IT_MODEL=1`, typecheck clean, smoke clean.** The
model-tier lifecycle — dialog, write, reload in a different process with no prompt, void by body edit — was
re-run against the new per-project store and passes unchanged.

---

## 2026-08-13 (last) — the red-team pass, and what one pair of eyes had missed — 0.10.2

**The caution at the top of this file said a review of ADR-0017/0018/0019 was probably worth more than the
next feature. It was.** `architecture-critic` and `product-strategist` ran against the three ADRs and the
R-38 fix. Thirteen risk entries (R-39…R-51), six fixed the same session, and **both reviewers independently
found the same one** (R-44), which is usually the sign a finding is real.

**Every finding acted on was reproduced by execution before it was written down** — and two turned out
*worse* than reported, which is the argument for that rule rather than a restatement of it.

**The one that shipped: R-39.** `delegate`'s `agent` parameter description was computed at registration
time, which is synchronous in the extension factory — before the `session_start` hook that loads the
definitions. So the map was always empty and **every model in every governed session read
`Available: none.`** It then did the reasonable thing and used `delegate({tools})`: no operator-authored
instructions, no `agent:` prerequisite, no body digest on the record, and permanently denied `always`.
**ADR-0017 and ADR-0019 were both dead machinery in exactly the way ADR-0019 was written to prevent** —
every dialog was a `<delegate>` dialog again, which is the prompt fatigue that argument turned on. The
comment on the line reasoned carefully about grant staleness and never noticed the map was empty.

Fixing it needed a fact nobody here had: **pi serialises a tool's schema at request time, not at
registration.** Measured with a throwaway probe that rewrote a parameter description in `session_start` and
read it back out of `before_provider_request`'s payload — `AFTER_SESSION_START` arrives at the provider. So
`refreshSpawnable()` is called from both hooks, writing through the *constructed* schema because
`Type.Optional` shallow-copies its input.

**The one that was destroying data: R-40.** `approvalsPath(_cwd?)` ignored its argument — a vestige of the
pre-ADR-0014 in-workspace store — so the unit suite passed a `mkdtemp` directory, believed it was hermetic,
and **rewrote and cleared the developer's real `~/.pi/agent/grants-approvals.json` on every `npm test`.**
Confirmed by looking: the file contained this suite's fixture, `cwd: /tmp/grants-approvals-oFhqs6`, with a
body digest of sixty-four zeroes. Latent while nothing could write the store; destructive from the moment
ADR-0019 made it reachable — and this very log had applied that reasoning to the *integration* suite the
same morning without carrying it back to the unit suite. The parameter is now gone entirely, so the mistake
is unspellable rather than merely fixed.

**Two findings that were worse than the report.** R-41: approving in project B does not merely ignore
project A's approval, it **deletes it from the file** — and, not in the report at all, the storage key is
`capability@subject` with no project component, so two checkouts with a same-named definition (`review`,
`deploy` — the common case) **cannot both hold an approval**. The pruning half is fixed; the keyspace needs a
format decision. R-42: the atomic-write temp file was named per *process*, so two concurrent
`saveApproval` calls unlinked each other's temp and **both returned failure having written nothing** —
measured with two *different* keys, so never limited to the shared-dialog case the finding described. That is
`delegate_all`, i.e. `always` failing precisely in the case ADR-0019 says drives adoption.

**Also fixed:** R-43 (`/grants revoke --all` revoked every project on the machine) and R-48 (`/grants`
truncated its verdict list at 12 in silence, dropping the *global* definitions first).

**Open, and needing decisions rather than patches:** R-41's keyspace, R-44 (the model-authored task is
written to disk and printed back, which `src/ledger.ts` forbids in unqualified terms — *"not recorded,
anywhere, ever"*), R-45 (the body pin is enforced on the persisted path and on neither the session nor the
inherited one), R-46 (one `approvalSource` for a mixed set, so the ledger can claim a human was asked when
they were not), R-47 (`PI_GRANTS_GATED=agent:x` is a silent no-op), R-49, R-50, R-51.

**Two things the reviewers cleared, which is worth as much.** The `ctx: null` preview added this morning has
no side effects — it returns before the gate is built, so it never touches the single-flight queue, session
approvals, `publishChildEnv` or `process.env`, and its only I/O is one read. And R-29's `once` fix still
holds now that the approval subject varies per definition.

**A process note worth keeping.** A model-tier run failed mid-pass and it was not a defect: source was
edited *while* the run was live, and a two-step edit left `grants-command.ts` briefly referencing a constant
declared later. Every `/grants` spawned in that window produced no verdict lines. **Do not edit the tree
while an integration run is in flight** — the failure looks exactly like a real regression.

**Verified: 276 unit, 17 integration, 21 with `PI_GRANTS_IT_MODEL=1`, typecheck clean, smoke clean.** The
mutation checks are recorded with each fix: removing `refreshSpawnable()` fails the R-39 test and nothing
else; the store's real file is byte-identical across a full `npm test`.

---

## 2026-08-13 (sixth) — the README caught up with four versions of the product

**The largest purely-mechanical job left, and it was not entirely mechanical.** `packages/pi-daddy/README.md`
still described the deleted pi-subagents interceptor as a provisioning path, and its own 0.7.0 banner said so
— which is a reasonable thing to write once and a bad thing to leave standing for three more releases.
Rewritten against the code, 626 → ~656 lines.

**Four generations of staleness, and two of them were actively dangerous to a reader:**

1. **§"What an agent type's ceiling actually is"** documented the pi-subagents frontmatter rules, whose
   central case is **inverted** in this product: there an absent `tools:` key meant pi's full default
   toolset, here an absent `allowed-tools` means *undeclared, therefore not spawnable*. An operator
   following the old table would have believed a declaration-free definition was the powerful one. Replaced
   by a `SKILL.md` ceiling table, with the inversion and the pattern refusal (`Bash(git:*)`) called out as
   the two load-bearing rows.
2. **§Approving a gated capability** said *"`always` is offered only on the interceptor path"* — the exact
   sentence ADR-0019 falsified — and, three paragraphs below its own 0.6.0 banner saying the store had moved
   out of the workspace, still said persisted approvals live in `.pi/grants-approvals.json`. A document that
   contradicts itself within one section is worse than one that is merely out of date.
3. **§"Enforce, not provision — the interceptor's limit"** and **§"Verified live against real agent types"**
   described code that no longer exists. Deleted rather than annotated; the probes hold that history, and
   `docs/probes/approval-ux` is now explicitly labelled in the README as a record of an interceptor run
   rather than a description of this version.
4. **Two test sections disagreed with each other** (149 vs 222 unit tests, both wrong) and the status header
   said 0.6.0. Collapsed into one, now 272 / 17 / +4.

**Two gaps found while writing, which is the usual return on doing this properly.**
`PI_GRANTS_APPROVAL_TIMEOUT` was **undocumented everywhere** — not in the README, not in `docs/SPEC.md` —
despite deciding how long a governance dialog waits and having a deliberate `0` ⇒ *no timeout* reading. And
`PI_CODING_AGENT_DIR` decides where persisted approvals live, which the new integration suite depends on and
neither document mentioned. Both are now in both tables.

**The one claim that needed a test rather than a proofread.** The README shows a `/grants` line reading
`allow  deploy  tool:bash, tool:read  (tool:bash approved: persisted)`. Documented output drifts, so the
preview test now asserts that annotation and says in its message that it pins the README example. Everything
else quoted from the code was checked against the source it came from — the undeclared-definition refusal,
the planned argv (which gained `--no-skills`, `--no-context-files` and `--no-prompt-templates` since the old
sample was written), `MAX_CHILDREN_PER_CALL`, `STALE_LOCK_MS`, `skillDirs`, and `allowUniversal` still
existing.

The root `README.md` had the same class of drift in three numbers and one ADR count; fixed in the same pass.

**Verified: 272 unit, 17 integration, typecheck clean.** No behaviour changed except the one new assertion.

---

## 2026-08-13 (fifth) — the approval store, watched working — and R-38 found doing it — 0.10.1

**The one job in the last session's table that needed no decision, only a real run.** ADR-0019 had made the
persisted-approval store reachable for the first time since 0.7.0, with every branch of `entryVerdict`
unit-tested and **nobody having watched the thing work**. It now works, observed:
`test-integration/approval.it.ts`, 7 model-free tests plus one model-driven lifecycle.

**What the model tier actually observed**, in one test and in this order: a real model called
`delegate({agent: "bash-user"})`; the dialog was raised with the **definition** as its subject and *Always
allow in this project (30 days)* on offer — the option no version between 0.7.0 and 0.9.0 could display;
the entry landed in `$PI_CODING_AGENT_DIR/grants-approvals.json` pinning both the ceiling and the body
digest; the ledger recorded `approvalScope: "always"`, `approvalSource: "prompt"`; a **different pi process**
then ran the same delegation with **zero dialogs** and a ledger line reading `approvalSource: "persisted"`;
and after rewriting the body — frontmatter byte-identical, so only ADR-0018's digest can catch it — the
dialog was raised again and the dismissed delegation failed. First run, no flakes.

**`PI_CODING_AGENT_DIR` is set on every test in the file, and that is not hygiene.** `approvalsPath`
defaults to `~/.pi/agent/grants-approvals.json` (ADR-0014 moved it out of the governed workspace), so
without the override this suite would read *and write the developer's own approvals*. The harness sanitises
`PI_GRANTS_*` and nothing else, which is exactly right and exactly why this needed saying out loud.

**R-38, found by writing the free tier.** One test seeded a valid entry and asked the same session two
questions. `/grants approvals` said `1 persisted approval`; `/grants` said
`BLOCK  bash-user — tool:bash requires explicit approval`. A real spawn would have proceeded. The cause is
**R-28's shape one layer up**: `/grants` ran the real `planDelegation` — which is why the file claims a
diagnostic cannot disagree with the enforcer — but enforcement is *plan → gate → approvals → re-plan*, and
`planDelegation` knows nothing about approvals by design. **Sharing the function while not sharing the
sequence** left the two free to disagree again.

Fixed by making the sequence the shared thing: `planWithApprovals` in `extensions/run-delegation.ts`, used
by the enforcer and by `/grants`, differing in one argument. `ctx: null` means *preview* — stored approvals
count exactly as they would for a spawn, and no human is asked.

**The rejected way of expressing that is the interesting part.** `hasUI: false` was the obvious lever and it
is a *different fact*: it means "there is nobody here to ask", which is true in every governed child, and it
replaces the plan's reason with advice about pre-approving in an interactive session. Using it would have
turned every gated definition's `BLOCK` line into a message about interactive sessions — and an existing
integration test asserting `tool:write requires explicit approval` would have caught it. Two different
absences of a human, kept distinguishable.

The listing also now says **why** it allows: `allow  bash-user  tool:bash, tool:read  (tool:bash approved:
persisted)`. An `allow` that silently depends on a 30-day entry in a file in the home directory is the thing
an operator ran `/grants` to discover.

**Three mutations were run to prove the new tests can fail** (rule 7, applied rather than asserted). Making
an unpinned entry fail *open* — `entry.bodyAtApproval && entry.bodyAtApproval !== current` — fails exactly
the fail-closed test and nothing else. Deleting the body comparison outright fails three. The preview test
had already failed against the shipped code before the fix, which is how R-38 was found.

Also folded in: `DelegationToolContext` now extends `ApprovalUIContext` instead of being passed through an
`as never`, and three dead imports left over from the `grants.ts` split are gone. `CLAUDE.md`'s state line
had been stale since 0.7.0 (three versions and three ADRs) and is current again.

**Verified: 272 unit, 17 integration, 21 with `PI_GRANTS_IT_MODEL=1`, typecheck clean, smoke clean.** The
model tier was re-run over the *whole* suite after the refactor, deliberately: the enforcement path changed,
and the model tests are the only thing that watches it end to end.

---

## 2026-08-13 (fourth) — ADR-0019: the persisted-approval store was unreachable — 0.10.0

**Found by grepping for call sites instead of trusting a reading.** R-37 was filed saying `always`
approvals *downgrade* on the delegate path. Wrong, and the correction is the useful part: `always` was
**never offered**. `offeredScopes` gated it on the path literal `"interceptor"`, and ADR-0016 deleted the
only caller that passed it. **No version since 0.7.0 could create a persisted approval at all** — so
`approval-store.ts` (220 lines), `entryVerdict`'s confused-deputy check, ADR-0014's atomic-write /
symlink-refusal / foreign-`cwd` work, and `/grants approvals|revoke` were all guarding a file nothing could
write. `docs/SPEC.md` said `always` was available *"on paths with a human-authored subject"*: true, and
misleading, in one sentence.

The user chose to make it reachable over deleting it (the steelmanned option — this project's best moves
have been deletions, and 220 lines of mutable on-disk state is its largest surface). The argument that
carried: `agent:` was three lines of decoration when R-35 faced the same choice, whereas this is working,
well-tested code implementing a property that was hard to get right, and what it buys is specifically the
survival of ADR-0012's default `bash` gate. A gate switched off by prompt fatigue is worse than one never
claimed.

**What shipped.** `delegate({agent: X})` approves against **X** on a new `"definition"` path that offers
`always`; `delegate({tools})` keeps `<delegate>` and keeps being denied it, because there the original
reasoning is untouched. A persisted entry pins the ceiling **and** ADR-0018's body digest, so rewriting a
definition's instructions voids it (`instructions-changed`) — strictly stronger than ADR-0010 designed,
since `ceilingForDefinition` reads only `allowed-tools` and could never have seen a body change. An entry
with no body pin fails closed: unverifiable is not unchanged. `CeilingLookup` became one `SubjectLookup`
returning `{ceiling, bodySha256}`, because two parallel callbacks is R-28's shape waiting to happen.

**The line-cap test caught its own author.** Adding this pushed `extensions/delegation.ts` to 403 lines and
`test/file-size.test.ts` — added this morning — failed. Raising the cap the day after writing it would have
neutered the guard, so the file was split as the failure message instructed: `run-delegation.ts` (what a
delegation *does*, 223 lines) and `delegation.ts` (how pi is *told* about it, 198). That is the guard
working exactly as designed, on the person who installed it.

**Verification was interrupted and is worth recording.** The Bash tool was unavailable for a stretch mid-task
(an unrelated outage), so the code sat fully edited and completely unverified. Nothing was committed and no
"fixed" note was written during that window — a claim of green with no run behind it is exactly what rule 5
exists to prevent. Everything below was run afterwards: **272 unit + 10 integration**, typecheck clean,
smoke clean.

---

## 2026-08-13 (third) — ADR-0018: the ledger records *which* instructions ran — 0.9.0

**R-35's audit half, closed as far as it can honestly be closed.** Every spawn naming a definition now
records `definitionDigest: {name, source, sha256}` over the body — the exact text passed as
`--append-system-prompt`.

**The binding constraint was already written down, at the top of `src/ledger.ts`:** *capability ids, counts
and identifiers only — never prompts, tool arguments or results.* That rule sorted the options by itself.
Two texts direct a governed child and they fall on opposite sides of it: the **body** is operator-authored,
already committed to a repository, and a hash of it is an *identifier*; the **task** is assembled by the
model from the parent's context and could carry anything the parent could see. So the body is digested and
**the task is never recorded, in any field, by decision** — the privacy rule now says so outright instead of
leaving it to be inferred.

The user declined the body **snapshot** (Option 2). The argument that carried: the ledger write path is a
fail-closed governance dependency, and doubling what can break it would mean either a full disk stops
governance or a record claims a snapshot that may not exist. The digest is the addressing scheme a snapshot
store would need anyway, so nothing is foreclosed.

**Three implementation details worth keeping.**

1. **The digest is over the body alone**, not the frontmatter — otherwise rewording `description` would
   report an instruction change that never happened. Pinned by a test that does exactly that.
2. **It is assigned into `empty`**, the object every refusal spreads, so it appears on every outcome from
   the point the file is read. That is the R-28 discipline applied to a record field: one spelling instead
   of eight that a ninth return could forget. The success return does not spread `empty`, so it names it.
3. **An ADR-0017 authorisation refusal carries NO digest** — deliberate, and the ordering is the reason. A
   caller who was never allowed to spawn the definition learns nothing about it, not even its hash.

**The test that matters is the ledger-file one**, not the plan one: the recurring defect here is a correct
value on the plan that the call site never passes to `buildRecord` (R-28, B-I3). It stages a `SKILL.md`
declaring a sub-tool pattern, so the plan is refused *after* the file is read and nothing spawns — then
reads the real JSONL line back. **Verified it can fail** by deleting `definitionDigest: plan.definitionDigest`
from `delegation.ts`; it does, and nothing else does. It also asserts a task sentinel is absent from the
line.

**R-37, found while scoping and recorded rather than fixed.** ADR-0017 falsified the premise behind the
fixed `<delegate>` approval subject — *"the only things naming a child are the task and the tool list, both
model-chosen"* — because a definition is now an operator-authored, capability-authorised subject. The
consequence is fail-closed (`ceilingOf("<delegate>")` is `null`, so `always` silently downgrades to
`session`) but it leaves ADR-0010's persisted-approval machinery **dormant on the only spawn path**, and
prompt fatigue is what gets gating switched off — R-25's shape. It is now the top open item.

268 unit + 10 integration, typecheck clean, smoke clean.

---

## 2026-08-13 (second) — ADR-0017: `agent:<name>` authorises a definition — 0.8.0

**R-35 closed as far as a capability model can close it, and R-36 found on the way.** The user chose Option
A (prerequisite) over the steelmanned Option B (delete the namespace). Shipped in two steps, in that order,
because step 2 does not work without step 1.

**Step 1 — R-36, found by measurement while scoping the ADR.** `deriveOwnGrant` filtered the inherited grant
against the session's *observed tool names*, and the matcher only ever matched `tool:` and `ext:` — so every
other namespace was dropped at the first provider request:

```
inherited      : tool:read, skill:review, agent:reviewer, ext:pkg/web_search
after  observe : ext:pkg/web_search, tool:read
```

**Live for `skill:` since R-32**: the child received the skill (it arrives as `--skill`) but could not
re-grant it, and `/grants` stopped listing something it held. Fail-closed, which is why it survived —
nothing fails when a grant quietly shrinks. It also made the `agent:` prerequisite unsatisfiable below the
root. Now only tool-shaped capabilities are filtered, in both the enumerated and wildcard branches.

**Step 2 — the prerequisite.** Spawning definition `X` requires holding `agent:X`; `tool:*` satisfies any of
them, because `resolve()` has **no wildcard rule** (a wildcard session works only because `deriveOwnGrant`
*enumerates* its observed tools, and definitions are not tools) — without that special case an **ungoverned**
session would have stopped being able to spawn, breaking "governance is opt-in".

Three details worth keeping:

1. **The refusal is a `denied`, not a bare reason.** `denied` is the escalation signal ADR-0008 designates,
   and asking to run a definition this session was not granted *is* an attempt to exceed the grant. A
   refusal leaving it empty would be invisible to every audit query.
2. **Authorisation is decided before anything is said about the file** — reporting "declares no
   `allowed-tools`" to a caller who was never allowed to spawn it discloses the definition and misnames the
   problem. Pinned by a test.
3. **It attenuates for free.** `ceilingForDefinition` already parsed `agent:` entries inside `allowed-tools`,
   so an operator writes a delegator's spawn rights in the same file as its tools, and `resolve()` already
   refuses to hand down one the parent lacks. Evidence the design anticipated this.

`delegate`'s tool description now lists only the definitions the session may actually spawn — listing all of
them would tell the model it can spawn things every attempt at which is refused, which is R-28's shape (a
description disagreeing with the enforcer).

**Breaking, and the breakage was visible in the suite**: five unit tests and four *integration* tests failed
until their enumerated grants gained `agent:` ids — the integration failures being the proof the rule bites
on the real path. **262 unit + 10 integration** (the extra one asserts the refusal end-to-end through
`/grants`), typecheck clean, smoke clean. `docs/SPEC.md`, the README banner and the quick-start grant all
updated; the README's deeper sections remain stale as before.

**Found and NOT fixed:** an `allowed-tools` entry written as `tool:read` becomes `tool:tool:read` — only
`ext:`, `skill:` and `agent:` pass through as written. It fails loudly (the catalog refuses it as unknown)
but the message names the mangled id rather than the mistake. Recorded in SPEC's known gaps rather than
fixed, because no ADR covers changing definition parsing and drifting into it during an unrelated change is
how the record stops matching the code.

---

## 2026-08-13 (first) — `extensions/grants.ts` split, and the ceiling made enforceable

**Behaviour-preserving by construction, and checked that way.** Baseline recorded first (250 unit + 9
integration, typecheck clean), then the file was cut apart and the same suites rerun. Nothing in `src/`
changed, `docs/SPEC.md` needed no edit, and no ADR was required: the product claims exactly what it
claimed yesterday.

| file | lines | holds |
| :--- | ---: | :--- |
| `extensions/grants.ts` | 202 | the pi surface only — three hooks, the tripwire, four registrations |
| `extensions/delegation.ts` | 381 | `runOneDelegation` and both tool registrations |
| `extensions/session.ts` | 228 | `createGrantsSession()`: env parsing, mutable state, `delegationContext`, `publishChildEnv` |
| `extensions/approvals.ts` | 193 | `obtainApprovals`, `republishable`, `ceilingOf` |
| `extensions/grants-command.ts` | 164 | `/grants`, unchanged |

**Every module takes the session as an explicit argument.** That is the point, not the line count. All four
wiring defects this package has had — the G7 `NaN` bound, the discarded `isError`, the unconditionally
registered `delegate` (S-5), R-28's omitted argument — were defects of *scope*: a value that was whatever
happened to be in the closure at one call site. Configuration on the session is `readonly`; the six fields
that genuinely change (`ownGrant`, `observed`, `observedTools`, `definitions`, `catalog`, `catalogReady`,
plus `cwd`) are read live **through the object**, because a copy of `ownGrant` taken at load time is a copy
taken before the tool surface is observed.

**Three things fell out of the split, all small, all deliberate.**

1. **`extensionCapabilities` was dead and is deleted** — ~28 lines whose only consumer was the interceptor
   ceiling ADR-0016 removed. It was still being maintained as if live. The fact its comment recorded is in
   `CLAUDE.md`; a dated note on R-28 records where its builder lives now.
2. **`GrantsCommandContext.inheritedApprovals` was typed `Map<string, InheritableApproval>`; it is a
   `Set<string>`.** Harmless only because the handler takes `ctx: any` and reads nothing but `.size` —
   i.e. it was caught by moving the value through a typed parameter, which is the argument for doing that.
3. **`createGrantsSession` takes no `pi`** (the log's sketch said it would) — with `extensionCapabilities`
   gone nothing in the session touches `pi`. `extensionPath` is passed *in*, because it must name the file
   pi loads as the extension and only `grants.ts` can say that about itself.

**`test/file-size.test.ts` (251st test) caps `src/` and `extensions/` at 400 lines.** Rule 7 satisfied: the
production change that breaks it is folding any of these back together, and it was verified by lowering the
bound to 200 and watching it fail with the offending files named. Tests are exempt — a long test file is
many small independent cases, not the failure mode being prevented.

**What it does not establish:** that the wiring is *correct*, only that it is unchanged. The 251 unit tests
still touch `extensions/` at only one point (`delegate-all-wiring.test.ts`); `session.ts` and `approvals.ts`
have no direct unit coverage, and the argument-list class of defect is now spread over three files instead
of hidden in one. The integration suite against real pi remains the check that actually exercises them.

---

## 2026-08-12 — a shipped enforcement defect, found by red-teaming a strategy question

**What the session was for:** the user asked whether the product could drop `pi-subagents` and rely on
"our library + pi". A `/brainstorm` over five options was stress-tested by the strategist and the
architecture critic. **The critic found a live defect that outranked the question it was asked.**

**R-28 — the `tool_call` hook reached a correct pure function through a wrong argument list.** Confirmed
by execution before it was written down, then fixed: one `decisionContext()` builder, four new tests in
`test/interceptor-wiring.test.ts` (the first unit coverage `extensions/grants.ts` has had), checked by
reintroducing the defect. **226 unit + 8 integration pass; typecheck clean.**

**Two lessons worth keeping.**

1. **A pure-core / thin-wiring design moves the bugs into the wiring.** `decideSpawn` and `ceilingFor`
   were correct and well covered — `agent-types-fidelity.test.ts:93` already pinned that an omitted
   `extensionTools` yields the wildcard. 226 tests could not see this because **the defect was in the
   argument list, and nothing tested the argument list.** Three reviewers had independently flagged
   `extensions/grants.ts` as the file with no unit coverage; that flag was correct and under-acted-on.
2. **This defect had been found and fixed once before, on `/grants` only** (see the comment on
   `extensionCapabilities`). Repairing the symptom at the call site that revealed it, rather than the
   shared call, is what let it survive on the enforcement path for two releases. The fix here is
   deliberately structural — the argument is now spelled in exactly one place.

**And it contaminated the question being asked.** ADR-0013 preferred the interceptor because `Agent` was
used 25× against `delegate`'s 0. Those calls cannot have passed a governed enumerated session while this
defect stood, so the number measures the **ungoverned** case. ADR-0015 therefore **declines to decide**
and asks for the measurement instead — the same failure mode as the original token-economics thesis
(ADR-0007), caught earlier this time.

**Re-measured, because prior probes were stale:** `@tintinweb/pi-subagents` is **0.15.0** (probes used
0.14.3) and pi is **0.84.1** (probes record 0.83.0). The proposal's core claims survive — still no
`tools` on `SpawnOptions` or `Agent`, RPC still `ping`/`spawn`/`stop`, children still in-process — but
its "unknown types get all tools" argument was answered upstream by `fallbackSubagent: "none"` (#183).
Recorded as R-31, with a differential test proposed as the missing tripwire.

**New to the landscape: herdr.** Panes are separate CLI processes, so `--tools` bites — the first spawn
mechanism other than our own where it does. The third-party `@andrewjacop/pi-herdr` is *not* the way in
(R-30: model-controlled `agentArgs` and `env`); speaking herdr's own CLI so **we** build the argv is
Option G in ADR-0015, and it would make herdr the child registry, answering most of the critic's
lifecycle objections to background delegation.

**Also recorded:** R-29 (one *Allow once* → N concurrent authorisations, confirmed by probe; latent
because `delegate` blocks, and a hard precondition for fan-out).

---

## 2026-08-12 (later) — re-architected: ADR-0016, and 0.7.0

The user's direction, given twice: **drop pi-subagents and every third-party pi extension**; build on pi
core + this package + their own `principal-pi-skills`, with **herdr as a hard requirement**; and prefer a
**widely adopted standard** for definitions. ADR-0016 records it. What shipped:

**Definitions are Agent Skills (`SKILL.md`).** `allowed-tools` is the grant, the body is the child's system
prompt. **The inversion is the whole point:** in pi-subagents' format an absent `tools:` meant *pi's full
default toolset*, so an undeclared definition was the most powerful kind and any parse failure produced a
wildcard — the direction that caused R-28 and review finding F18. Here absent means **not spawnable**, and
there is **no unknown-name fallback** (pi-subagents resolved an unknown type to `general-purpose` = every
tool, which is how a typo could grant everything).

**The port is deleted.** `src/agent-types.ts` and `src/interceptor.ts` are gone with three test files.
**R-31 is retired by deletion rather than mitigation** — its proposed devDependency pin and differential
fidelity test were never built and are no longer needed. The `tool_call` hook survives as a **tripwire**
that refuses third-party spawn tools and says plainly that it is not a boundary.

**Two behaviour changes fell out of that deletion, both deliberate.** The catalog now seeds pi's built-ins
unconditionally, because `/grants` runs before any provider request and an observation-only catalog made
every capability look "unknown" — **R-28's shape through a different door**. And `/grants` now runs the real
planner through the same context builder `delegate` uses, so a diagnostic that disagrees with the enforcer
is not expressible.

**Four tests were re-targeted rather than deleted, one deleted as redundant.** The properties survived even
though the code they exercised did not. The ADR-0011 Finding 1 test was **narrowed on purpose**: it
described a defect in `decideSpawn`'s wildcard shortcut, which no longer exists.

**`runHerdrPane` — and it failed four times end to end before it worked.** Each failure was a fact the probe
had not established, all four now encoded with tests (`docs/probes/g16-herdr` addendum): `--print` is
incompatible with an interactive agent; herdr **cannot pass a multi-line argument**, so a definition body is
staged to a file; a fresh pane is not yet at a shell prompt; and `agent read` returns **raw text, not the
JSON envelope** every other command uses. **The lesson from the last one is the one worth carrying** — the
unit fake had been written to the envelope shape, so *it agreed with the bug*. A test written from an
assumption tests the assumption.

**Bounded synchronous fan-out.** `delegate_all` runs N children concurrently; verified with three reviewer
definitions in 10.8s against ~30s sequential, each holding exactly what its own `allowed-tools` declared.
**No background mode by design** — fan-out carries most of the value, background carries nearly all the
lifecycle holes. ADR-0008 gained a **cardinality companion** (a subtree budget) and real **sibling ids**;
both gaps existed because a blocking `delegate` bounded cardinality to one *by accident*.

**Ledger integrity (R-34).** Nothing in this package had ever read a ledger back, so a torn line was
indistinguishable from a spawn that never happened. `verifyLedger` + `/grants ledger` now report it; a
corrupt line is **reported, never repaired**. Concurrent appends are serialised by a lock file with a short
timeout and stale-lock breaking.

**Released 0.7.0.** The `exports` map still pointed at the two deleted modules — a failure that would have
appeared **only on a consumer's machine**, since unit tests, typecheck and integration all passed. The smoke
test now exercises every subpath.

**Docs consolidated.** `docs/SPEC.md` is the new current-state document; ~4,700 lines of superseded material
moved to `docs/archive/` with a README explaining why each stopped being current. **Writing the spec found
R-35**: stating the guarantee precisely exposed that `agent:` capabilities enforce nothing, so a definition's
*instructions* are ungoverned — the capability model governs what a child can do, never what it is told to
do.

---

## 2026-08-10 (later) — ADR-0011 implemented, live-verified, and shipped as `pi-daddy` 0.5.0

**ADR-0011 is done and merged.** All three decided changes are implemented (`e8b0fef`), **155 tests
passing**, and — new — **verified live against real pi**: `docs/probes/adr-0011-universal`. The entry below
still says "Not yet implemented"; that was true when it was written and is left standing, as this register
always does.

**This is a breaking change, so the package is `0.5.0`.** Two spawns that succeeded in 0.4.0 now fail: an
agent type declaring a universal capability is refused on **both** paths, and a wildcard-holding delegator
no longer bypasses a configured gate. The README carries a *"0.5.0 is a breaking change"* section.

### What the live run proved, and what it found

Confirmed in a real pi process with real agent-type files, the driver **armed with `Allow once`** so that
"no dialog appeared" is falsifiable rather than merely unobserved:

- Wildcard delegator + agent type declaring `fabric_exec` → refused (was allowed in 0.4.0).
- Enumerated grant holding `fabric_exec` + same type → refused (was *silently passed through* in 0.4.0).
- Wildcard delegator + gated capability, real model-driven spawn → refused, ledger correct (the gate did
  **nothing** in 0.4.0).
- No approval dialog for any doomed spawn; no `approvalSource`/`humanDenied` in any ledger line.

**One new finding, needing a decision (probe Finding 1).** A wildcard delegator is now refused with
*"requires approval for tool:write"* while **no dialog is ever offered** — the wildcard branch returns
before a `ResolveResult` exists, and `shouldSeekApproval(undefined)` is `false`. It fails closed, but it is
the very defect ADR-0011 deliberately removed from `planDelegation`, reintroduced on the other path by the
same change. Two fixes are plausible (make the path prompt; or make the message honest) and **both are
design decisions, so neither was taken.** Recorded in ADR-0011 under *Open, from live verification*.

**Scenario 2's evidence is weaker than the others and says so.** The enumerated-path universal branch was
read from `/grants` inside a real pi process, not from a completed spawn: `deriveOwnGrant` strips
`fabric_exec` from a session that never observed it, so the escalation check fires first. Reaching it
end-to-end needs `npm:pi-fabric` installed, which this machine does not have.

### A citation that looked dangling and was not

ADR-0011 cites `docs/archive/reviews/2026-08-10-aggregated-findings.md` (findings A-S2 / B-C5). From the
`adr-0011-universal-capabilities` branch that file was absent — `docs/archive/reviews/` was committed to `main`
*after* the branch was cut — so it read as a reference to a document that had never been written, and was
briefly recorded here as one. **It was not**: the file is real, and the citation resolves from `main` after
the merge. A note in the ADR records the confusion rather than erasing it.

**The lesson worth keeping is about branch-local verification.** "The file does not exist" was concluded
from searches run inside a worktree that could not have contained it. A cross-branch check
(`git log --all -- <path>`) would have settled it in one command.

### 2026-08-11 — all three ADRs decided AND implemented; `pi-daddy` 0.6.0

**ADR-0012, ADR-0013 and ADR-0014 are accepted, implemented and committed.** 222 unit + 8 integration + 3
model-driven tests passing, typecheck clean across `src` + `extensions` + `test` + `test-integration`.

| ADR | Decided | Built |
| :--- | :--- | :--- |
| **0012 `bash`** | Threat model is *cooperative but fallible, **with prompt injection in scope*** — which is why "document it" was not enough: a prompt-injected agent holding `bash` **is** the adversarial case. | Gating closed under subsumption (gating `write` gates `bash`; the **direction** is tested both ways so it cannot invert). `bash` gated by default in a **governed** session only. README guarantee rewritten: it governs the **tool surface**, not the agent. |
| **0013 `pi-subagents`** | Govern it properly — decided on **usage**: `Agent` 25 times including that day, `delegate` **zero** outside probes. | Ceiling ported rule-for-rule from 0.14.3. |
| **0014 approvals** | Relocate the trust root; thread scope + subject. | Store moved to `$PI_CODING_AGENT_DIR`; legacy file **ignored and reported**, never migrated; `capability@subject` pairs; `once` stops at the boundary; atomic no-follow writes. |

**The port dragged review finding S-5 into the open.** `delegate` was registered **unconditionally**
despite a comment claiming otherwise, so "withhold `tool:delegate` and the child is a leaf" was untrue.
Invisible until ceilings honestly included inherited extension tools — at which point *every* agent type
"required tool:delegate", a correct reading of an incorrect situation, since in-process children really do
inherit our tool registry. Now conditional.

**One test had to be re-targeted rather than updated.** "A review-level child cannot re-spawn debug" tested
wildcard re-acquisition through a type that is no longer wildcard — and `review` holds `bash`, which
subsumes every built-in including `edit-diff`, so that spawn is now **legitimately allowed**. The wildcard
property is retested against an unknown type, and *a grant containing `bash` already confers all of these*
is pinned in its own test. That is R-25 made visible instead of hidden behind a wildcard ceiling.

**ADR-0013's other half is not ours to finish.** Measured: the live registry is unreachable by import
(different module instance), the supported RPC is `ping`/`spawn`/`stop` with no config query, and
`SpawnOptions` has no `tools` field — so **refuse-or-allow is a hard ceiling on that path**.
`docs/archive/proposals/pi-subagents-tools-parameter.md` is drafted **for the user to file**.

**Finding 6, still open and not addressable locally:** `subagents:rpc:spawn` bypasses the interceptor
entirely — event bus straight to `manager.spawn()`, no `tool_call` — so any other loaded extension can
spawn an ungoverned sub-agent. Adding names to `SPAWN_TOOLS` cannot catch it.

### G11 closed — and it found a defect on its first run

**`npm run test:integration`** now drives a real pi process with the extension loaded: **8 tests, ~17s, no
model tokens**, plus **3 opt-in end-to-end tests** (`PI_GRANTS_IT_MODEL=1`) with a real model calling real
tools. `npm test` stays fast and pi-free, as decided on 2026-08-10.

The default tier drives the `/grants` command, whose handler runs the real decision function over real
agent-type files — so the whole wiring (env parsing, agent-type loading, `publishChildEnv`, `decideSpawn`)
is exercised **without a model deciding anything**. That is what makes it deterministic enough to keep.
The suite is checked against reintroduced bugs: restoring the G7 `NaN` defect makes two of its tests fail.

**It found this immediately, and it is the kind of thing only an integration test could find:**

> **`AgentToolResult` has no `isError` field.** pi sets `isError` **only when `execute` throws** — a normal
> return is hardcoded `isError: false` (`pi-agent-core/dist/agent-loop.js`). `delegate` was *returning*
> `isError: true`, which pi silently discarded. **Every refusal this package ever made — escalation, gate,
> universal capability, depth, unknown capability — was recorded by pi as a SUCCESSFUL tool call**,
> including the G6 ledger-fail-closed and G8 child-failure paths added earlier the same day. Fixed by
> throwing.

Note what this means about the earlier G8 entry below: its claim that a failed child "comes back as a tool
error" was **only half true when written**. The text reached the model; pi's own error state did not.

### G12 closed, and three decisions written up for you (ADR-0012/0013/0014)

**ADR-0011 Finding 1 is resolved**: the wildcard branch keeps refusing, but the message is now honest — it
names the gated capability, says a `tool:*` grant cannot be approved for it because no dialog is offered on
that path, and points at `PI_GRANTS_GRANT` as the remedy. Making it *prompt* was rejected on merit: it
would let a wildcard holder widen its own children past an operator's gate with one dialog. Verified live.

**G12 — the docs stopped asserting a falsified fact.** The 72% tool-definition share now carries a dated
falsification note everywhere it appears (`SESSION-LOG`, `README`, ADR-0006, ADR-0007). Annotated, never
deleted, per this project's convention. Each note states what it does and does not undermine: ADR-0007's
reframe does not depend on it; **ADR-0006's magnitude claim and `pi-token-audit`'s headline feature do**.
`CLAUDE.md` and `docs/archive/GETTING-STARTED.md` also stopped describing a project with no production code in it.

**Three ADRs now await your decision.** Each has options honestly weighed and a recommendation, and none is
decided — they all narrow what the product claims, which is yours to choose:

| ADR | The finding | Recommended |
| :--- | :--- | :--- |
| **0012** | **`bash` escapes governance entirely — measured.** A session holding *only* `tool:bash`, at depth 1 of a maxDepth-2 tree, spawned an ungoverned pi with the full default surface: no ledger entry, no depth increment, no grant (`docs/probes/g5-bash-escape`). Also, gating is not closed under `SUBSUMPTION`, so gating `write` produces no prompt when `bash` is passed. | Close the subsumption gap; **narrow the advertised guarantee** rather than refusing every `bash` grant or becoming infrastructure. |
| **0013** | **The interceptor does not build the thing it governs.** Children are in-process (so `propagation.ts`'s race-freedom argument holds on the `delegate` path only), the ceiling omits extensions and skills, the hand-rolled frontmatter parser disagrees with pi's YAML *in the permissive direction*, identity is keyed differently at each end, and scheduled `Agent` calls have no hook at all. | Downgrade the interceptor to **best-effort guard + audit**; pursue the upstream `tools` parameter in parallel. |
| **0014** | **The approval file is forgeable by the agent it gates** — self-defeating in the package's own recommended `PI_GRANTS_GATED=tool:write` example, since a session that may use `write` can write the approval. Plus `once` being inherited by a whole subtree, the subject erased in propagation, and a corrupt file destroying valid entries on the next write. | Move the store outside agent-writable space; fix scope/subject/durability regardless. **Do not over-invest while 0012 is open** — the weaker link is elsewhere. |

**`skill:` and `agent:` capabilities enforce nothing**, under every option: skills are injected into the
system prompt rather than passed as tools, and nothing anywhere reads an `agent:` capability. That needs
fixing or removing — a capability that enforces nothing reads as a control.

### Review backlog: G1, G6, G7, G8 closed (same day, after the above)

Four more groups done, TDD throughout, each failing test watched failing first. **186 tests passing,
typecheck clean over `src` + `extensions` + `test`** (it previously excluded tests, which hid four errors).

- **G1 · the argv channel** — the delegation task sat in a CLI-parsed position. A task beginning `@` made
  pi read an arbitrary file into a child holding **no tools at all**, because the read happens before any
  tool exists and `--tools` therefore never applies. **Reproduced live**: a `--no-tools` child read a file
  *and obeyed the instructions in it*; after the fix it reports no filesystem access
  (`docs/probes/g1-argv`). Fixed with an unconditional leading space — positional, not pattern-based, so
  a third special prefix in some later pi cannot silently re-open it.
- **G6 · the ledger** — it reported **allowed** wildcard spawns as escalation attempts (`resolve()` has no
  notion of `tool:*`, so the extension's recompute denied everything), and dropped every refusal decided
  before resolution. `Decision.result` and `Delegation.result` are now **required**, so a new early exit
  cannot reintroduce either. A configured ledger that cannot be written now refuses the spawn.
- **G7 · configuration** — `parseInt` accepted `"2abc"` as `2` and gave `NaN` otherwise, and every
  comparison against `NaN` is false, so a malformed `PI_GRANTS_MAX_DEPTH` **removed** the depth limit
  rather than tightening it. Malformed now disables spawning and says which variable. Ungoverned sessions
  publish nothing to children. The catalog is awaited rather than raced.
- **G8 · child processes** — output cap, wall-clock timeout with `SIGTERM`→`SIGKILL`, `signal.aborted`
  checked *before* spawning (an `AbortSignal` does not replay), and failed children returned as tool
  errors instead of answers. Extracted to `src/run-child.ts` and tested against **real** processes.

**Eight groups remain open.** G2 (the `pi-subagents` reality gap), G3 (approval integrity) and G5 (`bash`
as a governance hole) need decisions rather than patches; G9/G10/G11/G12 are packaging, measurement
honesty, coverage and docs.

### ⚠️ The next actions are NOT the ones listed in the entry below

`docs/archive/reviews/2026-08-10-aggregated-findings.md` — **two independent reviews, cross-referenced, with eight
findings reached separately by both** — is the authoritative backlog now, and it was cut on `main` while
work happened on a branch, so it is easy to miss. **Read it before planning anything.** Merging ADR-0011
completed exactly one of its twelve groups (**G4**). Its own recommended order stands, with G4 struck:

**ALL TWELVE REVIEW GROUPS are now closed, or taken as far as they can go locally**, and ADR-0012, 0013
and 0014 are decided *and* implemented. The last two finished 2026-08-11:

- **G9 — the package was not installable.** `exports` pointed at `./src/*.ts`, and Node refuses to strip
  types under `node_modules`, so **every consumer import threw** while every in-repo test passed —
  verified by packing and installing the tarball. Now built to `dist/` with declarations, thirteen modules
  exported (three had been unreachable), `pi.extensions` declared on both packages, peer/dev deps
  declared, **tsconfigs committed** (the check config had lived in a session scratchpad, which is how four
  type errors in tests went unnoticed), `LICENSE` in both packages and at the root, a root workspace
  manifest, and `npm run test:smoke` — which packs, installs into a scratch project and *uses* the result.
  **The extension half was never broken**: pi's own loader reads TypeScript from `node_modules` fine.
- **G10 — the instrument's headline was arithmetic theatre.** `promptTokens` cancels out of
  `estToolTokens / promptTokens`, so the "tool-definition token share" was always
  `toolChars / payloadChars`. It now reports a **character share** and explains why no token figure
  exists. Relabelled rather than tokenized properly, deliberately: ADR-0007 retired the thesis a
  tokenizer would serve.

### What is left, and none of it is code

1. **File the upstream proposal** (`docs/archive/proposals/pi-subagents-tools-parameter.md`) — the user's call and
   the user's name. Until it lands the interceptor can refuse but never provision, which is measured
   rather than assumed (`docs/probes/g13-subagents-coupling`).
2. **Finding 6 has no local fix.** `subagents:rpc:spawn` reaches `manager.spawn()` over the event bus with
   no `tool_call`, so any other loaded extension can spawn an ungoverned sub-agent. Adding names to
   `SPAWN_TOOLS` cannot catch it — there is no tool call to catch.
3. **`pi-token-audit` still has no tests**, and is verified against one provider. G11 closed the
   `extensions/grants.ts` half of that coverage gap, not this one.
4. **Deferred by decision:** `A-14` (are deferred tool definitions billed as prompt tokens?) matters only
   if the cost thesis is revived, which ADR-0007 retired.

**A load-bearing "verified fact" in this file is falsified.** The 72% tool-definition share recorded in the
2026-08-09 entry — under *"Verified facts, don't re-litigate"*, and feeding **ADR-0006** — was proved
algebraically to be `toolChars / payloadChars`, a **character ratio, not a token measurement**
(`promptTokens` cancels; verified across a 72× swing). It has not yet been corrected there. Two other
architectural claims also fell: children are **in-process** on the interceptor path, so `propagation.ts`'s
race-freedom argument (and the R-26 fix) assumes a process boundary that exists on only one of the two
paths; and withholding `delegate` does **not** make a session a leaf.

**Previously agreed next feature — background + streaming delegation — should be re-decided against this
backlog.** It is a capability addition on top of a layer with twelve open critical findings, several of
which mean the guarantee the package advertises does not currently hold.

Also still queued and unaffected: the rpc integration harness (now hand-driven by two probes — that is the
point at which it should become `npm run test:integration`, and it is G11), the `PI_GRANTS_GATED`
recommendation, the `pi-subagents` proposal document, and A-14 (deferred).

---

## 2026-08-10 — the project is `pi-daddy`, under version control, with eight decisions taken

**The project is renamed to `pi-daddy`** (repo and project alike). "DTCM — Dynamic Tool & Context
Management" named the token-economics thesis ADR-0007 retired. Replaced only where the name is
*operational* — `CLAUDE.md`, `README.md`, `docs/archive/GETTING-STARTED.md`, all of `.claude/`. **"DTCM" is deliberately
preserved in every ADR and register**, where it *is* the abandoned thesis; a convention note in `CLAUDE.md`
forbids a blanket find-and-replace, because a register entry describes what was believed on its date and
renaming it makes the record lie.

**This is now a git repository** — the first one this project has had. Baseline commit `d8e4c47`, branch
`main`, 75 files, authored as `mojomanyana <nemanjaalavanja@gmail.com>` set **repo-local** so the global
identity is untouched. `.gitignore` covers `node_modules/`, `.superpowers/`, and — per **R-27** —
`.pi/grants-approvals.json` and `.pi/grants.jsonl`. No remote is set; that is the user's to add.

### Decisions taken (eight, in one pass)

| # | Decision |
| :--- | :--- |
| **ADR-0011** | **Accepted — Option 3.** Universal capabilities were treated three ways across the two spawn paths (silently dropped / silently passed / loudly refused). Fix: the interceptor refuses a spawn retaining a universal capability, `shouldSeekApproval` additionally requires `universal` to be empty, and the cosmetic stripping at `interceptor.ts:85` is removed. **Not yet implemented** — will be the first change to `src/interceptor.ts` since the package shipped. `src/resolve.ts` stays untouched. |
| **ADR-0009** | **Superseded by events.** The build path was taken; re-triggers stay live, now including "a `pi-fabric` release that fixes the recursion/containment exclusivity". |
| Wiring tests | **Integration harness, not extraction.** `obtainApprovals` stays in the extension; coverage comes from an rpc-mode suite driving real pi, promoted from `docs/probes/approval-ux/drive.mjs`. Wire as a separate `npm run test:integration` so `npm test` stays fast and pi-free. |
| Upstream PR | **Write the case first, code later.** A proposal document for a `tools` parameter on `pi-subagents`' `Agent` tool, to become an issue in the user's words. Patch only if the maintainer is receptive. |
| Gating `bash` | **Document as recommended, do not default it.** `bash` subsumes read/write/edit/grep/find/ls (R-25), so gating it is the highest-value gate *and* the likeliest source of reflexive approval. The README will recommend a `PI_GRANTS_GATED` value with the fatigue caveat; the code default stays empty, preserving "governance is opt-in and never silently tightens a workflow". |
| Next feature | **Background + streaming delegation.** |

### Next actions, highest value first

1. **Implement ADR-0011** — accepted but unimplemented; keeps the register honest.
2. **Background + streaming delegation.** `delegate` blocks until the child exits, so an orchestrator cannot
   fan out and collect — the actual multi-level pattern this project exists for. Also the first real test of
   the single-flight approval queue against genuine parallel spawns.
3. **The rpc integration harness** (decision above).
4. **`PI_GRANTS_GATED` recommendation** in the README (small).
5. **The `pi-subagents` proposal document** (small).
6. **Verify `pi-token-audit` against Anthropic and Google payload shapes** — proven on one provider only.
7. **A-14** — are deferred tool definitions billed as prompt tokens? Consciously deferred; only matters if
   the cost thesis is revived, which ADR-0007 retired.

---

## 2026-08-09 — `pi-daddy` 0.4.0: human approval for gated capabilities

Gated capabilities (held but not passable without a person saying yes) could previously only ever be
refused; `0.4.0` adds the yes — once/session/always scopes, inheritable down the tree intersected with
each child's actual grant, with `always` persisted per-project and offered only on the interceptor path
(agent types are human-authored files; `delegate`'s subject is model-chosen, so it never gets `always`).
**ADR-0010** records the approval semantics and **R-27** the hazard of a committed approvals file
authorising every clone (mitigated by ignoring entries whose `cwd` doesn't match). New public exports from
`src/approval.ts`, `src/approval-store.ts`, `src/approval-prompt.ts` — see `packages/pi-daddy/README.md`'s
*Approving a gated capability* section.

State: **unit-tested, typechecked, and verified live against real pi (149 tests, clean typecheck)**. The live
run is `docs/probes/approval-ux` — eight scenarios plus a companion, driven through `pi --mode rpc` (the same
`ctx.ui.select` the TUI dialog serves, not a rendered TUI). It found two defects, **both since fixed and
re-verified**: an approval inherited down the `delegate` path was applied but never recorded in the ledger,
and `delegate`'s default child model was a bare id that could resolve to an unauthenticated provider. The
probe still describes the original run — that is what a probe is for — with a dated resolution note on top.

A whole-branch review then returned **ship after fixing**, with no Critical findings: it could construct no
path granting a capability without the required approval, and `approved ⊆ grant` holds by construction at
every level on both paths. Its five Important and five Minor findings were all fixed in one wave — the
single-flight approval queue was inert in production (a fresh gate per call), `PI_GRANTS_APPROVED` could
escape the per-child env clamp, the dialog could fire for a spawn already refused for an unrelated reason,
the interceptor path passed neither `signal` nor `task`, and three documents described code that no longer
existed. `src/resolve.ts` and `src/interceptor.ts` remain byte-identical to their pre-feature state
throughout — the design's central claim. One reported item was deliberately left undone:
`SpawnRequest.isolated` is declared and populated but never read, and removing it means editing the protected
security surface, so it is recorded for a decision rather than patched around.

## 2026-08-09 — discovery → falsification → reframe → two shipped packages

### Where the project stands

**Status: BUILDING.** The product is a **capability-governance layer for pi's multi-level agent system**: a
top orchestrator grants each sub-agent a deliberate subset of tools/skills and withholds the rest;
sub-agents may delegate further but only ever a subset of what they hold; every grant and refusal is
recorded. Enforced by pi's own `--tools` allowlist, so the guarantee is structural.

`docs/archive/ROADMAP.md`'s phase plan is **obsolete** — it was written for the token-economics thesis. The gate
discipline and probe convention survive; the phase list does not.

### What happened, in order

1. **Discovery** pinned the substrate: pi (TypeScript, MIT, v0.83.0 installed locally, 0.84.1 upstream).
2. **G0 economic test failed decisively.** 82 real sessions, $76.12 of spend: catalog ~20 tools, p90 working
   set 4 tools, four tools = 98.1% of calls, ~50k median context, cache read:write 114:1. Break-even
   `S > 11.5·c·C` needs ~110 tools; mounting lost by 5×–102×. → G0 NO-GO, initiative parked (ADR-0005).
3. **Park reversed** (ADR-0006): the loss figure was computed on the *fallback* mounting path only. On
   native deferred loading (which pi routes to) the penalty collapses. Governing ratio is `S/(H+S)`, a curve
   over session length — a *fresh* session measured **72%** of prompt tokens on tool definitions.
   > **FALSIFIED 2026-08-10 (review finding A-C4). The 72% is not a token measurement.** `promptTokens`
   > cancels out of the calculation, so the figure is `toolChars / payloadChars` — a **character ratio**,
   > verified as such across a 72× swing in token count. The sentence is left standing because this is a
   > dated record of what was believed, but **it must not be quoted as evidence**. It is load-bearing for
   > **ADR-0006**, whose unpark argument rests partly on it; that ADR carries the same note. Correcting the
   > instrument is **G10**, **done 2026-08-11**: the report now states a character share and says so.
4. **The reframe (ADR-0007) — the most important event.** The user stated the actual goal: *"a large set of
   tools and sub agents… a top level orchestrating agent… that can give them some skills and tools but some
   not… narrow control of sub-agents… multilevel agent system."* Token cost was never the objective. The
   blueprint's §1 *justification* misled discovery; its *architecture* was always about control. Risk
   **R-17** had recorded the desired feature as a hazard.
5. **ADR-0008** established the invariant: capabilities attenuate monotonically down the tree.
6. **pi-fabric evaluated empirically** (11 probes) — it implements much of the design but **recursion and
   containment are mutually exclusive by construction** there. Decision **parked** with a re-trigger.
7. **Built and shipped** `pi-daddy` (0.3.0) and `pi-token-audit` (0.1.0).

### Verified facts (measured, not assumed — don't re-litigate)

- pi's **default** tool surface is only `read`, `bash`, `edit`, `write`. `grep`/`find`/`ls` exist but are not default.
- **pi's `--tools` / `--no-tools` hard-enforce**, including against extension tools; an `-e`-loaded extension
  cannot re-add its own tool past them (A-16). **This is the enforcement point.**
- **`bash` subsumes** the file/search tools, so a grant containing it is not narrow (A-15, R-25).
- In pi-fabric, `recursive: true` overrides `tools: []` *and* `extensions: false` — `fabric_exec` is a
  universal capability. Its `maxDepth` works; nothing else contains a recursive child.
- pi persists per-message `usage` with `cacheRead`/`cacheWrite`/`cost` in session JSONL (A-12).

### Shipped code (both under scoped waivers in `gate-reports/G0-2026-08-09.md`)

| Package | State | Verification |
| :--- | :--- | :--- |
| `packages/pi-daddy` **0.3.0** | resolver · ledger · spawn planner · `tool_call` interceptor · `delegate` tool · live catalog | **73/73 tests**, both typechecks clean, **7 live scenarios** verified against real pi |
| `packages/pi-token-audit` **0.1.0** | token/cost audit incl. tool-definition share | typechecks clean; verified end-to-end on `openai-codex`/`gpt-5.6-sol` |

Run tests: `cd packages/pi-daddy && npm test`.
Typecheck: tsconfigs are in the session scratchpad (not committed) — recreate with `tsc` pointing at
`src/**` and `extensions/grants.ts`, mapping `@earendil-works/pi-coding-agent` and `typebox` to the globally
installed pi's `dist/index.d.ts` and `node_modules/typebox/build/index.d.mts`.

### Open decisions (user's call)

1. **Code mode / pi-fabric** — parked with a re-trigger (durable actors, mesh coordination, or per-branch
   cost budgets). ADR-0009 stays *Proposed*.
2. **Upstream PR to `pi-subagents`** adding `allowed_tools` to the `Agent` tool. This is the one change that
   would turn the interceptor from *enforce-only* into *provisioning* for existing agent types, and it
   benefits everyone using that package. Not started — it is the user's name on the PR.
3. ~~**Rename the project.**~~ **RESOLVED 2026-08-10 — the project is `pi-daddy`.** "DTCM — Dynamic Tool &
   Context Management" named the token-economics thesis ADR-0007 retired. Replaced wherever the name is
   *operational* (`CLAUDE.md`, `README.md`, `docs/archive/GETTING-STARTED.md`, all of `.claude/`) and **deliberately kept
   in the historical record** — every ADR and register entry, where "DTCM" *is* the abandoned thesis and
   renaming it would make the record lie. See the convention note in `CLAUDE.md`.

### Next actions, highest value first

1. **Background + streaming delegation.** `delegate` blocks until the child finishes; add background handles
   and progress so an orchestrator can fan out and collect.
2. **`A-14`** (~1h, ~$1) — are deferred tool definitions billed as prompt tokens? Only matters if the cost
   thesis is revived; consciously deferred.
3. **Verify `pi-token-audit` against Anthropic and Google payload shapes** — only proven on one provider.

### Known gaps, stated so they aren't rediscovered as surprises

- The interceptor **enforces but cannot provision** (no `tools` param on `pi-subagents`' `Agent`). `delegate`
  provisions; the interceptor guards.
- Extension tools are catalogued as `tool:<name>`, not `ext:<pkg>/<tool>` — a provider payload carries names,
  not owning packages.
- `delegate` spawns `pi` from `PATH`.
- ADRs 0001/0002/0003 remain *Proposed*; their evidence is recorded but the reframe made their original
  framing partly moot.
