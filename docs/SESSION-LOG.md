# Session Log

**Read this first when resuming.** The register (`01-discovery.md` … `06-decisions/`) holds the reasoning;
this file holds *where things stand and what to do next*. Newest entry on top.

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
