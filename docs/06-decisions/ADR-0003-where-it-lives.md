# ADR-0003: Where It Lives — module in the fork, standalone service, or library

**Date:** 2026-08-08
**Status:** Proposed (OPEN — decide before G0)
**Driver:** Q-WHERE-1, Q-WHO-2, Q-WHERE-3, assumption A-10, risk R-08

## Context

The blueprint frames the system as middleware inside a forked "Pi Dev Agent". That leaves three
honest shapes for the Orchestrator + registry, with very different costs of being wrong. The
decision hinges on Q-WHO-2 (whose workflow integrates first) and A-10 (does the blueprint map
onto the baseline's loop without a rewrite).

**Input (2026-08-09, Q-WHO-1 + Q-WHAT-1 decision → ADR-0004):** The *shape* is now fixed even though
this ADR is not yet Accepted. Q-WHO-1 chose the OSS pi community as primary user, which requires a
one-command installable artifact; ADR-0004's Stage B is "one pi extension, npm/git-installable Pi
Package". That lands on **Option 1 minus the fork** — in-process, no network boundary, composing
through pi's documented extension seams rather than inside a modified agent core (Q-BASE-1 chose
build-on-as-dependency). **Option 2 (standalone service) is cut for v1** as adoption-zero for this
user and R-08 bait. **Option 4's spirit is retained at no cost:** the `05-metrics.md` §3 trace event
is the extraction seam, so a service can be carved out later if a second consumer appears.
Note also that Stage A's measurement harness is itself an extension, so instrumentation and product
share one integration surface — a single seam to maintain against pi's upstream velocity.
Still blocking acceptance: Q-WHO-2 (which concrete workflow integrates first) and A-10's one-page
module-boundary mapping with architecture-critic review.

## Options considered

### Option 1 — Module inside the forked agent
Fastest feedback against a real agent loop; no network boundary, no auth, no deploy story;
constrains the design to one agent's shape. Natural first consumer: the fork's own planner loop.

### Option 2 — Standalone middleware service (blueprint's shape)
Agent-agnostic from day one; any agent is a client; but ships a network boundary, auth, and a
deployment story before the core thesis is proven (R-08).

### Option 3 — Library/package the agent imports
No network hop, reusable across agents in the same language; locks consumers to that language;
cleanest testing story.

### Option 4 — Module-first with an extraction seam (1 → 2 later)
Build inside the fork behind a clean interface contract (the D1 `contracts` spec IS the seam);
extract to a service when a second real consumer exists. Preserves optionality at near-zero cost.

## Decision

_ (pending Q-WHO-2, A-10)

## Consequences

_

## Revisit trigger

A second real consumer appears (extraction case), or the fork integration proves the thesis and a
different first consumer emerges from Q-WHO-2's answer.
