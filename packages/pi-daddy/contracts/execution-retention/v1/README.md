# Execution retention 1.0 — producer contract for P03

Opt-in candidate API: `pi-daddy/execution-retention` (also the root export). This is a new archive
manifest, **not** ledger v3/v4, a check-receipt schema revision, or acceptance authority. The TypeScript
wire definition is `src/execution-retention.ts::ExecutionRetentionManifest`.

## Activation and actual wiring

The operator sets `PI_GRANTS_EXECUTION_ARCHIVE` to an absolute, private, operator-owned archive directory.
No model-facing parameter is added. `delegate`, `delegate_all` and `delegate_chain` carry the actual
public execute call ID into their shared governed executor. Each launch has its existing unique
execution ID and parent execution ID; logical child names are NOT join keys. `runNamedCheck` uses the
same retention writer and also accepts host `retentionDirectory` and `toolCallId` options. Unknown check
parentage stays null. No correlation claim supplies any of these identities.

The archive is asynchronous observation. Required provisioning/lease/check ledger writes retain their
previous failure semantics; archive publication is never awaited on the worker path. No extra worker
turn, prompt, message, extension or Herdr RPC is introduced. Herdr observation reuses existing reads.
Absent configuration disables archival without changing spawn argv or granting any authority.

## Directory and wire contract

Each admitted observation gets a random archive ID, independent of the logical name and execution ID:

```
<operator-directory>/<archiveId>/manifest.json
<operator-directory>/<archiveId>/<kind>-<sha256>.bin
```

The manifest is a small JSON object plus LF, atomically renamed from `manifest.pending`. Blob paths
are relative basenames. Existing blobs are not overwritten; unexpected pre-existing blobs fail the
observation. Completed generations remain readable while a new checkpoint publishes. Superseded blob
files are retained, not deleted. External archival owns retention duration and garbage collection.

- `version`: exactly `1.0`; reject unknown versions.
- `identity`: execution/parent/child/public-call identity; executor; task, definition and configuration
  digests; resolved workspace ID. Configuration hashes the exact plan argv/effective grant/timeout, or
  the check's explicit executable/argv/access/bounds. It does **not** dump environment or credentials.
  Task/definition/configuration digests are pins, **not retained instruction bytes**.
- `native`: actual process PID or actual Herdr pane/tab/launch name. Session ID and branch leaf are null
  in this slice. An explicitly supplied `--session` path can be recorded, but does not prove existence.
- `state`: `running` checkpoint or `terminal`; no terminal manifest means observation is incomplete.
- `outcome`: nullable numeric exit code and signal, timeout/abort/truncation/failure flags. A check whose
  control record fails can have child exit code 0 and `failed:true`; its required receipt failure still throws.
- `content`: `stdout`, `stderr`, `paneSnapshot`, `result`, `checkReceipt`, `session`. Every member is either
  `{status:"missing",path:null,sha256:null,bytes:null}` or
  `{status:"retained",path:<basename>,sha256:<hex>,bytes:<length>}`. `retained` means the producer wrote those
  exact bytes before publishing that checkpoint, **not** that an external archive still possesses them.
- `coverage`: `complete:false` and explicit loss reasons. This slice never claims evidence completeness.
- `acceptance`: always `not-assessed`. No receipt, tool result, terminal outcome or digest implies acceptance.

`stdout`/`stderr` are separate raw bytes, including available structured JSON output, not parsed into
trusted facts. Their cross-stream interleaving is not reconstructed. `result` is the exact executor's
assembled UTF-8 result before delegation display trimming; for checks its digest matches the returned
receipt's `output_sha256`. `paneSnapshot` replaces prior snapshots and is not a session transcript.
`checkReceipt` contains **the complete JSON serialization of the actual CheckReceipt plus LF**, including
all fields, not just `receipt_id`. Available receipt bytes survive later required ledger failure; that
failure still rejects the check. Absent receipt content stays missing.

## Bounds, loss, and privacy

At most 32 admitted observations are active. Each buffers at most 1 MiB of stream/snapshot data,
plus separate 1 MiB allowances for an indivisible result and an indivisible receipt. Oversize receipts
or results are missing, never represented by partial retained bytes. Streams may drop with explicit
loss reasons. Checkpoints coalesce; this is not an unbounded event queue. Archive errors become `lost`;
returned tool details may still say `pending` when publication has not completed. Treat pending,
missing files, invalid hashes, running-only checkpoints and all coverage gaps as incomplete, not success.
A whole producer-process crash can prevent final publication; this is not an fsync/crash-durability promise.
External hosts may call `flush()` at quiescence with their own timeout; worker control never does so.

No auth files, ambient environment dump, task text, monitoring state, or native transcript directory is
harvested. Retained output is untrusted and **can itself contain secrets printed by a worker**; no general
secret-redaction claim is made. Opt in only at an access-controlled harness archive boundary with an
appropriate content-handling policy. This is not malicious-filesystem race containment.

## Explicit prerequisite gap

Existing governed plans normally use `--no-session`. Existing Herdr replies used here expose pane/tab
identity, not a verified pi session ID, session file, or active branch. This slice does not change that
privacy/control default, read auth/session directories, invent a session join, or infer branch identity
from output. Therefore native session/transcript retention and verified session/branch TUI joins remain
**missing** pending a separately agreed native identity/session-export seam. P03 must not treat pane ID,
logical name, process PID, a requested session path, or output-shaped labels as that seam.

## Public consumer example

After a fresh build (the owner's historical dist is NOT current compiled proof):

```js
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { verifyRetainedBytes } from 'pi-daddy/execution-retention';

const m = JSON.parse(await readFile(manifestPath, 'utf8'));
if (m.version !== '1.0') throw Error('unsupported retention version');
const ref = m.content.checkReceipt;
let bytes;
if (ref.status === 'retained' && /^checkReceipt-[a-f0-9]{64}\.bin$/.test(ref.path)) {
  try { bytes = await readFile(join(dirname(manifestPath), ref.path)); } catch { /* missing */ }
}
const observed = verifyRetainedBytes(ref, bytes); // retained | missing | mismatch
// Even retained + terminal is NOT accepted work. Reconstruct independent P01 authority separately.
```

Apply archive size/path policies before reading untrusted manifests/blobs; never follow arbitrary paths.
`test/execution-retention.test.ts` supplies ordinary producer/consumer fixtures: real credential-free
fixture processes through public concurrent tools, interrupted structured bytes, complete real check
receipt generation with a **synthetic Git identity transport**, and deterministic Herdr replies. These
are not real pi/model/Herdr integration, real Git candidate assurance, installed smoke or formal acceptance.
