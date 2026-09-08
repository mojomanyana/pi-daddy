# ADR-0049 — Actual P01 intent application and explicit scheduling

Date: 2026-09-08
Status: Local implementation; overall review and formal acceptance pending

The prior P05 checkpoint omitted scope/priority/alternative adapters. Those were repository work, not
permanent external blockers. This continuation adds actual bounded P01 application using a separately
versioned v3 resource binding/journal and intent-request-v1 protocol. P01 work bytes remain authoritative;
controller receipts retain only request digests, event references, selected snapshots and explicit ranks.

Independent host authorization binds the complete proposed change and exact current binding/selection /
intent-controller revision. Concrete builder/strict-ingestion validation rejects owner, policy, topology
or permission expansion. Scope successors append real P01 events and commit the exact resulting selection.
Recorded alternative selection appends no intent. Priority policy names exact obligations, and the existing
fixed-profile reservation seam actually enforces lower-rank-first, once-per-selection primary dispatch.
No priority meaning is invented from P01 array order or execution success.

Approval establishes a pending admission barrier. Application waits for actual reservation quiescence under
the existing budget lock. New explicit appendWorkLedgerEventOnce shares P01 protection/locking and adds
exact ID/digest idempotence plus fsync; default append still preserves redeliveries. Work append followed by
receipt failure is unknown application, reconciled only from the exact original approved request. Complete
prefixes can resume without duplicate effects; torn data and retained crash locks never auto-repair/reclaim.

Tests exercise actual P01/P04 selections, unchanged permissions, fixed-profile scheduling, missing/stale
approval, busy/duplicate/cross-process delivery, interrupted multi-record reconciliation and actual process
exit with retained non-expiring locks. Status remains read-only. The contract and remaining matrix are in
packages/pi-daddy/contracts/intent-control/v1. Owned cancellation bridging remains implementation work;
general live pi/Herdr atomic targeted steering is still unqualified. P02/P04/P06 limitations remain.
