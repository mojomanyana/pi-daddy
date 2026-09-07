# ADR-0044: Opt-in work-v4 evidence with exact-snapshot acceptance

**Date:** 2026-09-06
**Status:** Accepted
**Driver:** P01's approved work/evidence identity boundary, frozen v2/v3 compatibility, and P01-PLAN-007's requirement for a durable decision record.

## Context

This records the **design approved on 2026-09-05**, not a new approval or completed task gate.
Approved design SHA-256: `368025d938c667b30e62b6ca58a7e09e22646cae2fc3024103faf180c4c02787`.
The implementing Revision 8 plan has SHA-256
`11a15802b7ddfb69371c777e1ef0351ea4381bffc68e9bba80915e4bc5d75010`.
The source candidate is not released or activated; package version 0.22.0 and default runtime emission
remain unchanged. Independent specification/quality/whole-change review and task acceptance remain pending.

The [SPEC](../SPEC.md#the-ledger) describes v3 grant/runtime recording and frozen v2 compatibility.
Those records identify governed executions and caller-declared correlation, but do not define generic
revision-bound work acceptance. A logical child position can be reused; completion is an observation,
not proof that a particular obligation's selected artifact satisfies a selected policy. A digest identifies
content but neither retains its bytes nor authenticates the party making a claim.

Work needs an explicit selected scope and exact revision/evidence binding without promoting wire labels
into authority or poisoning old readers. Source now contains the four builders, strict text ingestion,
dedicated append/inspection, selector, conditional projector and minimal occurrence reconciliation.
[Path tests](../../packages/pi-daddy/test/work-ledger-path.test.ts) exercise the real file path and
fixture trust boundary, including source-backed repairs for non-expiring ownership, ancestor/sidecar
misrouting and Node filesystem encoding equivalence. These observations are local Linux filesystem
and fixture evidence, not a general containment or authentication result.

The [candidate contract](../../packages/pi-daddy/contracts/ledger/v4/README.md) supplies the portable
wire/reference/error description and the [schema](../../packages/pi-daddy/contracts/ledger/v4/ledger-event.schema.json)
supplies closed shape/domain constraints. No critical assumption of a production signer, authority loader,
retained artifact store, or honest external filesystem actor is presented as validated.

## Options considered

### Option 1 — Extend the existing v3 union and ledger destination

Reuse all current paths and consumers with minimal new configuration. This would mix work claims with
provisioning evidence, change a frozen public contract, and cause old readers or rollback versions to
misinterpret/refuse new lines. Repairing those consumers would expand the compatibility change and still
would not establish acceptance authority. Rejected: dedicated opt-in evidence must not require rewriting
historical v2/v3 bytes or broadening their meaning.

### Option 2 — Dedicated opt-in v4 stream, shared append mechanics, explicit host context

Keep the producer and existing cross-process lock implementation, but select a separate destination and
non-expiring ownership only for v4. Add closed generic work events, strict semantic identity, exact snapshot
selection and a separately supplied in-process authority context. This isolates compatibility and makes
missing evidence/refusals inspectable without a service. It costs more explicit caller configuration,
full-input validation, conservative new-snapshot revalidation and indefinite orphan-lock unavailability.
It proves conditional binding only: the host must be trusted, and ordinary filesystem misrouting checks
are not an OS sandbox. Chosen within those boundaries.

### Option 3 — Add authenticated signers, authority/availability services and live adapters now

Such infrastructure could establish who is authorized to decide and how retained bytes are verified.
It also needs a separate authority policy, key lifecycle, storage/availability guarantees, threat model,
operational recovery and integration qualification. None is established by P01 or by a receipt-shaped
object. Deferred to separately approved work; inventing a loader or signature label now would conceal
rather than close the trust gap.

## Decision

Use option 2: a dedicated explicitly selected work-v4 evidence stream from the existing producer, with
closed real builders, strict text validation and canonical digests, exact selected snapshots, and acceptance
only under separately supplied validated host authority plus available exact evidence. Preserve v2/v3
contracts, defaults, serialization and exception/callback behavior. P01's positive proof is
**fixture trust-boundary simulation**, not production authentication, automatic approval or task qualification.

## Consequences

- **Isolation and rollback:** no runtime default switches to v4, no migration or mixed-file append occurs,
  and old integrity/dashboard readers reject v4 rather than counting it as grants/lifecycle evidence.
  Work paths and explicit grant protection are required; null protection is an explicit host declaration,
  not an environment fallback. Stop using the opt-in candidate and retain its evidence to roll back.
- **Identity:** SHA-256 covers RFC 8785 canonical JSON under a restricted safe-integer profile. Every own
  digest excludes only itself and includes nested digests. Timestamp changes affect event identity;
  formatting changes do not. Raw archival byte hashes remain distinct. Duplicate decoded JSON members,
  exact numeric-token failures, unsupported objects and bad supplied digests are refused, never repaired.
- **Bounds:** 64 KiB per nonblank record, 16 MiB and 10,000 nonblank records per supplied text, nesting
  depth 16 and 256 entries per input array. Output aggregates need not fit the input-array bound.
  Post-append byte/record capacity is checked under the same lock and descriptor before writing.
- **Selection and conflict:** no latest-head or arrival-order election. Exact inventory/bindings,
  ancestors, predecessors and dependencies must resolve; structural contradictions suppress the
  denominator. Missing selected artifact bytes remain local coverage gaps without dropping obligations.
  All conflicting delivery alternatives matter; redelivery under another event ID cannot cleanse them.
- **Host authority is the trusted computing base:** the validated context is detached at entry and binds
  authority snapshot, exact claim/authority IDs, selected snapshot, scope/intent/obligation/artifact
  revision and artifact byte digest, policy and evidence. The claim's artifact byte digest must equal
  the selected artifact revision's `contentDigest`, even if a supplied decision matches a wrong digest.
  Availability is separate from a wire digest. Superseded/mismatched decisions cannot authorize the current selection. New snapshots require fresh
  matching receipts. Contradictions fail closed; unsupported siblings remain diagnostic without revoking
  an independently complete exact claim. The library cannot authenticate a dishonest host's assertion.
- **No implicit authority:** labels, `observed` provenance, capability approvals, check success, completion,
  event-nominated paths and schema-shaped receipts cannot construct trusted context. No production
  authenticator, authority registry, callback, ambient loader or positive caller is added. The fixed
  [test controller](../../packages/pi-daddy/test/work-ledger-fixtures.ts) takes no incoming claims and
  derives its expected world separately. Its `1/1` proof is for a selected snapshot under fixture authority.
- **Execution identity is not association cardinality:** globally reconcile by execution ID before
  exposing selected scope/obligation associations. One execution may have multiple bindings/variants
  while remaining one attempt. Logical child IDs are not launch counters. Declared and observed labels
  remain distinct; unknown or contradictory identity/branch evidence is not filled by inference.
  Accepted progress counts obligations, never claims, receipts, attempts, variants or completions.
- **Non-expiring v4 ownership has an availability cost:** v4 explicitly disables age/liveness reclamation
  on the shared helper. A slow holder retains ownership; waiters fail at the inherited two-second timeout.
  Own-token cleanup remains. A killed holder or failed token creation can leave an orphan that blocks
  future writers indefinitely. Recovery requires separately authorized operator action after establishing
  quiescence and inspecting bytes; P01 adds no automatic recovery API, heartbeat or PID oracle. Legacy
  three-argument/age behavior is unchanged.
- **2026-09-07 candidate cleanup clarification (P01-REV-QUAL-001):** the quality review observed a
  successful append silently leaving a non-expiring lock after removal failure. Disabled-mode cleanup now
  attempts token-checked removal even after lock-close failure and reports the first cleanup failure if
  the body succeeded; public append translates filesystem errors to `WORK_LEDGER_WRITE_FAILED`. Failed
  ownership reads cannot authorize deletion, and replacement tokens remain untouched. Primary body errors
  retain precedence even if cleanup also fails; legacy age cleanup remains best effort. A rejected append
  may have fully written its line, with or without a remaining lock. Blind retry can add physical duplicate
  deliveries/consume capacity or fail on retained ownership; neither rollback nor exactly-once retry is
  promised. Preserve bytes and use separately authorized inspection/quiescent recovery, not automatic
  takeover. This clarification describes the source candidate, not task/release acceptance or new approval.
- **Filesystem scope:** preflight checks both work leaves and all existing/prospective ancestors against
  both protected grant leaves using Node UTF-8 filename spelling, canonical paths and available inodes.
  Rechecks and a regular-file descriptor protect the validated append path. This is cooperative
  accidental-misrouting protection, not containment against a malicious same-user race, dishonest host,
  incompatible writer, external lock deletion, mount alias or unsupported exclusive-create semantics.
  Preflight refusals precede mutation. Later failure may follow own-parent/lock activity or a partial
  append; partial bytes remain evidence, not a transaction rolled back by truncation.
- **Diagnostics:** explicit inspection is bounded and read-only. `read` means bytes were read, not that
  content or acceptance passed. Results are detached/frozen with fixed codes and typed references;
  no raw task text, native error message or path is copied into diagnostic results. Schema conformance
  cannot replace strict text/digest/graph/trust validation.
- **Contract tooling:** pure fixture construction calls production builders. Generation requires an
  explicit output directory and copies the hand-authored schema; imports write nothing. Tests use
  fresh explicit targets and check old collateral. The four exported examples are individual event
  objects, not an authority context or complete accepted graph. Documentation-structure assertions are
  not independent semantic review. Declared package targets are not compiled/installed-export proof.
- **Deliberate non-goals:** production authentication or acceptance activation, retention/archive services,
  dashboard/CLI expansion, workflow dispatch, general containment, model evaluation and qualification.
  Broader repeated-attempt scenarios, mutation-catalogue evidence, full-suite/integration/build/installed
  smoke handling and independent gates remain separate pending work; no such pass is claimed here.

## Revisit trigger

Reopen this decision before enabling any production caller to supply positive authority, automatically
recovering an orphan, mixing/defaulting work-v4 emission, or changing public wire/digest semantics.
Also reopen on evidence that a schema-valid unsupported claim becomes accepted, a duplicate/variant
inflates accepted obligations, a changed selection reuses stale authority, a cooperative slow writer loses
ownership, or a protected destination is mutated before refusal. A normal workload repeatedly reaching
16 MiB/10,000 records calls for a separately designed incremental/retention boundary, not silent truncation
or relaxed validation. Any broader filesystem/authentication promise requires new measured evidence and
independent review rather than reinterpreting these fixture results.
