# ADR-0039: Persisted approvals bind supplied tree state

**Date:** 2026-09-03
**Status:** Accepted
**Driver:** A 30-day approval that binds instructions and capabilities but not a supplied candidate-tree identity can be replayed after the reviewed tree changes.

## Context

`ApprovalBinding` already fails closed on task, definition, requested/effective capabilities, workspace,
context and parent. Correlation may also carry `tree_sha` and `last_change_seq`; before this decision those
values were recorded but did not scope an approval. They are caller-declared metadata, not proof measured by
pi-daddy, but adding them to equality can only narrow reuse.

## Options considered

1. **Bind optional `tree_sha` and `last_change_seq` when supplied.** Existing callers remain byte-for-byte
   compatible; supplied values must match on replay.
2. **Use a shorter TTL for tree-sensitive scopes.** Limits exposure but still permits replay across a changed
   tree during the shorter window and invents another expiry policy.
3. **Status quo with an explicit non-claim.** Simplest, but leaves supplied tree identity disconnected from
   the approval intended to describe the same run.

## Decision

Choose option 1. The two fields are optional and enter the version-1 binding digest only when the caller
supplies them. Absence preserves existing callers. Mismatch yields the existing `APPROVAL_SCOPE_MISMATCH`.
They remain caller-declared narrowing inputs: this does not claim pi-daddy measured or attested the tree.

## Consequences

Tree-aware controllers can prevent a standing approval from crossing their own change boundary. The same
approval no longer matches when either supplied value changes. Callers that omit both retain the prior
30-day behavior, so this does not close replay for legacy or uncorrelated use. Binding serialization gains
optional fields, but no ledger event shape changes.

## Revisit trigger

Revisit if a controller needs monotonic floor semantics rather than exact equality, or if operators need the
bound tree values displayed before approval.
