# pi-daddy — capability governance for pi's multi-level agent system

## What This Project Is

**Capability governance for pi's multi-level agent system.** A top orchestrator holds a catalog of tools
and skills; when it delegates, it grants each sub-agent a deliberate subset and withholds the rest.
Sub-agents may delegate further, but only ever a subset of what they themselves hold. Enforced by pi's own
`--tools` allowlist, with an append-only ledger of grants and refusals.

**Reframed 2026-08-09 (ADR-0007).** The blueprint justified itself on *context bloat / token cost*, and
discovery took that as the goal — building a measurement programme that correctly falsified it at gate G0.
The actual goal was always **narrowing control over sub-agents**, which is what the blueprint's
*architecture* (Top Agent → Orchestrator → provisioning) described. Judge work on **control correctness**,
not on token savings. The name "Dynamic Tool & Context Management" describes the retired thesis.

**Renamed 2026-08-10.** The project is **pi-daddy**. "DTCM — Dynamic Tool & Context Management" named the
token-economics thesis that ADR-0007 retired, so it was replaced everywhere the name is *operational* —
this file, `README.md`, `GETTING-STARTED.md`, and everything under `.claude/`.

**"DTCM" is deliberately left intact in the historical record**: every ADR, `01-discovery.md`,
`02-assumptions.md`, `03-risks.md`, `04-landscape.md`, and `ROADMAP.md`. Those mentions *are* the retired
thesis — "DTCM's MVP is staged", "park the DTCM initiative" — and rewriting them would erase the evidence
of the thing that was abandoned, which is the one thing those documents exist to preserve. **Do not
find-and-replace them.** A register entry describes what was believed on its date; renaming it makes the
record lie.

**Current state: SHIPPED AND HARDENED.** `pi-agent-grants` **0.6.0** and `pi-token-audit` **0.1.0** exist
under scoped gate waivers; `docs/ROADMAP.md`'s phase plan is obsolete and retained only as a record.
**All twelve groups of the review backlog are closed**, and fourteen ADRs are decided — the last three
(0012/0013/0014) on 2026-08-10/11.

**What the product claims, precisely** — this wording is load-bearing and was narrowed deliberately by
ADR-0012: it governs the **tool surface**, i.e. which tools pi exposes to a model, enforced structurally by
pi's own `--tools` allowlist. It does **not** contain an agent holding an execution primitive: a child with
`bash` can run `env -u PI_GRANTS_GRANT pi …` and get an ungoverned descendant (measured —
`docs/probes/g5-bash-escape`). Containing that is the OS's job and is out of scope.

## Where Things Live

```
docs/SESSION-LOG.md       — START HERE when resuming: state, verified facts, open decisions, next actions
docs/00-blueprint.md      — the architecture handoff, verbatim (immutable source input)
docs/01-discovery.md      — question bank; Q-WHY-1 and Q-WHAT-1 carry RE-ANSWERED blocks after the reframe
docs/02-assumptions.md    — assumptions register (A-01..A-16) with validation methods + statuses
docs/03-risks.md          — risk register (R-01..R-26); note R-17 is INVERTED (the boundary is the feature)
docs/04-landscape.md      — build-vs-leverage; TWO matrices — the first surveys the wrong shelf, see the note
docs/05-metrics.md        — measurement plan; M1/M2 cost metrics retired by ADR-0007
docs/06-decisions/        — fourteen ADRs, reversals kept: 0004→superseded, 0005 park→superseded, 0006
                            unpark (its magnitude claim falsified 2026-08-10), 0007 THE REFRAME, 0008
                            attenuation invariant, 0009 pi-fabric (parked), 0010 approval semantics,
                            0011 universal capabilities on both spawn paths.
                            0012 bash is a governance hole, 0013 the pi-subagents reality gap,
                            0014 approval store forgeable — all three ACCEPTED and IMPLEMENTED
docs/specs/               — capability-governance design (supersedes the blueprint's four artifacts)
docs/ROADMAP.md           — OBSOLETE phase plan, retained as a record
docs/gate-reports/        — the G0 verdict + baseline report (from the removed /gate); records both waivers
docs/reviews/             — TWO independent whole-codebase reviews + their cross-referenced aggregate.
                            The backlog that drove the hardening: 12 groups, ALL CLOSED. Read for context.
docs/probes/              — measurement probes, all live against real pi: baseline/, pi-fabric-eval/ (11),
                            approval-ux/, adr-0011-universal/, g1-argv/, g5-bash-escape/,
                            g13-subagents-coupling/
docs/proposals/           — pi-subagents-tools-parameter.md — DRAFTED FOR THE USER TO FILE UPSTREAM
packages/pi-agent-grants  — THE PRODUCT (0.6.0): resolver, ledger, interceptor, delegate tool, catalog,
                            human approval for gated capabilities, bounded child processes
packages/pi-token-audit   — token/cost audit (0.1.0). ITS HEADLINE NUMBER IS WRONG: the "tool-definition
                            share" is a character ratio, not a token share (falsified 2026-08-10, G10)
```

## How To Work Here

- `/adr <title>` — create or progress a decision record. **The workhorse; use it for anything that
  changes what the product claims.**
- `/brainstorm <topic>` — option generation plus a strategist/critic stress-test on one topic.

Subagents: `product-strategist`, `architecture-critic`, `research-scout` (advisory only; they never edit).

**`/kickoff`, `/validate`, `/gate` and `/spec` were removed on 2026-08-11.** They drove the discovery
programme ADR-0007 retired — `/kickoff` would have interviewed you about a falsified thesis and `/spec`
refuses until a gate passes that no longer means anything. They are in git history if ever needed.

```bash
cd packages/pi-agent-grants
npm test                   # 222 unit tests — fast, pure, no pi, no network
npm run typecheck          # src + extensions + tests + integration tests
npm run test:integration   # 8 tests vs a REAL pi process — ~17s, no model tokens
npm run test:smoke         # pack, install into a scratch project, import and USE it
PI_GRANTS_IT_MODEL=1 npm run test:integration   # + 3 end-to-end with a real model (~60s, costs money)
```

## Hard Rules

- **Phase discipline:** D0 (discovery) → G0 → D1 (specs) → G1 → D2+ (code). No production code
  before G1 — see `.claude/rules/phase-gates.md`. Probes only under `docs/probes/`.
- **Files are the memory.** Decisions → ADRs; claims → assumptions register; failure modes → risk
  register; answers → `docs/01-discovery.md`. An answer that exists only in chat does not exist.
- **The blueprint is immutable.** `docs/00-blueprint.md` is source input; disagreement is recorded
  beside it, never edited into it.
- **Terminology:** "workflow skills" = `.claude/skills/` (process tooling for this workspace).
  The agent-runtime tools/skills this project will eventually manage are called "tools" or
  "runtime skills" in specs — never bare "skills" where it could be ambiguous.

## Start Here

**Read `docs/SESSION-LOG.md` first** — newest entry on top. It carries current state, the facts not worth
re-deriving, and **`## NEXT SESSION`**, which is the ranked list of what is actually left. Then
`ADR-0007` (the reframe) → `ADR-0008` (the invariant) → `packages/pi-agent-grants/README.md`.

`docs/reviews/2026-08-10-aggregated-findings.md` is the twelve-group backlog from two independent reviews
that drove all the hardening. **All twelve are closed**, so read it for context and rationale rather than
as a work queue.

Do **not** start from the BASELINE questions or the ROADMAP phase list — both belong to the retired thesis.

**Facts established by measurement; re-deriving them wastes a session.**

*About pi:*
- Default tool surface is only `read, bash, edit, write`. There is **no native subagent tool** in pi core.
- `--tools` / `--no-tools` **hard-enforce**, including against `-e`-loaded extension tools. **This is the
  enforcement point**, and it is the reason no runtime is needed inside a descendant.
- `bash` subsumes the file/search tools, so a grant containing it is not narrow — and a child holding it
  can create a wholly **ungoverned** descendant (`docs/probes/g5-bash-escape`).
- A model-controlled string must never occupy an argv position pi parses: `@file` is read **before any
  tool exists**, so `--tools` cannot stop it (`docs/probes/g1-argv`).
- `AgentToolResult` has **no `isError` field**. pi sets it only when `execute` **throws**; a returned
  `isError: true` is silently discarded.
- `pi.getAllTools()` is available to an extension immediately; the first-provider-request tool array is not.
- Node refuses to strip types under `node_modules`, so library entry points must be compiled. **pi's own
  loader has no such limit** and reads extension TypeScript from `node_modules` fine.

*About `@tintinweb/pi-subagents` (0.14.3):*
- Its children are **in-process** `AgentRecord`s — `child_process` appears only in `worktree.ts`, for git.
  So `propagation.ts`'s race-freedom argument holds on the `delegate` path only.
- Its live agent registry is **unreachable** from another extension: importing the same path yields a
  different module instance (`docs/probes/g13-subagents-coupling`).
- `SpawnOptions` has **no `tools` field**, and the supported RPC is `ping`/`spawn`/`stop` only. So the
  interceptor can **refuse or allow, never narrow** — until the upstream proposal lands.
- `subagents:rpc:spawn` **bypasses `tool_call` entirely**, so an extension hooking it cannot see those
  spawns at all.

*About `pi-fabric` (evaluated, not installed):*
- `recursive: true` overrides `tools: []` *and* `extensions: false`, so recursion and containment are
  mutually exclusive there.
