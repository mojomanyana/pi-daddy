# ADR-0052 — Structured orders and applied next-order policy

Date:2026-09-08
Status: Local fixed-profile slice; full P15 and overall review/acceptance pending

Compile independently approved factory-order-v1 data into the existing P11 controller's explicit
fixed-experiment-v2 schedule. Reuse actual P01 work identities/source validation, P02 optional retention,
P05-origin intent bindings, P06 native fixed profile and v4 whole-batch reservations. Preserve old P11 v1
and delegate_all semantics. No separate scheduler service or model on the control path.

Each exact obligation has dependencies, an objective digest, bounded pre-reserved attempts and optional
reserved product choice. Objective failure differs from runtime exit: recovery follows objective failure,
not a model interpretation. Independent eligible branches continue while exhausted, unknown or decision-
blocked branches pause. Explicit decisions bind current byte-backed evidence and designated host authority.
An order boundary returns the decision; its owned lifetime still includes deadline and every worker.

Control eligibility must use coherent control snapshots, not a read-only observer snapshot while another
worker appends. Take the existing experiment lock and explicit resource controlSnapshot lock. Ordinary
inspect/reconcile stay read-only. All active execution promises are drained even after control-read failure.
The first concurrent activation test exposed the distinction; retain its failed controller-unknown evidence.

A bounded private registry records operational policy transitions and immutable order pins. Use exact
unchanged22606c2 adoption predicates, with separate whole-request approval and independently supplied facts
revalidated under lock. Actual candidate data affects subsequent matching fixed-worker inputs; old orders
keep intent/configuration/grant/acceptance pins. Rollback is an actual explicit restore transition. No
predicate/receipt-shaped metadata or P11 success can supply missing eligibility/authority.

Only unstarted orders can migrate: durable request, locked original-controller supersession, separately
approved new successor, receipt and renewed obligations with no acceptance transfer. Original claims refuse
active/history-bearing migration. Lost acknowledgements stay pending/unknown; no automatic repair/relaunch.

Scopes are fixed-profile byte work only, not model/skill generation, calibrated eligibility or whole-factory
qualification. Same-UID rollback, global resource enforcement, blocked filesystem I/O, full-controller-crash
recovery, live pi/Herdr targeting and active-order migration remain unqualified. Preserve native-byte drain
and no-follow inventory diagnoses. New source local only; exact4e20cbc publication was separately cleared.

Contract: packages/pi-daddy/contracts/factory-order/v1/README.md. Tests were introduced before implementation;
no model evaluation, install, mutation machinery, per-task review or campaign/native lifecycle edit.
