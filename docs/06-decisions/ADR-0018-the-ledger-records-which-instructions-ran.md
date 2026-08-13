# ADR-0018: the ledger records *which* instructions ran, as a digest — not what they said

**Date:** 2026-08-13
**Status:** Accepted (2026-08-13, by the user — digest only, snapshot declined)
**Driver:** the remaining half of R-35, left open by ADR-0017: *"what was this child told to do?"* is
unanswerable after the fact. Constrained by the ledger's standing privacy property (`src/ledger.ts:12`) and
by ADR-0010's confused-deputy check. Surfaces R-37 (below), which ADR-0017 created.

## Context

ADR-0017 closed the authorisation half of R-35: spawning definition `X` now requires `agent:X`, so *which*
definitions may run here is an operator decision. **The audit half is untouched.** A ledger record names
`agentType: "review"` and the capability sets, and nothing else. The definition's body — the text that
actually directs the child — is not recorded, not hashed, and not referenced. So a record proves what a
child was *authorised* to do and says nothing about what it was *instructed* to do, and if the file changed
since, nothing reveals that.

**The binding constraint is the ledger's own privacy rule**, stated at the top of `src/ledger.ts` and
honoured everywhere: *capability ids, counts, and identifiers only. Never prompts, tool arguments, or
results.* That rule is why a ledger is safe to commit, ship to an operator, or attach to a ticket. Two
different texts direct a governed child and they sit on opposite sides of it:

| Text | Author | Recording it |
| :--- | :--- | :--- |
| The definition **body** | the operator, in a file on disk | Compatible in spirit — it is not a prompt, an argument or a result, and it is already committed to a repository. |
| The **task** | the *model*, at call time | Squarely inside the prohibition. It is free text assembled from the parent's context and can carry anything the parent could see. |

**A digest sits on the safe side of both.** A hash is an identifier: it names a version of an
operator-authored artifact without reproducing its content.

**Precedent already in the codebase.** `grantAtApproval` pins an agent type's ceiling *at approval time* so
a later change voids the stored approval (ADR-0010). Pinning a definition's identity at spawn time is the
same move on the audit path.

**R-37, surfaced by ADR-0017 and recorded rather than decided here.** Delegate-path approvals use the fixed
subject `<delegate>` because — in `src/approval.ts:24–33`'s words — *"the only things naming a child are the
task string and the tool list, both chosen by the model. A key the model controls is not a key."* **After
ADR-0017 that premise is false for `delegate({agent})`**: the definition is operator-authored, and the
session must now hold `agent:<name>` to name it at all. The consequence today is that `always` approvals can
never persist on the only spawn path (`ceilingOf("<delegate>")` is `null`, so the write is skipped and the
scope downgrades to `session`), which is fail-closed but means ADR-0010's persisted-approval machinery is
dormant — and repeated prompting is what drives an operator to switch gating off, which is R-25's shape.

## Options considered

### Option 1 — digest only (`definitionDigest: {name, source, sha256}`)

Carried on the plan, like `requested`, so the ledger records what the planner actually used rather than
something re-derived at the call site (the B-I3 lesson). Buys: two questions that are currently unanswerable
— *"did every `review` child this week run the same instructions?"* (compare digests) and *"is the file
still what it was when this ran?"* (rehash it). Costs: ~40 lines and one `node:crypto` import. **Limit,
stated plainly:** it answers *which* text ran, never *what it said*. If the file is gone or changed, the
record proves the change and cannot recover the content.

### Option 2 — digest plus a content-addressed body snapshot

Write each distinct body once to `<ledger>.bodies/<sha256>.md`. Buys: the question is answered outright —
the text is recoverable even if the file changed. Costs: a second write in a path that must fail closed, so
a snapshot failure has to either fail the spawn (a new denial-of-service surface: a full disk stops
governance) or be best-effort (a record that claims a snapshot which may not exist). It also writes
operator-authored text to a new location with no retention policy, and the ledger stops being one file.

**Steelman:** the digest alone only *proves* the answer is lost, which is a strictly better failure than
silence but still a lost answer; and repositories rewrite files constantly, so "compare against the file"
degrades in exactly the incident where it matters most. **Rejected for now** on the failure-mode argument:
the ledger's write path is a fail-closed governance dependency, and doubling what can break it to gain
recoverability is a trade this project has consistently declined to make silently. Option 1 does not
foreclose it — the digest is the addressing scheme a snapshot store would need anyway.

### Option 3 — record the task as well

Answers the question completely, for both texts. **Rejected:** it violates the ledger's stated privacy
property directly, and the task is model-assembled from the parent's context, so it can contain anything the
parent could see. A governance artifact that becomes a secrets sink is worse than an incomplete one.

### Option 4 — record nothing; correct the claim instead

State in `docs/SPEC.md` that the ledger answers *"what was this child authorised to do"* and never *"what
was it told to do"*, and stop implying otherwise. Costs nothing, and legibility has real value here (R-25).
**Rejected** because the digest is cheap and the question is a normal one to ask of an audit trail — but the
documentation half of this option is adopted regardless, as part of Option 1.

## Decision

**Option 1.** `planDelegation` computes `definitionDigest = {name, source, sha256}` over the
definition's body whenever a spawn names one, carries it on the plan, and `buildRecord` writes it to the
ledger record. Nothing is recorded for a `tools:`-style delegation, which has no operator-authored
instructions to identify. The task is **never** recorded, and the privacy rule at the top of `src/ledger.ts`
is extended to say so explicitly rather than left to be inferred. For v1 this means the ledger can prove
*which* instructions ran and detect that a definition has changed since; it cannot reproduce the text, and
`docs/SPEC.md` says so in the same words.

## Consequences

**Positive.** *"Did all four reviewers run the same instructions?"* and *"has this definition changed since
that spawn?"* become answerable from the ledger alone. The digest is the addressing scheme Option 2 would
need, so it is a step toward recoverability rather than an alternative to it. It gives R-37 something
concrete to use if approval subjects later become real: a stored approval could be voided by a body change,
which `grantAtApproval` cannot currently detect because `ceilingForDefinition` reads only `allowed-tools`.

**Negative.** A digest invites over-reading: someone will treat *"digests match"* as *"the child behaved as
intended"*, which it is not — it identifies text, it does not evaluate it. The SPEC wording must resist
that. It also adds a field to a record shape that other tooling may parse; it is additive and optional, so
old readers are unaffected.

**Neutral / deliberate non-goals.** The **task is not recorded**, so the model-authored half of *"what was
it told to do?"* stays permanently out of the ledger — by decision, not by omission. No body snapshot, no
retention policy, no new file. R-37 is **not** decided here: whether definition spawns should use the
definition as their approval subject is a separate decision with its own trade-offs.

## Revisit trigger

Any investigation that needs the body of a definition that has since changed — that is Option 2's evidence,
and the digest is what will make the loss visible. Also: any tooling that starts treating matching digests
as evidence of correct behaviour, which means the wording failed.
