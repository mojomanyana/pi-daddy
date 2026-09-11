# ADR-0060 — Declared work joins ordinary execution

**Status:** implemented on the post-0.23.0 continuation branch; not released.

## Context

Work-v4 could project obligations and attempts, but a person had to construct ledger JSON and ordinary delegation emitted no work occurrence. The dashboard therefore had nothing truthful to show for normal work.

## Decision

Add `pi-daddy work add --id <id> --outcome <text>`. It writes a digest-only scope, policy, goal, obligation and selected snapshot to `.pi/work.jsonl`, plus a validated current-selection file. Outcome text is not retained. Repeating the exact declaration is idempotent; reusing the id for changed text refuses.

The loaded extension validates that selection at session start. Ordinary governed delegation then appends observed `starting` and terminal occurrences at its real execution boundary using the execution/parent/logical-child identity already assigned by the spawner. Terminal observation failure remains visible as a control failure rather than erasing a completed result. Runtime completion does not create acceptance.

Tool-call IDs outside work-v4's identifier grammar are represented by a labelled SHA-256 join; the exact value remains in execution retention. Missing or malformed declaration state leaves execution unbound and is reported rather than substituting old work.

## Evidence and limits

Red-first tests cover declaration privacy, exact retry, changed-outcome refusal, malformed/relocated state, occurrence idempotence and a real ordinary executor boundary. A bounded live occurrence on `openai-codex/gpt-5.6-sol` produced one child result and one attached completed attempt in the dashboard. It does not establish acceptance, archive coverage, arbitrary parent-session attribution, or concurrent variants.
