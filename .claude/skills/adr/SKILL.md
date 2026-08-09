---
description: Create or progress a pi-daddy architecture decision record in docs/06-decisions/. Use when the user says "adr", "record this decision", "let's decide X", or a brainstorm/validation converged enough for a decision.
argument-hint: <title | ADR-NNNN>
---

# /adr — decision records

Input: `$ARGUMENTS` — a new title, or an existing `ADR-NNNN` to progress toward Accepted.

## New ADR

1. Number it: next NNNN in `docs/06-decisions/` (0001–0003 are seeded).
2. Copy `TEMPLATE.md`; fill Context from the actual state of `docs/01-discovery.md` /
   `docs/02-assumptions.md` / `docs/03-risks.md` — cite IDs, and say plainly when a critical
   input is still UNVALIDATED.
3. Options: minimum two, honestly weighed; steelman the one you'd reject. Where options differ on
   facts (not preferences), name the assumption/probe that would settle it — that's `/validate` fodder.
4. Status starts at Proposed. Never birth an ADR as Accepted in the same breath — acceptance is a
   deliberate second step.

## Progressing to Accepted

1. Check inputs: are the driver questions ANSWERED and blocking assumptions resolved? If not,
   list exactly what's missing and stop — an ADR accepted on hope is how R-08 happens.
2. Walk the user through Decision and Consequences; make the deliberate non-goals explicit.
3. Set a Revisit trigger tied to an observable (ideally an existing risk trigger in `docs/03-risks.md`).
4. Flip Status to Accepted with today's date; update any documents that quoted the old status
   (ROADMAP gate checklist, discovery answers).

## Constraints

- One decision per ADR. A decision that needs "and" twice is two ADRs.
- Superseding: never edit an Accepted ADR's Decision — write a new ADR and mark the old one
  Superseded by ADR-XXXX.
