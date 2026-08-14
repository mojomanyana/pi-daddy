# Changelog — pi-agent-grants

Newest first. **Breaking changes are marked and say what to do about them.**

This file exists because the README had grown ninety lines of stacked version banners before a reader
reached what the package *does* — churn documentation in front of product documentation. The banners are
the record of how the package got here and are worth keeping; they are not worth reading first.

## 0.13.0 — the approvals file gets the lock the ledger already had, and two silences end

Closing the last items that were open rather than out of scope. One breaking change, and it is a type.

- **BREAKING: `revokeApproval` returns `"revoked" | "absent" | "failed" | "busy"`**, not a boolean. It had
  two outcomes for four facts, and `/grants revoke` printed *"no persisted approval named X"* whenever the
  write failed — telling an operator that the approval they are revoking does not exist **while it is still
  in effect**. The most alarming outcome wore the most reassuring message. `busy` is separate because a lock
  timeout happens *before* the load, so nothing was looked at and nothing may be claimed about the entry.
  Callers switching on the boolean must switch on the string; `"revoked"` is the only success.
- **Approval writes hold a lock (R-49).** Every write is load → modify → write and none of them was
  serialised, so session 1 could load, session 2 could revoke, and session 1's next save would restore the
  revoked entry for the rest of its 30 days. The lock is the ledger's, moved to `src/file-lock.ts` and used
  by both — one implementation, two callers, opposite failure policies: the ledger fails a delegation closed
  when it cannot take the lock, the approvals store never fails your work, because it is a convenience cache.
- **`/grants ledger` counts where each approval came from.** ADR-0020 keeps the persistence layer on an
  asserted fatigue argument and named the evidence that would settle it — `persisted` against `prompt` over
  real use. The data was already recorded and nothing read it. **Two numbers, both labelled**: raw records
  are an *upper bound* on prompts avoided, because within one session only the first would have been a
  prompt and the rest come from the in-memory session cache; distinct `capability@subject` pairs are the
  closer estimate. Reporting records alone overstated the layer twentyfold in the obvious case (R-63).
  Records written before per-capability sources existed are reported as *not counted* rather than folded in,
  because that older scalar over-claimed `prompt`.
- **A revoke is documented as taking effect at the next gate check**, not "immediately". A spawn whose gate
  check already passed is not retracted by a revoke arriving microseconds later — inherent to revoking
  anything, and no lock closes it.
- **An unreadable ledger no longer silences session start (R-60).** `verifyLedger` rethrows on anything but
  a missing file, and that call sat inside an empty catch — so a `PI_GRANTS_LEDGER` pointing at a directory
  produced no alarm, no warning, and not even the line saying governance was on.
- **Herdr panes opened by a killed process are closed at exit.** Coverage is exact and documented in
  `src/pane-reaper.ts`: normal exit and `process.exit()` are covered; SIGKILL is not, and neither is a
  SIGTERM nothing else in the process is listening for. **No signal handler is installed**, deliberately —
  one here would suppress Node's default termination and turn pi's "interrupt this turn" into "exit pi".

## 0.11.0 is a breaking change: per-project approvals, and an inherited yes names its instructions

Four decisions taken together after the first independent review of this package's approval layer
(ADR-0020…ADR-0023). Two of them break compatibility.

- **Approvals are stored one file per project**, under `$PI_CODING_AGENT_DIR/grants-approvals/`. The
  single shared file could not express two checkouts holding an approval for a same-named definition —
  `review`, `deploy`, i.e. what happens the moment you reuse your own conventions — and every write
  touched every project's data, which is where four defects came from. **The old file is ignored, not
  migrated**, and reported once; re-approve when next asked.
- **`PI_GRANTS_APPROVED` carries a body digest**: `capability@subject#sha256`. A child verifies it against
  the definition **it** loaded, because a child is a fresh process that re-reads from disk — so a
  `git pull` mid-tree could otherwise let a descendant run rewritten instructions under a yes given about
  the old ones. A 0.10 parent and a 0.11 child do not understand each other's format.
- **The task is never stored.** `taskAtApproval` is gone: it put model-authored text in an always-on file
  outside your repository for 30 days, which this package's own rule forbids — and it displayed as though
  it scoped the approval, which it never did.
- **`agent:*` exists.** "May spawn any of our definitions, but never hand over `write`" was previously
  unexpressible; the only wildcard was `tool:*`, which is authority to grant every tool. `agent:*` confers
  no tool authority. Do not pair it with `tool:bash`.

## 0.9.0 / 0.10.0: an approval is pinned to the *instructions* as well as the tools

**ADR-0018 and ADR-0019.** Two changes, and the second was a repair.

**Every spawn naming a definition now records a `definitionDigest`** — `{name, source, sha256}` over the
body, which is the exact text passed to the child as `--append-system-prompt`. So the ledger answers *"did
these four children run the same instructions?"* and *"has this definition changed since?"*. It does not
answer *what the instructions said*: the digest identifies text without reproducing it. **The task string
is never recorded, in any field, by decision** — it is assembled by the model from the parent's context and
could carry anything the parent could see.

**`always` approvals were unreachable and are not any more.** `offeredScopes` gated that scope on the
interceptor path, which 0.7.0 deleted — so **no version from 0.7.0 to 0.9.0 could create a persisted
approval at all**, and the whole store was guarding a file nothing could write. `delegate({agent: X})` now
approves against **`X`** and offers `always`; `delegate({tools: […]})` keeps the fixed `<delegate>` subject
and is still never offered it. A persisted entry pins the definition's `allowed-tools` **and** its body
digest, so rewriting what a child is told to do voids the approval (`instructions-changed`) — strictly
stronger than ADR-0010 designed, since the ceiling check alone could never have seen a body change. An
entry carrying no body pin fails closed: unverifiable is not unchanged.

## 0.8.0 is a breaking change: spawning a definition requires `agent:<name>`

**ADR-0017.** The catalog has always emitted `agent:<name>` for every definition and the parser has always
accepted it, but **nothing ever checked it** (R-35). The only gate on `delegate({agent: "deploy"})` was
whether that definition's `allowed-tools` fitted inside the session's grant — so governance covered what a
child *can do* and never *which operator-authored instructions it was given*, and an operator could not
say "this session may spawn `review` but not `deploy`".

**What you must change:** an enumerated `PI_GRANTS_GRANT` now needs an `agent:` id per definition it may
spawn. `PI_GRANTS_GRANT="tool:read,tool:delegate"` can spawn nothing by name; add `agent:review` to allow
that one. `tool:*` satisfies any of them, so an **ungoverned session is unaffected** and `delegate({tools:
[…]})` is untouched. The refusal names the missing capability and lists what the session *may* spawn.

It attenuates like every other capability: a definition's own `allowed-tools` may list `agent:other`,
which is how a delegator is told which definitions **it** may spawn — and a parent can never hand down one
it does not hold. The id authorises; it is never passed to `--tools`.

**Also fixed, and required for the above (R-36):** `deriveOwnGrant` filtered the inherited grant against
the session's *observed tools*, which silently dropped `skill:` and `agent:` capabilities at the first
provider request. A child holding `skill:review` therefore could not re-grant it, and `/grants` stopped
listing it. Only `tool:` and `ext:` are filtered now — an observation says nothing about a namespace that
is not tools.

## 0.7.0 is a breaking change: this package is now the spawner, not a fence

**ADR-0016.** Earlier versions were a governance layer wrapped around `@tintinweb/pi-subagents`: the
product was a `tool_call` interceptor that decided whether *someone else's* spawn was permissible. It
could refuse or allow, never narrow, because that package's `Agent` tool has no `tools` parameter — a
ceiling no amount of local work could lift.

This version spawns children itself, so **the grant is an argument rather than a veto**. What changed:

- **`delegate({agent, task})` spawns a definition by name.** Definitions are **Agent Skills
  (`SKILL.md`)** files — the open standard, already read by 16+ tools — and their `allowed-tools` field
  becomes the grant. The spec calls that field *"pre-approved"* and **experimental**; it declares intent
  and blocks nothing. Passed through `--tools` it becomes structural. **The standard declares intent;
  this package makes it enforced.**
- **`delegate_all` runs several children concurrently**, each with its own grant, its own instructions,
  and no knowledge of the others.
- **Two executors, one plan**: a captured child process (default) or a visible, attachable **herdr** pane
  (`PI_GRANTS_HERDR=1`).
- **Skills and context files are no longer inherited.** Previously a child spawned with `--tools read`
  still loaded every skill the operator had, plus `CLAUDE.md` — measured, `docs/probes/g16-herdr`. So the
  `skill:` capability namespace enforced nothing. It does now.
- **A cardinality bound.** A subtree *budget* caps how many descendants may exist at all, because the old
  `delegate` bounded that to one only by accident of being blocking.
- **Removed:** the pi-subagents ceiling port (`agent-types.ts`, `interceptor.ts`). The `tool_call` hook
  remains as a **tripwire** that refuses third-party spawn tools — installing one is a single command,
  and a silently ungoverned descendant is the thing this package exists to prevent.

Built because that guarantee does not exist elsewhere. `@tintinweb/pi-subagents` provisions statically per
agent type and cannot be narrowed per spawn; `pi-fabric` provisions dynamically but **cannot constrain a
recursive child at all** (measured: `docs/probes/pi-fabric-eval`).

## Earlier

### 0.6.0

- **The approvals store moved out of the workspace** and a legacy in-workspace file is ignored with a
  warning (see *Approving a gated capability*).
- **`PI_GRANTS_APPROVED` carries `capability@subject` pairs** and `once` no longer crosses a boundary
  (**ADR-0014**). A 0.5.x parent and a 0.6.x child do not understand each other's format.
- **`bash` is gated by default** in a governed session, and gating is closed under subsumption, so
  `PI_GRANTS_GATED=tool:write` also gates `bash` (**ADR-0012**). Set `PI_GRANTS_GATED=""` for the old
  behaviour.
- **`delegate` is registered only when the session may delegate**, which is what the docs always claimed.
- Library entry points are compiled to `dist/`, so consumer imports work at all.

### 0.5.0 — hardening from two independent reviews

- **G1 · the argv channel.** Closed; see *Propagation is race-free by construction*.
- **G6 · the ledger.** It reported allowed wildcard spawns as escalation attempts, and dropped every
  refusal decided before resolution. Both fixed at the type level, so a new early exit cannot reintroduce
  them.
- **G7 · configuration.** Malformed bounds fail closed and say so; ungoverned sessions publish nothing; the
  catalog is awaited rather than raced.
- **G8 · child processes.** Caps, timeout, abort-before-spawn, real errors for failed children.
- **ADR-0011 · universal capabilities** are refused on every path, and a wildcard-holding delegator no
  longer bypasses a configured gate. Spawns that succeeded in 0.4.0 therefore fail — and **that reliance was
  never sound**, since each of them handed a child either the entire catalog or a capability an operator had
  explicitly gated. There is deliberately no override flag; the ledger names the capability and the reason.

---

Requires pi ≥ 0.83.0, Node ≥ 22.19. MIT.
