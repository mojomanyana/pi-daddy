# ADR-0076: Consolidate pi-daddy into five layers with one ledger

**Date:** 2026-09-21
**Status:** Accepted (2026-09-21; the operator approved the five design sections and PR 1 in session)
**Driver:** the operator's restated goal (2026-09-21): pi-daddy should coordinate a session across agents,
runtime skills and context, not only govern the tool surface. R-08 (scope creep), R-58/R-59 (documents
describing behaviour the code no longer had), R-119…R-126 (fixes that claimed properties the code did not
have), R-144 (documents selling a deleted guard). ADR-0016 (this package is the spawner) and ADR-0008
(attenuation) are unchanged and are what this programme protects.

## Context

Measured at `f3f4ae4` (0.28.0), 2026-09-21. Every number below was produced by a command in the same
session; the roast that produced them is summarised here because an answer that exists only in chat does
not exist.

**Size and shape.** `src/` and `extensions/` hold 23,787 lines in 161 files; `contracts/` adds 10,631
lines of JSON Schema and READMEs; `test/` holds 22,697 lines and 1,117 `test()` calls. Clustered by role,
the grant-resolution, spawn, ledger, approval and executor code that implements the stated product is
about 9,200 lines. Dashboard, work DAGs, learning, debrief, experiment, factory, measured orders,
producer IPC, dispatch and intent control, and the activity timeline are 7,709 lines (32 percent) plus
nearly all of `contracts/`.

**The kernel is not pure.** Eleven import edges run from the governance path into that accretion:
`src/delegate.ts` imports `activity-timeline.ts`; `src/ledger-append.ts` imports four `work-ledger-*`
modules; `src/check-runner.ts` imports `execution-retention.ts`; `extensions/execute-child.ts` imports
`ordinary-runtime.ts`, `work-runtime.ts`, `execution-retention.ts` and `activity-timeline.ts`;
`extensions/session.ts` imports `work-command.ts`. The header comment of `extensions/grants.ts` still says
every decision lives in `src/` as a pure function.

**State and contracts have multiplied.** Ten append-only stores with distinct hash-chain formats; three
ledger schema versions (v2, v3, v4) all shipped; eight state locations under `.pi/`; twenty `PI_GRANTS_*`
and nineteen `PI_DADDY_*` environment variables; seventy `package.json` subpath exports; `intent-control`,
`execution-retention` and `debrief` each shipped in two versions side by side. `skill-harness` is not a
declared peer: it is discovered through a global symbol and refused unless its `sourceCommit` equals one
hard-coded hash (`src/dashboard-harness.ts:9`), so `/grants learning` and `/grants host` break on every
harness rebuild.

**The size guard has been gamed.** `test/file-size.test.ts` counts newlines only. Line 17 of
`src/measured-order.ts` is 1,815 characters; eight source files contain lines over 300 characters; twelve
files sit between 383 and 399 lines; the guard does not recurse into `src/vendor/`.

**Documents disagree with the code and with themselves.** `docs/SPEC.md` opens by promising "no history"
and spends its first 200 lines on release notes with commit hashes and "remains pending"; its heading names
a 0.27.0 release candidate inside a 0.28.0 package. `CLAUDE.md` and `README.md` say forty-three ADRs and
741 unit tests; there are seventy-five and 1,117. Sentences such as "the local P05 ordinary-boundary repair
now queues intent direction while an attached original ordinary child is busy" use work-package numbers
from a proposal that is not in the repository and model codenames ("Sol-approved") that are expanded
nowhere. `test/work-ledger-contract.test.ts:397-405` asserts that an ADR contains a date string, a
SHA-256 and two `### Option` headings; those assertions count toward the unit total.

**What a child receives.** The SKILL.md body and the task string. No parent conversation, no summary, no
context files (the `contextFiles` input exists in `planSpawn` but no user knob reaches it), no shared
memory. Chain handoff keeps the last 32 KiB of stdout; the DAG runner throws when predecessor output
exceeds 32 KiB; children run with `--no-session`, so their own transcripts are discarded.

**What the field does (sourced survey, 2026-09-21).** No surveyed harness enforces child ⊆ parent on the
tool surface: Claude Code forks take the parent's exact tool pool; LangChain deepagents permissions
"replace the parent agent's rules entirely"; tintinweb pi-subagents nest additively; Codex scopes by
sandbox mode; Claude Code's own skills documentation says `allowed-tools` "does not restrict which tools
are available". The differentiator ADR-0008 describes survives intact. Every surveyed competitor offers at
least one richer context channel: fork (`context: fork`, `mode="fork"`, `inherit_context`), a `memory:`
scope, files as shared memory with eviction, resumable and steerable children, worktree isolation, and
journaled replay. pi core already ships `--fork <session>`, `--session <path>`, `ctx.fork()`,
`ctx.compact()`, a `handoff.ts` example, and a subagent example that passes `--tools` from frontmatter.

**Decisions taken in the 2026-09-21 brainstorm** (the operator's answers, recorded so this ADR does not
re-litigate them): keep every user-facing capability, but contracts, stores, environment names and exports
may be reshaped and consumers re-pin once; the first coordination feature is context handoff to children;
"quality is fixed" means a fresh Claude or Codex session, given only README, SPEC, the glossary and this
ADR, can ship a small change to the delegate path without opening the session log or the risk register.
A fast non-generative decision model (TypeSafe Jev via OpenRouter) is to be usable at four decision
points, default off, toggled from the dashboard, with every use recorded.

## Options considered

### Option 1 — Layers first, then the feature (chosen)

Name the layers, enforce their direction with a test that starts red, consolidate stores, environment
names, exports and the harness dependency, rewrite SPEC once at the end, then build context handoff
inside the clean kernel. Costs five to eight pull requests before the first coordination feature lands.
Buys a feature built once on the shape it will keep, and a fair chance at the fresh-session test, which is
mostly a test of documents. Forecloses nothing.

### Option 2 — The feature pulls the cleanup

Build context handoff now, cleaning only what it touches (spawn, definitions, run-child, session), and let
each later feature clean its own path. Fastest to value. Steelman: this is how mature codebases are
usually improved, and it never spends a PR on pure restructuring. Rejected because SPEC would remain
unreadable, the products would remain wired into the spawn path, and the fresh-session test would fail on
documents alone. This is also the process that produced the current state.

### Option 3 — Strangler kernel

Copy the nine-thousand-line kernel into a clean `src/core/` with its own SPEC and repoint the extension;
products migrate later. Fastest clean kernel. Steelman: the copy can be reviewed as a whole and the
products never block it. Rejected because two copies of the kernel would exist during the transition, and
R-58, R-59 and R-144 are this repository's record of what happens when two copies of a truth diverge.

### Option 4 — Keep every public contract, clean internally only

Unminify, restructure modules and rewrite documents while keeping ledger v2/v3/v4, every `contracts/`
schema, every export and both environment prefixes compatible. Steelman: zero consumer churn. Rejected by
the operator: the only known consumer is `skill-harness`, which re-pins once, and compatibility would keep
all ten stores alive.

## Decision

pi-daddy is reorganised into five layers with a mechanically enforced import direction, its ten stores
collapse into one hash-chained ledger under one state directory, environment names and exports are
unified, `skill-harness` becomes an optional peer negotiated by version, the size guard counts statements
and caps line length, the documents are rewritten so that a fresh session can ship a delegate-path change
from README, SPEC and the glossary alone, and only then is context handoff built. Every user-facing
capability of 0.28.0 survives. The kernel's existing guarantees (ADR-0008 attenuation, ADR-0010/0014
approval integrity, ADR-0012's bash boundary, ADR-0016 spawner architecture) are unchanged; this ADR moves
code, it does not change what a grant means.

### The layers

| Layer | Contents | May import |
|---|---|---|
| `kernel/` | plan (delegate), spawn, run-child, propagation, resolve, definitions, catalog, capabilities, refusals, grant-env, chain, fanout, pi-tools | nothing above |
| `governance/` | ledger (one format), approvals and their store, grant store, leases, file-lock, correlation, check-runner | kernel |
| `executors/` | process executor; herdr start, poll, stage, cli, pane-reaper and vendored lifecycle | kernel, governance |
| `advisors/` | the `Decider` interface (`choice`, `score`, `noul`), a null decider, the Jev-over-OpenRouter adapter | kernel, governance |
| `products/` | dashboard, daily view, work DAGs, learning, debrief, experiment, factory, measured orders, producer IPC, dispatch and intent control, activity timeline | anything below |

One test reads every import in `src/` and `extensions/` and fails on any upward edge. It is added red at
the eleven sites listed in Context and made green by replacing each direct import with a hook: the planner
accepts an `extraChildEnv` contributor instead of importing the timeline; `execute-child` emits
`child_starting` and `child_settled` on one in-process bus that products subscribe to at session start;
`ledger-append` stops knowing about the work ledger, which subscribes to ledger events; `check-runner`
takes a retention callback; `session.ts` reads declared-work state through a product-registered provider.

**The advisors boundary.** Return types in `advisors/` carry no `Capability` type and no refusal code. No
kernel or governance function accepts an advisor result. An advisor's output can select, rank, annotate or
propose; it can never widen `effective`, satisfy a gate, or replace a human answer. This restates the
project's rule that no model sits on the security path, and it matches the decision model's own
documentation ("treat probabilities as signals, not authorization"). Two further decisions are deferred to
their own records so that each has one decision and one revisit trigger: **ADR-0077**, advisors are advice
(the decision points, the settings block, the advice event and its privacy rule), shipping with the
advisors layer; **ADR-0078**, context handoff is an attenuating dimension (the five modes and the inherited
ceiling), shipping with the handoff feature. Both must respect the boundary fixed here.

### The consolidation checklist

Each row is marked done by the pull request that closes it.

| Today | After | PR |
|---|---|---|
| Ten append-only stores; ledger v2, v3, v4 all written | One hash-chained `ledger.jsonl` with event kinds `capability`, `lifecycle`, `approval`, `lease`, `work`, `control`, `experiment`, `activity`, `advice`; one writer, one reader with kind filters; a read-only importer for the old `.pi/grants.jsonl` for one minor release, then no legacy readers | 3 |
| Eight state locations under `.pi/` | One directory `.pi/pi-daddy/` holding `ledger.jsonl`, `settings.json`, `grant.json`, `approvals/`, `content/` (content-addressed blobs, shared by retention, activity content and later the artifact store). `.pi/grants.env` is retired in favour of `settings.json` | 3 |
| Twenty `PI_GRANTS_*` and nineteen `PI_DADDY_*` variables | `PI_DADDY_*` only; old names read with a one-line deprecation warning for one minor release, then dropped | 3 |
| Seventy subpath exports | Under ten: root, `kernel`, `ledger`, `approvals`, `executors`, `dashboard`, `work`, `learning`, `advisors`, plus `contracts/*` for schemas skill-harness consumes | 3 |
| Line-count guard; eight files with lines over 300 characters | Statement-count guard, 120-character line cap, recursion into `vendor/`; files reformatted in the PR that touches them | 3 onward |
| `skill-harness` pinned to a commit hash through a global symbol | Optional peer with a version range; bridge negotiated by a version field; when absent, `/grants learning` names what to install | 4 |
| `contracts/` in v1 and v2 side by side, 10,631 lines | One current version per family; retired versions under `docs/archive/contracts/` with a README naming the last release that wrote them | 4 |
| Tests asserting document prose | Deleted, not migrated; the unit count drops | 3 |
| Comments citing risk numbers | One sentence of intent at the site; the register keeps the history; done file by file as files are touched | 2 onward |
| SPEC.md: 1,465 lines of layered release notes | One section per layer answering: what it does, what it guarantees, what it does not do, which files hold it. Present tense. A test asserts no hex string of seven or more characters and no `PR #` token | 5 |
| Undefined nouns (P01…P15, Sol, Terra, quiescence, ordinary, original, exact, producer, factory order, measured order, debrief, blind, attention slot, trust store, skill-harness) | `docs/GLOSSARY.md`, one line per term, linked once from SPEC, PRODUCT-GUIDE and REQUIREMENTS; retired terms say what replaced them | 1 |
| CLAUDE.md carries counts and versions that go stale | Orientation only: three sentences on the product, the layer names, hard rules, start-here order, measured facts about pi and Herdr | 1 |

### Sequence and versioning

1. Truth and glossary: this ADR, `GLOSSARY.md`, corrected SPEC counts and headings, release-note paragraphs moved to the session log, CLAUDE.md shrunk. Docs only.
2. Layers: directories, moves, the import-direction test red then green. No behaviour change; the full unit and integration suites are the proof.
3. One ledger, one state directory, environment rename, exports collapsed, statement-count guard on. Ships as **0.30.0** because it breaks the ledger format, environment names, state paths and exports; `skill-harness` re-pins once.
4. `skill-harness` as an optional peer; contracts pruned.
5. SPEC rewritten as the layer map with its drift test. First fresh-session probe run here.
6. Advisors layer, null decider, Jev adapter, settings block, dashboard toggle pane, advice rows, live tier behind `PI_DADDY_IT_JEV=1`. Carries ADR-0077.
7. Context handoff: modes, ceiling, staged fence, ledger field, integration tests against a real pi child. Carries ADR-0078.
8. Output selection, routing proposal, signals: one to three additive PRs.
9. Jev handoff probe under `docs/probes/jev-handoff/` and the second fresh-session run.

Each PR takes rule 10's independent review pass. Every new guard names the production change that would
break it; the import-direction test, the SPEC drift test and the statement-count guard all start red on
today's tree.

## Consequences

**Positive.** The kernel becomes a nine-thousand-line unit a session can hold in context, with a test
that keeps it that way. One ledger means one reader, one dashboard projection and one place to see grants,
lifecycles and advice side by side. A fresh session has a finite, present-tense description of the product.
Context handoff is built on a spawn path that has no hidden subscribers.

**Negative.** Five to eight pull requests of restructuring precede the first coordination feature. 0.30.0
breaks the ledger wire, environment names, state paths and exports; `skill-harness` and any private
consumer must re-pin. Deleting the prose-asserting tests lowers the unit count, and the count has been used
as release evidence. Comments lose their risk-number breadcrumbs; the register remains, but the link from a
line of code to its history now goes through `git blame`.

**Neutral.** Historical documents are untouched: every ADR, the risk register, the session log and the
archive keep their wording, including "DTCM" and the P-numbers, because rule 2 and rule 4 of
`docs/WORKING-RULES.md` apply. The layering does not change any refusal code, ledger event semantics for
grants, or the argv a child receives.

**Deliberate non-goals.** No user-facing capability is deleted. No automatic retry or controller recovery
is introduced. `bash` containment remains the operating system's job (ADR-0012). No advisor ever
authorises anything. Resumable children, worktree isolation and a shared artifact store are recorded as
the next candidates after this programme, not part of it; the content-addressed blob directory is the only
brick laid for them here.

## Revisit trigger

Any one of these reopens the decision:

- The second fresh-session probe (after PR 7) fails because the session had to open the session log or
  the risk register to ship a delegate-path change. That means the documents, not the code, are the
  bottleneck, and the sequence should be re-cut around them.
- A pull request adds an exemption to the import-direction test rather than a hook. One exemption is the
  first of eleven.
- A type in `advisors/` gains a `Capability` field, a refusal code, or is accepted by any function in
  `kernel/` or `governance/`. That is the boundary this ADR exists to fix, and crossing it is a new decision
  that needs its own record.
- Programme cost exceeds twelve pull requests before PR 7 lands. R-08's scope-creep trigger applies to the
  cleanup itself.

## Amendment 2026-09-21 — what PR 2 found when the layers were cut

Recorded the same day, after the move, because the Decision above states two things the move corrected.

**`extensions/` is the composition layer, together with `src/index.ts` and `src/cli.ts`.** The Decision says
extension files are "split the same way". They are not: they are wiring, they import from every layer, and
twenty-five of them import the `GrantsSession` type from `extensions/session.ts`. Moving them into
subdirectories would have changed the path pi loads (`pi.extensions` in `package.json`) and the `-e` path a
child receives, for no gain in enforcement. The layering test treats `extensions/**` and the two root files
as composition, permitted to import anything and forbidden to be imported by any layer. A third file at the
`src/` root is refused.

**Classification refinements, all recorded in `test/layering.test.ts` by directory:** the `work-ledger-*`
family, `execution-retention`, `retention-contract`, `retention-json`, `native-session` and `init` are
governance (they are stores and their readers, not products); workspace routing, pure approval resolution
(`approval`, `delegation-approval`), `correlation`, `execution-id`, `ledger-identifiers`, `skill-resources`,
`skill-packages` and `progress` are kernel; `vendor/herdr-pi-lifecycle.ts` is under executors and
`vendor/adoption.ts` under products. `ExecutorKind` and `EXECUTOR_KINDS` now live in `kernel/delegate-types.ts`;
`executors/executor.ts` re-exports them.

**The "eleven import edges" figure was the code map's clustering, not the layering test's.** After the move
the test reported seven upward edges. Three were the `ExecutorKind` type (moved into the kernel); two were
`execution-retention` importing `native-session` (resolved by classifying `native-session` as governance);
one was `kernel/workspace.ts` re-exporting the lease functions (removed; `governance/workspace-public.ts`
keeps the `pi-daddy/workspace` subpath whole so no consumer loses an export); one was the planner importing
the activity timeline, replaced by the `childEnv` hook the Decision describes. The kernel refuses any hook
key in the `PI_GRANTS_` namespace or already set, so the hook cannot widen what a child inherits, and a test
forces that refusal. The other hooks the Decision anticipated (`execute-child`, `ledger-append`,
`check-runner`, `session.ts`) were not needed: those edges disappeared under the classification above or
because their importer is composition.

**Public surface.** Export keys in `package.json` are unchanged; their `dist/` targets moved with the files.
Root exports are unchanged. The `DelegationContext.activity` field is gone from the planner's public type,
replaced by `childEnv`; that is the one type-level change a direct `planDelegation` consumer would notice.

## Amendment 2026-09-21 — PR 3 is three pull requests, and what the store inventory changed

**PR 3 lands as 3a, 3b, 3c and 3d.** The consolidation row set was one pull request in the Decision; an
inventory of the stores (below) and the size of the formatting change made one change unreviewable. 3a:
formatter, guards, prose-asserting tests deleted. 3b: `PI_DADDY_*` only with an explicit governance key list,
exports under ten. 3c: one project state directory, `grants.env` retired, user-level stores under one
`pi-daddy/` directory. 3d: one record format and one reader, version 0.30.0. (Amended the same day: the
state-directory move touches init, the stores, the smoke test and forty ledger-path assertions, so it left 3b.)

**3c decisions (2026-09-21, operator).** The user-level grant store and approvals move under one `pi-daddy/`
directory **without migration**, following ADR-0020's precedent literally: a session names the old location and
asks for `/grants init` or a fresh approval; nothing copies authority. `settings.json` is the one committable
file in `.pi/pi-daddy/`; init writes a `.gitignore` beside it excluding everything else. The default child
timeout rises from twenty to sixty minutes now (ADR-0038 dated note), and an inactivity-based deadline on pi's
JSON event stream is scheduled as **PR 3e**, after the format change, because a `pi --print` child gives the
parent no activity signal until it exits. Each takes
rule 10's review pass; the checklist rows stay as written with their PR column read as 3a/3b/3c.

**The inventory found twenty-one stores, not ten, and the grants ledger has no hash chain at all.** The only
chained journals are the control journal, the experiment store and the measured-order journal, and all three
refuse by policy to live under `.pi/` because they hold private controller state under
`~/.local/state/pi-daddy/`. Several stores pin device and inode identity and a header line into their binding,
and the work ledger refuses any path that aliases the grants ledger. So the Decision's "one hash-chained
`ledger.jsonl`" for everything would reverse a privacy policy and break every existing binding. The operator
chose, on 2026-09-21: **one record envelope, one reader library and one project state directory; the private
controller journals keep their location and adopt the same format.** The dashboard reads all of them through
one projection. The checklist row "one hash-chained ledger.jsonl" is read accordingly.

**The environment rename collides with the kernel guard.** Products already use `PI_DADDY_*`, so after the
rename the `childEnv` guard cannot refuse by prefix. The operator chose: the kernel exports the closed list of
governance keys (grant, depth, max depth, gated, approved, ledger, fan-out, parent id, execution id, herdr,
child timeout), the guard refuses exactly those plus any key already set, and a test asserts the list equals
what propagation writes.

**The 120-character cap is enforced by Prettier, not by the guard.** 41 files had lines Prettier could not
break (string literals, regexes, comment prose) or minified embedded scripts. The operator chose Prettier at
width 120 as a root dev dependency with a CI check. The module guard counts statements (ceiling 400, the
largest file measured 395) and caps any line at 200 characters, which is below every minified line found
(300 to 1,815) and above every legitimately unbreakable one after the seventeen longest were split. Vendored
files are excluded from formatting because their bytes are hash-pinned; the first formatting run caught that by
failing the adoption-pin test.
