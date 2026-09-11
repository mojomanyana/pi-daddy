# ADR-0065 — Optional primary-return fan-out with retained shadow accounting

Status: implemented candidate; live qualification pending
Date: 2026-09-11

## Decision

Preserve `delegate_all` exactly as wait-for-all when its existing input shape is used. Add an opt-in pair, `completion: "primary"` plus a required in-range one-based `primary`, for independent variants where one result controls parent latency and every other child is a shadow.

All children are still planned, approved, budget-split, assigned unique execution identities and started through the existing `runOneDelegation` path. The tool returns when the selected primary settles. Shadow failure does not change that result, and aborting the caller after primary return cancels only still-running children through their existing signals. No fallback, retry, winner selection, quality inference or acceptance is introduced.

The original grants session retains a bounded (128-run) primary/shadow accounting record keyed by the primary execution ID. Background settlement records every execution ID, role and success/failure without retaining child prose. `/grants variants` exposes running/settled summaries to the human. Existing grants and Work-v4 lifecycle ledgers remain the durable per-child evidence when configured. Capacity refuses before any child starts; there is no eviction or recovered ownership.

The returned `primaryExecutionId` is the actual preallocated occurrence, not a regenerated label. Requested model and thinking still describe child argv only; neither demonstrates provider-internal reasoning.

## Validation

A deterministic readiness/release fixture makes the primary wait until both shadows have started, then proves the primary returns while both are still unsettled. Explicit release yields one successful and one failed shadow; `/grants variants` and the original ledger retain all three terminal outcomes. A second run aborts a ready shadow only after its primary returned and verifies final original-owner accounting. The existing synchronous fan-out test continues to require both children before return.
