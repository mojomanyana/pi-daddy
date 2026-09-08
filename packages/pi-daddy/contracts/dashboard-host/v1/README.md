# Connected producer dashboard host v1 (local candidate)

This is the existing dashboard's explicit operational host, not another scheduler or learning-decision
store. It launches no models. Source through f276698 is public draft PR35; this subsequent integration is
LOCAL ONLY. Original overall CHANGES-REQUESTED remains. No live/authenticated factory acceptance follows.

## Additive original ordinary control and revision application

Optional `ordinaryDigest` pins the original port retrieved using `ordinaryChildrenFor(originalExtensionAPI)`
BEFORE dispatch. Pass it as `options.ordinary` and independently approve native requests via `authority.ordinary`.
`ordinary-cancel` carries the exact closed v1 request through this SAME host journal/CLI handler. It requests
original abort, never reconstructs a PID/pane or replaces a caller promise. Failed final acknowledgement
remains failure despite cancellation/complete bytes. Late opt-in coverage gaps and failed/unknown ordinary
control withhold presentation quiescence. Absent original ports cannot cancel; old configs are unchanged.
See `contracts/ordinary-control/v1/README.md` for limits. The legacy P11 bridge remains separately supported.

Existing `intent`/`intent-reconcile` also carry opt-in `intent-request-v2` / `revise-selection` through the
actual P01 controller: direct non-scope successors, not topology/owner/policy/effect expansion. No acceptance
transfer or duplicate effect. See `contracts/intent-control/v2/README.md`. These narrow formerly absent A
paths; unretained/crashed handles, wider revision domains and atomic authenticated live TUI steering remain
unqualified. No new trust/case/blind/control store or worker observation hook is introduced.

## Loaded artifacts and independent authority

`pi-daddy/dashboard-harness` exports `loadDashboardHarness(artifactRoot, manifest, privateParent)`.
The manifest is `DashboardHarnessArtifact`: version `dashboard-harness-artifact-v1`, exact sourceCommit
`1c02194d4a3709d14890a5fbbad91ff5f0151f65`, relative compiled `files` SHA256 map, canonical existing
`typeboxRoot` and its `typeboxPackageSha256`. This exact harness commit is a LOCAL dependency, not claimed
public. Compile actual source first; the loader neither compiles nor installs. The ordinary fixture's37
source bodies/provenance demonstrate the real adapters, generated P01/retention readers and core writers.

An approved artifact has `package.json` bytes `{"type":"module"}`, `core.js` re-exporting the actual
work-capture/work-signals/intervention/factory-calibration core modules, and the original relative module
layout under `packages/adapters/src/` and `packages/core/src/`. The callable entries are learning-journal,
trust-lifecycle, archive-policy/observer/checkpoint, archived-work, execution-retention-archive,
work-case-review, blind-intervention, evidence-archive, work-signal-observation/cases and work-case-archive.
The learning journal is a genuine named module export at this pin, not yet an adapters-root re-export.

The loader checks bounded regular non-group/other-writable bytes, copies at most128 files/8MiB into an
exclusive private directory, loads the real modules and rechecks bytes. Fresh paths avoid substituting an
old module-cache instance for changed disk bytes. It returns `{api, artifactDigest, directory, manifest}`.
Typebox remains the actual existing peer; package metadata is bound, not its whole source graph. This is
loaded artifact identity, NOT human/module authentication, code confinement or hostile same-UID resistance.
No arbitrary unreviewed module should be authorized merely because someone can compute its checksum.

`pi-daddy/dashboard-host` exports `createDashboardHost` / `openDashboardHost`. Supply the loaded `api`, exact
`DashboardHostConfig`, original budget binding, optional ORIGINAL `openExperiment` controller and an
independent current `authority()` callback. The callback returns host/config and whole request digest
allowlists, independent P01 context and native dispatch/experiment authorities. Request fields and files
never supply authority to that callback. Copying a controller/interface or supplying a pin-shaped string
cannot substitute for the original branded object. Structural host authority is still not authentication.

Creation is explicit and exclusive. Reconnect ONLY opens `trustDirectory/producer-host`; no caller-selected
replacement attention directory. The original trust lifecycle validates its archive-local registration,
policy identity and fixed store. Its predeclared attention policy must allow no more than FIVE questions.
Host config binds source policy, selected initial P01 snapshot, budget/experiment, author, initial case/blind
IDs and loaded artifact digest. Changed config/another policy/store needs new explicit authority; no reset.

## Source → checkpoint → semantic daily view

Config sources have IDs and kind `work`, `facts` or `retention`. There may be at most one work source.
Explicit `observe` requests select one configured source and exact previous checkpoint; max32 sources.
No worker hooks, status messages, directory scan, automatic watcher or refresh-driven collection is added.
The journal claims the request BEFORE the actual harness ingestion. Policy path/SHA/root/expiry are checked
through real `archivePolicyBinding` and `ingestPolicySource`, not inferred from mtime or receipt shape.

- `facts`: an exact retained JSON/JSONL object containing genuine host-declared `WorkSignalFacts`; payload
  `{sourceId, previousCheckpointId, facts:null}`. This does not make declarations authenticated truth.
- `work`: payload `{sourceId, previousCheckpointId, facts: <observed facts SOURCE MANIFEST ID>}`. Only an
  already observed configured fact source is accepted, not caller replacement facts. The actual pinned P01
  projector and `captureArchivedWorkSignals` bind scope/obligations and retain observation/case/linkage IDs.
  Nomination failure preserves raw checkpoint plus semantic failure and never invents a successful case.
- `retention`: exact v2 policy with `contentPolicy:referenced-blobs`; facts:null. Real manifest/blob ingestion,
  readback and `projectRetainedExecutions` feed the existing daily reader. Missing blobs stay gaps.

Frames re-read retained bytes and recompute projections. Native files do not prove an active TUI branch;
activeBranch remains null. Source SHA/checkpoints, unobserved sources, partial coverage, independently
supplied acceptance and declared facts remain separate. If control selection is unreadable, the initial
host declaration is labelled unavailable, acceptance is withheld, but explicit observation can still retain
incomplete bytes. Steering cannot use that fallback. Scope-changing intent requests update the actual
control selection; stale UI selection/CAS cannot overwrite it.

Only explicitly selected exact sources are semantically consumed. Reference-only/redacted bytes are not
masqueraded as exact replay. Ingestion/access policy expiry is enforced on these paths; no redactor,
credential-safe export approval UI or physical retention-duration deletion is invented here. Those remaining
P03.4 operations belong to a concrete separately supplied harness policy adapter. No history is deleted.

## Attention, pause and actual presentation acknowledgement

The host's independent `presence()` returns `{present, closing, evidenceDigest, expiresAt}` or null.
It must be sourced/authorized outside worker metadata. Idle, PID, title and agent-end events do not populate
it. Missing, expired, changed or absent presence hides cards on read without writing; explicit `defer`
retains weekly deferral. Neither a declaration nor a socket path authenticates a human.

A `present` request includes `{userPresent,closing,evidenceDigest,dispatchRevision}`. It checks the real
resource pause at zero active reservations (and optional original experiment quiescence) before/after
opening the existing manual presenter. Selected case detector version/population must match the real trust
policy. Each actual case/blind card reserves attention through ORIGINAL `trust.expose` before checkpoint
CAS. Silent/retired/insufficient policy defers; partial/failed reservations are never refunded. The fixed
checkpoint cannot change card IDs or refill on answers/reconnect. Blind occupies one of five total slots.
Zero-card issues and explicit v2/v3 selection remain visible.

A successful preparation returns its debrief frame digest, **prepared-not-delivery**. The actual dashboard
can render that frame, then an independently approved `presented` request names the exact frame digest.
The host rechecks original presence and pause before recording its presentation acknowledgement. This is
host-acknowledged delivery, not independently verified human perception or globally atomic live-TUI pause.
Another authorized controller could change a boundary after a snapshot; reads hide stale presentations and
resume/control actions close the original presenter. No stronger atomic transport primitive is invented.

`debrief` payload is the existing explicit command line (`label 1 skip`, `choose none`, `reveal`, etc.).
The original selected-batch/case writer and immutable blind quality writer own decisions. The host journal
holds only request/attention/presentation transport state and references/digests, not a cloned decision
history. Failed label acknowledgement propagates through the actual dashboard action rather than being
lost in a void return. Reopen reads original quality; it neither votes nor reveals automatically.

## Exact steering and original lifetimes

Requests are closed bounded `DashboardHostRequest` objects: version1.0, requestId, hostDigest,
expectedTip, selectionDigest, operation and payload. Use `dashboardHostRequestDigest` for independently
approved whole requests. Obtain tip/selectionDigest by reading `frame()`; reading them confers no authority.

- `dispatch`: original pause/resume `DispatchRequest` → resource controls. Native expected revision and
  independently approved digest remain required. Busy reservations leave a durable pending barrier.
- `dispatch-reconcile`: explicit original request → existing reconcile; frame/refresh never calls it.
- `intent` / `intent-reconcile`: original `IntentRequest` → actual P01 scope/recorded alternative/priority
  APIs and their original no owner/policy/effect expansion guards. General entity/topology expansion is
  still outside the bounded adapter, not accepted merely by a UI action.
- `cancel`: `{dispatch:<legacy cancel-execution request>, cancellation:<ExperimentCancellation>}`. IDs,
  current legacy revision, exact target and both independent approvals are checked. Cancellation invokes
  ONLY the supplied original experiment controller, not a reopened PID/pane/terminal target. Reopen cannot
  recover lost handles. This bridges the older protocol for the supported P11 controller, not arbitrary
  live pi/Herdr or every ordinary child cancellation route.

Host journal CAS admits one exact request. Duplicate IDs read retained results without effects. A required
append/sync/close/release failure remains failed/unknown even if bytes/effects exist. Best-effort host-failure
markers preserve that separately; their own persistence can fail. `reconcile()` is read-only, not a retry.
An unresolved claim/failure does not permit new dispatch, takeover, refund or unreceipted effect replay.
Original worker outcomes/accounting remain independent of host/control success.

## Existing dashboard process/plugin

`serveDashboardHost(privateSocketPath, originalHost)` runs inside the owning process. The existing dashboard
uses `--host-socket /private/host.sock` or explicit `PI_DADDY_HOST_SOCKET`, carried by the existing Herdr plugin
open path. It makes read-only frame requests on refresh and forwards only explicit approved JSON action
lines. `--once --daily-json --host-socket ...` is a real read-only CLI path. Programmatic
`runDashboard(argv, env, {connected:host})` uses the same handlers. No new monitoring service or scheduler.

The Unix socket is bounded/private, at most4 clients,64KiB request/512KiB response and5s client deadlines.
Close drains admitted host requests, not arbitrary worker tasks. A disconnected/failed reply is unknown;
never retry an action automatically. Resource/experiment owners retain their own lifetime/drain duties.
Blocking filesystem I/O, hostile same-UID actors, deployed privacy consent, authenticated modules/humans,
arbitrary TUI targeting and real model/provider qualification remain distinct B/C limits.

## Ordinary retention opt-in

Set `PI_GRANTS_RETAIN_NATIVE_SESSIONS=1` and an existing canonical private `PI_GRANTS_NATIVE_SESSION_ROOT`
in the ordinary host environment. Shared delegate/all/chain planning allocates a new per-execution directory
and passes its `--session` target into the recorded plan; model tool parameters cannot choose the path.
Invalid/reused/nonprivate targets refuse. Default children remain ephemeral. Existing asynchronous retention
captures available native bytes at the same execution seam; it does not create observer session entries,
claim final-source completeness, or infer an active TUI branch from a file tail.
