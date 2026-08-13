# ADR-0019: the persisted-approval store is unreachable — make `always` real, or delete it

**Date:** 2026-08-13
**Status:** Accepted (2026-08-13, by the user, Option 1 — make `always` reachable — over the steelmanned
option of deleting the store). **Implemented in 0.10.0**; the status line said "Proposed" until 2026-08-14,
which was simply stale. Verified end to end in 0.10.1 (`test-integration/approval.it.ts`) and then **partly
revised the next day**: ADR-0020 replaces the single shared store this ADR made writable, ADR-0021 removes
the `taskAtApproval` field it armed, and ADR-0022 extends its body pin to the inherited path. The decision
itself stands — the store is reachable and `always` means something.
**Driver:** R-37, sharpened into something larger by grepping for its call sites. Touches ADR-0010
(approval semantics), ADR-0014 (store integrity), ADR-0012 (gating `bash` by default) and ADR-0017 (which
falsified the premise the current behaviour rests on). ADR-0018 supplies a component either fix needs.

## Context

**Nothing in 0.9.0 can create a persisted approval.** `offeredScopes` (`src/approval.ts:79`) offers
`always` on one path only — `"interceptor"` — and **no production code passes it**. Grepping the package:
`"interceptor"` survives in the `ApprovalPath` type, in that one comparison, and in two test files. The
sole caller of `obtainApprovals` is `extensions/delegation.ts`, which passes `"delegate"`. ADR-0016 deleted
the interceptor; the string outlived the path.

The consequence is not a hole — it is **dead machinery that reads as live**:

- `src/approval-store.ts` (220 lines) can be read but never written by this version.
- `entryVerdict`'s ceiling comparison — ADR-0010's confused-deputy check — can only judge entries no
  current code path could have produced.
- ADR-0014's integrity work (atomic rename, `wx` against symlinks, the foreign-`cwd` rule that closed a
  demonstrated exploit) guards a file nothing writes.
- `/grants approvals` and `/grants revoke` are commands over an empty set.
- `docs/SPEC.md` says `always` is available *"on paths with a human-authored subject"*, which is true and
  misleading in the same sentence: **no such path exists.**

Entries written by 0.6.x–0.7.0 in the home directory can still load, so the reader is not strictly dead
code — but nothing can add to it, and those entries name agent types that ADR-0016 removed, so
`entryVerdict` returns `type-missing` for them anyway.

**Why `always` was withheld from `delegate`, and why that reason expired.** `src/approval.ts:24–33`:
*"the only things naming a child are the task string and the tool list, both chosen by the model. A key the
model controls is not a key."* Correct on its date. **ADR-0017 falsified it for `delegate({agent})`**: the
definition is operator-authored, and the session must hold `agent:<name>` to name it at all. The model
chooses *which* authorised definition, exactly as it chooses which tool to call.

**One thing a ceiling pin cannot cover.** `ceilingForDefinition` reads only `allowed-tools`, so an approval
pinned to the ceiling survives a total rewrite of a definition's *instructions* — which is R-35's hazard
reappearing inside the persistence layer. **ADR-0018's `definitionDigest` is the missing half**, and it
exists as of this morning.

**What is actually at stake is ADR-0012.** Gating `bash` by default is the highest-value use of this
machinery and its hardest test — that tension is already recorded against R-25. Without persistence the
answer to *"may this child have bash?"* is re-asked every session, and an operator asked the same question
every session eventually sets `PI_GRANTS_GATED=""`. A gate switched off by fatigue is worse than a gate
that was never claimed.

## Options considered

### Option 1 — make `always` reachable where a human-authored subject exists

`delegate({agent: X})` uses **`X` as the approval subject** on a new `"definition"` path that offers
`always`; `delegate({tools: […]})` keeps `<delegate>` and keeps offering only `once`/`session`, because
there the original reasoning still holds exactly. The stored entry pins **both** the ceiling and
ADR-0018's body digest, so a rewritten definition voids it — a new `instructions-changed` verdict beside
`type-changed`. `CeilingLookup` becomes one snapshot lookup returning `{ceiling, bodySha256} | null` rather
than two parallel lookups, so a call site cannot pass one and forget the other (R-28's shape).

Costs ~60 lines plus test updates, and it makes the prompt honest as a side effect: *"approve tool:bash for
deploy?"* instead of *"for `<delegate>`"*. An entry without a body pin is treated as
`instructions-changed`, i.e. **fail closed** — pre-0.9 entries require one re-approval.

One real trade-off: the single-flight de-duplication key is `capability@subject`, so two concurrent spawns
of *different* definitions gating `bash` now raise two dialogs where they previously shared one. That is
the correct number of questions — they are different questions — but it is more of them, and R-29's rule
(a `once` is consumed by exactly one caller) is what keeps it safe.

### Option 2 — delete the persistence layer

Remove `always`, `src/approval-store.ts`, `/grants approvals`, `/grants revoke` and the `always` branch of
`obtainApprovals`; keep `once` and `session`. **Steelman, and it is strong:** this project's best moves
have been deletions — the pi-subagents port, `agent-types.ts`, R-31 *"retired by deletion rather than
mitigation"*. 220 lines of mutable on-disk state outside the workspace is the largest attack surface this
package has, it exists purely for convenience (the security decision is the human's yes, taken already),
and ADR-0014 exists *because* an earlier version of it was exploitable. Deleting it removes a whole class
of future defect and every line is currently unreachable anyway.

**Rejected, on the difference from R-35's Option B.** `agent:` was three lines of decoration; this is
working, well-tested code implementing a property that was hard to get right, and re-adding it later costs
far more than the ~60 lines to reach it now. And the thing it buys is not convenience in general — it is
specifically the survival of `bash` gating (ADR-0012), the one gate this package recommends by default.

### Option 3 — leave it, correct the wording

Say plainly in `docs/SPEC.md` that `always` is not currently reachable and the store is inert. Costs
nothing and removes the misleading sentence. **Rejected as a destination** but adopted as a component of
whichever option wins: the documentation must stop implying a scope the code cannot offer. Left alone,
this is the R-25 failure — a control that reads as a control — in its third appearance in this register.

## Decision

**PROPOSED: Option 1.** `delegate({agent})` approvals are keyed to the definition, on a `"definition"`
path that offers `always`; `delegate({tools})` is unchanged. A persisted entry pins the definition's
ceiling *and* its ADR-0018 body digest, and a change to either voids it. `ApprovalPath` loses the dead
`"interceptor"` member. For v1 this means: an operator who says *"always allow bash for `deploy` in this
project"* is asked once per 30 days instead of once per session, and is asked again the moment `deploy`'s
tools or instructions change.

## Consequences

**Positive.** ADR-0010's persisted approvals and ADR-0014's integrity work become reachable — they are
currently paid for and unused. ADR-0012's default `bash` gate becomes survivable in daily use, which is the
whole reason it is on by default. The confused-deputy check gets strictly stronger than ADR-0010 designed
it, because it now covers instructions as well as tools.

**Negative.** It restores a mutable on-disk state surface that has been exploited once before, in a version
where nothing could write to it — the risk register must reflect that the file is live again. More dialogs
in a fan-out across different definitions. Pre-0.9 entries are invalidated (fail closed, one re-approval).

**Neutral / deliberate non-goals.** `delegate({tools})` gets **no** `always`, ever: there the subject is
model-chosen and the original reasoning stands unmodified. A child still cannot be asked anything — it has
no UI — so persistence helps the human session only, and inheritance remains the mechanism below the root.
Nothing here changes what a body may say (R-35's residue) or `bash`'s escape (ADR-0012).

## Revisit trigger

Any `always` approval surviving a change to the definition it names — that is the confused-deputy check
failing, and it is what `instructions-changed` exists to prevent. Also: a second appearance of the pattern
that produced this ADR — a capability, scope or command that no live path can reach — which is now three
for three (R-35's `agent:`, R-36's dropped namespaces, this).
