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

## Change discipline

10. **Every change lands through a pull request. Never commit to `main`.** No exemption for docs-only or one-line
    changes — the rule is stated as *always* precisely so there is nothing to argue about at the margin.

    **The PR is where this project's review happens, and review is what has caught every serious defect in it.** Six
    independent reviewers across two rounds found a critical governance flaw in the same feature *twice*, in work that
    was already green on four suites, manually verified, and had a PR description written. A commit that reaches
    `main` without one skips the single step with that track record, and loses the diff and the written rationale
    that make a change re-examinable a month later.

    Added 2026-08-18, after eleven commits went straight to `main` — not by decision, but by drifting: the session
    happened to still be on `main` after an earlier squash-merge and nobody checked. **So the practical form of the
    rule is: check the branch before the first edit of a task, not before the commit.**

## Terminology discipline

11. **"Workflow skills"** = `.claude/skills/` (process tooling for this workspace). The runtime
   tools/skills this project governs are called **"tools"** or **"runtime skills"** in all documents —
   never bare "skills" where it could be ambiguous.
