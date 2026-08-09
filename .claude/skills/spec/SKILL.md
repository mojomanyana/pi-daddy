---
description: Produce one Phase D1 design artifact for pi-daddy (contracts | registry | lifecycle | scaffolding) into docs/specs/. Refuses before gate G0 has passed. Use when the user says "spec the contracts", "design the registry schema", "state machine spec", or similar.
argument-hint: contracts | registry | lifecycle | scaffolding
---

# /spec — Phase D1 design artifacts (gated)

Artifact: `$ARGUMENTS` — one of `contracts`, `registry`, `lifecycle`, `scaffolding`.

## Gate check (do this first, always)

Look for a G0 report with verdict GO in `docs/gate-reports/`. **If none exists, refuse** —
kindly, with the current blocking list from the most recent gate report (or "no gate has been
run — start with `/gate`"). No exceptions: specs written before the ADRs are decided encode
guesses as architecture. Design sketches for exploration belong in `/brainstorm` output, not in
`docs/specs/`.

## Producing the artifact (post-G0)

1. **Inputs:** the Accepted ADRs (0001–0003 + any later), answered discovery questions, metric
   targets M1–M7, and the ROADMAP's "Done means" row for this artifact. `docs/00-blueprint.md`
   is reference material — where an ADR overrode it, the ADR wins; note each override inline.

2. **File:** `docs/specs/YYYY-MM-DD-<artifact>-design.md`. Shape: status header, decision table
   up front, schemas/diagrams inline with examples, deferred items listed with reasons.

3. **Every spec must carry:** the MVP cutline sentence at the top; its metric budgets as
   acceptance criteria; a test/eval plan; failure-mode handling (for `contracts`: stale-call and
   error semantics; for `registry`: source-of-truth + reindex triggers per R-07; for `lifecycle`:
   thrash guard per R-05 and a full transition table; for `scaffolding`: the dev-loop story and
   the integration path into the baseline agent).

4. **Review loop:** before declaring done, send the draft to `architecture-critic`; record its
   concerns and your dispositions in a "Review" section at the bottom. Unresolved H-severity
   concerns block done.

5. **Close:** update the ROADMAP D1 table status and tell the user which artifacts remain for G1.

## Constraints

- Specs contain schemas, diagrams, tables, examples — still no production code anywhere.
- One artifact per invocation; resist scope-merging (R-08).
