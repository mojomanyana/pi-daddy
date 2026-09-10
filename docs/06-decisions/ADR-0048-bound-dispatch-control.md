# ADR-0048 — Bound dispatch controls, not live worker steering

Date: 2026-09-08
Status: Implemented local candidate; overall review and formal acceptance pending

P05 extends the existing resource reservation journal instead of adding a dashboard intent/authority
store. Explicit v2 budget creation supports independently host-authorized pause/resume of future
reservations for that binding. Existing v1 creation, hashing and static binding types remain compatible;
v1 readers reject v2 semantics. Work-v4 remains the sole work-intent source; no acceptance is inferred.

Exact request IDs/digests, expected dispatch revision, request/decision/application/outcome replay and
bounded locked admission prevent stale overwrite and duplicate application. Pending requests establish
an admission barrier; application waits for verified zero-reservation state under the same lock. Original
live permits must settle; restart/PID/idle/receipt-shaped data cannot reclaim or prove a boundary. Read-only
inspection does not lock/write/reconcile. Required journal failures still reject; complete appends can
precede failure, so unknown acknowledgement requires exact-ID readback rather than blind effect retries.

The supported actual execution seam is the existing probed fixed-digest profile using a v2 budget. Resume
restores only its fixed allowance, never scope/effect expansion. Cancellation is distinct and unsupported
by this request protocol. Scope revision, reprioritization, alternative selection and general live pi/Herdr
steering are blocked without an atomic supported application primitive. Existing executor AbortSignals
are not a durable authenticated targeted-control transport. No terminal typing/status prompts are used.

The P15 contract, matrix and strict request schema live at
packages/pi-daddy/contracts/dispatch-control/v1. P04 live freshness, P02 native gaps and P06 containment /
aggregate resource limitations remain explicit. Ordinary owned tests are not installed/live qualification.
