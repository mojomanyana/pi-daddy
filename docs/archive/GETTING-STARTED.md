# Getting Started — pi-daddy (WSL)

This is a standalone, self-contained project workspace for **pi-daddy** — capability governance for pi's
multi-level agent system, from your architecture handoff.

> **This page described the project as it started, and is out of date in one important way.** It said
> "documentation + Claude Code configuration only — zero implementation code, by design". **Production code
> now exists**: `packages/pi-daddy` (0.6.0) and `packages/pi-token-audit` (0.1.0), shipped under
> scoped gate waivers recorded in `docs/gate-reports/G0-2026-08-09.md`. The phase plan those gates belonged
> to is obsolete (`docs/ROADMAP.md`). Start from `docs/SESSION-LOG.md` and
> `docs/reviews/2026-08-10-aggregated-findings.md` instead of from this file.

It assumes nothing about any other repo. Drop it into any folder, rename the folder freely.

## What's in it

```
CLAUDE.md              # project memory for Claude Code (phase rules, file map, commands)
README.md              # what this project is and how the workflow runs
GETTING-STARTED.md     # this file
.claude/
  skills/              # /adr /brainstorm  (the discovery-era skills were removed 2026-08-11)
  agents/              # product-strategist, architecture-critic, research-scout
  rules/phase-gates.md # no production code before gate G1, docs-are-the-memory
docs/
  00-blueprint.md      # your handoff, verbatim (immutable source input)
  01-discovery.md      # question bank: BASELINE / WHY / WHAT / WHO / WHERE / WHEN / budgets / kill
  02-assumptions.md    # A-01..A-10 with validation methods
  03-risks.md          # R-01..R-10 with early-warning triggers
  04-landscape.md      # build-vs-leverage worksheet
  05-metrics.md        # baseline-first measurement plan
  06-decisions/        # ADR template + 3 open ADRs
  ROADMAP.md           # D0 → G0 → D1 → G1 → D2..D4
  gate-reports/        # the G0 verdict, written before /gate was removed
```

## Set up in WSL, step by step

> **Historical.** This describes the original bootstrap from a zip, when the project was documents
> only. The workspace is a git repository now (baseline commit `d8e4c47`), so there is nothing to
> unzip and nothing to `git init`. The folder name it used, `dtcm`, is the retired thesis name.

```bash
# 1. Get the workspace (it is already a repo; no remote is configured yet)
cd ~/projects/pi-daddy

# 2. Run the test suite to confirm the toolchain works
cd packages/pi-daddy && npm test && cd -

# 3. Launch Claude Code at the project root
claude

# 4. Inside Claude Code — read the state, then the backlog
#    (NOT /kickoff: discovery finished, and the phase plan it belongs to is obsolete)
```

Then read `docs/SESSION-LOG.md`, followed by `docs/reviews/2026-08-10-aggregated-findings.md` — the
authoritative backlog of what is still wrong.

If `claude` isn't installed in WSL yet, install it first (see Anthropic's Claude Code install
docs for the current command), then repeat step 3.

## Your first session, step by step

> **Historical — this whole section belongs to the retired thesis.** Discovery is finished, its BASELINE
> questions were answered, `/gate` passed G0 with two scoped waivers, and `docs/ROADMAP.md`'s phase list is
> obsolete. **`/kickoff`, `/validate`, `/gate` and `/spec` no longer exist** — they were removed on
> 2026-08-11 precisely because they would interview you about a programme abandoned in **ADR-0007**. For current work, go to `docs/SESSION-LOG.md` and the review backlog. The
> steps below are kept as a record of how the project was meant to start.

1. `/kickoff` — Claude reads the project state, shows a status snapshot, then interviews you
   starting with the ★★★ questions. Expect it to open with the BASELINE block — Q-BASE-1 (which
   repo/project is the "Pi Dev Agent" you're forking, and its license) — because almost
   everything else depends on that answer. Answers get written into `docs/01-discovery.md`;
   the files are the memory, not the chat.
2. When a question needs option-exploration first: `/brainstorm <topic>` — e.g.
   `/brainstorm Q-WHERE-2` (registry storage) or `/brainstorm MVP cutline`.
3. When a claim needs evidence: `/validate A-02` (cache economics) and `/validate A-01`
   (does tool-count actually degrade accuracy) are the two most decision-shaping ones.
4. Capture the baseline numbers early — `docs/05-metrics.md` §1 defines seven (B1–B7), measured
   on the unmodified baseline agent; probe scripts live in `docs/probes/`, never as product code.
5. Decide the three open ADRs (`/adr ADR-0001` …), then run `/gate`. A GO on G0 unlocks
   `/spec contracts|registry|lifecycle|scaffolding` — the blueprint's four Developer Directives,
   which land in `docs/specs/`. A GO on G1 unlocks actual implementation (Phase D2).

## Ground rules the kit enforces

> **The first rule below has been consciously waived twice**, for `pi-daddy` and
> `pi-token-audit`, both recorded in `docs/gate-reports/G0-2026-08-09.md`. The rest still hold, and the
> documentation discipline in particular is what makes this workspace navigable.

No production code before gate G1 — probes only, in `docs/probes/`. Every decision becomes an
ADR; every load-bearing claim gets an assumption ID; every answer is recorded in the docs.
`docs/00-blueprint.md` never gets edited — disagreements become assumptions, risks, or ADRs.
