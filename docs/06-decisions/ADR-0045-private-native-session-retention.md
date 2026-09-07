# ADR-0045 — Private native session retention is observation, not authority

Date: 2026-09-08 (local implementation batch)
Status: Implemented candidate; independent overall review and formal acceptance pending

## Decision

Publish execution-retention wire version 2.0 rather than changing the Sept7 1.0 semantics in place.
Consume native Herdr 0.8.2 protocol 20 session references on existing governed start/get paths, and admit
bounded private pi v3 session bytes only after actual header, descriptor and parent-link checks. Keep
public tool-call identity and execution parentage independent of logical names/native session pointers.
A live pi SessionManager observer may retain its checked active leaf; file-only readers cannot infer it.

`PI_GRANTS_EXECUTION_ARCHIVE` remains optional. Native file reads additionally require an owner-private
`PI_GRANTS_NATIVE_SESSION_ROOT`. No session/auth directory scan, native rewrite/migration, auth harvesting,
monitoring extension, injected status prompt or extra worker/model turn is added. Observation I/O is queued
and coalesced, never awaited by worker control. Mandatory control receipt failures still fail as before.

## Evidence and limits

The installed pi 0.84.2 SessionManager exposes getSessionId/getSessionFile/getLeafId. Its branch/resetLeaf
operations do not persist a leaf pointer; ordinary tests exercise this with real native file writes and
navigation, without creating a model runtime. Herdr's bundled protocol 20 schema exposes agent_session
as an id/path reference, not an active leaf. Tests of Herdr transport are synthetic, not live qualification.

Default --no-session process children still have no persistent transcript. Print/interactive executor
paths do not expose a live child SessionManager; file/Herdr-only branches stay unknown. A new RPC executor
could expose get_entries.leafId, but no such executor/control change is implemented or claimed here.
Raw session/output text can contain sensitive data authored by workers; private opt-in archival is not
universal redaction or hostile-filesystem containment. No retention record establishes accepted work.

The source-owned strict schema, frozen builders, complete deterministic manifest/blob fixtures and direct
Node generator/check are published under packages/pi-daddy/contracts/execution-retention/v2. Historical
v1 documentation, raw sessions, evidence, compiled output and dependencies remain unchanged. Local source
commits are authorized for this batch; no release, push, PR or external publication is authorized.
