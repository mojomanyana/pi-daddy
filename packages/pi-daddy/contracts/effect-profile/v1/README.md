# P06 local candidate: a fixed digest boundary and durable resource accounting

**Version 1.0, local only; overall review and formal acceptance pending.** This is not a sandbox for pi,
bash, arbitrary JavaScript, model invocations, or writable workspaces. Existing delegation/check behavior
is unchanged. The one supported new operation is `linux-bwrap-digest-v1`: hash at most 16 KiB of byte input
with a fixed trusted worker and return its digest/length on stdout. It is useful for independently checking
small evidence payloads, not executing an arbitrary factory order. Full P06 remains only partially covered.

The unchanged executable guard checks Linux, resolved Node then exact bwrap/prlimit paths, regular-file
type, no group/other write bits, and size<=256MiB. Refusals keep the original error message and add exact
path/details plus RUNTIME_NOT_REGULAR / RUNTIME_WRITABLE / RUNTIME_TOO_LARGE. Independent read-only CI
telemetry observes all prerequisites; conforms:false is not namespace success and does not skip tests.
No installation, shared chmod, runner provisioning or host policy weakening is performed. Actual remote
24.20 predicate remains unknown in the old logs; Node22's missing bwrap remains a provisioning blocker.

## Public API

`pi-daddy/resource-budget`: `createResourceBudget`, `openResourceBudget`, `resourceBindingDigest` and types.
`pi-daddy/effect-profile`: `prepareDigestProfile`, `runDigestProfile`, `DIGEST_PROFILE` and types.
Both are also exported from the root. Historical dist is not a build of these exports.

```ts
const binding = await createResourceBudget({
  directory: '/operator-private/new-budget', // fresh child of a canonical owner-private directory
  authorityDigest: independentlySelectedPolicyDigest,
  limits: { maxAttempts: 8, maxInputBytes: 65536, maxConcurrent: 2 },
});
// Persist this detached/frozen binding in the trusted controller, separately from its journal.
const profile = await prepareDigestProfile(binding); // actual bounded native probes; may reject
const result = await runDigestProfile(profile, {
  attempt: { attemptId: 'exec:unique', orderId: 'order:a', experimentId: 'experiment:b',
    kind: 'primary', parentAttemptId: null },
  bytes: Buffer.from('evidence'),
}, signal);
```

The byte input and identity are detached before asynchronous work. No input is interpreted as code, an
option, path, command, environment, lease store or destination. Byte input is base64-encoded in process
argv; this is **not a secret-transport API**. Worker output is just digest/length, not raw input. The
profile token is process-local and opaque: a JSON roundtrip or receipt-shaped object cannot admit work.
The public producer validator/retention manifest is not an admission capability or work approval.

## Actual boundary and supported/unsupported matrix

| Route/property | Disposition |
| --- | --- |
| Linux bwrap user/mount/PID/network namespace setup | Observed supported on the measured WSL2 host; re-probed per prepared handle |
| Owned outside-file read/write; mutation of owned read-only mount | Actual fixture attempts denied (`ENOENT`, `EROFS`), allowed fixture read succeeds |
| Reach host loopback listener | Actual owned listener remains unreachable from the network namespace |
| Untrusted code / shell / child launch API | Not exposed by this profile; Node permission child-process tripwire also actually denies spawn |
| Worker cancellation | Existing `runChild` signal/deadline path; actual owned namespace worker/helpers observed stopped |
| Cgroup aggregate CPU/memory/PID enforcement | Unsupported: no writable delegated cgroup measured |
| `prlimit` | Per-process CPU/FD tripwire only, not aggregate limits; V8 heap flag is not an OS memory cap |
| Persistent destinations / writable or shared workspace roots / alternative lease stores | Unsupported; absent from the closed API, no host workspace/store mounted |
| Arbitrary pi/bash/model profiles; provider-money hard cap | Unsupported before workload launch; no fallback or inferred/posthoc dollar allowance |

The launcher uses existing `/usr/bin/bwrap`, `/usr/bin/prlimit` and the current trusted Node executable.
It drops capabilities **inside the child**, clears its environment, creates new namespaces and exposes
only read-only system runtime directories plus the fixed Node binary. No host capability configuration,
installation, privilege escalation or service/cgroup configuration changes are performed. The preparation
probe alone mounts a disposable owned read-only fixture; the production worker mounts no user workspace.
The production Node worker has permission mode enabled; Node permission mode by itself is not claimed
as a hostile-JavaScript sandbox. Only fixed package code executes, so ungoverned descendants are not an
admitted operation. Internal Node/helper threads/processes are not separate billable attempts.

The selected binary fingerprints are pinned and rechecked before each workload. The operator/kernel,
trusted package code, runtime installation and control-owned filesystem are the trust boundary. Runtime
updates during an invocation, malicious same-UID host writers, rollback of trusted storage, kernel/runtime
exploits and hostile-process containment are not qualified. Read-only bind mounts do not freeze a host
administrator's runtime files. This route therefore cannot be relabelled a general shared-root sandbox.
No user payload launches merely because executables exist or a caller claims a profile name.

## What is actually reserved

One independently retained `BudgetBinding` pins the canonical private directory and journal device/inode,
external authority digest and closed limits. The budget is **one scope across all orders and experiments**
using that binding, not a new allowance per logical name. A different binding is a different explicit
scope, never proof of sharing an aggregate limit. There is exactly one fixed journal/lock location; the
API offers no alternative lease-store override. Binding/header mismatch or physical replacement fails.

Admission reserves **one cumulative attempt, its full input-byte count, and one active invocation slot**
before the existing execution seam is called. Those are the only aggregate hard counters claimed. A
maximum of 1024 attempts, 16 MiB cumulative inputs and 32 active invocations is configurable downward.
No aggregate CPU, memory, disk, PID or money cap is asserted. Bounded trusted preparation probes are
control/setup work, not admitted user attempts. There are no provider calls or money estimates.

Primary, retry, shadow and explicitly governed descendant attempts all consume allowance; non-primary
attempts require an existing parent reference in the same scope. A duplicate attempt ID is rejected,
including redelivery after completion. Cancellation/failure never refunds attempts or bytes. The live
controller releases only the active slot, after executor settlement; a mandatory settlement failure still
rejects even if the worker exited zero. Existing finalization helpers preserve primary errors.

Reopening preserves all outstanding charges/slots. An exited PID, timeout, new controller, late result or
receipt-shaped data does **not** reclaim an orphan. Only the original live permit can settle its exact
reservation; exact repeated settlement is idempotent and contradictory late settlement rejects. There is
no recovery/reclaim API. Exhausted orphan capacity requires a separately designed, authorized quiescent
reconciliation—not deleting a journal, new lease store, renamed directory or pretending a retry is free.

The private journal is strict bounded JSONL, opened without symlink following, validated against independent
binding/counters, serialized with the existing no-stale-recovery lock, and fsynced before launch. Incomplete
writes fail closed without truncation/repair. A completed append can precede a cleanup error: no exactly-once
blind retry guarantee. Creation is explicit/exclusive; reopening never creates/reset state. This relies on
a trusted durable filesystem and sole cooperative host protocol, not tamper-proof consensus storage.

Opt-in P02 retention records exact attempt/parent IDs, actual raw/result bytes and runtime outcomes. It is
still `not-assessed`, and missing native session/branch fields do not become complete evidence.

## Checks and limitations

Direct Node tests (retained dependencies only):

```sh
node --test packages/pi-daddy/test/resource-budget.test.ts packages/pi-daddy/test/effect-profile.test.ts
```

These native effect tests require the demonstrated Linux/bwrap/Node primitive and deliberately fail rather
than silently count unavailable containment as a passing qualification. Arithmetic tests include real
cross-process contention, duplicate delivery, byte/count exhaustion, cancellation/restart, replaced stores,
partial journals and immutable authority. Native tests use disposable owned fixtures and a local listener,
not provider traffic or an untrusted hostile executable. A forwarding spawn observer verifies zero real
spawn calls for unsupported inputs and a real post-spawn mandatory-accounting failure. No production test
control, guard bypass, model review/test, installation or mutation machinery is introduced.
