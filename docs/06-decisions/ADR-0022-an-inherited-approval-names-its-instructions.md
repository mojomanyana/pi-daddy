# ADR-0022: an inherited approval names the instructions it was given for

**Date:** 2026-08-14
**Status:** Accepted (2026-08-14, by the user, Option 1 over a steelmanned Option 3 — document the limit)
**Driver:** R-45, from the 2026-08-13 red-team pass. Completes ADR-0019's headline property across all three
approval paths, and changes the propagation format ADR-0014 defined.

## Context

ADR-0019 made a persisted approval **void once the thing it was granted for changes**, pinning both the
definition's `allowed-tools` and — using ADR-0018's digest — its **body**. That property is the reason the
30-day store was kept rather than deleted.

`resolveApprovals` satisfies a gate from three sources, in order: `inherited` → `session` → `persisted`.
**Only the persisted branch passes through `entryVerdict`.** Session approvals are bare
`capability@subject` strings in memory; `inheritApprovals` publishes them to a child as
`PI_GRANTS_APPROVED=capability@subject`, with no digest, no ceiling and no expiry. So ADR-0019's property
holds on the one path that survives a restart and on neither of the two that do not.

**The scenario, at depth 2.** A human approves `tool:bash@deploy` while `deploy`'s body reads *"Run
./deploy.sh staging"*. The orchestrator delegates to a child that itself holds `tool:delegate`. Meanwhile the
file is rewritten — a `git pull`, or any agent in the tree holding `write` — to *"Run ./deploy.sh production
--force"*. The child is a **new OS process**: it loads `deploy` from disk (the new body), receives
`PI_GRANTS_APPROVED=tool:bash@deploy`, hits the `inherited` branch first, matches on the key, and runs the
new instructions with `bash` and **no dialog**. The ledger records `approvalSource: "inherited"`, which reads
as correct.

**This is not a privilege escalation** — `bash` was held, and `approved ⊆ grant` holds at every level by
construction. It is the **confused deputy** ADR-0010 and ADR-0019 exist to stop, on the paths that skip the
check.

**One case that is already sound and must not be broken by the fix.** A `session`-scoped approval used by
the *approving process itself* is consistent: `session.definitions` is a `session_start` snapshot, so the
parent spawns the body it was asked about even if the file has since changed. The hazard is specifically the
**boundary**, where a fresh process re-reads from disk. R-50 records the snapshot behaviour and its other
consequences.

## Options considered

### Option 1 — pin the digest in the handoff *(chosen)*

`PI_GRANTS_APPROVED` entries become `capability@subject#sha256` for definition subjects. The child hashes
the body it loaded and drops any inherited approval whose digest does not match.

**Buys:** ADR-0019's property becomes true on all three paths, enforced structurally rather than by the
child trusting its parent's memory. Fails closed and fails *quietly correctly*: a mismatch is not an error,
it is simply an approval that does not apply, so the ordinary gate runs — which for a child means a refusal
naming the fix, because a child has no interactive user.
**Costs:** a **breaking change to the propagation format** — a 0.10 parent and a 0.11 child do not
understand each other's `PI_GRANTS_APPROVED`. ADR-0014 already made exactly this change once, for the same
reason (a scope and a subject that were being discarded one hop down), so the precedent and the failure mode
are both known: an unparseable entry is dropped, which costs a prompt and never grants anything.

### Option 2 — do not inherit definition approvals at all

A child must hold its own approval.

**Steelmanned:** it is the most conservative reading, and it makes the boundary trivially safe — nothing
crosses it unverified because nothing crosses it. It would also delete `inheritApprovals`' subtlest code.
**Why it lost:** a child runs `--print` with no interactive user, so it cannot be asked; the approval it
lacks can only produce a refusal. Multi-level delegation with any gated capability — which, since ADR-0012
gates `bash` by default, is most of the interesting cases — would stop working at depth 1. ADR-0010 chose
inheritance deliberately and named the per-level `approvalSource: "inherited"` ledger record as its
compensating control; this option discards the feature rather than fixing it.

### Option 3 — document it as a known limit

State in `docs/SPEC.md` that inheritance is keyed to capability and subject only.

**Steelmanned:** it is free, it is honest, and the exposure needs a definition to be rewritten *during* a
delegation tree's lifetime — narrow. The package already documents larger holes (ADR-0012).
**Why it lost:** the rewrite does not need an attacker. `git pull` is the ordinary case, and an agent
holding `write` is the configuration this package recommends gating rather than forbidding. Documenting a
hole is right when closing it is disproportionate; here closing it is one string field and a hash the child
already computes for its own ledger record.

## Decision

**An inherited approval carries the body digest of the definition it was given for, and is honoured only
against a matching body.** `PI_GRANTS_APPROVED` publishes `capability@subject#<sha256>` when the subject is
a definition; the `<delegate>` subject carries no digest, because it names no file to hash and — per
ADR-0019 — is never persisted or offered `always` for the same reason. On arrival the child re-hashes the
definition it loaded and drops any approval whose digest differs; a malformed entry is dropped as it already
is. `session`-scoped approvals used *within* the approving process are unchanged and remain consistent by
snapshot. For v1 this means a definition rewritten mid-tree re-raises the gate below the level that approved
it, and — because a child cannot be asked — refuses, naming the capability.

## Consequences

**Positive.** ADR-0019's stated property is true on every path. A `git pull` mid-tree can no longer silently
change what a descendant was authorised to do. The digest the child needs is already computed for its own
ledger record, so this adds no new machinery.

**Negative.** Breaking propagation format: mixed-version parent and child lose inherited approvals and
therefore refuse gated delegations until both sides upgrade. A definition edited harmlessly — a typo in a
comment — voids inherited approvals for the rest of the tree, which is a false positive by intent: the
digest cannot tell a typo from a rewrite, and ADR-0018 chose that trade knowingly.

**Neutral.** Nothing changes for the `tools:` form, which never had a file to pin.

**Deliberate non-goals.** The **ceiling** is not re-verified on inheritance, because it does not need to be:
the child computes its own ceiling from the file it loaded and intersects it with its own grant, so tools are
already handled by the invariant. No digest is carried for `<delegate>`. No attempt to distinguish a
cosmetic edit from a substantive one.

## Revisit trigger

A false positive that costs real work: an operator reporting that inherited approvals evaporate across a
tree for a reason they consider cosmetic — line-ending normalisation, trailing whitespace, a reformatted
body. That would argue for normalising the body before hashing, which is a change to ADR-0018's digest and
therefore that ADR's decision to revisit, not this one's.
