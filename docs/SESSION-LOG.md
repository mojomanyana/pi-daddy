# Session Log

**Where things stand and what to do next.** `docs/SPEC.md` says what the product *is*; ADRs hold the
decisions; this file holds state and next actions. Newest entry on top.

---

## 2026-09-21 — cleanup before PR 3d: archive, trim, retire, delete

Branch `claude/adr-0076-cleanup` from `c59e0a3`. Operator direction: "do a cleanup first, big one". All four parts
were chosen. **Archived** (moved verbatim under `docs/archive/`, README lines added): the three HANDOFF documents,
USING-WITH-PRINCIPAL-PI-SKILLS, PUBLISHING, RUNNING-IT, FINAL-READINESS-INDEX, `docs/plans/`, `docs/handoff/`,
82 session-log entries before 2026-09-15, 102 resolved risk entries, the pre-0.13.0 changelog, and the
execution-retention v1 contract. **Trimmed:** the package README from 910 lines to a page that points at the
guide, SPEC and glossary. **Deleted:** effect profile, factory orders, measured orders and sessions, producer IPC,
primary/shadow fan-out and `/grants variants` — sources, tests, contracts and the bubblewrap CI steps — with the
factory-authority check moved into the adoption registry, the retired profile id kept as a constant so existing
experiment bindings still validate, and the dashboard host's experiment cancellation route removed. ADR-0076
carries a dated amendment recording the reversal of "keep every capability" for these five.

Evidence at `c59e0a3` plus these edits: typecheck clean; `prettier --check .` clean; smoke OK; model-free
integration against real pi 0.84.2: 38/38; full unit runner: the 59 baseline failures (all bubblewrap-dependent
suites) are gone with the suites, and nothing new fails. Independent review pass (code-reviewer subagent, six
hypotheses): six findings, all repaired — a SPEC paragraph still advertising `completion:"primary"` and
`/grants variants`; the dashboard-host contract still accepting a `cancel` operation whose route was deleted (removed
from the union, the allowlist, the authority type and the contract README with a dated note); an orphaned bwrap test
fixture; a probe README pointing at deleted paths (dated note added, rule 2); a dangling CI comment; a test title
naming measured orders. Refuted: dead references in live code and docs, schema residue in `delegate_all`, drift in
the moved factory-authority helpers, archive completeness (heading counts 90→9+82, 164→61+103, 34→29+5).

Deferred deliberately: ledger v2/v3 contracts and their generators retire with PR 3d-i (the dashboard's v2 reader
goes there); intent-control v1 and debrief v1 stay because code and tests still read them.

### NEXT SESSION

1. **PR 3d-i** (parked as local commit `71fbb4e` on `claude/adr-0076-pr3d-record-format`; rebase onto this
   cleanup): envelope for the grants ledger and activity timeline, importer, `pi-daddy ledger repair`, new
   `contracts/ledger-record/v1`, ledger v2/v3 retired, version 0.30.0.
2. **PR 3d-ii**: work ledger and the private controller journals on the envelope; intent-control v1 retired.
3. **PR 3e**: inactivity-based child deadline on pi's JSON event stream.
4. PR 4 harness peer; PR 5 SPEC as layer map + fresh-session probe; PR 6 advisors (ADR-0077); PR 7 context
   handoff (ADR-0078); PR 8; PR 9.


---

## 2026-09-21 — ADR-0076 PR 3c: one project state directory, settings.json, sixty-minute default

Worktree `claude/adr-0076-pr3c-state-directory` from `73299b5` (PR 3b merged). `src/kernel/project-paths.ts` owns
every location: project state under `<cwd>/.pi/pi-daddy/` and user state under `<agent dir>/pi-daddy/`
(`grants/`, `approvals/`, `workspace-leases/`). `test/project-paths.test.ts` was red first (fifty-eight `.pi`
literals in code across twenty-six files) and now refuses any pi-daddy path literal outside that module; pi's
own locations (`.pi/skills`, `.pi/settings.json`, `~/.pi/agent`) may still be named in operator text. The
`.includes(".pi")` refusal guards in the private journals became one predicate with the same semantics.

`pi-daddy init` writes `.pi/pi-daddy/settings.json` (JSON; `buildProjectSettings` keeps every fact the shell file
carried: grant, per-definition declarations and reasons, withheld capabilities with who declared them, routable
workspaces, cross-references, cautions, ledger file, default gate) and a `.gitignore` that keeps everything else
in that directory out of commits. `.pi/grants.env` is no longer written; existing files are ignored, as they always
were by code. Product directories are created recursively since the state path is two levels deep.

**Operator decisions this session.** The user-level stores move **without migration**, ADR-0020's precedent
applied literally: `session-report` warns at start when a grant store, approvals file or project ledger exists
at its pre-3c location and not at the new one, and says what to do. The default child timeout is **sixty
minutes** (ADR-0038 dated note; test updated): the operator saw working builds killed at twenty. The real fix,
an inactivity deadline on pi's JSON event stream, is **PR 3e** after the format change, because a `pi --print`
child gives the parent no activity signal until it exits.

Evidence at `73299b5` plus these edits: typecheck clean; `prettier --check .` clean; project-paths, init, store,
work, session and layering tests green; smoke OK (its check now reads `settings.json`); model-free integration
against real pi 0.84.2 with the new default ledger path: 38/38; full unit failing set equals the baseline after
one daily-host test was repointed. Independent review pass (code-reviewer subagent, seven hypotheses): ten
findings, all repaired here. The two that mattered: the nested `.gitignore` is inert when a project's root
`.gitignore` covers `.pi/` (git never descends into an ignored directory), so init now runs `git check-ignore`
and prints the two re-include lines when the record is uncommittable, with a red-first test; and a recursive
mkdir in the work command never throws EEXIST, which had made its symlink refusal unreachable, so it creates the
two levels one at a time as init does. Also: the old `grants.env` is now named at session start (a shell that
still sources it points the ledger variable at the old ledger); stale twenty-minute comments and two `1200`
table cells corrected; dead slug/hash code and unused imports removed from the stores; the lease directory uses
the shared helper; a duplicate content-store path entry removed; `settings.json` takes its ledger name from the
constant and sorts `withheld` so the file stays diffable; a stale shell-file sentence fixed.

### NEXT SESSION

1. **PR 3d** — one record envelope and one reader across the stores; private controller journals stay under
   `~/.local/state/pi-daddy/`; importer for the old `.pi/grants.jsonl`; version 0.30.0; skill-harness re-pins.
2. **PR 3e** — inactivity-based child deadline: children run in pi's JSON event mode, the parent kills only
   after N minutes without an event, and the dashboard shows live progress. Replaces the wall clock ADR-0038
   left in place.
3. PR 4 harness peer + contracts pruned; PR 5 SPEC as layer map + fresh-session probe; PR 6 advisors
   (ADR-0077, shared package); PR 7 context handoff (ADR-0078); PR 8; PR 9.


---

## 2026-09-21 — ADR-0076 PR 3b: one environment namespace, nine export keys

Worktree `claude/adr-0076-pr3b-env-exports-state` from `797ffef` (PR 3a merged). `src/kernel/env-names.ts` now owns
every environment variable name, the closed `GOVERNANCE_ENV_KEYS` list, the `LEGACY_ENV_NAMES` table and
`adoptLegacyEnvironment`. All twenty `PI_GRANTS_*` names (plus the two test-tier switches) are `PI_DADDY_*`; the
dashboard's `PI_DADDY_LEDGER` and the governance ledger variable were the same fact under two constants and are
one constant now. Legacy names are adopted once per process at the three entries (extension, `pi-daddy` CLI,
dashboard CLI) with one visible warning; the new name always wins; legacy values are left for older siblings.
The kernel's `childEnv` guard refuses by the closed list instead of by prefix. `test/env-names.test.ts` was red
first and forces: no `PI_GRANTS_` literal in shipped code outside the table, every key the planner writes is a
governance key, adoption semantics.

The export map went from seventy keys to nine: root, `kernel`, `ledger`, `approvals`, `executors`, `dashboard`,
`work`, `learning` (barrel files per layer, no `export *` name conflicts) and one `contracts/*` wildcard. The
smoke probe, four export-asserting tests, the subpath mentions in contract READMEs, the package README,
SPEC, PUBLISHING and the readiness index were repointed (the review found the first pass had missed the
last four documents). skill-harness imports no pi-daddy subpath (verified against the 0.17.0
tarballs: it reads `grants.jsonl` and the bridge symbol), so no known consumer breaks; the `DelegationContext`
type is unchanged since PR 2.

Evidence at `797ffef` plus these edits: typecheck clean; `prettier --check .` clean; layering, guards and
env-names tests green; smoke OK after two repoints; model-free integration against real pi 0.84.2 (children now
receive `PI_DADDY_*`): 38/38; full unit failing set equals the baseline. One run showed an extra failure in a
trust-budget test that compares against `Date.now()`; it passed in isolation and on the rerun, so it is a
pre-existing timing flake, noted here and not repaired in this PR. Prettier must run from the repository root:
run from the package directory it cannot see `.prettierignore` and reformats the hash-pinned vendored files, which
the adoption-pin test caught a second time. Independent review pass (code-reviewer subagent): one critical
finding — legacy adoption ran after `createGrantsSession` had read `PI_DADDY_GRANT`, so an operator sourcing an
old `.pi/grants.env` would have received an ungoverned wildcard root while the warning said the rename worked,
and the reload snapshot was taken pre-adoption. Adoption now happens as the constructor's first statement,
the session records what it adopted, and `test/session-legacy-env.test.ts` (red first) forces the ordering.
Also repaired: removed subpaths still advertised in five current documents; contract READMEs half-renamed;
two undocumented surface changes now in the CHANGELOG. Accepted as-is: a simulated third-party adapter fixture
under `test/fixtures/` still names `PI_GRANTS_NATIVE_SESSION_ROOT`; it is fixture bytes, not shipped code.

### NEXT SESSION

1. **PR 3c** — `.pi/pi-daddy/` as the one project state directory (ledger, work files, learning connection,
   activity, content); user-level stores under `~/.pi/agent/pi-daddy/{grants,approvals,workspace-leases}` with
   copy-on-first-read from the old locations; `pi-daddy init` stops writing `.pi/grants.env` and writes
   `settings.json`; smoke and the forty ledger-path assertions follow.
2. **PR 3d** — one record envelope and reader across the stores; private controller journals stay under
   `~/.local/state/pi-daddy/`; importer for old `.pi/grants.jsonl`; version 0.30.0; skill-harness re-pins.
3. PR 4 harness peer + contracts pruned; PR 5 SPEC as layer map + fresh-session probe; PR 6 advisors (ADR-0077,
   shared package); PR 7 context handoff (ADR-0078); PR 8; PR 9.


---

## 2026-09-21 — ADR-0076 PR 3a: Prettier, statement-count guard, prose tests deleted

Worktree `claude/adr-0076-pr3a-format-guards` from `5da2dfe` (PR 2 merged on top of 0.28.1). Prettier 3 at width
120 is a root dev dependency with `npm run format` / `format:check` and a CI step before typecheck; `src/`,
`extensions/`, `test/`, `test-integration/` and `scripts/` were formatted once. Vendored files are excluded: the
first run reformatted `products/vendor/adoption.ts` and the adoption-pin test went red, which is the guard working.
`test/file-size.test.ts` now counts statements through the TypeScript AST (ceiling 400; largest file 395) and caps
every shipped line at 200 characters; a self-test proves it measures statements, not newlines. Seventeen lines
over 200 characters were split with identical runtime bytes: message strings into concatenations, five embedded
child scripts into one statement per line inside their template literals. `test/risk-register-status.test.ts`
and the ADR/SPEC prose assertions in `work-ledger-contract.test.ts` are deleted; the contract README link check
stays. One source-shape regex in `namespace-diagnostics.test.ts` became whitespace-tolerant.

Three operator decisions from the PR 3 checkpoint are recorded in ADR-0076's second amendment: PR 3 lands as
3a/3b/3c; one record format and reader with the private controller journals staying under `~/.local/state`;
`PI_DADDY_*` with an explicit governance key list; Prettier for the width cap. The store inventory that forced
them (twenty-one stores, no chain on the grants ledger, three journals that refuse `.pi/`, inode-pinned bindings)
is summarised there.

Evidence at `5da2dfe` plus these edits: typecheck clean; `prettier --check .` clean; guards 3/3; layering 2/2;
model-free integration against real pi 0.84.2: 38/38; smoke OK; the full unit runner's failing set equals the
baseline set recorded at `454774b` (59 bubblewrap/WSL2 cases), no new, no vanished. Independent review pass
(code-reviewer subagent): every rewritten string and embedded script verified byte- or AST-identical by canonicalising
both trees; four findings, all repaired here — the package README still described the line-count guard, R-144 still
named the deleted test as R-72's control (dated note added), the guard's header called 400 statements "the 400-line
spirit" while 24 modules exceed 400 lines after formatting (reworded with the numbers), and `scripts/` was formatted
but unguarded (now under the line cap).

### NEXT SESSION

1. **PR 3b** — `PI_DADDY_*` only with the exported governance key list and its test; export map under ten;
   `.pi/pi-daddy/` as the one project state directory (`settings.json`, `grant.json`, `approvals/`, `content/`);
   `.pi/grants.env` retired; deprecation warnings for old names for one minor release.
2. **PR 3c** — one record envelope and one reader across the twenty-one stores; private controller journals keep
   `~/.local/state/pi-daddy/`; importer for old `.pi/grants.jsonl`; version 0.30.0; skill-harness re-pins.
3. PR 4 harness peer + contracts pruned; PR 5 SPEC as layer map + fresh-session probe; PR 6 advisors
   (ADR-0077, shared package); PR 7 context handoff (ADR-0078); PR 8; PR 9.


---

## 2026-09-21 — ADR-0076 PR 2: five layers cut, import direction enforced

Worktree `claude/adr-0076-pr2-layers` from `ea72a58` (PR 1 merged), rebased onto `d55b80c` (0.28.1, PR #60, merged by
another session meanwhile) before CI; three conflicts resolved (changelog order, one import, one version assertion). Every `src/` file now lives under
`kernel/`, `governance/`, `executors/` or `products/` (`advisors/` is reserved for PR 6); `src/index.ts`,
`src/cli.ts` and `extensions/` are the composition layer. `test/layering.test.ts` was written red first (159
stray root files, then seven upward edges) and is green with zero exemptions; the ADR carries a dated
amendment recording how each edge was closed and where the Decision's expectations differed from the tree.
`test/file-size.test.ts` now recurses, since a non-recursive read would have guarded only two files and
reported green.

Behaviour-neutral by intent; two deliberate edits: the planner takes a `childEnv` hook instead of importing
the activity timeline, refusing `PI_GRANTS_*` or already-set keys (forced by a new test), and `ExecutorKind`
moved into the kernel. `pi-daddy/workspace` stays whole through `governance/workspace-public.ts`; export
keys and root exports are unchanged; `dist/` targets moved with their files. Four contract READMEs and three
SPEC sentences that named old paths were repointed. One import-rewriter false positive was caught and
reverted: a `"./.."` fixture literal in `test/init.test.ts`.

Evidence on this machine at `ea72a58` plus these edits, HEAD printed in the same commands: typecheck clean;
layering 2/2; the full unit runner's failing set is byte-identical to the unchanged tree's: 59 cases, 57 of them
`ENOENT /usr/bin/bwrap` (CI installs bubblewrap) and 2 pre-existing `measured-order` journal-replacement
assertions that fail identically at `ea72a58` on this WSL2 filesystem, with no new and no vanished failures; model-free integration tier
against real pi 0.84.2: 38/38; pack-and-install smoke: OK, after it caught the `pi-daddy/workspace` subpath
losing `defaultWorkspaceLeaseDir`, which is why `workspace-public.ts` exists. Independent review pass (code-reviewer subagent, adversarial hypotheses A–F written first): five
findings, all repaired in the same change. (1) `pi-daddy/workspace` had lost `ENV_WORKSPACE_LEASE_DIR`, the
seventh lease name, while the ADR amendment claimed the subpath was whole; restored, and
`test/workspace-public-surface.test.ts` now forces the full surface. (2) This entry's evidence sentence
called all 59 failures bubblewrap; corrected above. (3) `THIRD_PARTY_NOTICES.md`, `adoption-pin.json` and the
factory-order README named the old vendor paths; repointed. (4) The layering test missed `createRequire`,
`new URL`, template imports and bare `pi-daddy/` self-imports; covered, and its docstring now states what it
does not cover. (5) Stale old-path prose in comments, including one written in this change; repointed
mechanically outside import lines. Refuted: runtime path loading, non-path literal rewrites beyond the one
already reverted, `childEnv` widening, other lost exports.

Cross-session notes: the skill-harness session reported (1) the advisors code should ship as one small
package shared by both repositories, and (2) a planned `skill-research-v1` work template needs a few KiB of
structured context plus file paths handed between sibling and dependent children. Both are inputs to
ADR-0077/0078; neither changes this PR.

### NEXT SESSION

1. **PR 3 — one ledger, one state directory, `PI_DADDY_*` only, exports under ten, statement-count guard
   with a 120-character line cap.** Ships as 0.30.0. Delete the prose-asserting tests. skill-harness re-pins.
2. **PR 4 — skill-harness as optional versioned peer; contracts pruned.**
3. **PR 5 — SPEC as the layer map** with the no-hex/no-PR-token test; first fresh-session probe.
4. PR 6 advisors (ADR-0077, shared package boundary to decide), PR 7 context handoff (ADR-0078, must carry
   structured context and file paths between siblings), PR 8 selection/routing/signals, PR 9 probes.


---

## 2026-09-21 — ADR-0076: the consolidation programme, PR 1 (truth and glossary)

Branch `claude/adr-0076-consolidation-programme` from `f3f4ae4` (0.28.0). A roast of the codebase and a sourced
landscape survey preceded this entry; both are summarised in ADR-0076's Context with the numbers they produced.
The operator's answers in the same session are recorded there as decisions: keep every capability but reshape
contracts; layers before features; context handoff is the first coordination feature; "quality is fixed"
means a fresh session ships a delegate-path change from README, SPEC and the glossary alone; a
non-generative decision model (Jev via OpenRouter) is usable at four decision points, default off, toggled
from the dashboard, every use recorded as advice.

This PR changes documents only: ADR-0076 accepted; `docs/GLOSSARY.md` created; `CLAUDE.md` reduced to
orientation with no counts or versions; README counts corrected (ADR count, unit count, Agent Skills adoption
count); the release-note block that opened `docs/SPEC.md` moved here verbatim (below) and replaced by a pointer
to PRODUCT-GUIDE and REQUIREMENTS until PR 5 rewrites SPEC as a layer map; two risk entries added (R-179 Jev
endpoint is alpha, R-180 `allowed-tools` is experimental in the standard). No code, contract or test changed.
Author's own read is the review for this docs-only PR, said here per rule 10.

Verification on this machine at `f3f4ae4` plus these edits: the two tests that read documents
(`risk-register-status`, `work-ledger-contract`) pass, 16 of 16. The full unit runner exits non-zero here
because `/usr/bin/bwrap` is absent: every failing case is in `effect-profile`, `dispatch-control` and
`dashboard-host-boundary` and fails with `ENOENT … /usr/bin/bwrap`; CI installs `bubblewrap` before the
suite. No other case failed. Required CI on the pull request is the merge gate.

Cross-session note for ADR-0077: the skill-harness session reported that its operator chose to consume the
advisors code as one small published package shared by both repositories (Decider interface, null decider,
Jev adapter, typed errors), not as a pi-daddy subpath export. ADR-0076 describes `advisors/` as an in-repo
layer; ADR-0077 must decide the package boundary and this is flagged to the operator before it is written.

### NEXT SESSION

1. **PR 2 — layers.** Create `kernel/`, `governance/`, `executors/`, `advisors/`, `products/` under
   `packages/pi-daddy/src` (and mirror in `extensions/`), move files, add the import-direction test red at the
   eleven sites listed in ADR-0076, make it green with hooks, not exemptions. No behaviour change; full unit
   and integration suites are the proof.
2. **PR 3 — one ledger, one state directory, `PI_DADDY_*` only, exports under ten, statement-count guard.**
   Ships as 0.30.0. skill-harness re-pins once (its session was told on 2026-09-21).
3. **PR 4 — skill-harness as optional versioned peer; contracts pruned.**
4. **PR 5 — SPEC rewritten as the layer map**, with the no-hex/no-PR-token test. First fresh-session probe.
5. Then PR 6 advisors (ADR-0077), PR 7 context handoff (ADR-0078), PR 8 selection/routing/signals, PR 9 the
   Jev handoff probe and the second fresh-session run.

The older NEXT SESSION block further down (dated 2026-09-04) is superseded by this list.

### Release-note paragraphs moved verbatim from `docs/SPEC.md` (2026-09-21)

## 2026-09-15 - completed ledger history visibility candidate

Isolated branch `codex/session-learning-20260915`, base `96fdbf2`. The operator confirmed six Pi
delegations were tracked; the compact renderer silently omitted roots beyond its three-root default.
ADR-0075 records a visible hidden-root count and local h/Enter history expansion/collapse, independent of
d/Enter governance Details. Expansion also reveals collapsed completed children. Active and attention
branches retain their ancestors even with compact limits set to zero. The connected daily/debrief route
keeps its existing semantics; the product guide now distinguishes the two display paths.

Candidate validation: 35 focused renderer, projection and CLI tests passed, including a real offline CLI
readline round trip. Five adjacent daily-panel and module-size checks also passed. TypeScript check and
`git diff --check` passed. Node 26.7.0 and the existing
product-delivery producer node_modules were reused through a local symlink without installs or dependency
changes. Tests identify the production behavior whose regression would fail each assertion.

This is synthetic offline display evidence, not an installed live-pane claim. No model calls, live
Pi/Herdr controls, mutation tests, commits, pushes, merge or publication were performed. Independent final
review remains pending; historical records and the immutable blueprint were preserved.

## 2026-09-15 — managed-install dependency follow-up for 0.27.2

PR54 merged and pi-daddy 0.27.1 published with matching archive bytes. Local update changed one package,
but final standalone discovery failed with ERR_MODULE_NOT_FOUND for the Pi SDK: Pi installs with
--legacy-peer-deps, whereas isolated qualification had explicitly installed that peer. That qualification
did not represent Pi's install mode. Evidence and immutable 0.27.1 remain preserved.

0.27.2 declares the SDK as a runtime dependency without changing its supported range or discovery code.
Installed smoke now omits peers and adds no SDK separately, so the former package declaration fails.
Review, CI, installed archive verification, publication and managed local verification remain gates.

Follow-up candidate evidence: corrected installed-package smoke passed using only the packed archive and
--legacy-peer-deps, including standalone CLI and configured skill references with no copies. Independent
Sol review of all eight changed files passed without findings; no dependency versions moved in the lock.

The first 0.27.2 CI run passed unit/integration checks but its stricter installed smoke exposed the same
runtime-dependency issue for TypeBox: local npm had hoisted an indirect copy, while CI correctly did not.
Both direct external runtime imports (SDK and TypeBox) are now declared as dependencies. Existing peer
contracts remain; no model calls or runtime logic changes are added.

Final dependency candidate: installed smoke also passes under Node24.19.0/npm10.8.2 with peer resolution disabled; no dependency versions changed. Fresh required CI remains the merge gate.

## 2026-09-15 — 0.27.1 configured runtime skill discovery candidate

At base `6bf5e167`, branch `codex/fix-package-skill-discovery-20260915` replaces setup's universal copying
with references to Pi-enabled installed/local runtime skills. Definitions, catalog and setup share a
read-only Pi package resolver; missing sources skip installation, disabled resources stay excluded, and
selected local overrides retain their ceilings. A malformed local override cannot expose a wider package
ceiling. Legacy unregistered npm scaffolding remains available. ADR-0074 records the reversal.

Local validation: 71 focused tests passed (`skill-resources`, `init`, `definitions`, `catalog`), TypeScript
check and package build passed, and `git diff --check` passed. No mutation suite, model call or user/Herdr
session was run. Node 26.7.0 and reused Pi SDK 0.85.1 dependencies were used without dependency installation.
The coordinator verified the required resolver/settings APIs in the published SDK 0.83.0 archive; the
existing peer floor is unchanged. Runtime testing of that older SDK is not claimed.

Independent coordinator filesystem/Pi checks passed for actual Principal 3.2.0 global and project installs:
seven skills, no project copies or Pi collision diagnostics, and matching definition/catalog source paths
through init, repeat and force. Evidence is retained outside source under the task's evidence directory.
Independent code review, required CI, merge, canonical archive qualification, publication/tag and local
installed update remain release gates; this entry is candidate evidence, not a publication claim.

Final candidate review addendum (same day): independent Sol review found two parser/reporting edges:
blank/comment-separated YAML collections and invalid UTF-8 before the frontmatter header. Both were
corrected with targeted regressions; the final independent verdict is PASS with no remaining actionable
findings. Final focused run: 72 passed; typecheck and build passed. Required CI/publication remain pending.

Required CI follow-up: the first PR54 run exposed an approval-persistence fixture that disabled the
entire Pi agent directory and a four-line module-size overrun. The fixture now obstructs only the
approval-cache parent; source comments were shortened without changing runtime behavior. Both affected
test files pass locally (36 tests). The failed CI logs are retained; the corrected commit requires fresh CI.

---

Entries before 2026-09-15 were moved verbatim to `archive/SESSION-LOG-2026-08-to-09-14.md` on 2026-09-21.
