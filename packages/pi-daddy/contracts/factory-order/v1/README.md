# P15 — bounded fixed-profile factory orders and applied policy changes

Local supported slice, not full factory/model qualification. Public API: `pi-daddy/factory-order` and root
exports. This compiles into the ACTUAL existing P11 controller, not a scheduler service or model planner.

## Charter, intent and resource boundary

`FactoryOrderCharter` / `parseFactoryOrder` / `factoryOrderDigest` bind version factory-order-v1, orderId,
canonical new directory, exact v4 budget, P01 WorkIntentBinding and full source hash, scope digest, common
base64 bytes, deadline1000..30000ms, current policy revision/candidate digest and1..16 nodes. Each node pins
one exact selected P01 obligation, dependencies,1..3 named attempts, expected SHA256 and optional reserved
product decision/owner. Every selected obligation is covered exactly once, required P01 obligation
prerequisites cannot be omitted, cycles/missing dependencies reject. Charter≤48000 bytes, total attempts≤32,
each expanded input≤16KiB. Scope is the exact P01 selected snapshot digest, not a pathname/logical name.

Only the probed fixed digest/hold profile is supported. A candidate FixedPolicy binds a canonical byte
suffix, acceptance-policy digest, grants:[], effects:['fixed-digest'], model:null, effort:null, skills:[].
Other configurations/effects refuse; offline SHA work is not model/skill work. The exact frozen charter is
independently approved by the host; a model may propose data but no model participates in eligibility,
resource arithmetic, permission, objective outcome, product choice or activation.

The compiler emits explicit **fixed-experiment-v2** with an order-schedule-v1 payload. P11 v1 semantics and
existing delegate_all remain unchanged; old experiment readers reject v2. P01 work bytes/selection and
permitted read effects are revalidated. P11 pre-reserves ALL node/recovery attempts and queued slots in one
synced resource-v4 batch before any worker launch. Runtime input is common bytes + pinned policy suffix +
explicit attempt suffix. No extra attempts, implicit grant expansion or optimistic per-child budget checks.
Existing per-call cap bounds actual running attempts. Queued/recovery slots are conservative active charges;
skip/failure/cancel/exhaustion never refunds cumulative use.

## Actual controller API

```ts
const registry = await createFactoryRegistry({directory, authorityId, scopeDigest, baseline});
// Privileged one-time host initialization, like budget creation; not a model/wire authority loader.
await createFactoryOrder(registry, exactCharter, independentAuthority);
const order = await openFactoryOrder(registry, orderId, independentAuthority);
const before = await order.inspect();       // no models, worker writes or dispatch
const run = await order.advance(preparedProfile);
const boundary = await run.boundary;        // automatic eligible work drained; returns reserved decisions
await order.decide(exactDecision, newlySuppliedHostAuthority);
const final = await run.completion;         // owns all workers, accounting and remaining reservations
const bytes = await order.readArtifact(exactExecutionId);
```

Objective success requires actual hash-backed P11 artifact bytes and the expected result digest under the
frozen policy, not exit0 alone. Objective failure may consume only the next pre-reserved node attempt.
Dependencies require satisfied predecessor nodes. A reserved decision additionally requires a full exact
factory-decision-v1 request, independently approved digest, designated owner, current evidence digest and
binding. Approve/reject is a recorded product choice, never inferred from stdout/model labels. Duplicate
choices read back; conflicts, stale evidence and missing authority refuse. Decision digest covers requestId,
bindingDigest, nodeId, evidenceDigest, authorityId and choice. Evidence identity includes policy, node,
winning execution and artifact. No implicit decision changes or acceptance inheritance.

Status returns nodes/obligation refs, objective state, next structural action, policy pin, accounting and
explicit dispatchAuthorized. An eligible graph action is not permission when dispatchAuthorized:false.
No provider is called; modelTransport is not-used-fixed-profile. Public inspect/reconcile are read-only and
never wake/dispatch. Control eligibility instead takes the existing experiment lock and explicit resource
controlSnapshot lock, avoiding a racing read-only observer snapshot as a control oracle. Required logging /
accounting remains on the fail-closed path; optional P02 observation is still asynchronous.

`order.cancel(exactExperimentCancellation, hostAuthority)` uses the ORIGINAL P11 handle and newly supplied
exact cancellation approvals. No new reader can signal guessed PID/pane/idle state. The ordinary bounded
profile deadline also owns queued/active lifetimes. Boundary resolves early only for a reserved decision;
completion includes all launched work and cleanup. Storage failures after start yield explicit unknown
rather than an unhandled background execution promise or fabricated success.

### Failure/escape matrix

| Observation | Deterministic action |
| --- | --- |
| Exact objective passes, no reserved decision | Satisfy this node under frozen order policy; dependent nodes eligible |
| Expected objective failure | Next explicitly pre-reserved node recovery only |
| Recovery exhausted | Stop affected branch; stakeholder action; independent nodes continue |
| Missing/corrupt artifact or unknown old execution | Unknown branch/dependents pause; no replay/refund; independent eligible nodes may continue |
| Reserved product decision | Return decision-required at boundary; wait for exact independent choice or deadline |
| Rejected decision | Branch/dependents stop; independent nodes continue |
| Scope/source/effect drift | Stakeholder/new charter; no silently broadened scope/effects |
| Total admission exhausted | No node launch; no optimistic partial admission |
| Shared journal/ownership/accounting failure | Fail closed, abort original owned handles, drain launched tasks, unknown if evidence cannot be retained |
| Duplicate/restart/lost acknowledgement | Read actual pinned state; never create another attempt/materialization to guess what happened |

Unused reservations settle without launching at final bounded termination; attempts/bytes remain charged.
No generic P01 work-acceptance event is synthesized: the view keeps acceptance:not-assessed. Satisfied means
this explicitly authorized objective/decision policy, not full task, skill, evaluation or factory acceptance.

## Applied adoption, subsequent-order pins and rollback

Exact pure upstream source `22606c21adb118b9ae395fe93a197609a63e05e3:packages/core/src/adoption.ts` is vendored
unchanged in src/vendor/adoption.ts; adoption-pin.json records its hash. Its predicates are CONDITIONAL,
not an activation service or authenticated authority. No model evaluation is performed here.

FactoryAuthority is separately retained host input: id, exact order/decision/activation/migration digests,
optional exact cancellation digests, independent P13 adoption/rollback authority and eligibility facts keyed
uniquely by binding ID. Duplicate conflicting fact keys reject. Do not populate these lists/facts from an
incoming proposal or a successful P11 result. This slice uses one explicitly configured host authority ID;
remote identity/approval-service integration remains a host responsibility, not a signature claim.

`openFactoryRegistry(binding).activate(request, authority)` validates the exact candidate/scope/experiment /
assessment policy and receipt through the pinned predicates AGAIN under the existing bounded control lock.
The whole factory-activation-v1 request is also approved, including expected current revision/candidate.
Wrong/stale/expired/forged receipts, changed scope, false eligibility and missing authority cannot activate.
The exact rollback candidate must be the currently active candidate. Applied change is a synced journal
transition, not a caller boolean. New matching order creation revalidates current eligibility/expiry; all
existing orders retain their immutable candidate/revision, intent, grants, model/effort/skill and policy pins.
The new byte policy actually changes subsequent fixed-worker inputs/artifacts; it is not metadata-only.

`registry.rollback(exactP13RollbackRequest, authority)` revalidates current active adoption/candidate/scope
and separately approved rollback against the pinned predicate, then appends the actual restore transition.
It returns application:applied only after required persistence. The upstream predicate's not-performed
result is not confused with that application. Changed newer policy cannot be overwritten by stale rollback.
Existing orders remain pinned. No automatic rollback from one failure, no grant expansion.

## Explicit migration and durable receipts

`migrateFactoryOrder(registry, request, authority)` requires exact factory-migration-v1 approval plus both
source and successor order approvals. Only an UNSTARTED original P11 controller may be superseded, checked
under its own lock—not from PID/idle/finished metadata. A durable request precedes the source's actual
order-migrated barrier; all future starts of that source refuse. A separately materialized matching-scope
successor receives current approved policy. The applied migration receipt lists renewed obligation refs,
grantExpansion:false and acceptanceTransfer:none. Any original claim, including completed work, yields an
explicit refused-active receipt; active/history-bearing migration is NOT supported. Cross-scope migration
requires separately governed new registry/order authority, not this exception.

A lost acknowledgement/partial materialization can leave pending-or-unknown and a blocked old order. Exact
redelivery only reads; it does not repeat source migration, creation or execution. No rollback/truncation /
lock reclamation or inference from an orphan artifact. Full-controller-crash recovery remains separate.

## Persistence and qualification limits

Registry is an operational policy/order-pin journal INSIDE pi-daddy, not a dashboard learning-decision store.
New private canonical directory, pinned directory/file dev/inode, nofollow single-link bounded files,
non-expiring lock, chained records and required sync/close/directory sync. Limits512KiB/256 records/64KiB
record/32 pinned orders. Physical experiment materialization is validated against its earlier compiled pin.
Readbacks check actual journals/artifacts; missing/corrupt/torn data does not silently reset state.

Host initialization/declarations are conditional authority, not authentication, rollback resistance or hostile
same-UID containment. Filesystem stalls, aggregate CPU/memory/PID/money/disk guarantees, live pi/Herdr atomic
steering, arbitrary model/skill variants, calibrated evaluation/adoption eligibility, installed/live demos,
active-order migration and full P15/factory acceptance remain unqualified. Existing P11/P06 bounds and P08
pause limits remain. Native865-vs1316 original evidence and original-live observation-drain diagnosis are
preserved; draining is not full-session completeness or fsync.
