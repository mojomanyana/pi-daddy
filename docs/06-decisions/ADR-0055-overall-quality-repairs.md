# ADR-0055: Concrete repairs from the settled overall review

Status: implemented locally; no publication or overall acceptance
Date: 2026-09-08

The ONE independent review of7b33669 stopped CHANGES-REQUESTED on specification and quality. Its verdict,
probes and frozen trees remain immutable. These are bounded quality repairs, not a new review or closure
of the seven implementable specification integration gaps.

## QUAL001 — controller failure is not worker failure or clean completion

Replay preserves the existing controller-unknown event as a monotone controller-failure indicator even
when every worker artifact/result line already exists. Experiment and factory views expose control:
not-assessed/failed/unknown plus diagnostics. Failed mandatory bookkeeping aborts/drains original work;
unused original permits are consumed without launch, including failed pre-dispatch acknowledgements.
Started/primary/boundary/completion waiters settle; no new attempt, refund or controller restart occurs.

Primary resolves from its ORIGINAL observed worker result after successful artifact persistence, without
an unlocked whole-controller read that races a shadow or waits for its exit. This is NOT a controller
success acknowledgement. Required control errors can follow a completed worker and charged effects.
Final views/factory wrappers carry failed/unknown status even if a later read could find complete bytes;
dispatch is not authorized after controller failure.

Failure-record append/sync/close/release is itself fallible. Only a returned acknowledgement marks that
write acknowledged locally; a failed attempt is explicitly unacknowledged. Replay says a failure record
was observed, not that the interrupted write was fsynced. If unavailable persistence leaves no marker,
a fresh reader cannot reconstruct a lost process-local error: control stays not-assessed, never certified
clean. Actual retained failure markers survive reopen. No power-loss/hostile-UID completeness is asserted.

## QUAL002 / QUAL003

Registry replay maintains the exact prior activation stack, not just candidate bytes. A→B→A and repeated
candidates restore the precise earlier adoption receipt on rollback. Only the original baseline has no
activation. Subsequent orders revalidate current authority, eligibility and expiry and pin that adoption ID.
Old bug-produced order pins with null adoption after nonbaseline rollback now refuse replay, not automatic
migration/repair. Existing pinned orders do not silently adopt a later policy.

Daily view uses actual P01 claim/selection/receipt results. Authority and work snapshot IDs are independent
namespaces and need not equal. Superseded/mismatched receipts remain stale when no current matching receipt
supports the selection; missing authority remains unresolved and P01 still owns all acceptance checks.

## QUAL005 / implementable QUAL004

Two lifecycle fixtures now use explicit retained Node sleepers with actual readiness/liveness BEFORE
teardown, independent held-lock checks and bounded original processes, plus captured stderr. The earlier
Node26 and Node24 1084/0 counts are preserved WITH the missing-sleep false-green coverage limitation.
No bare sleep prerequisite is inferred present from those greens.

Runtime diagnostics preserve the SAME Linux/type/mode/256MiB conditions and original error message, adding
exact path, predicate details and error codes. Independent read-only CI telemetry reports all prerequisites
without skipping required tests or claiming namespace qualification. Job10min/unit5min/test45s bounds and
two file workers preserve the full ordinary glob and Node22.19.0/24.x matrix. A missing-bwrap negative test
uses a verified byte-identical bounded private runtime fixture, changing ONLY that new copy's permissions;
shared cached Node is untouched. Unsupported type/size still fails the fixture prerequisite, not an oracle
waiver. Its exact missing-bwrap assertion and zero-listener assertion remain required.

Remote bwrap/namespace provisioning is NOT performed or authorized here. Exact remote24.20 predicate remains
unknown until fresh actual telemetry; diagnostics do not retroactively supply it. No CI retry, install,
package lifecycle, new runner, source publication, model/live evaluation or reviewer contact.

## Verification

Ordinary owned red→green regressions cover complete-result sync/close/release failures, failed failure-record
sync, retained crash lock, factory wrappers and pre-dispatch started waiters, repeated rollback lineage /
authority/expiry/order pins, real walking P01 context with distinct identities, live sleeper barriers and
specific native predicates. Full ordinary, no-emit, isolated compiled affected paths and postcommit results
are separately retained in the stopped batch receipt. Historical reds and P17D retained/inconclusive persist.

OAR-SPEC-001..007 remain OPEN implementable integration work with separately named B/C limits: operational
observation/attention, dashboard steering, restricted retro supervisor, variant/casting orchestration,
calibration trust lifecycle, Principal associations and connected complete-loop demonstration. This quality
batch neither classifies those as external nor implements/accepts them.
