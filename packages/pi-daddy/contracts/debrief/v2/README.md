# Explicit work-signal and durable blind host integration

Additive P08 integration; v1/manual case-v2 remains unchanged by default. No provider, automatic
worker prompt, attention hook, Herdr control, model evaluation, routing or acceptance is introduced.

## Actual host boundary

`pi-daddy/debrief-host` (also root exports) accepts a trusted host's loaded harness modules:
`createWorkCaseReviewer`, `createWorkSignalReviewer`, `retainBlindIntervention`, `openBlindIntervention`.
The actual tested source is skill-harness638494af0a0058edf9a9b1b02e57af894ab46ed6. Exact source bodies,
SHA256 pins and ordinary isolated compilation are in test/fixtures/debrief-durable-host; upstream
contracts are retained beside this README. No dependency install, dynamic worker module loader,
replacement archive/decision ledger, cached permission or fake authenticated operator is supplied.
The structural DebriefHarness interface is NOT runtime module authentication: loading/provenance and
independent host authorization remain host obligations. No caller pin string can authorize a writer.

```ts
// Explicit host action, with independently configured author and private archive.
const blind = retainDebriefBlind(harnessPorts, archiveRoot,
  { manifest, evidence, qualification }, author);
// Retain blind.comparisonId AND author independently before reconnect/exposure.
const preview = openDebriefBlindPreview(harnessPorts, archiveRoot, blind);
// preview has ONLY view/readArtifact/quality, never archive metadata/choose/reveal.
const presenter = createRetainedDebrief(harnessPorts, {
  archiveRoot, author, blind, scope: retainedAttentionScope, persistence: hostAttentionCAS,
  cases: { version: 'work-signals-v1', batchId, observationId }, offset: 0,
});
await presenter.open({mode:'manual', userPresent:true});
// Existing dashboard presenter/actions, after explicit manual requests:
await presenter.choose({kind:'one', labels:[opaqueLabel]});
await presenter.reveal();
```

Retention freezes private inputs through the actual adapter, including independent private random seed.
It is never implicit during open/reconnect. Reconnect binds the original comparison ID/author and reads
`quality()`, NOT `reveal()`, to discover an existing vote. The adapter re-reads original inputs/artifacts
on every access; missing/corrupt input or immutable choice refuses. Different choices remain refused
across presenter/process restarts. Same-choice replay does not create another vote. A required write/sync
failure remains failure even when complete choice bytes subsequently exist; explicit reopen may observe
those original bytes without another writer call or automatic reveal. No crash durability is inferred.

Only opaque labels, verified artifact previews and explicit quality state reach the pre-reveal blind card.
Private seed, raw roles, costs/configuration and archive metadata do not. Arbitrary artifact content can
still disclose identity; this is not universal redaction or a real blind study. The existing bounded
consumer supports2..4 arms, up to4 artifacts/card and64KiB/artifact, with320-character previews. Larger
producer comparisons are refused, not silently truncated into a qualified study.

## Signal cases and attention

`cases.version:'work-signals-v1'` explicitly invokes createWorkSignalReviewer. Its page includes the exact
independent observation ID and issues, even with ZERO cards. Counts are SELECTED BATCH counts (<=1024),
not all live work or calibration denominators. Pages are<=5. Case-v3 reasons/metrics/IDs are validated
against the pinned formula; case-v2 coverage issues remain coverage, not defect labels. Existing v2
reviewer/batches are not silently reinterpreted. `work-case-v2` explicitly selects the old route.

The signal reader rederives exact case membership from the original retained observation; foreign cases,
old/wrong batch, malformed/missing input and stale author/CAS cannot become labels or promotion. Labels
use the existing durable decision writer/history and exact evidence/author/prior decision digest.
Skip, uncertainty, deferred/busy/absent context and unselected cards remain unresolved.

One blind question consumes ONE of FIVE TOTAL slots, normally four cases plus one blind. Answers, skip,
close/reopen and reconnect do not refill slots. No next page is inferred automatically. New explicit
host scope/offset and independent selection are required for another page.

Signals or durable blind binding opt into `debrief-checkpoint-v2`: original v1 fields plus bindingDigest
of the independently configured signal batch/observation and blind comparison/author. A changed/old
checkpoint refuses, including zero-card batch switches. Checkpoints retain attention/request transport
only; canonical case/quality decisions remain in harness storage. Loss/rollback-safe attention storage,
authenticated human identity and live pause policy remain host qualification, not properties inferred
from a file, a supplied identity string or a caller-present flag. Frame freshness stays snapshot-unknown,
automatic presentation unqualified and acceptance not-assessed.
