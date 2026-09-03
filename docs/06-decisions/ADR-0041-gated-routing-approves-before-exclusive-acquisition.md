# ADR-0041: Gated routing approves before exclusive acquisition

**Date:** 2026-09-03
**Status:** Accepted; not implemented in this wave
**Driver:** An unapproved model-reachable routing attempt holds the destination writer lease through the approval dialog and records acquisition for a child that never starts (R-145).

## Context

Current ordering previews non-liftable refusals, resolves and leases the workspace, then asks. It protects
against destination races but turns a routing gate into an availability lock. The default dialog is bounded at
120 seconds; an operator can still configure an unbounded wait.

## Options considered

1. **Keep lease-before-dialog and add a `never-ran` fact.** Makes the ledger complete but preserves the
   availability problem.
2. **Resolve, bind destination identity, ask, then acquire and revalidate.** No exclusive lock is held while
   waiting; a changed destination or conflict refuses after approval and newly banked authority is removed.
3. **Ask against workspace ID only, then acquire.** Smallest ordering change, but registry repointing can make
   the approved destination differ from the acquired one (R-137).

## Decision

Choose option 2. Approval must bind the resolved canonical destination identity, acquisition follows approval,
and the acquired destination is revalidated against the approved identity. A mismatch or lease conflict starts
no child and unbanks authority created for that failed attempt.

## Consequences

Approval dialogs no longer deny other governed writers. The cost is a real post-approval failure window and a
new trusted destination component in the binding. This is not purely additive to the current version-1 binding
and ordering, so it is deliberately not implemented in this wave. The smaller ledger-only patch was also not
taken: current successful teardown already writes a matching release, while failure to write it is reported;
a new `never-ran` wire fact would require a versioned ledger decision rather than an ad-hoc v3 enum change.

## Revisit trigger

Implement after the destination-binding wire/version and an end-to-end race probe are specified and mutation
entries cover acquisition, revalidation and unbanking on both executors.
