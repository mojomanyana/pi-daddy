# Ordinary original-child control v1 — explicit local host integration

Package-root `ordinaryChildrenFor(originalExtensionAPI)` returns the port associated during actual grants
extension factory registration. The original owning bootstrap must retain that object; a copy/name/path
cannot look it up. Call BEFORE ordinary children run. Late opt-in is allowed but permanently labels missed
original lifetimes; empty rows then cannot certify quiescence. Defaults stay untracked/ephemeral unless
separately enabled (native file retention and cancellation capture are distinct opt-ins).

The actual shared execute-child wrapper retains an original AbortController per execution and composes
it with caller and lease signals. It never replaces the caller promise, primary result or existing process/
Herdr timer/close path. No model tool schema exposes this port. No peer process or PID/pane is recovered.
`inspect()` is process-local read-only status, NOT persisted authority or a clean durability acknowledgement.
`quiescent()` additionally refuses unknown ownership, required control failure or unretained history. A
best-effort terminal lifecycle/lease observation failure remains visible as `control:failed` beside the
worker outcome, but does not turn a known-settled child into a permanent execution boundary. A boundary
already known to be unavailable refuses an intent hold before installing it; it never blocks unrelated
ordinary admission while claiming reconciliation could make progress.

Cancellation shape:

```
{ version: "ordinary-cancel-v1", requestId, bindingDigest, expectedRevision,
  target: { executionId, parentExecutionId, toolCallId } }
```

Use actual execution UUIDs and nullable original parent UUID / actual tool-call ID (bounded256 characters),
never logical child position. `ordinaryCancellation` validates/detaches; `ordinaryCancellationDigest` hashes
the closed request. Independently supply `{bindingDigest, requestDigests}`. Approved digest is not inferred
from request shape, worker output or the port's existence. Synchronous CAS precedes original abort; result
`abort-requested` means completion is still owned by the original caller, not certified terminated.
Exact duplicate reads original result without effect or needing new authority. Different bytes under the
same request ID, stale revision, changed target, missing original handle and copied ports refuse.

Opted-in controllers retain up to1024 occurrence records and1024 requests. Capacity is non-refunding;
failed admission uses original workspace finalization. Ordinary successful worker output survives terminal
observation failure, which is separately marked failed. An executor exception remains unknown. Neither
unknown nor full bytes grants retry/recovery permission. Large transport frames may refuse their existing
byte bound rather than truncate a purported complete registry.

Existing dashboard config may ADD `ordinaryDigest: port.bindingDigest`; old configs/hashes remain unchanged.
Pass that original port as `open/createDashboardHost({ordinary:port,...})`. Approval additionally needs
`authority.ordinary`; operation `ordinary-cancel` carries the exact request above through the existing
manual `dashboardHostAction`/socket. The existing host claim/result journal binds request ID/tip/selection
and blocks failed-ack replay. No new persistent cancellation/decision database. Reconnect without the
original port can inspect other retained state but cannot cancel; process restart never restores handles.

For approved intent changes, the existing host additionally takes an original admission hold (at most32,
revision-changing). Busy direction waits in the existing host journal; original children continue. New
ordinary execution refuses at its original admission seam. The hold spans native asynchronous application
and any native resource pending state, and releases only after explicit successful native/host readback.
Unknown/failed host acknowledgement never releases it. This is not an expiry/unlock/recovery API; do not
run an older host writer against a new pending ordinary operation. Guide reconciliation does not mandate
generic entity/topology/opaque-policy editing; those unsupported extensions need concrete scope/semantics.

A failed final host sync can coexist with actual abort, charged effects and a later readable result. The
host stays failed/unknown and duplicate request is readback only. Caller cancellation still works and a
completed fanout sibling remains in the original result. Manual presentation refuses known nonquiescence,
but this does not establish an atomic deployed TUI pause, source completeness, human/module authentication,
P01 acceptance or hostile same-UID confinement. Wider live host association requires separate B/C evidence.
