# P05 bounded dispatch control v1 — contract for P15

Later local continuation: [actual P01 intent application](../../intent-control/v1/README.md) supplies
scope/priority/alternative adapters under a separate v3 resource binding and intent protocol. The matrix
below remains the contract for **this v1 dispatch-only protocol**, not a permanent claim of external blockers.

Implemented local candidate; overall review and formal acceptance pending. This is **not general live
worker steering**. No new dashboard authority database, model judgment, worker prompt, terminal typing,
Herdr control call or background reconciler is introduced. P04 status remains read-only and unchanged.

## Exact action matrix

| Request | Supported target/boundary | Result |
| --- | --- | --- |
| `pause-dispatch` | One independently bound **v2 resource budget**; application only under the reservation lock with zero active reservations | Pause future reservations; never interrupt admitted work |
| `resume-dispatch` | Same exact budget and zero-reservation boundary | Re-enable only its original fixed limits; no scope/effect expansion |
| Busy pause/resume | Same budget, original live permits still outstanding | Pending; admission barrier blocks new reservations; explicit authorized reconciliation after settlement |
| `cancel-execution` | No atomic durable request-to-live-executor cancellation primitive implemented | Explicit unsupported/not-applied, never ordinary steering or terminal fallback |
| `revise-scope`, `reprioritize`, `select-alternative` | No supported atomic P01 revision application adapter supplied | Explicit unsupported/not-applied; work-v4 remains sole intent source |
| Targeted live pi/Herdr steering | No verified atomic session/target/safe-boundary mechanism established | BLOCKED; pane/title/PID/idle/last-entry facts are not authority |
| Arbitrary bash/model/shared-write or alternative budget/lease stores | Outside the partial P06 profile | BLOCKED; no global dispatch/containment claim |

The useful demonstrated route is `prepareDigestProfile(v2Binding)` / `runDigestProfile`: its actual existing
reservation seam obeys the gate. Preparation probes are not workload dispatch and are not disabled by the
workload gate. Other budgets and executors that do not use this binding are not governed. The boundary is
**verified reservation quiescence**, not global process silence or an authenticated live-pi safe point.
P06's original live owner settles its own permit after executor finalization; orphan reservations remain
active across restart. There is no PID/TTL/receipt-based recovery or general worker-state inference.

## Authority and revision

The host retains the independently created budget binding and supplies independent `DispatchAuthority`
declarations: its exact authority digest plus at most 128 approved request digests. These are trusted host
inputs, not request metadata, authentication credentials or a wire-authority loader. A host must not derive
approval from an incoming request/claimed result or merely copy its identifiers. Defaults are denied.
No mutable approval list is persisted. Existing trusted-store/same-UID/rollback limitations still apply;
this library is not a remote authentication boundary or a revocable distributed authority service.

`DispatchRequest` has a closed version `1.0`, immutable request ID, exact `bindingDigest`, expected **dispatch
revision**, action and nullable execution target. That revision is operational budget state, **not a P01
scope revision**. Requests cannot rewrite P01 intent or claim acceptance. `targetExecutionId` is non-null
only for the distinct unsupported cancellation route. Wire input uses `parseDispatchRequest` (4096-byte
limit, duplicate-aware/exact numeric parsing); `request.schema.json` describes the decoded closed shape.
Do not first round lossy numeric tokens through JSON.parse and call them validated original wire bytes.

Use `dispatchRequestDigest` over the complete canonical request to join independent approval. Missing/wrong
authority refuses; then unsupported route, stale revision and another pending decision refuse. One approved
request advances dispatch revision immediately, including when busy; stale UI cannot supersede it. A busy
admission barrier prevents new reservations while existing work drains. The application itself waits for
zero active reservations under the same non-stale-recoverable lock used by reserve/settle. A barrier is not
a claim that pause has already applied, or that the active worker stopped.

```ts
import { createDispatchBudget, openResourceBudget } from 'pi-daddy/resource-budget';
import { parseDispatchRequest } from 'pi-daddy/dispatch-control';
// One-time host creation under an explicitly owned private parent; persist binding independently.
const binding = await createDispatchBudget({ directory, authorityDigest, limits });
const budget = openResourceBudget(binding);
const controls = budget.controls(independentHostDeclarations); // or null: no authority
const request = parseDispatchRequest(operatorRequestBytes);
const result = await controls.request(request);
const observed = await controls.inspect(); // read-only; never calls request/reconcile
// Only an explicit authorized controller operation may apply pending work:
const reconciled = await controls.reconcile(request.requestId);
```

## Durable request / decision / application / outcome

No parallel intent store: controls extend the existing pinned `budget.jsonl` transaction and reservation
replay. **Explicit binding/header version 2.0** opts into these semantics; unchanged `createResourceBudget`
still creates v1.0 and retains its v1 static return type. Old v1 readers reject a v2 binding rather than
silently skipping controls. No conversion/reset/in-place upgrade API exists.

- `control-request` atomically records the exact request and its approved/refused decision. Approved state
  starts pending with boundary-pending outcome; refusals are not-applied/refused. Each ID occupies one slot.
- `control-apply` records application of the one approved pending request and projects its paused/enabled
  outcome. It is invalid when reservations are active. No transport callback or caller-supplied receipt
  may mark application. `reserve` replays and enforces both committed pause and the pending barrier.
- `DispatchSnapshot` version `dispatch-control-snapshot-v1` includes exact binding digest, revision, paused
  flag, **admission: blocked-pending|paused|enabled**, immutable records and `acceptance:not-assessed`.
  Freshness is `snapshot-unknown`. Readback is not work acceptance or new host authorization.
- An exact duplicate ID/digest only reads the existing result, including pending. It never applies, emits
  another record or repeats an effect. Reusing an ID for another digest rejects. Reconciliation explicitly
  names one exact request ID and rechecks its independently supplied approval and boundary; another ID
  cannot reconcile the pending request. Repeated reconciliation is idempotent.
- No acknowledgement or a thrown I/O/cleanup error means the caller must retain **unknown application**;
  it must not assume success or silently retry a new ID. A complete append may precede an error, including
  fsync/close/lock-cleanup failure: this is not a no-write/no-effect-on-error guarantee. Inspect/reconcile
  the exact ID in the bound store. A pending record is not application; a complete current application
  record is readback, not proof of crash durability, authenticated remote delivery or live worker state.

Mandatory failures reject, including after bytes were written. Partial/invalid/replaced journals refuse
further admission; no truncation, alternate store or recovery credit is attempted. Capacity is bounded by
128 request records and at most 128 applications in addition to the existing attempt/settlement limits,
2305 total v2 lines and 2 MiB. Cumulative attempts/bytes are never refunded. Read-only inspections use
O_RDONLY, no lock creation, bounded descriptor/path consistency checks and no write/control callbacks.
Concurrent changes can make an inspection fail; no old state is substituted.

## Evidence and exclusions

Ordinary owned fixtures exercise real file locking, cross-process duplicate delivery, exact independent
fixture declarations, busy original permits, stale revisions, missing authority, mandatory-sync failure,
source replacement/partial data, read-only byte/directory preservation and actual probed fixed-digest
execution behind the gate. They do not qualify hostile same-UID writers, rollback resistance, complete
controller-crash cleanup or installed/live pi/Herdr operation. No native/model test messages were sent.

P02 native branch/availability gaps, P04 unqualified live freshness/transport, and P06 arbitrary-effect and
aggregate CPU/memory/PID/disk/provider-money limitations remain. P15 must preserve this exact bounded matrix,
unknown acknowledgements, independent approval, request identity and acceptance separation.
