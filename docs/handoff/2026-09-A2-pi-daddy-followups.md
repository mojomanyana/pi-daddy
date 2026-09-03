# Wave 1 audit follow-ups — handoff

**Date:** 2026-09-03
**Branch:** `wave1/audit-followups`
**Baseline:** `c119dd7d0ae72656270eeeffb10b6268915a14bc`
**Release action:** none — do not publish, tag, or push from this handoff.

## Outcome

This wave reconfirmed each supplied finding against the baseline and repository rules before changing behavior. It adds fail-closed project-store loading, closed correlation inputs, model-catalogue preflight, the model-free real-pi CI tier, additive approval narrowing, consumer dependency metadata, root-safe tests, and corrected current-state documentation. Four architecture/runtime findings were decided rather than patched past their evidence.

No ledger event kind or event envelope changed. The strict v3 `capability_decision` refusal enum gained `GRANT_STORE_INVALID` and `MODEL_UNRESOLVED`, and correlation's existing fields became narrower. Generated strict-v3 consumers, including skill-harness, must re-pin to the regenerated contract/fixtures before consuming these events.

## Finding freshness

| Audit item | Freshness at `c119dd7` | Result |
|---|---|---|
| Malformed/unsupported/unreadable/wrong-CWD project grant store silently became absence | **CONFIRMED** | Loader now returns `absent | valid | refuse`; a refused store creates an empty governed root grant, not `*`, emits a loud startup notification, and appends `GRANT_STORE_INVALID` when the project ledger can be used. Explicit `PI_GRANTS_GRANT`, including the child channel, still bypasses the cwd store. ADR-0037 was amended append-only. |
| Correlation accepted arbitrary schema versions and arbitrary JSON `assurance_scope` | **CONFIRMED** | Runtime normalization, all three model-facing tool schemas, generated v3 schema, fixtures, and tests now admit only optional `schema_version: "1.0"` and the closed entire-run/selectors union. |
| Explicit child models were not resolved before side effects | **CONFIRMED** | A per-session callback uses pi 0.84.2's `ctx.modelRegistry.find(provider,id)` before approval, lease, or spawn. Misses append `MODEL_UNRESOLVED`; `PI_GRANTS_ALLOW_UNRESOLVED_MODELS=1` is an explicit operator bypass for custom providers. |
| CI did not execute real pi | **CONFIRMED** | `test:integration:ci` runs the 36 model-free, Herdr-free real-pi tests (`approval.it.ts` and `governance.it.ts`) on both CI Node versions. Workflow comments now distinguish that tier from local Herdr and paid-model tiers. |
| Current command/test counts and 0.21.0 release date were stale | **CONFIRMED** | Command-derived current counts are 739 unit, 48 default integration, 36 CI integration, 124 mutation guards, and 43 ADRs. 0.21.0 is dated 2026-09-02. Historical release-evidence counts remain historical. |
| Persisted approval ignored supplied tree/change state | **CONFIRMED** | ADR-0039 accepted and implemented the permitted additive form: optional `tree_sha` and `last_change_seq` join binding equality and digest only when supplied. This narrows replay but does not attest caller metadata or change the ledger wire. |
| Different lease directories permit split-brain writers | **CONFIRMED / OPEN** | Existing R-148 execution evidence remains valid. ADR-0040 chooses a Git-common-directory coordination point, but implementation is blocked on a positive host/container + linked-worktree probe. No lease behavior changed. |
| R-145 described an unbounded default approval wait | **CHANGED, core defect CONFIRMED** | The released default is now 120 seconds, not unbounded; an explicit configuration can still be unbounded, and the lease is still acquired before the dialog. ADR-0041 chooses approve-bound-destination, then acquire and revalidate. This requires non-additive binding/order/race work and was not implemented. |
| Mutable registry can repoint inherited `workspace:<id>` authority | **CONFIRMED / OPEN** | Probe g37 remains the reproduction. ADR-0042 chooses an inherited attenuating id-to-canonical-destination pin shared by process and Herdr propagation. Implementation is deferred until the prior failed design's gaps have a positive reversal and mutation coverage. |
| Root-unsafe chmod/dashboard tests | **CONFIRMED** | Root skips prevent false expectations where UID 0 bypasses mode checks. |
| Public declarations require `NodeJS.*`, but Node types were dev-only | **CONFIRMED** | ADR-0043 declares `@types/node >=22` as a non-optional peer contract; manifest and lockfile agree. |
| Named-check receipts are returned but not durably recoverable | **CONFIRMED / DOCUMENTED GAP** | SPEC now states that receipt persistence/retrieval remains the controller's responsibility; no unsupported persistence mechanism was invented. |
| Upstream principal run-state context | **PARTLY CHANGED at public source checked** | Public `principal-pi-skills` source at `a6596950d64a3a525f95329d5dbd3e38948be408` still tests run-state `schema_version === "1.0"`, but contains no `gate_evaluated` event. No pi-daddy compatibility behavior was changed on an unverified event claim; downstream must re-check the exact principal source/tag it intends to pin. |

## Before / after evidence

Baseline commands were run from `packages/pi-daddy` with HEAD printed in the same measurement session:

- `npm test`: **731 passed**
- `npm run typecheck`: **passed**
- `npm run test:smoke`: **passed**
- `npm run test:integration`: **47 passed** against real pi and Herdr

Candidate commands:

- `npm test`: **739 passed, 0 failed**
- `npm run typecheck`: **passed**
- `npm run test:smoke`: **passed**
- `npm run test:integration`: **48 passed, 0 failed** against real pi and Herdr
- `npm run test:integration:ci`: **36 passed, 0 failed** against real pi, without Herdr/model spend
- `npm run test:mutation`: **124/124 guards forced named failures** in a clean disposable committed snapshot
- `git diff --check`: **passed**

The first mutation attempt was invalid evidence: the disposable worktree linked only root `node_modules`, while the workspace-local `typebox` dependency was absent, so many named suites failed at import rather than on their mutations. The catalogue also correctly rejected five stale paths after the grant-store session refactor. The stale entries were re-pinned, both dependency locations were made available in the disposable worktree, and only the clean committed candidate rerun is reported above.

## Commands for the next operator

```bash
git branch --show-current
git rev-parse HEAD
cd packages/pi-daddy
npm test
npm run typecheck
npm run test:smoke
npm run test:integration
npm run test:integration:ci
# test:mutation refuses a dirty tree: run it only on a committed candidate or disposable committed snapshot
npm run test:mutation
cd ../..
git diff --check
git status --short --branch
```

## Critical review

The first specification review found five defects: chain preflight occurred after its upfront approval loop; model-facing schemas were not closed; an empty supplied tree value was omitted; legacy approval digests changed when new fields were absent; and the handoff evidence/counts were stale. Repairs added preflight to chain planning with a ledgered refusal, closed every tool-schema object, bound presence rather than truthiness, preserved the exact old digest serialization, and corrected the evidence.

Repair review then found that the paid chain abort fixture contradicted upfront preflight and that Herdr cleanup swallowed workspace-close failure. The fixture now uses a catalogue-accepted model that fails only in the child pi execution phase, and cleanup is awaited, parsed, and asserted. Two independent final critical reviews approved candidate tree `a7870641ed39fa805540ea15b1f7214d8bcb3c3d`; one was a complete whole-change quality adjudication. The final evidence-only handoff update does not alter product or test behavior.

## ADR scope

- **ADR-0039 — implemented:** optional caller-supplied tree state narrows persisted approval reuse.
- **ADR-0040 — decision only:** shared lease coordination under `gitCommonDir`, pending a positive probe.
- **ADR-0041 — decision only:** approval precedes exclusive acquisition, with destination binding and post-acquisition revalidation.
- **ADR-0042 — decision only:** inherited destination pins attenuate mutable workspace-ID meaning.
- **ADR-0043 — implemented metadata contract:** Node types are a non-optional peer.
- **ADR-0037 amendment — implemented:** invalid project stores fail closed and record a refusal where possible.

Do not describe ADR-0040/0041/0042 as shipped behavior. R-137, R-145, and R-148 remain open.

## Downstream re-pin notes

1. Regenerate or copy the exact v3 schema and fixtures before strict consumers ingest the two new refusal values or the narrowed correlation shape.
2. Skill-harness (or any generated strict enum consumer) must re-pin; no event-kind migration is needed.
3. Controllers supplying `tree_sha`/`last_change_seq` should expect exact-match approval reuse. Omission preserves prior behavior.
4. Custom model providers not visible through pi's session catalogue must set `PI_GRANTS_ALLOW_UNRESOLVED_MODELS=1` deliberately; this bypass is not inherited as model proof.
5. Verify the exact principal-pi-skills source/tag separately: public source checked here did not contain the reported `gate_evaluated` event.

## Workspace hygiene

The pre-existing untracked `.pi/` directory was not read, edited, staged, removed, or copied into disposable worktrees. No publish, tag, push, or GitHub mutation was performed.
