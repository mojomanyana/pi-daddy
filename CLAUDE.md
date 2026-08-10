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

**Current state: BUILDING**, with two packages shipped under scoped gate waivers. Production code exists —
see `packages/`. `docs/ROADMAP.md`'s phase plan is obsolete and retained only as a record.

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
                            AWAITING YOUR DECISION: 0012 bash is a governance hole (measured escape),
                            0013 the pi-subagents reality gap, 0014 approval store is forgeable
docs/specs/               — capability-governance design (supersedes the blueprint's four artifacts)
docs/ROADMAP.md           — OBSOLETE phase plan, retained as a record
docs/gate-reports/        — /gate verdicts + the baseline report; the G0 report records both waivers
docs/reviews/             — TWO independent whole-codebase reviews + their cross-referenced aggregate.
                            THE AUTHORITATIVE BACKLOG: 12 groups, 5 closed. Read before planning work.
docs/probes/              — measurement probes: baseline/ (session history), pi-fabric-eval/ (11 probes),
                            approval-ux/, adr-0011-universal/, g1-argv/, g5-bash-escape/ (live vs real pi)
packages/pi-agent-grants  — THE PRODUCT (0.5.0): resolver, ledger, interceptor, delegate tool, catalog,
                            human approval for gated capabilities, bounded child processes
packages/pi-token-audit   — token/cost audit (0.1.0). ITS HEADLINE NUMBER IS WRONG: the "tool-definition
                            share" is a character ratio, not a token share (falsified 2026-08-10, G10)
```

## How To Work Here

- `/kickoff` — resume discovery: status snapshot, then interview on the highest-leverage open questions
- `/brainstorm <topic>` — option generation + strategist/critic stress-test on one topic
- `/validate <A-ID>` — execute one assumption's validation method, record evidence
- `/adr <title>` — create/progress a decision record
- `/gate` — evaluate the current gate (G0/G1), write a go/no-go report
- `/spec contracts|registry|lifecycle|scaffolding` — Phase D1 artifacts (refuses before G0 passes)

Subagents: `product-strategist`, `architecture-critic`, `research-scout`.

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

**`docs/SESSION-LOG.md`** — it carries current state, the measured facts not to re-litigate, the open
decisions, and the ranked next actions. Then **`docs/reviews/2026-08-10-aggregated-findings.md`**, which is
the **authoritative work backlog** — twelve groups from two independent reviews, five closed. Then
`ADR-0007` (the reframe) → `ADR-0008` (the invariant) → `packages/pi-agent-grants/README.md`.

Do **not** start from the BASELINE questions or the ROADMAP phase list — both belong to the retired thesis.

**Do not plan work without reading the review backlog.** It is easy to miss: it was committed to `main`
while feature work happened on a branch, so a worktree can legitimately not contain it. Several of its open
findings mean the guarantee this package advertises does not currently hold — most sharply, a child holding
`bash` can run `env -u PI_GRANTS_GRANT pi …` and create a completely **ungoverned** descendant.

**Facts established by measurement; re-deriving them wastes a session:** pi's default tool surface is only
`read, bash, edit, write` · pi's `--tools`/`--no-tools` hard-enforce even against `-e`-loaded extension
tools (this is the enforcement point) · `bash` subsumes the file/search tools, so a grant containing it is
not narrow · in pi-fabric, `recursive: true` overrides `tools: []` and `extensions: false`, so recursion and
containment are mutually exclusive there.
