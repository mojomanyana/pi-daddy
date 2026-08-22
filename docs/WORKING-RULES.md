# Working rules — pi-daddy

**These are the project's rules, and they live in the repository because they are cited by it.** The risk
register references them eighteen times, ADR-0027 amends rule 2 by name, and a rule nobody clones is not a
rule.

> **Relocated 2026-08-14.** They lived in `.claude/rules/phase-gates.md`, which is now local-only —
> `.claude/` is gitignored, so that copy is Claude Code's and this one is the project's. **Documents dated
> before 2026-08-14 cite the old path**; that is correct for their date and the content is the same. One
> note here beats rewriting thirty-five citations, and rule 2 below is the reason.
>
> The filename `phase-gates.md` was itself a fossil: the phase-gate rule that named it was retired when two
> packages shipped under recorded waivers, and the name was kept only so links resolved. Nothing links to
> it now, so the name goes too.

## Documentation discipline — the rules that did the work

1. **Decisions live in ADRs** (`docs/06-decisions/`), load-bearing claims live in the assumptions
   register, failure modes live in the risk register. **An answer that exists only in chat does not
   exist.** This is the single most valuable convention here: every ADR that had to be revisited was
   revisitable *because* its options and reasoning were written down beside the decision.

2. **Reversals are recorded, never rewritten.** ADR-0004 superseded, ADR-0005 parked then superseded,
   ADR-0006's magnitude claim falsified, ADR-0011 amended after live verification. A register entry
   describes what was believed **on its date**; editing it to match today makes the record lie. Add a
   dated note; do not revise history.

   **One recorded exception, 2026-08-14 (ADR-0027).** The package rename `pi-agent-grants` → `pi-daddy` WAS
   find-and-replaced through dated documents, including ADRs, the risk register, the session log, probes and
   the archive. The test that permits it: does the name denote something **abandoned**? "DTCM" does — those
   sentences are the evidence of a retired thesis. "pi-agent-grants" did not: same artifact, same behaviour,
   different label, and nothing was ever published under it. ADR-0027 lists exactly what became untrue as a
   result, because a falsification nobody wrote down is indistinguishable from the truth. **Rule 4 below is
   unaffected and still absolute.**

3. **`docs/00-blueprint.md` is immutable source input.** Disagreement with it is recorded as an
   assumption, a risk, or an ADR — never edited into it.

4. **The retired name stays in the record.** "DTCM — Dynamic Tool & Context Management" named the
   token-economics thesis ADR-0007 retired. It is replaced wherever the name is *operational*
   (`CLAUDE.md`, `README.md`, `GETTING-STARTED.md`, everything under `.claude/`) and **deliberately kept**
   in every ADR and register, where it *is* the abandoned thesis. Do not find-and-replace it.

## Evidence discipline — learned the hard way, repeatedly

5. **Measure before asserting, and say which you did.** Nearly every significant finding here came from
   running something against real pi, and several contradicted careful reasoning: children are in-process,
   `getAllTools()` is reachable but the agent registry is not, `isError` on a returned tool result is
   silently discarded. Probes live in `docs/probes/` with a README stating what they measure and how to
   rerun.

6. **State what evidence does *not* cover.** Every probe here has a "what this does not establish"
   section, and each one has since stopped somebody over-claiming — including the author.

7. **A test that cannot fail is worse than no test.** Four were found in review. When adding one, name
   the production change that would break it; if none exists, the test is decoration. The integration
   suite is checked this way deliberately: reintroduce the G7 `NaN` defect and two of its tests fail.

8. **Prefer failing closed, and prefer being loud about it.** Malformed configuration disables spawning
   rather than falling back to a default; an unreadable extension surface yields the wildcard rather than
   an under-counted ceiling. Both are paired with a message naming the variable, because a silent
   safe-mode is as confusing as a silent unsafe one.

## Terminology discipline

9. **"Workflow skills"** = `.claude/skills/` (process tooling for this workspace). The runtime
   tools/skills this project governs are called **"tools"** or **"runtime skills"** in all documents —
   never bare "skills" where it could be ambiguous.

## Change discipline

10. **`main` is only ever advanced by merging a pull request.** Never edit or commit while checked out on
    `main`, and never push to it — merging your own PR advances `main` by design, which is the rule working
    rather than a breach of it. **No exemption by size or kind:** docs-only, one-line, version bumps,
    reverts and hotfixes all take the same path. Amending, rebasing and force-pushing *your own open PR
    branch* are fine, as is merging `main` into it; rule 2 is about documents, not about git.

    **Check the branch before the first edit of a task, not before the commit** — that is where this control
    has to fire, because the failure it answers was not a decision. Eleven commits (`b7c0475..26e778f`)
    reached `main` on 2026-08-18 while a session sat there after an earlier squash-merge and nobody looked.
    R-85 carries the trigger. **If you find work already on `main`, do not rewrite history:** unpushed, `git
    switch -c <branch>` at HEAD and then `git branch -f main origin/main`; already pushed, leave it and
    record the SHAs in the session log. A bad record is cheaper than a force-push. This paragraph is here
    because the first draft of this rule said only "never commit to `main`", and a reviewer pointed out that
    a prohibition with no recovery procedure is an invitation to `git reset --hard` on unrecoverable work.

    **A pull request is the venue, not the review.** Anything touching behaviour gets at least one
    independent pass — a review subagent with a written hypothesis, or the operator — recorded in the PR
    before it merges; a docs-only change may merge on the author's own read, said out loud in the PR. What
    the venue buys by itself is the diff, the written rationale, and the PR number as a durable index from a
    line of code back to why it is there. The evidence for the *pass* is `docs/SESSION-LOG.md` 2026-08-17
    (review): six reviewers, eighteen defects, two shipping blockers, in work already green on four suites,
    manually checked against a real herdr daemon, with a PR description written. And ADR-0033's two rounds
    of three reviewers each, both finding a critical governance defect in one feature — **a feature that
    never went through a PR at all: it is those eleven commits.**

    One PR per landed change, and a change may cover several tasks; **the ADR, the SPEC update and the
    session-log entry ship inside the PR of the work they describe**, never a second PR narrating the first.
    This governs tracked files only — gitignored paths (`.claude/`, the grant store) are outside it, and by
    rule 1 outside the record until something tracked says so.

    **Enforcement, stated because an unstated absence reads as enforcement.** `hooks/pre-commit` refuses a
    commit on `main` and names the recovery; it is wired **per clone** by `git config core.hooksPath hooks`,
    so if that command prints nothing the hook is inert. `test/branch-guard.test.ts` proves the script
    refuses — not that your clone installed it. **`.github/workflows/ci.yml` runs typecheck, the unit suite,
    a tree-cleanliness check, the mutation catalogue and the installed-package smoke on every pull request**,
    which is the half that stops a guard rotting unnoticed. **And since 2026-08-22 it blocks:** `main` on GitHub
    requires a pull request (zero approvals) with both CI legs green, force-pushes and deletions are refused,
    and `enforce_admins` is **on** — without that last flag the rule would bind everyone except the only
    account able to breach it, which is exactly how R-85's eleven commits reached `main`. A direct `git push`
    to `main` is now rejected by the server, not by a hook somebody has to install.

    **The escape hatch, named so nobody has to invent one under pressure:** protection is one API call to lift
    (`gh api -X DELETE repos/<owner>/<repo>/branches/main/protection`) and one to restore. Lifting it is a
    decision to record, not a workaround to reach for — and CI being unavailable is the case it exists for. And `pre-commit` is never invoked for a clean merge, cherry-pick or
    revert, so those land on `main` unguarded — the hook catches the *drift* this rule was written for, not
    every route to `main`.
