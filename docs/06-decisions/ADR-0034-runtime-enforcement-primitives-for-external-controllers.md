# ADR-0034: runtime enforcement primitives for external controllers

**Date:** 2026-08-19
**Status:** Accepted (implementation owner mandate; upstream contract pinned below)
**Driver:** `principal-pi-skills` PR #31 critical-assurance handoff; R-86…R-89; ADR-0008,
ADR-0012, ADR-0014, ADR-0018, ADR-0021, ADR-0022 and ADR-0026.

## Context

An external workflow controller needs to join its run/task/workspace state to pi-daddy's capability
records, bind a gated approval to one exact delegation, coordinate a single governed writer per
workspace, and run named checks without handing a verifier an unrestricted shell. These are generic
runtime properties. The controller's assurance profiles, role names and state machine do not belong in
pi-daddy.

The immutable integration input is `principal-pi-skills` PR #31 head
`961f8ccbdb2a12e92db1e1b2d4ab7ca50f9d7d21`. On 2026-08-19 GitHub reported its `spec-lint` check
**SUCCESS**, and the PR head was still exactly that SHA. The contract uses schema version `1.0`, opaque
assurance sources `default|flag|alias|natural-language|policy|user|user-downgrade`, a structured scope,
RFC 3339 `activated_at`, exact candidate `tree_sha`, and sequence freshness floors. pi-daddy preserves
those values for correlation and does not interpret them.

Five existing boundaries constrain the implementation:

1. Capability authority remains
   `effective = (requested ∩ parentGrant ∩ ceiling) \ (gated \ approved)`. Correlation cannot grant.
2. `allowed-tools` is a ceiling. An absent declaration is NONE.
3. pi-daddy governs tools, not paths. `WRITER_ROOT` can be validated as an initial CWD, never confined.
4. `bash` can escape governance (ADR-0012). A lease cannot stop it or any unrelated process from writing.
5. Existing callers provide no correlation or workspace data. Their behavior must remain unchanged.

Approvals already pin a definition's ceiling and body digest, carry their subject across boundaries,
expire persisted entries after 30 days, consume `once` exactly once under concurrency, and refuse late
approval after the call lifetime (ADR-0026). Missing are exact task/request/effective-grant and optional
workspace/context/parent bindings. ADR-0021 forbids storing task text *or a task hash*. The new requirement
makes the hash necessary, so this ADR narrows that decision: task **text remains forbidden**, while an
internally-computed SHA-256 may be stored as an identity with the privacy limit stated.

## Options considered

### Option 1 — process-local maps and locks

Keep correlation and approvals in memory and use a `Map<workspace, owner>` for writers.

**Buys:** the smallest implementation and no platform dependency. **Costs:** separate pi processes can both
be writers, SIGKILL leaks ownership, and parent failure has no recovery story. It misses the scenario that
forced the feature and is rejected.

### Option 2 — reuse the existing mtime-stale file lock

Use `withFileLock` for the full child lifetime.

**Buys:** no new mechanism. **Costs:** it deliberately transfers ownership after ten seconds without checking
liveness. A valid ten-minute child, stopped process, laptop suspend or debugger pause would therefore admit
a second writer. That behavior is acceptable only for sub-100ms ledger/store writes and is unsafe for a
workspace lease. Rejected.

### Option 3 — kernel-held writer lease, opaque correlation, and a no-shell check subpath (chosen)

Use util-linux `flock` held by a helper process whose stdin is owned by the parent. The kernel releases the
lock when the helper exits; parent death closes the pipe, and the helper stops the attached process or herdr
tab before releasing. Token-checked metadata distinguishes clean release from recovery of an owner that died.
Read-only children take no exclusive lock; writers for one canonical root contend on
the same lock, independent of model-chosen workspace IDs.

Add optional correlation and workspace inputs to governed delegation. Internally compute the task,
requested-capability and effective-capability digests; keep external digest-looking fields under an
explicitly non-authoritative correlation object. A caller's read/write label cannot lower coordination below
what its requested tools require. New approval bindings are exact and non-inheritable;
legacy unbound approval behavior remains only for calls that provide no new binding context.

Add a purpose-specific library subpath for named checks. Operator-owned definitions contain an absolute
executable and argv array. The runner uses `spawn` directly, a validated initial workspace, a sensitive-name
filter plus explicit environment allowlist, timeout/output bounds, and a receipt over executable, argv, cwd,
timing, exit/signal, output digest, and Git head/candidate tree computed with a temporary index and verified
again after execution under an exclusive coordination lease. The exact hashed executable bytes are staged
privately and executed. It is not a model-facing arbitrary-command interface.

**Buys:** same-workspace writer exclusion survives process boundaries; kernel cleanup handles SIGTERM,
SIGKILL and parent failure; the check seam avoids shell parsing; all artifacts join by external IDs without
making those IDs authority. **Costs:** writer leases require a measured `flock` implementation and fail
closed where it is unavailable; task hashes permit dictionary guessing of low-entropy tasks; the ledger
needs a versioned event union; check executables remain arbitrary code.

## Decision

Choose Option 3.

- Correlation is optional, copied verbatim as bounded JSON metadata, and never consulted for capability
  resolution. The planner separately records trusted digests it computes itself.
- A bound approval covers the effective definition/body, exact task, requested/effective capability sets,
  optional workspace/context IDs, and parent delegation ID. It cannot cross a delegation boundary. `once`
  remains a one-use approval; persisted approvals retain an explicit expiry. Legacy calls without binding
  context retain the current key/scopes for compatibility.
- Workspace IDs resolve through an operator-owned registry. The registered root is realpathed, verified as
  a Git-registered worktree, used as the initial CWD, and keyed by canonical root for writer exclusion.
- The writer lease coordinates **pi-daddy-governed children only**. It is not a filesystem lock, sandbox,
  proof of prompt compliance, or implementation of another controller's `writer` field.
- The check runner accepts a named ID only. It performs no shell interpolation and claims no network or
  filesystem isolation unless a future implementation supplies and records an actual OS sandbox.
- Ledger format v2 is an append-only event union: capability decision, workspace lease, child lifecycle and
  check receipt. The reader keeps accepting legacy grant records. The ledger says what authority was
  granted/refused and what process outcome was observed; it never says an external assurance gate passed.
- Stable refusal codes accompany, rather than replace, existing human diagnostics. The upstream token
  `BLOCKED_CRITICAL_ASSURANCE` is metadata/output owned by the controller and must pass through unchanged.

## Consequences

**Positive**

- Same canonical workspace means at most one governed writer before spawn; different roots remain
  concurrent.
- Crash recovery is an observed kernel-lock fact rather than an age guess.
- Candidate tree and committed head remain separate join fields.
- Existing callers that omit the new fields keep their current grants, CWD and approval behavior.
- No principal-pi-skills role/profile/event vocabulary enters pi-daddy policy.

**Negative**

- util-linux `flock` is a platform requirement for write leases, and `setpriv --pdeathsig` couples writer
  subprocess/check death to the parent. Unsupported or ambiguous state refuses rather than silently falling
  back to an in-memory lock or uncoupled process.
- A task digest is linkable and susceptible to guessing. The ledger must never add task text, arguments or
  results, and operators should treat the digest as sensitive metadata rather than anonymization.
- A process started without a shell can itself invoke one; package-manager lifecycle scripts and arbitrary
  test binaries remain arbitrary code.
- Lifecycle/release records can be absent after abrupt death; the next successful acquisition records
  recovery. Detecting a lost final tail still requires an external ledger anchor, as before.

**Deliberate non-goals**

- Path confinement, prevention of writes by unrelated processes, containment of `bash`, network isolation,
  and interpretation/enforcement of external assurance profiles or gates.

## Revisit trigger

- pi or Node exposes a portable native advisory-lock API: replace the helper while preserving the lease
  contract.
- A supported platform lacks `flock` and has a measured workload needing writer leases: decide a native
  adapter rather than weakening to mtime or memory.
- A low-entropy task is recovered from its ledger digest: move task identity to a keyed digest supplied by a
  trusted controller, with key management decided separately.
- A check requires real filesystem/network containment: add an OS-sandbox executor and record the sandbox
  identity; do not widen the meaning of the current receipt.

---

## Amendment, 2026-08-20 — six independent reviewers over the unmerged candidate

Rule 2: this is appended, and nothing above it is edited. What follows is what became **untrue**, what was
**over-claimed**, and what this ADR now additionally decides. The register entries are R-99…R-118.

### The invariant held

Every reviewer that looked for it confirmed `effective = (requested ∩ parentGrant ∩ ceiling) \ (gated \
approved)` on every path they could construct: correlation never reaches `resolve()`, bound approvals never
reach `ENV_APPROVED`, write access is derived from the trusted requested set rather than the caller's label,
and the approval layer carries an independent binding-equality backstop. No fail-open was found in capability
authority. Everything below is about the *runtime* half.

### What became untrue

**"Crash cleanup … before releasing flock" understated what teardown had to kill.** `flock` is not passed
`--close`, so the command it execs **inherits the lock file descriptor** and holds the lock in its own right —
measured in `docs/probes/g35-flock-fd-inheritance`, which was written because two reviewers reached opposite
conclusions and both said they had measured it. Killing the wrapper released nothing. The holder now runs in
its own process group and teardown kills the group. Decided additionally: **cleanup never throws.**
`release()` returns `released | released-unrecorded | lost`, because every caller runs it from a `finally`
and a throwing cleanup destroyed a completed child's entire output (R-99).

**"Token-checked metadata distinguishes clean release from recovery of an owner that died" was true of the
code and false of the evidence.** An unreadable predecessor record read as "no crash", and a swallowed
release write left `state: "active"` so the next owner recorded a crash that never happened. Decided
additionally: an unreadable record is `recovered: "unknown"`, never `false`, and "recorded" means this owner
wrote its own handover (R-100).

**"The helper stops the attached process or herdr tab before releasing" licensed a loop that never
released.** `herdr tab close` was retried forever while holding the lock. Decided additionally: the retry is
**bounded** and then releases anyway with a marker file. An unreleasable lock strands a worktree with no
in-product recovery, which is worse than a recorded failure to close (R-102).

**"Correlation is … never consulted for capability resolution" was true; "never confers authority" was
narrower than the code.** Two of the binding's six identity components — `workspace_id` and `context_id` —
were read out of caller-supplied correlation into what this ADR calls the trusted scope, so a bound approval
could be spent in a workspace the child never entered. Decided additionally: the binding takes **trusted
values only** and does not accept a `CorrelationMetadata`; scope follows the routing spec, which is
registry-resolved and leased before any human is asked. `context_id` remains, documented as a caller-declared
label that narrows only (R-110).

**"Copied verbatim as bounded JSON metadata" was not a bound.** No key whitelist, no per-field limit,
`assurance_scope` declared `Type.Any()`, and `correlation` is a model-facing parameter on all three
delegation tools — so a model could write 32 KB of arbitrary text into the append-only ledger, against this
ADR's own "the ledger must never add task text, arguments or results". Decided additionally: **a whitelist of
the pinned schema 1.0 field set**, each string bounded, `assurance_scope` bounded separately, and an
undeclared key **refused by name** rather than dropped. If upstream adds a field, an actionable break beats a
silent secrets sink (R-111).

**"Stable refusal codes accompany … existing human diagnostics" was two-thirds true.** No execution-phase
failure carried a code, and five planner refusals carried none — including the `assertNarrowing` violation,
ADR-0011's invariant and the one refusal a controller switching on `error.code` would misclassify as an
internal error (R-107…R-109).

### What this ADR now additionally decides

- **The ledger's outcome vocabulary must not conflate materially different facts.** `lost`, `retained`,
  `uncontended` and `released-unrecorded` are added, because a lease evaporating under a live governed writer
  was recorded identically to an operator pressing stop, a deliberately retained lease was blamed on a crash,
  and a read lease that took no kernel lock was counted as an exclusion (R-103…R-105).
- **A terminal observation is not an authorization record.** The ledger's fail-closed rule is correct for
  `capability_decision`, which *provisions*. It is wrong for `child_lifecycle: completed` and lease-release
  records, which are written after the child has already run — failing closed there prevents nothing and
  discarded paid-for work while blaming "ledger". Those appends are best-effort and **loud**: a non-strict
  append now reports its failure rather than swallowing it, and a teardown failure is reported *alongside*
  the result.
- **The upstream token is honoured only when the child otherwise exited cleanly non-zero.** Matching on text
  alone let a timeout, a cancellation, a lost lease or a truncated answer be reported as a clean upstream
  veto, with the governance-authored reason discarded. A process killed mid-sentence has not been assessed by
  anybody's gate. Pass-through of a genuine token is unchanged (R-106).
- **A refused operation must not leave authority behind — on every path, not the one where it was found.**
  The post-gate ledger-failure denial banked a 30-day approval for a spawn that never happened, which is the
  third appearance of this shape (R-113).

### What this amendment does NOT resolve

Recorded because a review that produced twenty register entries and no open items would be suspicious:

- **Workspace routing does not attenuate.** `PI_GRANTS_WORKSPACE_REGISTRY` is not in `GRANT_ENV_KEYS`, so it
  inherits into every governed child, and `workspace_id` is a model-facing parameter validated against the
  registry with **no check that the caller was authorised for that workspace**. A child routed to `staging`
  can route its grandchild to `prod`. Depth, fan-out, grant, gated and approvals all attenuate; the initial
  working directory does not. This ADR's non-goals cover *path confinement* and say nothing about *which
  registered root a descendant may select*, so it is an unrecorded gap rather than an accepted trade-off.
  **It needs its own decision** — a `workspace:<id>` capability namespace is the obvious shape — and is
  deliberately not decided here.
- **The persisted approval binds text, not state.** The binding omits `run_id`, `head_sha`, `tree_sha` and
  all three sequence freshness floors — the exact fields the controller supplies so that a stale approval
  cannot be replayed. A 30-day entry approved at a reviewed tree is spendable twenty days later at an
  unreviewed one for a byte-identical task. `parent_id` is also not an identity: it is the literal `"d0"` for
  every root session. The mirror case is worse for usability: `delegate_chain` mints a fresh nonce per
  handoff, so a chain step's task digest is unique every run and *Always* can never apply, which is R-25's
  fatigue shape. **Both need a decision about what a 30-day scope may mean when the binding is exact.**
- **The approval dialog discloses three of the six bound components.** An operator approving `tool:bash` for
  "apply the migration" cannot see whether the workspace is `staging` or `prod`. The enforcement got more
  precise and the disclosure did not move.
- **`tree_sha` is not the exact candidate content the SPEC claims.** `git add -A` honours `.gitignore`, so a
  check can write ignored paths, install a `.git/hooks/post-commit`, or modify a submodule's working tree and
  the pre/post comparison still passes. Computing the identity also writes blob objects into the real
  `.git/objects`, so a documented read-only measurement is not read-only.
- **The lock key does not include the lease directory.** Two sessions disagreeing about `PI_CODING_AGENT_DIR`
  — a devcontainer and a host, which the two-step setup makes normal — contend on different files and each
  reports itself the single governed writer.
- **`access: "read"` is nearly unreachable.** Four tool names classify as read-only, so any grant containing
  `tool:delegate`, a `skill:` or an `agent:` id forces a write lease, and read-only fan-out onto one
  workspace self-conflicts. This is a classification problem, not a policy one.
- **R-101** (pid recycling in the helper) and **R-118** (an untested defence-in-depth check) are accepted with
  their reasons in the register.

---

## Second amendment, 2026-08-20 — six reviewers over the FIRST amendment's own fixes

Appended, nothing above edited. The register entries are R-119…R-129.

**The invariant held a third time.** No reviewer could construct a path where correlation, a binding or a
workspace label widens `effective`.

**What the first amendment decided and the code did not do.** Three of its four new decisions were true of
the comments and false of the code when written:

- *"A terminal observation is not an authorization record… those appends are best-effort and loud"* — the
  terminal `child_lifecycle` append was still `strict: true`, so a contended lock still destroyed a
  completed child's output (R-119).
- *"a non-strict append now reports its failure rather than swallowing it"* — the mechanism that makes that
  possible was wired to two empty callbacks, one guarding the evidence record itself (R-120).
- *"A refused operation must not leave authority behind — on every path"* — the take-back was gated on one
  path, and a human declining the second of two gated capabilities strands a 30-day approval with no fault
  at all (R-121).

All three are now code rather than prose, each pinned by a test that fails when the guard is removed.

**One decision is narrowed.** The first amendment made truncation disqualify the upstream token. That was
wrong: the process executor keeps the HEAD of the output and the token is matched at byte 0, so a genuine
veto with a long rationale is still a genuine veto, and rejecting it broke the pass-through this ADR pins.
Only a child that never finished speaking — killed, cancelled, or never started — is disqualified (R-122).

**One decision is added.** `release()` is memoized and its outcome union distinguishes the alarm (nobody
recorded the handover) from the healthy case (a successor owns the record) and from a read lease that never
locked. Conflating them meant the one value requiring action was indistinguishable from two that do not
(R-126).

### What this amendment does NOT resolve

The first amendment's unresolved list stands unchanged — workspace routing still does not attenuate, a
persisted binding still pins text rather than tree state, the dialog still discloses three of six bound
components, `tree_sha` is still blind to ignored paths, and the lease key still omits the lease directory.
Added to it:

- **`assurance_scope` is exempt from the per-field bound** and copied verbatim with no inner validation, so
  roughly 14 KB of caller-authored text still reaches every event. R-111 was narrowed 8×, not closed, and
  no document said so until now.
- **`schema_version` is never compared to `"1.0"`.** The field naming the pinned schema is unvalidated while
  unknown fields are fatal, so an upstream 1.1 breaks on a field name rather than on the version — the
  actionable message was available for free. A third option nobody weighed: refuse by version, and record
  dropped keys rather than refusing them.
- **The fan-out infrastructure `catch` is unreachable from the wiring layer**, so R-97's regression claim is
  corrected a second time rather than satisfied (R-127). The test written for it was deleted rather than
  weakened until it passed.
- **Two runtime value-import cycles** now exist among the split modules, safe only because nothing reads a
  cross-module binding at module-evaluation time — a condition a future top-level `const` would violate with
  a `ReferenceError` no test covers.
- **The audit this all rests on has no artifact** (R-129). Rule 5 would park a 17-mutation measurement under
  `docs/probes/`; R-127 is what its absence costs.

**The lesson worth carrying, stated plainly because it has now happened on both sides of a review:** a claim
written beside a fix is not the fix. Every critical finding in this round was a comment, a SPEC paragraph or
an ADR sentence that described an intention as an accomplished fact. The mechanical guards this project
already trusts — the line ceiling, the branch guard, the refusal enumeration — are the ones that never had
this failure.

---

## Third amendment, 2026-08-20 — the v2 wire contract becomes a packaged artifact

PR #9 merged and tagged the implementation while the only complete description of a v2 JSONL line remained
TypeScript plus prose. An external skill harness would therefore have to duplicate the event union and guess
at optionality, nested approval/refusal shapes and nullability — creating the parallel contract this project
already rejects for governance rules.

Decided additionally:

- The next authorized package release will ship a closed JSON Schema draft 2020-12 union at the versioned
  public path `pi-daddy/contracts/ledger/v2/ledger-event.schema.json` and one deterministic fixture per event under the
  adjacent `fixtures/` path.
- Fixtures are generated through the real `buildRecord`, workspace-lease, child-lifecycle and check-receipt
  builders. A test compares checked-in artifacts to fresh builder output, and installed-package smoke imports
  the schema and every fixture.
- A line with no version/event discriminator remains the legacy 0.17 `GrantRecord`. Once a line explicitly
  names a version it is never eligible for that fallback: version 2 must validate as a known event and every
  unsupported explicit version fails closed. pi-daddy's reader enforces that dispatch boundary and required
  join fields; full nested validation belongs to consumers of the schema.
- The v2 schema is frozen as a closed contract. Adding/removing a field, event or enum member, changing
  requiredness, or changing a field's meaning requires a new ledger version and a new versioned artifact
  path. Documentation-only clarification and additional examples may remain within the path when they do not
  change which records validate.

**Cost:** this turns previously published TypeScript behavior into an explicit public compatibility
obligation. The artifact itself is new public API and therefore needs a patch-versus-minor release decision;
this amendment does not choose or apply a package version.

**Not resolved:** every limitation listed by the two amendments above remains — workspace routing does not
attenuate; persisted approvals do not bind head/tree/freshness; the operator dialog is incomplete; candidate
identity omits ignored and Git-internal state; lease identity omits the lease directory; `assurance_scope`
and `schema_version` remain under-validated; access classification remains conservative; and the runtime
module cycles remain. Publishing their wire representation is not repairing them.
