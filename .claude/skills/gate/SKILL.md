---
description: Run the current pi-daddy phase gate (G0 or G1) — evaluate exit criteria from the roadmap and write a dated go/no-go report. Use when the user says "gate", "are we ready for the next phase", "go/no-go", or asks whether discovery is done.
---

# /gate — phase-gate evaluation

Evaluate the CURRENT gate from `docs/ROADMAP.md` (G0 if no passing G0 report exists in
`docs/gate-reports/`, else G1; refuse politely if both have passed — D2+ exit reviews are metric
reports, not gates).

## Procedure

1. **Collect evidence per checklist item** — from the documents only. Chat memory does not count;
   if an answer exists in conversation but not in `docs/01-discovery.md`, the item FAILS with note
   "answered but unrecorded" (then offer to record it and re-run).

2. **Evaluate honestly.** For each item: PASS / FAIL / WAIVED-BY-USER (waivers need the user's
   explicit say-so this session, recorded with their reason). Special checks:
   - No CRITICAL assumption may sit UNVALIDATED — ACCEPTED-UNVALIDATED requires the user's reason.
   - ADRs must be Accepted, not Proposed.
   - The kill-check (Q-KILL-1) must show evidence was actually weighed — a gate that can't fail
     is theater.

3. **Verdict:** GO only if every item is PASS or WAIVED. Otherwise NO-GO with the shortest path
   to GO: the ordered list of blocking items and which command clears each
   (`/validate A-02`, `/adr ADR-0002`, …).

4. **Write the report** to `docs/gate-reports/G<N>-YYYY-MM-DD.md`: checklist table with per-item
   evidence links, waivers with reasons, verdict, blocking path. Update the ROADMAP checkboxes
   to match reality.

5. **On G1 GO:** state explicitly that the no-production-code rule is lifted for spec'd work, and
   restate the MVP cutline sentence from the specs so D2 starts aimed.

## Constraints

- You may not waive items on the user's behalf; you may recommend a waiver and say why.
- A NO-GO is a good outcome when true — say so without apology.
