# Rules — pi-daddy working discipline

These rules apply to all work in this project.

> **The phase-gate rule that gave this file its name is retired.** It said *"before G1 passes: no
> production code — this project deliberately has no `src/` yet"*. Two packages have since shipped under
> explicitly recorded waivers (`docs/gate-reports/G0-2026-08-09.md`), `docs/ROADMAP.md`'s phase plan is
> obsolete, and the discovery skills that drove the gates (`/kickoff`, `/gate`, `/validate`, `/spec`) were
> removed on 2026-08-11. A rule that forbids what the repository already contains does not protect
> anything; it just teaches a new session to distrust the file. The filename is kept so existing links
> resolve. **The rules below are the live ones**, and they are the ones that carried the project.

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
