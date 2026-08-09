---
description: Run the validation method for one pi-daddy assumption (A-01..A-10) from the assumptions register and update its status with evidence. Use when the user says "validate A-03", "test the assumption about caching", or a gate is blocked on UNVALIDATED critical assumptions.
argument-hint: <A-ID>
---

# /validate — execute one assumption's validation method

Target: `$ARGUMENTS` — a row in `docs/02-assumptions.md`.

## Procedure

1. **Read the row.** Restate the claim, why it's doubtful, its validation method, and what's at
   stake (which gate/ADR it blocks). Set its status to IN-PROGRESS.

2. **Plan the validation before executing** — show the user: method, expected artifact, and the
   pass/fail line ("we call it VALIDATED if …"). Pre-registering the threshold prevents motivated
   reasoning after results land. Get a nod, then run.

3. **Execute by method type:**
   - **Research** (A-01 literature, A-03 provider behavior, A-08 capability scan): delegate to
     the `research-scout` subagent; require sources with dates; prefer primary docs over blog posts.
   - **Probe/benchmark** (A-01 catalog scaling, A-02 cost model, A-05 retrieval eval, A-07
     embedded store): write throwaway scripts ONLY under `docs/probes/<A-ID>/` with a README
     stating what it measures and how to rerun. Probes never become product code and nothing
     outside `docs/probes/` may import from them.
   - **Analysis** (A-09 failure modes, A-10 module mapping): produce the one-page artifact the
     method names, then have `architecture-critic` attack it before accepting.

4. **Judge against the pre-registered line.** VALIDATED, BUSTED, or — if evidence is genuinely
   mixed — keep IN-PROGRESS with the specific missing measurement named. The user (not you) may
   choose ACCEPTED-UNVALIDATED; record their reason verbatim.

5. **Record.** Update the register row (Evidence field links to the probe README / scout report /
   analysis doc), add a register-log row, and propagate: busted assumptions must be reflected in
   the touching ADRs and risks the same session. Report what the new status unblocks.

## Constraints

- A cited number without a source or a probe behind it is not evidence.
- Probes are deletable at any time.
