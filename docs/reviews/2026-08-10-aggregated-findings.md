# Aggregated review findings — 2026-08-10

Two independent reviews of `pi-daddy`, cross-referenced:

- **Review A** — five parallel reviewers (security, `pi-token-audit`, correctness, API/tests, docs),
  each told nothing about the others. Full report: `2026-08-10-independent-review.md`.
- **Review B** — a separate agent, 12 critical / 13 important / 6 minor.

Neither knew of the other. **Eight findings were reached independently by both**, which is the strongest
signal in this document. Two findings **directly contradicted** each other; both were resolved by reading
pi's and `pi-subagents`' actual source, and the result was one each way.

---

## The two contradictions, resolved

### ✅ Review B was right — children are IN-PROCESS on the interceptor path

**B-C4** claimed `pi-subagents` creates children in the same Node process, so every grants instance shares
one `process.env`. **A's security reviewer concluded the opposite**: *"I could not construct one. Every value
written by `publishChildEnv` is genuinely session-scoped."*

Verified: `child_process` appears in exactly one file of `@tintinweb/pi-subagents@0.14.3` — `worktree.ts`,
for git. Children are `AgentSession` objects constructed in-process.

**Both were partly right, which is why they diverged.** `delegate` genuinely spawns a subprocess
(`spawn("pi", …)` at `grants.ts:476`), so its per-child `env` object is isolated — A's analysis was correct
*for that path* and over-generalised. The **interceptor path has no process boundary**, so
`publishChildEnv`'s writes to `process.env` are global to every sibling and descendant in the same process.

**Consequence:** the entire race-freedom argument in `propagation.ts` — and the R-26 fix it records —
assumes a process boundary that exists on only one of the two paths. This is the single most important
cross-reference result in this document.

### ❌ Review B was wrong on mechanism — compaction does NOT desynchronise the token-audit FIFO

**B-C12** claimed compaction and tree-summarization requests enter the FIFO without a matching
`message_end`. Verified: **zero occurrences of `onPayload` in every file under `dist/core/compaction/`**.
`before_provider_request` is wired solely through `sdk.js:200`, which compaction never reaches. Those
requests cannot enter the queue.

**But A found the real version of this concern:** there is **no correlation key at all**. `pending.shift()`
blindly takes the oldest entry. The pairing holds in pi 0.83.0 by accident of implementation, not by design,
and any future path emitting a request without a matching `message_end` shifts every later pairing
permanently and invisibly — while still looking plausible, because consecutive turns have similar payloads.

**Reclassified:** Critical → Important, with the mechanism corrected.

---

## Independently confirmed by both reviews

These carry the most weight — two reviewers with no shared context reached them separately.

| # | Finding | A | B |
| :--- | :--- | :--- | :--- |
| 1 | `@`-prefixed task reads arbitrary files before any tool exists | C-1 | C7 |
| 2 | The persisted-approval file is forgeable by the agent it gates | C-3 | C1 |
| 3 | Wildcard parents bypass gating; `assertNarrowing` never runs on the interceptor path | S-2, S-9 | C5 |
| 4 | Withholding `delegate` does not make a session a leaf | S-5 | C8 |
| 5 | Skills and `agent:`/`ext:` capabilities are labels, not controls | S-8 | C10 |
| 6 | Malformed `PI_GRANTS_MAX_DEPTH` disables depth limiting (`NaN`) | S-4 | I4 |
| 7 | Ledger write failures are silently swallowed | R-4 | I2 |
| 8 | Unbounded child output buffering, no timeout | R-1 | I5 |
| 9 | The token-definition percentage is not a defensible measurement | C-4 | I1 |
| 10 | Stale version/test counts in the summary docs | Docs | Minor |

**A additionally proved C-4 algebraically** — `promptTokens` cancels, so the figure is
`toolChars / payloadChars`, a character ratio. Verified across a 72× swing in token count. B rated it
Important; **A's severity is correct**, because that number sits in `SESSION-LOG.md` under *"Verified facts
— don't re-litigate"* and fed ADR-0006.

---

## Unique to Review B — genuinely new

| # | Finding | Why it matters |
| :--- | :--- | :--- |
| **B-C2** | Interceptor ceilings ≠ what `pi-subagents` actually gives children. Extensions and skills load independently of `tools:`. | A found the skills half (S-8); B correctly generalises it — the computed ceiling is not the child's real authority. |
| **B-C3** | **TOCTOU on agent identity.** Grants caches definitions at `session_start` and trusts frontmatter `name`; `pi-subagents` keys by *filename* and reloads before execution. A safe cached definition can be swapped before the spawn. | A saw the name-vs-filename mismatch as a Minor; B escalated it correctly by connecting it to the reload timing. |
| **B-C4** | In-process children share `process.env`. | Resolved above — correct, and it invalidates a load-bearing argument. |
| **B-C6** | **"Allow once" satisfies multiple concurrent spawns.** Single-flight returns one `once` outcome to every concurrent caller sharing capability+subject. | Distinct from A's S-1 (scope flattened at propagation). *Both are real and independent.* A's own fix-wave re-review had flagged this as an out-of-scope minor; B is right to escalate it. |
| **B-C9** | **`bash` enables `env -u PI_GRANTS_GRANT pi …`** — a child with `bash` creates a completely ungoverned descendant. | A found gating isn't closed under `SUBSUMPTION` (S-7); B found the total-bypass escape. This is worse than either alone. |
| **B-C11** | **Scheduled `Agent` calls bypass approval.** Approved once at creation; later executions run through the scheduler with no `tool_call`. | Nobody in A looked at scheduling. |
| **B-I3** | Delegate refusals with no `plan.result` (bad depth, empty task, unknown capability) are never recorded. | Broader than A's "audit gap if `obtainApprovals` throws". |
| **B-I7** | Qualified `ext:pkg/tool` grants cannot be delegated — catalogued as `tool:name`, and `--no-extensions` disables them anyway. | Makes an entire capability namespace unusable. |
| **B-I8** | **"Inactive" governance still governs descendants.** With `PI_GRANTS_GRANT` unset the extension still publishes grant/depth vars. | Directly contradicts the README's "nothing is blocked". |
| **B-I12** | **Exports point at `.ts`; Node refuses type stripping under `node_modules`.** Missing peer deps. | A proved three modules unreachable; B shows the whole export strategy fails for real consumers. B's is deeper. |
| **B-I6** | Approval writes follow project-controlled **symlinks**; no locking or atomic replace. | A found the lost-update race; B adds the symlink vector. |
| **Minor** | No `LICENSE` file despite both manifests declaring MIT; `charsPerToken` documented backwards; `PI_TOKEN_AUDIT_PRINT=0` still prints; empty tool list counts 2 chars. | |

## Unique to Review A — genuinely new

| # | Finding | Why it matters |
| :--- | :--- | :--- |
| **A-C2** | **The frontmatter parser disagrees with pi's own YAML parser.** A block-list `tools:` reads as *absent → wildcard* here, `["read","grep"]` in pi. Verified. | Nobody in B found this. With a wildcard delegator the spawn is **allowed** and the ledger records `effective: ["tool:*"]` while the child is actually restricted — the audit record is wrong in the *permissive* direction. |
| **A-S3** | The ledger records **false escalation attempts for spawns it allowed** — the wildcard path recomputes the record from different inputs, so `isEscalationAttempt()` returns true for a legitimate spawn. | Corrupts the one signal the ledger exists to provide. |
| **A-S6** | Approval **subjects are erased at the propagation boundary** — a `<delegate>`-subject approval is published as a bare capability matching *any* subject. | `approval.ts:33` argues at length that a model-controlled key is not a key; one hop down, the key is gone. |
| **A-R2** | A corrupt approvals file makes the **next write silently destroy every other entry**. Reproduced. | B found symlinks and locking; A found that corruption is *amplified* by the next legitimate write. |
| **A-R3** | **Abort-signal race** — the listener attaches after an `await`, and `AbortSignal` does not replay. A cancellation in that window is lost and the child runs on. | |
| **A-R5** | Unsynchronised catalog rebuild can falsely refuse the first `delegate` of a session. | Fails closed, but non-deterministic. |
| **A-S9** | The interceptor governs **three hardcoded tool names**, so any other spawn-capable tool — including `fabric_exec` — is invisible to it. | |
| **A-A3/A5** | `grants.ts` hand-copies an unexported validator; `appendRecord` has **zero tests** despite the README's fail-closed claim. | |
| **A-tests** | **A fourth test that cannot fail** — `approval-store.test.ts:56` "human-readable" passes with indentation deleted. | Three earlier weak tests were already found and fixed during construction. |
| **A-attacks** | **Eight documented failed attacks**, incl. no escalation constructible through `resolve()` itself. | Separates a hardened core from an unexamined one. |

---

# Grouped for fixing

Ordered by what a fix *touches*, not by severity, so each group can be one change with one test pass.

### G1 · The argv channel — `src/spawn.ts`
**A-C1 / B-C7.** Model-controlled task occupies a CLI-parsed position; `@file` reads anything, `--approve`
parses as a flag.
→ Feed the task on stdin, or prefix so it cannot be parsed; reject `@`/`-` prefixes in `planDelegation` so
it becomes a recorded refusal. **One file. Do this first — it is the cheapest critical.**

### G2 · The `pi-subagents` reality gap — `interceptor.ts`, `agent-types.ts`, `grants.ts`
**B-C2, B-C3, B-C4, B-C11, A-C2, A-S9.** The interceptor's model of what a child receives is wrong in five
ways: ceilings omit extensions/skills, definitions are cached while the spawner reloads, identity is keyed
differently, `process.env` is shared in-process, scheduled executions have no hook, and the frontmatter
parser disagrees with pi's YAML parser.
→ Resolve the authoritative runtime config from the same snapshot the spawner uses, immediately before
execution; replace env propagation with per-session state; block scheduling until it has a hook.
**This is the largest group and the one that most needs a decision before code.**

### G3 · Approval integrity — `approval-store.ts`, `approval-prompt.ts`, `grants.ts`
**B-C1, B-C6, B-I6, A-C3, A-S1, A-S6, A-R2.** Forgeable store; `once` satisfying concurrent spawns; `once`
inherited by a whole subtree; subject erased in propagation; corruption amplified by the next write;
symlinks; no locking.
→ Move the store outside agent-writable space (or sign it); thread `scope` through propagation so `once`
never crosses a boundary; propagate `capability@subject` pairs; atomic replace + no-follow.

### G4 · Wildcard and universal bypasses — `interceptor.ts`, `approval.ts`
**B-C5, A-S2, A-S9, ADR-0011.** The wildcard branch returns `allow` before gating; `assertNarrowing` never
runs here. **ADR-0011 is already Accepted and unimplemented** — the branch for it exists at
`adr-0011-universal-capabilities`.
→ Implement ADR-0011 and remove the wildcard early return in the same change.

### G5 · `bash` is a governance hole — `resolve.ts`, `spawn.ts`
**B-C9, A-S7.** Gating is not closed under `SUBSUMPTION`, and `bash` can run `env -u PI_GRANTS_GRANT pi …`
to create an ungoverned descendant.
→ Gate a capability if anything subsuming it is gated; and decide whether `bash` becomes universal or
requires an OS sandbox. **The `env -u` escape may be unfixable in-process — that is a design question, not
a patch.**

### G6 · Ledger integrity — `grants.ts`, `ledger.ts`
**B-I2, B-I3, A-S3, A-R4, A-A5.** Silent write failures; unrecorded pre-resolution refusals; false
escalation records on the wildcard path; `appendRecord` untested.
→ Record before spawning; fail closed when a ledger is configured; always return a `result` from
`decideSpawn`; add the missing tests.

### G7 · Configuration robustness — `grants.ts`
**B-I4, B-I8, A-R5.** `NaN` depth disables enforcement; inactive governance still publishes state; catalog
rebuild races the first `delegate`.
→ Strict integer validation failing closed; publish nothing when inactive; await the catalog or treat
"not yet observed" distinctly from "unknown".

### G8 · Child process handling — `grants.ts`
**B-I5, A-R1, A-R3.** Unbounded buffering, no timeout, abort race, failures returned as successes.
→ Cap and truncate output; independent SIGTERM→SIGKILL timeout; check `signal.aborted` before spawn;
return a real tool error on non-zero exit.

### G9 · Packaging and consumability — `package.json`, `index.ts`
**B-I12, A-A1, A-A2, Minor.** `.ts` exports unusable under `node_modules`; three modules unreachable;
`catalog`/`delegate` missing from `index.ts`; missing peer deps; no `LICENSE`; no workspace manifest.
→ Compile to `dist/*.js` + declarations, add an installed-tarball smoke test, fix the export map, add
`LICENSE`.

### G10 · `pi-token-audit` measurement honesty
**A-C4, B-I1, B-I9, B-I10, B-I11, B-C12(reclassified), Minor.** The headline is a character ratio; Bedrock
reports 0 and Google 1; degraded measurements are hidden; `agent_end` fires too early; no correlation key.
→ Either relabel it a character share and delete the calibration ceremony, or tokenize the tool block
properly. **Then correct `SESSION-LOG.md:97`, which records the 72% as a verified fact.**

### G11 · Test coverage
**B-I13, A-A4, A-A5, A-tests.** `extensions/grants.ts` untested (three reviewers converged on it);
`pi-token-audit` has no tests; a fourth test that cannot fail; no committed typecheck; root `npm test`
fails.
→ The rpc integration harness already chosen, plus the extraction two reviewers independently recommended.

### G12 · Documentation
Stale versions and ADR counts in `README.md` / `CLAUDE.md`; `GETTING-STARTED.md` claims zero implementation
code and uses the retired name in shell commands; `SESSION-LOG.md:97` records a falsified "verified fact".

---

## Recommended order

1. **G1** — one file, closes a critical, cheapest possible win.
2. **G12 + the `SESSION-LOG` correction** — the docs currently mislead about a falsified fact.
3. **G4** — ADR-0011 is already accepted; the branch exists.
4. **G6, G7, G8** — contained, testable, no design decisions needed.
5. **G3** — needs a decision on where approvals live before any code.
6. **G2** — largest, and needs the `pi-subagents` integration model settled first.
7. **G5** — may be unfixable in-process; treat as an ADR, not a patch.
8. **G9, G10, G11** — packaging, honesty, and coverage; independent of the above.
