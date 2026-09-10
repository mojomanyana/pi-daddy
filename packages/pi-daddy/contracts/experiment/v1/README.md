# P11 fixed-profile experiment controller — partial, local implementation

Existing pi-daddy API, not a service, delegate_all replacement, evaluation engine or P11 completion.
P15 entry point: `pi-daddy/experiment`; types and pure digest/parser functions also exported at package root.

## Actual boundary

`createExperimentBudget` explicitly creates resource journal **4.0**. Versions1/2/3/defaults and existing
wait-for-all delegation are unchanged. Older readers reject4.0. `reserveBatch` appends ONE synced record
under the existing non-expiring resource lock after checking the entire batch against remaining attempts,
input bytes and active slots. No partial optimistic per-child admission. All2..32 chartered primary/shadow /
retry slots remain conservatively active, including queued waves/retries. No refund for skip, failure,
cancellation, timeout or lost acknowledgement. Only original minted live permits settle slots. This is not
aggregate CPU/memory/PID/money accounting; existing bounded profile preparation probes are separate host
qualification, not experiment attempts.

`prepareDigestProfile` still performs actual fixed native probes. An opaque prepared profile for this exact
budget is required; JSON/profile labels cannot launch. The existing digest operation hashes at most16KiB.
The new v4-only batch route additionally permits an explicitly declared **hold** calibration payload with
the SAME native namespace/Node permission/prlimit/output/3s timeout/3.5s hard-deadline bounds. Hold never
produces a successful digest; it exists for owned cancellation/deadline/lifecycle demonstrations. Neither
operation accepts command/code/env/workspace/provider settings. The existing runDigestProfile request/byte operation stays unchanged. A post-spawn result lacking observed
exit/signal now conservatively withholds settlement credit; an abort flag alone is not observed cancellation. Base64 argv is NOT secret transport.

## Frozen charter and authority

`ExperimentCharter` / strict `parseExperimentCharter`:

- version `fixed-experiment-v1`, experimentId, orderId, exact budgetDigest and fixed profile
- common `{sha256,bytes,work,workTextDigest}`; actual common bytes copied/materialized once
- optional `work` is the actual P05 `bindWorkIntent` binding: pinned P01 file identity, exact selection and
  priority references. Full source bytes must match workTextDigest and resolve under P01. This is a pinned
  common-input context, NOT v3 priority scheduling, permission expansion or acceptance.
- mode `concurrent-shadow` (exact N=2 primary+shadow) or `bounded-waves`
- deadlineMs1000..30000; variants2..32, entire normalized charter≤48000 bytes
- each variant: variantId, exact executionId, kind primary/shadow/retry, prior declared parentExecutionId,
  canonical suffixBase64 and operation digest/hold. The worker hashes common bytes plus that explicit
  suffix; these are DATA differences, not model/effort/skill differences.
- configuration `{model:null,effort:null,skills:null}`: unknown remains unknown. Any other value or unknown
  field refuses, not an invented delivery charter. First variant is the sole digest primary. Later parents
  must already be declared. Execution/variant IDs are unique within this charter; global host identity and
  approval namespaces remain host responsibilities, not inferred from names/PIDs/pathnames.

Separately retained `ExperimentAuthority {authorityDigest,charterDigests,cancellationDigests}` approves exact
whole normalized charters/cancellation requests for the independently retained budget authority. Null,
unlisted or changed context refuses. P15 MUST establish approvals independently; never populate lists from
incoming proposals/receipt IDs. These are trusted-host capability declarations, not remote authentication.

P10 freeze/investigation6db7a67 has executionReady:false and cannot be used as a run charter. P12
0475e1f inspection/blind fixtures are conditional, not live qualification. P13 adoption22606c2 predicates
are not applied activation. This controller does not turn any of those flags into execution permission.

## Materialization, ownership and API

```ts
// Host has independently approved the exact charter and retains the resulting physical binding.
const binding = await createExperiment({directory, budget, charter, bytes, authority});
const controller = openExperiment(binding, authority);
const run = await controller.start(preparedProfile);
const primary = await run.primary;        // does NOT await shadow, other variants, or judge
const whole = await run.completion;       // controller-owned lifetime, including cleanup/accounting
const snapshot = await controller.inspect();
const readback = await controller.reconcile(); // actual bound journals/artifact bytes, read-only
const bytes = await controller.readArtifact(executionId); // exact charter member, retained hash checked; detached
```

Creation uses a new private canonical directory, immutable common.bin, separate hash-named variant
directories and a pinned synced experiment.jsonl header. The binding records directory/journal dev/inode,
charter and budget identity; retain it independently. No automatic migration or overwrite. Common bytes /
optional P01 source are checked before admission and each wave. Workers receive detached private byte
copies and no production workspace mount, so a shadow cannot overwrite primary data or artifacts.

A durable one-shot claim precedes atomic admission. An admitted journal entry precedes dispatch. The existing
`MAX_CHILDREN_PER_CALL` cap (currently8) is imported and enforced; larger N uses complete bounded waves.
Queued slots already count against the TOTAL budget. Explicit retries wait for their declared parent's
terminal handling, run only on non-success, and otherwise settle cancelled-before-launch. They consume the
pre-reserved allowance either way; no new retry IDs/variants are invented.

Each actual executor result is synced to its own exclusive result.json before its digest/terminal state is
appended to the one experiment journal. Original handles own AbortControllers and execution promises.
`run.started` contains only original fixed-profile spawn/settled-without-spawn observations; those are
lifecycle facts, not worker/session authority. P02 retention is still optionally used by the real profile
execution path with exact execution/parent IDs. Resource settlement failures reject even after exit0.

The controller holds all execution promises and waits for launched workers on its completion path. A
bookkeeping failure aborts remaining owned handles, consumes unused reservations without launching and
records unknown when possible. Whole-experiment deadline aborts the actual original handles, including
queued attempts; per-worker native deadlines still apply. Required I/O/settlement failures are not success.
No caller callback or boolean supplies a cancellation outcome.

## Controller failure versus worker outcome (QUAL001 repair)

`ExperimentView.control` is `not-assessed | failed | unknown`; it never certifies clean controller
completion from worker states. Existing controller-unknown events now replay as explicit failure even
when complete result records already exist. Process-local mandatory failures remain visible if recording
fails; `controller-failure-recording-unacknowledged` is not a successful durability acknowledgement.
Fresh readers observe retained failure records; absent a record they cannot reconstruct lost process
state, so control remains not-assessed. Unavailable reads return unknown on settlement paths.

Primary is the ORIGINAL worker/artifact outcome after successful artifact persistence, not a whole-controller
read or bookkeeping success. It does not wait for a shadow or racing public inspection. Completion and
boundary carry explicit control failure/unknown; factory wrappers preserve it. Failed pre-dispatch writes
still consume original unused permits without spawning and settle started waiters. No refunds/relaunch.
All artifact bytes and charges remain separate from required control append/sync/close/lock-release failure.

## Exact owned cancellation

`ExperimentCancellation {version:'experiment-cancel-v1',requestId,bindingDigest,executionId}` binds one
immutable target. Approve `experimentCancellationDigest(request)` separately. `controller.cancel(request)`
records the request before touching its ORIGINAL LIVE AbortController. Exact redelivery only reads back;
conflicting request IDs refuse. The visible request outcome stays requested-or-unknown until actual result
bytes and a terminal journal record support observed-cancelled or finished-without-cancel. A request is not
an acknowledgement of application, and an error after append does not prove no effect.

This supplies the owned fixed-profile cancellation bridge HERE. P05 dispatch-control wire cancellation,
arbitrary live pi/Herdr atomic targeting and cross-process handle transfer are still unsupported integration
work. No guessed PID, pane/title/idle flag, terminal typing, worker prompt or extra observer/control RPC.

## Restart, unknown state and limits

Reopening with the exact physical binding can inspect/reconcile actual budget records and immutable artifacts.
Duplicate start cannot re-execute a recorded claim—even if admission, launch or acknowledgement is unknown.
An open controller without the original handles reports uncompleted old work UNKNOWN, never idle/completed.
No old active slot is reclaimed/refunded or silently relaunched. Missing/mismatched artifacts cannot support
terminal success. Reconciliation is deliberately read-only: orphan permits, complete unreceipted artifacts,
non-expiring crash locks and torn files require separately governed recovery, not guessed completion or
truncation. A durable cancellation request without an owned handle stays unknown, not applied.

The immutable input/artifact representation is not storage quota enforcement. Canonical private single-link /
nofollow bounded files, hash-linked bounded journal, fsync and non-expiring lock defend ordinary faults;
hostile same-UID races, rollback, blocked filesystem I/O and full-controller-crash cleanup remain unqualified.
Limits:256KiB journal,260 lines,64 explicit cancellation requests,32 variants,16KiB per input/result read,
fixed400-line module ceiling. Admission may conservatively reserve more slots than concurrently running
workers. Global admission beyond this exact budget, arbitrary pi/bash/model isolation, model/effort/skill
variants, judgments/efficacy/casting, aggregate CPU/memory/PID/money and automatic adoption remain unsupported.

`ExperimentView` version experiment-view-v1 reports explicit identities, states, artifact digests backed by
actual bytes, accounting, cancellations, diagnostics, unknown configuration, snapshot-unknown freshness and
acceptance:not-assessed. Runtime completion is NOT approval, causality, cheapest-eligible qualification or
routing/adoption authority. Primary and shadow are concurrent only in concurrent-shadow mode; larger waves
are labelled bounded-waves, not a simultaneous N-way experiment or later replay masquerading as shadow.

## Preserved native865 vs1316 failure: distinct repair

P08's earlier failure is retained, not erased by later passes. A deterministic native test now explicitly
captures+drains the earlier file, appends an actual SessionManager entry, then finishes: terminal+verified
still names the earlier stable-format snapshot and coverage.complete remains false. A second ordered final
observation+drain retains the appended bytes. No arbitrary sleeps or rerun-until-green is used to establish
that distinction.

The old governed-process oracle polled terminal/verified, which was NOT a native observation quiescence
barrier. `drainExecutionRetention(originalStatus)` now exposes the existing admitted-observation drain through
an original-live-status WeakMap capability. Copied/wire receipt-shaped statuses reject. The real governed
process test uses that drain before final-byte equality, without changing capture semantics, producer
completeness, native branch rules or asynchronous worker-control separation. Drain is not fsync, a future
producer barrier, authentication or proof of full-session completeness. No capture-loss/completeness repair
is claimed where the demonstrated violation was the asynchronous final-byte oracle.

A separate selected-run failure exposed P01's recursive readdir oracle following an intentional self-link
with different traversal depths. A bounded no-follow physical inventory plus positive byte-change sentinel
replaces only that test oracle; original alias refusal and zero-mutating-call assertions remain unchanged.

Local source/tests and isolated compiled paths are measurements, not installed/live qualification or full
P11 acceptance. See ADR-0051. Stop for independent overall review and next ready P15/P17D clause.
