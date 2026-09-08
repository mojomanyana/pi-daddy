# ADR-0051 — Atomic fixed-profile experiment admission and owned shadows

Date:2026-09-08
Status: Local partial P11 implementation; overall review/acceptance pending

Use existing pi-daddy fixed-profile execution, P02 retention, P01 source resolution, original AbortSignal
lifecycles, resource journal and fan-out cap. Do not change delegate_all wait-for-all/cancellation semantics.
New explicit resource version4 reserves every chartered primary/shadow/retry in one locked synced append.
Queued waves consume slots conservatively; only the original minted permits settle. Old readers refuse.

A separately authorized whole charter pins common bytes, optional actual P01 file/selection, per-variant
byte differences, immutable execution IDs, fixed digest/hold operation and deadline. General model/effort /
skill settings refuse; unknown is not filled in. Investigation freezes and conditional adoption/comparison
predicates are not a live run charter. The hold operation is bounded calibration, never digest success.

Materialize exclusive immutable common and variant artifacts under a private pinned directory. Record a
one-shot claim before admission and actual byte-backed results in a bounded synced hash-linked journal.
Run at most the existing per-call cap in bounded waves. The separate primary promise does not await shadow
or judge; the retained controller completion promise owns every actual worker and all accounting/cleanup.
Pre-reserved retries wait for parent non-success; successful parents cancel unused retry reservations without
refund. There is no automatic new variant or retry.

Exact independently approved cancellation records precede original live handle aborts. Actual executor
settlement/result bytes establish only bounded lifecycle outcomes. Request metadata, caller booleans,
PIDs/panes and worker messages cannot target or prove cancellation. This is an owned fixed-profile bridge,
not general live pi/Herdr steering or the older P05 dispatch wire route.

Restart reconciliation reads actual bound journals/artifacts without relaunch, refund, lock reclamation or
receipt-only repair. Missing outcomes are unknown. Same-UID rollback/races, filesystem stalls, full-controller
crash cleanup and aggregate host CPU/memory/PID/money guarantees remain unqualified.

Separately diagnose the preserved865-vs1316 native failure with ordered real capture/drain, append and finish.
A terminal verified-format snapshot can precede later bytes; coverage stays partial. Repair the test's invalid
final-byte oracle by exposing existing observation draining through an original-live-status capability, not
by sleeping/retrying or changing native capture/completeness claims.

The selected regression run also exposed a P01 test-only inventory oracle following its intentional self
symlink to variable traversal depths. Preserve that failure; use bounded no-follow inode/mode/link-target /
byte snapshots instead, with a positive real-change sentinel. Production alias guards and zero-mutation
assertions are unchanged.

Contract: packages/pi-daddy/contracts/experiment/v1/README.md. No models, installs, lifecycle execution,
per-task model review, new services, history cleanup or publication of new source. P11 is not complete.
