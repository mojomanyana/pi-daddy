# Handoff — principal-pi-skills v3 assurance to pi-daddy 0.18

**Contract pin:** `mojomanyana/principal-pi-skills` PR #31 head
`961f8ccbdb2a12e92db1e1b2d4ab7ca50f9d7d21`  
**Verified:** 2026-08-19, GitHub `spec-lint` check `SUCCESS`; PR head still matched the pin.  
**Do not install unpublished npm `3.0.0`.** Integrate from the pinned source/PR until that project makes a
separate release decision.

pi-daddy does not implement the principal assurance state machine. It supplies generic spawn-time authority,
workspace coordination, process receipts and join fields; the principal controller remains authoritative for
risk, phases, gates, freshness and `BLOCKED_CRITICAL_ASSURANCE`.

## 1. Start the controller and preserve its metadata

Read the controller's `principal-pi-assurance init/show` output from the pinned source. For each governed
spawn, pass its values without translating their meaning:

```json
{
  "correlation": {
    "schema_version": "1.0",
    "run_id": "run-...",
    "task_id": "task-2",
    "workspace_id": "writer-2",
    "context_id": "review-spec-2",
    "phase": "review-specification",
    "assurance_effective": "critical",
    "assurance_source": "natural-language",
    "assurance_scope": {"type":"selectors","selectors":["src/auth/**"]},
    "activated_at": "2026-08-19T20:00:00Z",
    "plan_digest": "...",
    "definition_digest": "...",
    "task_digest": "...",
    "base_sha": "...",
    "head_sha": "...",
    "tree_sha": "...",
    "event_seq": 41,
    "last_change_seq": 30,
    "last_authority_seq": 38
  }
}
```

The source enum remains exactly
`default|flag|alias|natural-language|policy|user|user-downgrade`; scope remains the v1 object; activation is
the controller's RFC 3339 value. pi-daddy copies these as opaque metadata. Its trusted `taskDigest` and
`definitionDigest` fields are computed independently; never treat the values under `correlation` as proof.

## 2. Register worktrees outside the model-facing call

Write an operator/controller-owned registry file:

```json
{
  "version": 1,
  "workspaces": {
    "writer-2": {"path": "/absolute/path/to/the/registered/git-worktree"}
  }
}
```

Then start pi with:

```bash
export PI_GRANTS_WORKSPACE_REGISTRY=/path/to/workspace-registry.json
export PI_GRANTS_WORKSPACE_LEASE_DIR="$PI_CODING_AGENT_DIR/pi-daddy/workspace-leases"
```

The tool call supplies only:

```json
{"workspace":{"workspace_id":"writer-2","access":"write"}}
```

Use `access:"read"` for advisory children whose requested capabilities are known read-only. The label cannot
lower `write`/`edit`/`bash` or an unknown/custom tool: pi-daddy conservatively upgrades those requests to a
writer lease. Genuine reads may coexist; one canonical root has at most one governed writer. A conflict
returns `WORKSPACE_WRITE_CONFLICT` before child process start. Different roots can run in
parallel. The registered root is realpathed, checked against `git worktree list`, and set as initial CWD.
This does **not** confine later paths or exclude unrelated writers. The measured Linux path requires
util-linux `flock` and `setpriv`; missing primitives fail closed. `writer: "build"` in assurance state is
metadata until a real pi-daddy lease is acquired.

## 3. Approval behavior

Supplying correlation/workspace context selects the exact binding path. A gated approval is bound to:

- pi-daddy's computed definition body digest;
- exact task digest;
- requested/effective capability-set digests;
- workspace/context IDs when supplied; and
- parent delegation ID.

It cannot be replayed for another task/definition/workspace/context/parent and does not inherit. `once` is
one-use; persisted approvals retain their explicit 30-day expiry. Existing uncorrelated callers keep the
legacy subject-scoped behavior.

Treat `APPROVAL_EXPIRED` as “ask again” and `APPROVAL_SCOPE_MISMATCH` as “this approval is about another
spawn”; neither permits a downgrade or widening.

## 4. Evidence/check execution

For controller-owned checks, import from the installed pi-daddy package:

```js
import { runNamedCheck } from "pi-daddy/check-runner";
import { resolveWorkspace, loadWorkspaceRegistry } from "pi-daddy/workspace";

const registry = {
  version: 1,
  checks: {
    "unit-full": {
      executable: "/absolute/path/to/node",
      argv: ["--test", "test"],
      inherit_env: ["LANG", "TMPDIR"],
      timeout_ms: 600000,
      max_output_bytes: 1048576,
      workspace_access: "write"
    }
  }
};

const workspaces = await loadWorkspaceRegistry(process.env.PI_GRANTS_WORKSPACE_REGISTRY);
const workspace = await resolveWorkspace(workspaces, "writer-2");
const { receipt, exitCode, output } = await runNamedCheck({
  checkId: "unit-full",
  registry,
  workspace,
  correlation: {
    schema_version: taskPacket.schema_version,
    run_id: taskPacket.run_id,
    task_id: taskPacket.task_id,
    workspace_id: taskPacket.workspace_id,
    plan_digest: taskPacket.plan_digest
  },
  ledgerPath: process.env.PI_GRANTS_LEDGER
});
```

The executable/argv come from operator-owned configuration, never from the model. While holding the check's
exclusive workspace lease, pi-daddy computes `head_sha` and the exact candidate `tree_sha` itself using a
temporary index (`read-tree HEAD`, `add -A`, `write-tree`) and verifies both again after execution. It stages
and executes the exact executable bytes it hashed; configure an interpreter as `executable` and put a
workspace script in `argv` when path-relative executable behavior matters. Supplied head/tree
values may only match; they cannot override the measured identity. Record `receipt_id` in the principal
evidence event or the next spawn's `check_receipt_id`. A new candidate tree creates a different receipt.

The pi-daddy receipt is a runtime receipt, not the principal v1 evidence object. Map its `exit_code`, computed
`head_sha`/`tree_sha`, task/workspace IDs and time into the controller's schema, assign the controller's next
trusted `seq`, and use a stable command label tied to `check_id`/`argv_sha256`. Do not copy the whole task
packet: its schema intentionally has no head/tree fields.

No shell interpolation is used. This is **not** an OS sandbox: the executable or its test code can write,
use the network, invoke a shell, or spawn descendants. Keep raw `bash` gated. If an assurance control needs
network/filesystem isolation, use a real OS sandbox and record that separately; this runner does not imply it.

## 5. Ledger joins

Read `PI_GRANTS_LEDGER` as v2 events and join on correlation IDs plus trusted digests:

- `capability_decision` — requested/effective/denied/gated, definition/task trusted digests, approval
  source/scope, structured refusal;
- `workspace_lease` — acquisition, refusal, release, timeout or crash recovery;
- `child_lifecycle` — starting/completed/failed, executor, exit/signal/timeout/abort/truncation;
- `check_receipt` — receipt/workspace/check/tree identity.

Legacy lines have no `event` and remain capability decisions. The ledger answers what authority was
provisioned or refused and what process outcome was observed. It does not prove a principal gate passed or
that requirements were satisfied.

The principal event vocabulary remains in `scripts/assurance-state.mjs`; do not duplicate it into this
ledger. In particular, Git-Ops completion is persisted only by the controller's `finalization_completed`.

## 6. Blocking contract

Preserve a controller gate failure exactly:

```text
BLOCKED_CRITICAL_ASSURANCE
Missing controls:
- ...
```

and controller CLI exit code 3. Never turn it into a successful inline review, a broader grant, a caller
workspace fallback, or a pi-daddy “allow”. pi-daddy refusal codes are additional runtime facts, not aliases
for the principal gate token.

## 7. skill-harness

skill-harness continues to consume principal-pi-skills' `tests/specification.yaml`, fixtures, objective
assertions and judge output. It should not infer an assurance pass from a pi-daddy ledger line.

For an integration-grade runtime cell, retain these artifacts together:

1. principal run ID/state snapshot and final trusted event sequence/digest;
2. pi-daddy ledger filtered by that `run_id`;
3. check receipt IDs with exact head/tree;
4. skill-harness subject/judge result and model IDs.

Reject publication when a required cell has no measured result or a judge error. Paid/model runs remain a
separate authorization; this repository's implementation and probe use no unpublished package and no model.
