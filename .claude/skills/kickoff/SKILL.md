---
description: Start or resume a pi-daddy discovery session — reads project state, interviews the user on the highest-leverage open questions, and records answers into the docs. Use when the user says "kickoff", "continue discovery", "where were we", or wants to work the project without a more specific command.
---

# /kickoff — pi-daddy discovery session driver

You are driving Phase D0 of the Dynamic Tool & Context Management project.
Docs root: `docs/`. Honor `.claude/rules/phase-gates.md` at all times.

## Procedure

1. **Load state** (read, don't skim): `README.md`, `docs/01-discovery.md`, `docs/02-assumptions.md`,
   `docs/ROADMAP.md`, and the latest file in `docs/gate-reports/` if any. Build a one-screen
   status: questions ANSWERED/OPEN by criticality, assumptions by status, ADR statuses, baseline
   captured or not.

2. **Show the status snapshot first** — five lines max. The user must see where the project
   stands before being asked anything.

3. **Pick the 1–3 highest-leverage OPEN items.** Priority order: (a) the BASELINE questions if
   still open (everything downstream depends on them), (b) ★★★ questions whose answer unblocks an
   ADR, (c) CRITICAL assumptions whose validation method can start now, (d) the baseline metric
   capture if not yet done.

4. **Interview, one question at a time.** For each: give the question's context from the doc in
   your own words (two sentences), offer the option space if the doc lists one, and ask. Push back
   on vague answers — "internal for now, maybe OSS later" is not an answer to Q-WHO-1; primary
   means ONE. Where the user is unsure, offer to `/brainstorm` the topic or `/validate` the
   blocking assumption instead of forcing a guess.

5. **Record immediately after each answer** — edit `docs/01-discovery.md`: fill the Answer field,
   set Status, add a row to the answered-question log. If the answer validates/busts an
   assumption, update `docs/02-assumptions.md` with evidence. If it forces a decision, draft or
   update the ADR via the `/adr` flow. Answers live in files, not in chat.

6. **Close the session** with: updated status snapshot, what became decidable, and the single
   most valuable next command (`/validate A-0X`, `/brainstorm <topic>`, or `/gate` if G0 looks close).

## Hard constraints

- Never mark a question ANSWERED without text in its Answer field.
- Never write production code; measurement probes only in `docs/probes/`.
- If the user tries to jump to implementation ("let's just build the vector registry"), name the
  gate: G0 requires the ADRs decided first — then offer the fastest legitimate path to it.
