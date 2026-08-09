---
description: Structured brainstorm on one pi-daddy topic (e.g. registry storage, eviction policy, MVP cutline) — diverge with strategist/critic subagents, converge to 2-3 scored candidates, record the outcome. Use when the user says "brainstorm X", "what are our options for X", or a discovery question needs option-space exploration before it can be answered.
argument-hint: <topic or Q-ID>
---

# /brainstorm — divergence → convergence on one topic

Topic: `$ARGUMENTS` (a free topic, or a question ID like `Q-WHERE-2` from `docs/01-discovery.md`).

## Procedure

1. **Frame it.** Read the relevant discovery question(s), linked assumptions, and any touching
   ADRs. Restate the topic as a single decision-shaped question plus its constraints (budgets
   from `docs/05-metrics.md`, the blueprint's position from `docs/00-blueprint.md`, and whatever
   is known about the baseline agent from the Q-BASE answers). Confirm the frame with the user in
   one sentence before diverging.

2. **Diverge — generate ≥4 options across distinct postures**, always including:
   leverage-first (adopt an existing platform/native capability), minimal-custom (smallest thing
   that moves the metric), blueprint-literal (what `00-blueprint.md` prescribes), and one
   contrarian option (including "don't do this at all" where sane).

3. **Stress in parallel.** Send the option set to the `product-strategist` subagent (value/user
   lens) and the `architecture-critic` subagent (failure/cost lens). Have `research-scout` fill
   any factual gaps (current library/platform capabilities) with sources and dates.

4. **Converge.** Score options against: metric impact (M1–M7), time-to-evidence, dev-loop cost,
   and reversibility. Present a ranked shortlist of 2–3 with one-line rationale each. Recommend
   one; say what evidence would flip the ranking.

5. **Record.** Append the outcome (frame, shortlist, rationale, evidence-to-flip) under the
   relevant question's Answer field in `docs/01-discovery.md`, or into the touching ADR's Options
   section if one exists. New load-bearing claims discovered → new rows in `docs/02-assumptions.md`;
   new failure modes → `docs/03-risks.md`.

## Constraints

- No production code. Probe sketches may be described, not built (build via `/validate`).
- Every option must state its cost in the currencies this project cares about: dev-loop
  complexity, new infrastructure, new language surface, cache/latency behavior.
