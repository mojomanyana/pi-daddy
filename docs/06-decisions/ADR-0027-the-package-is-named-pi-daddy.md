# ADR-0027: the package is named `pi-daddy`, and the old name was replaced everywhere

**Date:** 2026-08-14
**Status:** Accepted (2026-08-14, by the user, over the assistant's recommendation on the second question)
**Driver:** publishing. `pi-agent-grants` was about to be published under a name that matched neither the
repository, the workspace root, nor anything anyone calls this project.

## Context

The project has been **pi-daddy** since 2026-08-10. The package inside it was `pi-agent-grants`, a name
from before the rename that survived because nothing forced the question — until a first publish to npm did.
Both `pi-daddy` and `pi-agent-grants` were free on the registry, so this was a free choice rather than a
constrained one, and it was made before anything was published: **no version of this package was ever
released under the old name.**

Two decisions, taken together.

## Decision 1 — the package and its directory are `pi-daddy`

`packages/pi-agent-grants/` → `packages/pi-daddy/`, moved with `git mv` so history follows the files, and
`"name": "pi-agent-grants"` → `"name": "pi-daddy"`.

The workspace root, which is `private` and never published, was renamed `pi-daddy-workspace`. npm workspaces
require the root and its members to have distinct names, and given a forced choice the *published* artifact
should hold the good name. That suffix means nothing beyond "this is not the thing you install".

## Decision 2 — the old name was replaced in dated documents too, and that is a deliberate exception

**126 occurrences across 29 files were replaced, including in ADRs, `docs/03-risks.md`,
`docs/SESSION-LOG.md`, `docs/probes/` and `docs/archive/`.**

**This contradicts a rule this repository states twice**, and the contradiction is recorded here rather than
left for someone to discover:

- `CLAUDE.md`: *"**Do not find-and-replace them.** A register entry describes what was believed on its
  date; renaming it makes the record lie."*
- `.claude/rules/phase-gates.md` §2: *"Reversals are recorded, never rewritten … A register entry describes
  what was believed **on its date**; editing it to match today makes the record lie."*

Both were written for **DTCM**, and the distinction that justifies treating this differently is the one they
turn on. *"DTCM"* named a **retired thesis**: the sentences containing it — "DTCM's MVP is staged", "park the
DTCM initiative" — *are* the evidence of the abandoned idea, and rewriting them would erase the thing those
documents exist to preserve. `pi-agent-grants` names **nothing that was retired**. It is a label for the
same artifact, with the same behaviour, that this ADR relabels. No belief changes when the string changes.

**What is nonetheless now untrue, stated plainly rather than glossed:**

- ADR-0016, dated 2026-08-12, now reads *"pi-daddy 0.7.0"*. There was never a `pi-daddy@0.7.0`; there was a
  `pi-agent-grants@0.7.0`. The same applies to every version number in every dated document.
- `docs/probes/` READMEs cite `packages/pi-daddy/...` for probes run when that path did not exist.
- `docs/archive/` is documented as *"kept as evidence, never edited to match today"* and has now been edited
  to match today.

**Why that was accepted anyway.** Nothing was ever published under the old name, so no reader outside this
repository can hold an artifact the old name refers to; the git history preserves every original wording,
and `git log --follow` traverses the move; and a tree containing two names for one package is a trap with a
demonstrated cost — R-59 and R-72 are both entries about a stale name in an orienting document being
inherited by every subsequent reader, and both cost a session.

**The assistant recommended the narrower scope and was overruled**, which is recorded because an ADR whose
options all point one way is not a decision record. The narrow option was: rename operationally, leave dated
documents alone, add a note to each. Its advantage is that no document becomes false. Its cost is fourteen
documents saying `pi-agent-grants` indefinitely, and a reader having to learn that the split is deliberate.

## Consequences

**The working rules §2 and `CLAUDE.md`'s terminology note are amended, not deleted**, to name this as the
exception with its reason. (Those rules lived in `.claude/rules/phase-gates.md` when this ADR was written
and moved to `docs/WORKING-RULES.md` the same day, when `.claude/` became gitignored — same content, and a
rule the repository cites has to be a rule the repository contains.) A rule that forbids what the repository already contains does not
protect anything — it teaches the next session to distrust the file, which is the exact failure the
phase-gate rule at the top of that same file was rewritten to escape.

**The DTCM prohibition is untouched and still absolute.** If anything, this ADR sharpens it: the test is
whether the name denotes something *abandoned*. "DTCM" does. "pi-agent-grants" did not.

**This ADR is now the only record that the rewrite happened.** That is the whole reason it exists — a
falsification nobody wrote down is indistinguishable from the truth.

## Revisit trigger

Anyone finding a document whose meaning is now wrong rather than merely relabelled — a sentence that only
made sense under the old name, or a version reference that misleads about what was actually installable.
Fix that document, and cite this ADR for why it reads as it does.
