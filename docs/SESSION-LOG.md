# Session Log

**Read this first when resuming.** The register (`01-discovery.md` … `06-decisions/`) holds the reasoning;
this file holds *where things stand and what to do next*. Newest entry on top.

---

## 2026-08-10 (later) — ADR-0011 implemented, live-verified, and shipped as `pi-agent-grants` 0.5.0

**ADR-0011 is done and merged.** All three decided changes are implemented (`e8b0fef`), **155 tests
passing**, and — new — **verified live against real pi**: `docs/probes/adr-0011-universal`. The entry below
still says "Not yet implemented"; that was true when it was written and is left standing, as this register
always does.

**This is a breaking change, so the package is `0.5.0`.** Two spawns that succeeded in 0.4.0 now fail: an
agent type declaring a universal capability is refused on **both** paths, and a wildcard-holding delegator
no longer bypasses a configured gate. The README carries a *"0.5.0 is a breaking change"* section.

### What the live run proved, and what it found

Confirmed in a real pi process with real agent-type files, the driver **armed with `Allow once`** so that
"no dialog appeared" is falsifiable rather than merely unobserved:

- Wildcard delegator + agent type declaring `fabric_exec` → refused (was allowed in 0.4.0).
- Enumerated grant holding `fabric_exec` + same type → refused (was *silently passed through* in 0.4.0).
- Wildcard delegator + gated capability, real model-driven spawn → refused, ledger correct (the gate did
  **nothing** in 0.4.0).
- No approval dialog for any doomed spawn; no `approvalSource`/`humanDenied` in any ledger line.

**One new finding, needing a decision (probe Finding 1).** A wildcard delegator is now refused with
*"requires approval for tool:write"* while **no dialog is ever offered** — the wildcard branch returns
before a `ResolveResult` exists, and `shouldSeekApproval(undefined)` is `false`. It fails closed, but it is
the very defect ADR-0011 deliberately removed from `planDelegation`, reintroduced on the other path by the
same change. Two fixes are plausible (make the path prompt; or make the message honest) and **both are
design decisions, so neither was taken.** Recorded in ADR-0011 under *Open, from live verification*.

**Scenario 2's evidence is weaker than the others and says so.** The enumerated-path universal branch was
read from `/grants` inside a real pi process, not from a completed spawn: `deriveOwnGrant` strips
`fabric_exec` from a session that never observed it, so the escalation check fires first. Reaching it
end-to-end needs `npm:pi-fabric` installed, which this machine does not have.

### One documentation defect fixed

ADR-0011 cited `docs/reviews/2026-08-10-aggregated-findings.md` (findings A-S2 / B-C5) as the evidence for
the one change made beyond its stated decision. **That file was never written** — it exists nowhere on
disk, and those labels appear nowhere but in the ADR. The reviews happened in a session whose output was
not persisted, which is exactly what "files are the memory" exists to prevent. The dangling citation is
**recorded in the ADR rather than deleted**, and repointed to evidence that does exist: the pre-change code
at `main:src/interceptor.ts:84-92`, where the branch returns `allow: true` without ever reading `ctx.gated`.

### Next actions, highest value first

1. **Decide Finding 1** (prompt vs. honest message) — small, and it is a live incoherence in shipped code.
2. **Background + streaming delegation** — the agreed next feature. `delegate` blocks until the child
   exits, so an orchestrator cannot fan out and collect: the actual multi-level pattern this project
   exists for. Also the first real test of the single-flight approval queue against genuine parallel spawns.
3. **The rpc integration harness** — promote `docs/probes/approval-ux/drive.mjs` into `npm run
   test:integration`. Two probes now hand-drive it; that is the point at which it should be a suite.
4. `PI_GRANTS_GATED` recommendation in the README · the `pi-subagents` proposal document · verify
   `pi-token-audit` against Anthropic and Google payload shapes · A-14 (deferred).

---

## 2026-08-10 — the project is `pi-daddy`, under version control, with eight decisions taken

**The project is renamed to `pi-daddy`** (repo and project alike). "DTCM — Dynamic Tool & Context
Management" named the token-economics thesis ADR-0007 retired. Replaced only where the name is
*operational* — `CLAUDE.md`, `README.md`, `GETTING-STARTED.md`, all of `.claude/`. **"DTCM" is deliberately
preserved in every ADR and register**, where it *is* the abandoned thesis; a convention note in `CLAUDE.md`
forbids a blanket find-and-replace, because a register entry describes what was believed on its date and
renaming it makes the record lie.

**This is now a git repository** — the first one this project has had. Baseline commit `d8e4c47`, branch
`main`, 75 files, authored as `mojomanyana <nemanjaalavanja@gmail.com>` set **repo-local** so the global
identity is untouched. `.gitignore` covers `node_modules/`, `.superpowers/`, and — per **R-27** —
`.pi/grants-approvals.json` and `.pi/grants.jsonl`. No remote is set; that is the user's to add.

### Decisions taken (eight, in one pass)

| # | Decision |
| :--- | :--- |
| **ADR-0011** | **Accepted — Option 3.** Universal capabilities were treated three ways across the two spawn paths (silently dropped / silently passed / loudly refused). Fix: the interceptor refuses a spawn retaining a universal capability, `shouldSeekApproval` additionally requires `universal` to be empty, and the cosmetic stripping at `interceptor.ts:85` is removed. **Not yet implemented** — will be the first change to `src/interceptor.ts` since the package shipped. `src/resolve.ts` stays untouched. |
| **ADR-0009** | **Superseded by events.** The build path was taken; re-triggers stay live, now including "a `pi-fabric` release that fixes the recursion/containment exclusivity". |
| Wiring tests | **Integration harness, not extraction.** `obtainApprovals` stays in the extension; coverage comes from an rpc-mode suite driving real pi, promoted from `docs/probes/approval-ux/drive.mjs`. Wire as a separate `npm run test:integration` so `npm test` stays fast and pi-free. |
| Upstream PR | **Write the case first, code later.** A proposal document for a `tools` parameter on `pi-subagents`' `Agent` tool, to become an issue in the user's words. Patch only if the maintainer is receptive. |
| Gating `bash` | **Document as recommended, do not default it.** `bash` subsumes read/write/edit/grep/find/ls (R-25), so gating it is the highest-value gate *and* the likeliest source of reflexive approval. The README will recommend a `PI_GRANTS_GATED` value with the fatigue caveat; the code default stays empty, preserving "governance is opt-in and never silently tightens a workflow". |
| Next feature | **Background + streaming delegation.** |

### Next actions, highest value first

1. **Implement ADR-0011** — accepted but unimplemented; keeps the register honest.
2. **Background + streaming delegation.** `delegate` blocks until the child exits, so an orchestrator cannot
   fan out and collect — the actual multi-level pattern this project exists for. Also the first real test of
   the single-flight approval queue against genuine parallel spawns.
3. **The rpc integration harness** (decision above).
4. **`PI_GRANTS_GATED` recommendation** in the README (small).
5. **The `pi-subagents` proposal document** (small).
6. **Verify `pi-token-audit` against Anthropic and Google payload shapes** — proven on one provider only.
7. **A-14** — are deferred tool definitions billed as prompt tokens? Consciously deferred; only matters if
   the cost thesis is revived, which ADR-0007 retired.

---

## 2026-08-09 — `pi-agent-grants` 0.4.0: human approval for gated capabilities

Gated capabilities (held but not passable without a person saying yes) could previously only ever be
refused; `0.4.0` adds the yes — once/session/always scopes, inheritable down the tree intersected with
each child's actual grant, with `always` persisted per-project and offered only on the interceptor path
(agent types are human-authored files; `delegate`'s subject is model-chosen, so it never gets `always`).
**ADR-0010** records the approval semantics and **R-27** the hazard of a committed approvals file
authorising every clone (mitigated by ignoring entries whose `cwd` doesn't match). New public exports from
`src/approval.ts`, `src/approval-store.ts`, `src/approval-prompt.ts` — see `packages/pi-agent-grants/README.md`'s
*Approving a gated capability* section.

State: **unit-tested, typechecked, and verified live against real pi (149 tests, clean typecheck)**. The live
run is `docs/probes/approval-ux` — eight scenarios plus a companion, driven through `pi --mode rpc` (the same
`ctx.ui.select` the TUI dialog serves, not a rendered TUI). It found two defects, **both since fixed and
re-verified**: an approval inherited down the `delegate` path was applied but never recorded in the ledger,
and `delegate`'s default child model was a bare id that could resolve to an unauthenticated provider. The
probe still describes the original run — that is what a probe is for — with a dated resolution note on top.

A whole-branch review then returned **ship after fixing**, with no Critical findings: it could construct no
path granting a capability without the required approval, and `approved ⊆ grant` holds by construction at
every level on both paths. Its five Important and five Minor findings were all fixed in one wave — the
single-flight approval queue was inert in production (a fresh gate per call), `PI_GRANTS_APPROVED` could
escape the per-child env clamp, the dialog could fire for a spawn already refused for an unrelated reason,
the interceptor path passed neither `signal` nor `task`, and three documents described code that no longer
existed. `src/resolve.ts` and `src/interceptor.ts` remain byte-identical to their pre-feature state
throughout — the design's central claim. One reported item was deliberately left undone:
`SpawnRequest.isolated` is declared and populated but never read, and removing it means editing the protected
security surface, so it is recorded for a decision rather than patched around.

## 2026-08-09 — discovery → falsification → reframe → two shipped packages

### Where the project stands

**Status: BUILDING.** The product is a **capability-governance layer for pi's multi-level agent system**: a
top orchestrator grants each sub-agent a deliberate subset of tools/skills and withholds the rest;
sub-agents may delegate further but only ever a subset of what they hold; every grant and refusal is
recorded. Enforced by pi's own `--tools` allowlist, so the guarantee is structural.

`docs/ROADMAP.md`'s phase plan is **obsolete** — it was written for the token-economics thesis. The gate
discipline and probe convention survive; the phase list does not.

### What happened, in order

1. **Discovery** pinned the substrate: pi (TypeScript, MIT, v0.83.0 installed locally, 0.84.1 upstream).
2. **G0 economic test failed decisively.** 82 real sessions, $76.12 of spend: catalog ~20 tools, p90 working
   set 4 tools, four tools = 98.1% of calls, ~50k median context, cache read:write 114:1. Break-even
   `S > 11.5·c·C` needs ~110 tools; mounting lost by 5×–102×. → G0 NO-GO, initiative parked (ADR-0005).
3. **Park reversed** (ADR-0006): the loss figure was computed on the *fallback* mounting path only. On
   native deferred loading (which pi routes to) the penalty collapses. Governing ratio is `S/(H+S)`, a curve
   over session length — a *fresh* session measured **72%** of prompt tokens on tool definitions.
4. **The reframe (ADR-0007) — the most important event.** The user stated the actual goal: *"a large set of
   tools and sub agents… a top level orchestrating agent… that can give them some skills and tools but some
   not… narrow control of sub-agents… multilevel agent system."* Token cost was never the objective. The
   blueprint's §1 *justification* misled discovery; its *architecture* was always about control. Risk
   **R-17** had recorded the desired feature as a hazard.
5. **ADR-0008** established the invariant: capabilities attenuate monotonically down the tree.
6. **pi-fabric evaluated empirically** (11 probes) — it implements much of the design but **recursion and
   containment are mutually exclusive by construction** there. Decision **parked** with a re-trigger.
7. **Built and shipped** `pi-agent-grants` (0.3.0) and `pi-token-audit` (0.1.0).

### Verified facts (measured, not assumed — don't re-litigate)

- pi's **default** tool surface is only `read`, `bash`, `edit`, `write`. `grep`/`find`/`ls` exist but are not default.
- **pi's `--tools` / `--no-tools` hard-enforce**, including against extension tools; an `-e`-loaded extension
  cannot re-add its own tool past them (A-16). **This is the enforcement point.**
- **`bash` subsumes** the file/search tools, so a grant containing it is not narrow (A-15, R-25).
- In pi-fabric, `recursive: true` overrides `tools: []` *and* `extensions: false` — `fabric_exec` is a
  universal capability. Its `maxDepth` works; nothing else contains a recursive child.
- pi persists per-message `usage` with `cacheRead`/`cacheWrite`/`cost` in session JSONL (A-12).

### Shipped code (both under scoped waivers in `gate-reports/G0-2026-08-09.md`)

| Package | State | Verification |
| :--- | :--- | :--- |
| `packages/pi-agent-grants` **0.3.0** | resolver · ledger · spawn planner · `tool_call` interceptor · `delegate` tool · live catalog | **73/73 tests**, both typechecks clean, **7 live scenarios** verified against real pi |
| `packages/pi-token-audit` **0.1.0** | token/cost audit incl. tool-definition share | typechecks clean; verified end-to-end on `openai-codex`/`gpt-5.6-sol` |

Run tests: `cd packages/pi-agent-grants && npm test`.
Typecheck: tsconfigs are in the session scratchpad (not committed) — recreate with `tsc` pointing at
`src/**` and `extensions/grants.ts`, mapping `@earendil-works/pi-coding-agent` and `typebox` to the globally
installed pi's `dist/index.d.ts` and `node_modules/typebox/build/index.d.mts`.

### Open decisions (user's call)

1. **Code mode / pi-fabric** — parked with a re-trigger (durable actors, mesh coordination, or per-branch
   cost budgets). ADR-0009 stays *Proposed*.
2. **Upstream PR to `pi-subagents`** adding `allowed_tools` to the `Agent` tool. This is the one change that
   would turn the interceptor from *enforce-only* into *provisioning* for existing agent types, and it
   benefits everyone using that package. Not started — it is the user's name on the PR.
3. ~~**Rename the project.**~~ **RESOLVED 2026-08-10 — the project is `pi-daddy`.** "DTCM — Dynamic Tool &
   Context Management" named the token-economics thesis ADR-0007 retired. Replaced wherever the name is
   *operational* (`CLAUDE.md`, `README.md`, `GETTING-STARTED.md`, all of `.claude/`) and **deliberately kept
   in the historical record** — every ADR and register entry, where "DTCM" *is* the abandoned thesis and
   renaming it would make the record lie. See the convention note in `CLAUDE.md`.

### Next actions, highest value first

1. **Background + streaming delegation.** `delegate` blocks until the child finishes; add background handles
   and progress so an orchestrator can fan out and collect.
2. **`A-14`** (~1h, ~$1) — are deferred tool definitions billed as prompt tokens? Only matters if the cost
   thesis is revived; consciously deferred.
3. **Verify `pi-token-audit` against Anthropic and Google payload shapes** — only proven on one provider.

### Known gaps, stated so they aren't rediscovered as surprises

- The interceptor **enforces but cannot provision** (no `tools` param on `pi-subagents`' `Agent`). `delegate`
  provisions; the interceptor guards.
- Extension tools are catalogued as `tool:<name>`, not `ext:<pkg>/<tool>` — a provider payload carries names,
  not owning packages.
- `delegate` spawns `pi` from `PATH`.
- ADRs 0001/0002/0003 remain *Proposed*; their evidence is recorded but the reframe made their original
  framing partly moot.
