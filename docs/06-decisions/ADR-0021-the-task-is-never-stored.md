# ADR-0021: the task is never stored, not even as provenance

**Date:** 2026-08-14
**Status:** Accepted (2026-08-14, by the user, Option 1 — delete the field outright)
**Driver:** R-44, found **independently by both reviewers** in the 2026-08-13 red-team pass. Enforces a rule
ADR-0018 stated and this code contradicted.

## Context

ADR-0018 set the ledger's privacy boundary and `src/ledger.ts` states it without qualification:

> PRIVACY: capability ids, counts, and identifiers only. Never prompts, tool arguments, or results. […]
> **The task is not recorded, anywhere, ever** — it is assembled by the model from the parent's context and
> can carry anything the parent could see, so a ledger holding it would be a secrets sink.

ADR-0018's Option 3 was rejected on exactly that reasoning. `docs/SPEC.md` repeats the rule as "in any
field".

**And `extensions/approvals.ts` writes `taskAtApproval: task` into the persisted entry**, where
`/grants approvals` prints it back as `for: <task>`. The field predates ADR-0019 and was unreachable —
nothing between 0.7.0 and 0.9.0 could write the store at all — so **ADR-0019 armed it hours after the rule
was made explicit**, and the same session-log entry that recorded the rule also shipped the contradiction.

The destination is **worse than the ledger by ADR-0018's own criteria**. `PI_GRANTS_LEDGER` is opt-in and
the operator chooses its path; `$PI_CODING_AGENT_DIR/grants-approvals*` is always-on, sits outside the
repository, and holds the string for 30 days. A concrete instance: the model calls
`delegate({agent: "deploy", task: "rotate the prod key AKIA…, current value in .env line 4"})`, the human
clicks *Always allow*, and that sentence is now at rest in the home directory.

**A second reason, not found by either reviewer.** Displaying `for: <task>` beside a standing approval
**implies a scope the approval does not have.** The entry authorises *any* task for that definition for 30
days. It reads like a constraint and is not one — the legibility failure R-25 names for `bash` grants and
R-35 named for `agent:` ids, in the human-facing surface where it is most likely to mislead.

## Options considered

### Option 1 — delete the field *(chosen)*

Remove `taskAtApproval` from `ApprovalEntry`, stop writing it, stop displaying it, and strip it from any
entry rewritten by this version.

**Buys:** the stated rule becomes true. The misleading `for:` line goes. Nothing else changes, because the
field is part of **no key** — `approvalKey` is `capability@subject`, and `src/approval.ts` already documents
`taskAtApproval` as "Provenance only, NEVER part of a key".
**Costs:** one line in `/grants approvals` and one test fixture. An operator wondering *why* they approved
something loses the only in-store hint.

### Option 2 — delete the task, display the pinned body digest instead

Show `instructions 4f2a91c` from the `bodyAtApproval` the entry already stores.

**Buys:** provenance that is an identifier rather than model text, and one an operator could in principle
join against the ledger.
**Why it lost:** R-51 records that **nothing reads `definitionDigest` today** — `verifyLedger` never touches
it — so the line would invite an operator to act on a value no tool can help them with, which is how a
diagnostic starts lying by implication. The right order is a reader first (R-51's mitigation), then a
display. The hash stays in the file either way; this decision only declines to surface it yet.

### Option 3 — keep the field and narrow the rule in writing

Amend `ledger.ts` and ADR-0018 to say the ban covers the ledger and exempt the approval store, with the
reason.

**Steelmanned:** it is the honest move *if* the provenance is genuinely load-bearing, and a rule that
existing code violates is worse than a rule with a stated exception. Revoking an approval you no longer
remember giving is a real situation.
**Why it lost:** the exemption would have to argue that a 30-day always-on file outside the repository is a
*safer* home for model-authored text than an opt-in ledger the operator placed deliberately, and that
argument cannot be made. The provenance an operator actually needs — *which definition, when, pinned to
which instructions* — is already in the entry, and the fuller answer belongs in the ledger, which records
every spawn.

## Decision

**`taskAtApproval` is removed.** The task is not written to the approval store, is not displayed by
`/grants approvals`, and is stripped when this version rewrites a file that contains one — the write path
projects each entry through an explicit whitelist of declared fields, so no future field can leak into the
store by accident either. `ledger.ts`'s "not recorded, anywhere, ever" stands unamended, and is now true.
For v1 this means the listing shows the key, the approval date and the expiry; the task is still shown in
the **dialog** at the moment of approval, which is where a human needs it and where it is not at rest.

## Consequences

**Positive.** The privacy rule is enforced rather than asserted. A human-facing line that implied a
nonexistent scope is gone. The whitelist on write closes the class, not just the instance.

**Negative.** An operator reviewing `/grants approvals` cannot see what prompted an approval. Mitigation
exists and is not built: the ledger records every spawn against that definition, including the digest.

**Neutral.** Entries written by 0.10.0–0.10.2 that contain a task are unreadable after ADR-0020 anyway,
since that decision ignores the old shared file.

**Deliberate non-goal.** No redacted, truncated or hashed form of the task. A truncation still leaks, and a
hash of a model-authored string is not provenance a human can use.

## Revisit trigger

An operator who cannot answer *"why is this approved?"* and for whom the ledger does not suffice — for
instance because no ledger was configured at the time. That is a real gap, and the answer is then R-51's
digest reader plus Option 2's display line, in that order, not the task string.
