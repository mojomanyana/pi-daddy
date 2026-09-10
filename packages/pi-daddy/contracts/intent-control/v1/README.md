# P05 actual intent application adapter — contract for P08/P11/P15

Local implemented continuation after reviewed 785f7e6, not yet cleared for publication or formal acceptance.
The earlier dispatch-v1 matrix describes that earlier protocol; omitted repository adapters were not a
permanent external blocker. This adapter performs actual P01 appends, selected-intent changes and explicit
scheduling changes. It does not send worker messages or infer general live-pi safe boundaries.

## Supported effects and exact boundaries

| Action | Actual effect | Bounds |
| --- | --- | --- |
| revise-scope | Rebuild/validate supplied P01 revision/snapshot events with existing builders; append missing immutable events; commit exact resulting selected snapshot in controller receipt | Next scope revision and exact predecessors; same entity set, owner, scope ID, parent/dependency entity topology, exact policy refs; no permission expansion |
| reprioritize | Persist complete explicit `{obligation, rank}` policy for exact selected obligations; real subsequent v3 reservations enforce it | No work append or selection change; lower rank first, ties by canonical full obligation reference, never incoming array order |
| select-alternative | Validate an already recorded exact P01 snapshot and select it in the authoritative controller receipt | No append; same entity/owner/topology/policy/non-expansion checks; not a latest/last/first snapshot election |
| busy request | Record approved request references and keep pending-or-unknown; admission barrier blocks new reservations | Application only under the existing budget lock after all original reservations settle; dispatch and intent pending requests exclude each other |
| fixed-profile execution | Actual `runDigestProfile` reservation carries exact selection, controller revision and scheduled obligation | v3 primary, once-per-selection/obligation dispatch only; original attempt/input/concurrency charges and opaque native profile unchanged |

Adding/removing entities, policy changes, topology expansion, unbound effects and v3 retry/shadow scheduling
are outside this deliberately bounded policy, not proved impossible external primitives. v1/v2 resource
routes retain their previous features and wire semantics. Scope revision, intent-controller revision and
legacy dispatch revision are three different values; none is work acceptance.

## One intent source; explicit v3 header

`bindWorkIntent` validates actual owned regular work-v4 bytes and the exact initial selection/priorities.
Its physical path/device/inode plus optional protected grant-ledger path are retained in an independently
held **v3.0 resource budget binding** created with `createIntentBudget`. Work file and parent must be private,
canonical/owned; symlinks/replacement/hardlinks/partial bytes fail. No discovery or authority file is loaded.
The existing pinned `budget.jsonl` stores only references and operational selections/priorities, never a
second copy of revision contents or granted permissions. Work-v4 remains the sole authoritative intent
content. No dashboard database, mutable approval list, package install or source-store upgrade is created.

No silent conversion: `createResourceBudget` remains v1.0; `createDispatchBudget` remains v2.0. Older readers
reject v3. The existing reservation journal gains `intent-request` and `intent-apply` only under the v3
header. It holds at most 32 intent requests/applications in addition to existing bounded records (2369
lines / 2 MiB total). The separate work ledger keeps existing P01 byte/record bounds.

## API / complete-change authorization

```ts
import { bindWorkIntent, createIntentBudget, openResourceBudget, runDigestProfile } from 'pi-daddy';
import { parseIntentRequest } from 'pi-daddy/intent-control';
const work = await bindWorkIntent({ path, grantLedgerPath, selection: initialSelection, priorities });
const binding = await createIntentBudget({ directory, authorityDigest, limits }, work);
const budget = openResourceBudget(binding);
const controller = budget.intentControls(independentHostDeclarations); // null defaults denied
const request = parseIntentRequest(originalRequestBytes);
const result = await controller.request(request);
const status = await controller.inspect(); // no lock files, writes or reconciliation
const reconciled = await controller.reconcile(request); // complete original request, exact digest/ID
// Existing prepared digest profile must belong to this same binding.
if (!status.nextObligation) throw new Error('no currently admissible scheduled obligation');
await runDigestProfile(profile, { attempt, bytes, intent: {
  selection: status.selection, revision: status.revision, obligation: status.nextObligation
} });
```

The caller must check a non-null next obligation and separately satisfy any applicable host workflow gates.
P04 can consume the resulting exact `status.selection` as `workContext.selectedSnapshot`, with independently
verified P01 acceptance authority if available. The adapter never constructs that acceptance authority.

`IntentRequest` (`intent-request-v1`) binds exact resource binding digest, expected controller revision,
expected current snapshot AND event identity, action, target selection, complete proposed event bytes and
complete explicit priorities. Independent host declarations authorize its **whole normalized digest**,
not just a request ID/action/target. Request metadata contains no approval field. Host declarations must be
independently established, not mechanically copied from wire claims. The library does not authenticate a
remote caller or confer trust on receipt-shaped JSON. No approval/effect callback is accepted.

The strict parser enforces duplicate members, exact numeric tokens, closed shape, 48 KiB, at most 16 proposed
revision/snapshot events, 32 exact obligation priorities, 64 selected non-scope revisions and safe bounded
IDs/ranks. `request.schema.json` is a standalone decoded-shape schema; its embedded `work_*` definitions are
exact P01 definitions with local reference prefixes, compared to the original by tests. Shape validation
is not authority, digest, graph, availability, non-expansion or application validation. Events must match
actual P01 builder output, and cannot smuggle unselected revisions/snapshots or acceptance/occurrence events.

## Application, acknowledgement and reconciliation

Approval validates current selected P01 closure, full proposed closure, exact predecessors and non-expansion
under the budget transaction. The request receipt records immutable request digest, exact old/new selections,
proposed event references, priorities, decision and pending-or-unknown application state. Approval advances
only the intent-controller revision. A stale expected revision/selection or missing approval cannot overwrite
it. Unknown authority, stale and busy refusals remain recorded immutable decisions, not implicit retries.

At verified **reservation** quiescence, the adapter revalidates actual source bytes and uses the new explicit
`appendWorkLedgerEventOnce` seam. It shares P01's protected destination checks, terminal-LF admission and
non-expiring work-file lock. Only this opt-in seam skips exact event ID/digest redelivery and fsyncs; ordinary
`appendWorkLedgerEvent` still preserves duplicate deliveries. Contradictory same-ID data rejects. The
adapter revalidates resulting actual P01 bytes before appending the application receipt and switching selected
intent/priorities. It does not fabricate application from a callback, timestamp, idle flag or acknowledgement.

A complete work append followed by controller receipt failure remains **pending-or-unknown**, with old
controller selection until an actual application receipt exists. Exact duplicate request delivery is readback
only. Explicit reconciliation requires the same entire authorized original request and ID/digest; it skips
already retained exact events, appends only missing events, fsyncs retained bytes again, and records one
application. No duplicate intent effects, alternate store, truncation or automatic repair. Preserve the
immutable original request: the controller receipt intentionally stores references rather than missing
revision contents. Losing that proposal is not permission to invent replacements.

An I/O error is never proof nothing happened: even an application receipt may have been completely written
before sync/close failure. Caller acknowledgement is unknown until exact bound readback/reconciliation;
readback is not crash durability or remote/live-worker authentication. Torn bytes stop admission. A real
controller crash can leave non-expiring budget/work locks and outstanding permits: status stays read-only,
and reconciliation refuses rather than inferring ownership loss from PID/age. Safe lock/orphan recovery
needs separately governed work; it is not supplied here.

`IntentSnapshot` version `intent-controller-snapshot-v1` exposes exact selected references, controller
revision, explicit priorities and immutable decision/application/outcome records. `resultSelection` is null
until applied, then records the exact resulting selection; outcomes distinguish selection-applied,
priority-applied, pending-or-unknown and refused. `intent-ready` is readiness of
this intent layer, **not** an unpaused dispatcher or accepted work; inspection also reports dispatch pause
and a next obligation only when relevant barriers allow it. Freshness stays snapshot-unknown; acceptance is
not-assessed. Scheduling consumption means once dispatched/charged, never completed or accepted. Dependencies
are retained P01 intent relationships, not newly invented acceptance/dispatch prerequisite semantics.

## Remaining boundaries, honestly classified

- **Implemented here:** bounded scope successor application, concrete priority enforcement and recorded
  alternative selection through real P01/control/reservation/profile seams. Models remain unnecessary.
- **Owned fixed-profile cancellation adapter not implemented here:** the existing caller-held AbortSignal
  can cancel its own invocation. A durable request-ID-to-live-owned-handle/application acknowledgement bridge
  is still repository implementation work, not proof of a missing kernel primitive. No such acknowledgement
  is invented, and cancellation remains distinct from steering.
- **General live pi/Herdr steering remains genuinely unqualified:** no verified atomic session/target/safe-
  boundary transport was established. No terminal typing, worker/status prompts or PID/title/idle guesses.
- **Scope of boundary:** quiescence of this exact budget, not global process silence. Historical/untracked
  executions keep their old exact work bindings; this does not steer or rebind them. Coordinated controller
  writers share the budget lock; direct conflicting work writes invalidate selection/admission rather than
  being silently accepted. Malicious same-UID races/rollback and full-controller-crash cleanup remain excluded.
- P02 native bytes/branch gaps, P04 live freshness and P06 arbitrary pi/bash/shared-write/global resource
  containment limitations remain. No source result closes overall review or formal acceptance.

Ordinary owned tests cover actual appends/selection/P04 projection, unchanged permission bytes, real native
priority enforcement, stale/default-denied authority, busy settlement, exact duplicate/cross-process delivery,
complete-append/failed-receipt and multi-record reconciliation, torn/substituted files, a real controller exit
with retained locks, and read-only status. Fixtures are not live pi/Herdr or installed-package qualification.
