# Work capture/review contract — P07 input for P08

Owner: skill-harness. `work-case.schema.json` and `review-request.schema.json` are emitted from source-owned schemas. `fixtures/` comes from the actual case builder, archive and decision writer over seven synthetic layout incidents. These are not live captures, authenticated human statements or approved work.

## Host API

```ts
import { createWorkCaseReviewer } from '@skill-harness/adapters';
// An independently configured operator/controller selects this exact private archive, batch and author.
const reviewer = createWorkCaseReviewer(archiveRoot, batchManifestId, operatorIdentity);
const page = reviewer.list(0, 5); // total/offset/items; no writes, <=5 items per call
const history = reviewer.history(caseManifestId); // read-only; no decision is inferred
const result = reviewer.decide({ caseManifestId, priorDecisionId, disposition, note });
```

The caller must establish the legitimate operator and presentation/attention policy. This API is not a user authenticator, remote capability service or authorization for workers/adoption. A JSON case cannot supply the author, change batch membership or promote itself. Host callbacks can integrate this actual harness-owned writer with an existing dashboard; absent a genuine configured writer, UI actions must stay unavailable rather than writing a separate dashboard ledger.

- `list` returns `{total,offset,items:[{caseManifestId,candidate,priorDecisionId,disposition}]}`. Unselected cases do not become agreement. A skip remains skip/unresolved, not a positive label. Five is a per-call ceiling, not proof of the P08 per-pause budget; the presenter must enforce one overall budget including blind cards.
- `decide` accepts only the four schema fields. The selected batch bounds membership; author is fixed at host initialization. Unknown keys, stale prior IDs, invalid case state and altered history reject.
- Result is `{current:WorkCaseDecision,replayed:boolean}`. Exact replay does not overwrite a newer current decision. Corrections append a digest-bound chain and preserve prior records.
- Data lives in the existing private harness archive under `case-decisions/<caseId>/history.jsonl`, with a non-expiring owner-token lock at `case-decisions/<caseId>.lock`. First initialization occurs under that lock. Files/ancestors are checked, writes/directory entries synced, and another owner's lock is never removed.
- Missing/partial/invalid existing histories refuse further writes. No truncate, automatic stale-lock recovery, rollback or manufactured empty history is provided. A crash/cleanup failure can leave durable bytes and an error; inspect the exact case. Whole-directory rollback by a hostile same-user owner is not prevented or qualified.
- Case records stay silent/unresolved/causal-not-established. Labels do not alter P01 acceptance, grants, runtime control or scored specifications. Scenario promotion and independently verified calibration outcomes remain separate.

Schemas cover wire shape. The source case builder additionally checks canonical ID and cost/reason consistency; the decision writer validates chain identity and expected prior state. Rendering arbitrary caller objects is not validation.

## P08 presentation obligations

Use existing dashboard/plugin. A verified suitable pause (not every agent_end or guessed idle state) and explicit exposure/calibration policy are still required for automatic presentation. At most five total questions/cards, including blind-choice cards. Defer on unknown boundary/absence/budget exhaustion. Reconnect retains unresolved cards. Quality choice must precede cost/configuration reveal in the separate frozen comparison family; no live casting result is implied by these fixtures. No worker/status messages or observer steering.

Direct reproduction after compiler build:

```sh
node scripts/generate-work-case-contract.mjs --check
node node_modules/vitest/vitest.mjs run packages/core/test/work-capture.test.ts packages/adapters/test/work-case-review.test.ts packages/adapters/test/work-case-archive.test.ts
```

Actual integration, independent labels/attention policy and full P07/P08 acceptance remain pending.
