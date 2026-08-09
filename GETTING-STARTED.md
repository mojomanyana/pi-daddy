# Getting Started — pi-daddy (WSL)

This is a standalone, self-contained project workspace for the **Dynamic Tool & Context
Management** system from your architecture handoff. It is documentation + Claude Code
configuration only — zero implementation code, by design (that's Phase D2, behind two gates).

It assumes nothing about any other repo. Drop it into any folder, rename the folder freely.

## What's in it

```
CLAUDE.md              # project memory for Claude Code (phase rules, file map, commands)
README.md              # what this project is and how the workflow runs
GETTING-STARTED.md     # this file
.claude/
  skills/              # /kickoff /brainstorm /validate /adr /gate /spec
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
  gate-reports/        # /gate writes verdicts here
```

## Set up in WSL, step by step

```bash
# 1. Open your WSL terminal and create the project folder (rename as you like)
mkdir -p ~/projects/dtcm && cd ~/projects/dtcm

# 2. Get the kit in — Windows Downloads is reachable from WSL at /mnt/c
unzip /mnt/c/Users/alava/Downloads/dtcm-kit.zip -d .

# 3. Make it a repo so every discovery answer and decision has history
git init -b main
git add -A
git commit -m "pi-daddy: discovery kickoff kit (docs + Claude Code workflow, no code)"

# 4. Launch Claude Code at the project root
claude

# 5. Inside Claude Code — start discovery
/kickoff
```

If `claude` isn't installed in WSL yet, install it first (see Anthropic's Claude Code install
docs for the current command), then repeat step 4.

## Your first session, step by step

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

No production code before gate G1 — probes only, in `docs/probes/`. Every decision becomes an
ADR; every load-bearing claim gets an assumption ID; every answer is recorded in the docs.
`docs/00-blueprint.md` never gets edited — disagreements become assumptions, risks, or ADRs.
