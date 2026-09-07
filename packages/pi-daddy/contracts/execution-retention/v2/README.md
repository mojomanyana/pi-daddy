# Execution retention 2.0 — committed producer input for P03

This version replaces the **wire semantics**, not the authority model, of the Sept7 1.0 candidate.
The old v1 document and all prior receipts remain historical. Ledger v2/v3 and work-v4 are unchanged.
Formal acceptance and independent overall review remain pending; fixture validity is not live qualification.

## Public contract and reproducibility

- API: `pi-daddy/execution-retention` (also the package root).
- Strict JSON Schema: `pi-daddy/contracts/execution-retention/v2/manifest.schema.json`.
- Six standalone manifest fixtures and their exact referenced blob bytes:
  `pi-daddy/contracts/execution-retention/v2/fixtures/*`.
- Source-owned schema, closed/frozen builder, exact integer/duplicate-aware JSON reader:
  `src/retention-contract.ts`, exported as `RETENTION_SCHEMA`, `buildExecutionRetentionManifest`,
  `parseExecutionRetentionManifest`.
- Source-owned generator: `scripts/generate-retention-contract.ts`. No import-time writes or default target.

From the repository root, with retained Node/dependencies (no package manager or lifecycle):

```sh
node packages/pi-daddy/scripts/generate-retention-contract.ts --check packages/pi-daddy/contracts/execution-retention/v2
node packages/pi-daddy/scripts/generate-retention-contract.ts --write /absolute/new-parent/fresh-output
node --test packages/pi-daddy/test/retention-contract.test.ts packages/pi-daddy/test/native-session-retention.test.ts
```

The write target must not exist and its parent must exist. `--check` is read-only and checks the complete
fixture inventory, not just known files. Each fixture is built with the same producer wire builder and
native-byte parser as runtime output; all declarations are deterministic synthetic examples, **not**
provider/native-issued receipts. Two fixtures deliberately share identical transcript bytes but have
different branch knowledge. Exact bytes alone cannot tell an external reader which branch is active.

## Activation and supported native routes

`PI_GRANTS_EXECUTION_ARCHIVE=/private/archive` still opts in to asynchronous output/receipt retention.
Native **file content** additionally needs `PI_GRANTS_NATIVE_SESSION_ROOT=/private/native-sessions`.
That root must be an absolute, owner-private directory (0700); admitted files must be owned regular
single-link `.jsonl` files within its canonical boundary. Symlink files/outside targets, missing headers,
wrong expected session IDs and arbitrary non-session files are refused. No directory scan, auth read,
parent-transcript traversal, session migration or rewrite occurs. A native file's ordinary 0644 mode is
acceptable behind the checked private root; this is not hostile-filesystem race containment.

Existing governed launch paths now consume:

1. **Herdr 0.8.2 protocol 20 `AgentInfo.agent_session`**, from already-required `agent start/get` replies.
   The exact started pane ID and `agent:"pi"` must match. `kind:"id"` records that native session ID with
   missing transcript bytes. `kind:"path"` locates a private session file; the ID is read from its valid
   v3 header, never inferred from the pathname, pane, PID, terminal output or logical name. The reference's
   integration source is observation provenance, not work authority. No additional Herdr RPC is issued.
2. **Explicit pi `--session` files** on an already-governed process plan. Argv is only a locator, not proof:
   the asynchronous reader must actually open stable private bytes and validate the native header before
   publishing an ID. Start/end observations are coalesced, so missing early files can become available.
   The default `--no-session` behavior is deliberately unchanged; archive activation does not enable
   persistence or alter a worker's control/error behavior.
3. **The public read-only pi `SessionManager` API**, when a host actually owns that native manager:
   `retention.observeSessionManager(manager)` or `readNativeSession({source:"pi-session-manager", manager,
   path:manager.getSessionFile(), allowedRoot})`. The reader samples `getSessionId/getSessionFile/getLeafId`
   before/after the descriptor read and requires the leaf's complete parent chain in the retained bytes.
   This supplies an observed leaf (including an observed null after `resetLeaf`), not a guessed file tail.
   An in-memory manager has no retained file on this route and remains explicitly missing.

**Exact unsupported routes:** default ephemeral process children have no session-file bytes. Current
print-mode/interactive Herdr launch seams do not expose a live child `SessionManager`. Herdr protocol 20
session references contain no leaf. Pi 0.84.2 `branch()`/`resetLeaf()` change only its in-memory pointer,
so reopening a JSONL file reports the last appended entry, not necessarily the live active branch.
Consequently **file-only and Herdr-only active branches stay unknown**, even when transcript bytes are
retained. Pi RPC `get_entries` does expose `leafId`, but replacing the current governed print/interactive
executor with a new RPC control protocol is not implemented or claimed here. No monitoring extension,
injected status prompt, additional worker turn, or model call is used to bridge these gaps.

## Version 2 fields and authority separation

The wire remains a small `manifest.json` with relative content-addressed blob basenames, plus LF.
It is replaced atomically after all referenced bytes are written. Every generation passes the strict
producer builder before publication. There is no fsync or full-process-crash durability promise.

The v1 identity, terminal outcome, content reference and observation-only fields remain, with these
**explicitly versioned** changes:

- `version` is `2.0`; the v2 reader rejects `1.0` rather than silently interpreting it as v2.
- New required `nativeSession`: source, status, session ID/path, `parentSessionPath`, branch state/leaf,
  last persisted entry ID, byte digest and a reason. No parent file is read from the header pointer.
- `native.sessionId/sessionPath/branchLeafId` are checked display projections of that observation.
  Callers cannot inject these through the PID/pane display setter.
- `content.session` now refers to actual retained native bytes when available. A valid header followed
  by a partial/invalid tail may still have retained bytes, but its status is `truncated`/`invalid`, and
  no active branch is promoted. Bad or mismatched headers do not admit bytes.
- `nativeSession.status:"verified"` means stable private native-format bytes passed header/tree checks.
  It is **not authentication**, successful execution, accepted work, or proof the active branch is known.
- `branchState:"observed"` is possible only on a matching live manager observation; `unknown` always
  has a null leaf. `lastPersistedEntryId` is separately labelled and never elected as active.
- The first native session ID and opened inode pin that observation. Replacement/mismatch clears the
  current reference/branch, records a gap and leaves previously written blob bytes intact.

Public call IDs come from the actual tool execute argument on delegate/all/chain, not output labels.
Execution IDs/parent execution IDs remain separate from native session parent pointers. Two concurrent
calls with the same logical name do not share attempts, sessions or archive directories. Terminal outcome
and check receipts are never acceptance authority. Every manifest keeps `acceptance:"not-assessed"` and
`coverage.complete:false`. P03 must independently reconstruct P01 authority before claiming accepted work.

## Bounds, interruption and consumer obligations

At most 32 archive observations are active. Stream/snapshot bytes share 1 MiB; assembled result, complete
check receipt and native-session bytes each have their own 1 MiB ceiling. A single native read is active
per observation, with one coalesced latest request; there is no growing read queue or polling timer.
Worker control never awaits these reads/writes. External `flush()` waits at quiescence only, with a host-
owned timeout. Archive admission/write loss, missing/truncated/changed native state, and initial coverage
gaps remain explicit. Loss strings are historical observations, not a recomputed assurance score.

An interrupted worker retains available output/check/session bytes already observed; a producer-process
crash may leave only a running checkpoint. That must stay incomplete. A successful tool return can have
pending archive writes; failed required provisioning/lease/check ledger receipts retain their existing
failure semantics. Receipt bytes available before a mandatory append failure do not turn that failure
into success. No receipt is partially published as a complete receipt.

The archive never harvests environment or auth state. Raw worker/session content can itself contain
sensitive data: explicit private-root consent and an access-controlled external archive are required;
no universal secret-redaction guarantee is made.

A public consumer must validate the manifest, enforce basename/size limits, then verify **actual bytes**:

```js
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseExecutionRetentionManifest, verifyRetainedBytes } from 'pi-daddy/execution-retention';
const manifest = parseExecutionRetentionManifest(await readFile(manifestPath, 'utf8'));
const reference = manifest.content.session;
let bytes;
if (reference.path) {
  try { bytes = await readFile(join(dirname(manifestPath), reference.path)); } catch { /* missing */ }
}
const retained = verifyRetainedBytes(reference, bytes); // retained | missing | mismatch
// A path/digest/status alone returns missing. Even verified retained bytes are not accepted work.
```

Use bounded reads in an untrusted archive. Installed/compiled consumption needs a fresh build; historical
owner `dist` was preserved, not reused as proof of the new API. The native tests invoke real installed
SessionManager persistence/navigation without creating an AgentSession or model runtime; Herdr tests use
schema-shaped deterministic replies. Neither is live pi/Herdr/model qualification.
