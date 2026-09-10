# P08 manual debrief / label / blind view — integration contract for P10/P12/P13

Local implementation candidate, not overall acceptance or live qualification. This is the existing
pi-daddy dashboard/Herdr plugin path, not a new product. P04 read-only daily view and P05 intent controls
remain separate. Labels/choices never dispatch workers, alter grants/work acceptance, adopt a candidate
or establish causality.

## Immutable actual inputs

`provenance.json` pins exact Git blob bytes:
- work-capture schema/review contract and seven-case/batch/review fixtures at harness
  **4460af93c55aa3a52df262782cd339ad374113b8**;
- intervention manifest/assessment/public blind view/choice/reveal and actual retained synthetic artifacts at
  **0475e1f5684e01992850c48aa14841751711701a**.

The vendored source documents and fixtures are unchanged. Original public zero-seed comparison fixtures
are not real blinding, live casting, authenticated human decisions or routing authority. The read path
validates closed schemas, case identities/reason-cost consistency, history digests/links and opaque artifact
membership plus actual bytes. Case/page/history callbacks must come from the genuine configured harness
owner; an arbitrary object/"author" field does not supply that provenance.

## Existing render/action path

`dashboardFrame({cwd, debrief: presenter})` renders the actual validated presenter. `dashboardDebriefAction`
and the existing CLI's own input handler call its explicit actions. Neither uses worker prompts, terminal
transport, observer messages or P05 control APIs. `runDashboard(argv, env, {debrief: presenter})` accepts an
already configured/opened host presenter; it does **not** override a host's closed/deferred state.

For the standalone synthetic manual view:

```sh
pi-daddy-dashboard --once --debrief-fixture --no-color
pi-daddy-dashboard --once --debrief-fixture --debrief-json
# Without --once, input belongs only to this dashboard:
# choose tie variant-... variant-...
# reveal
# close
# open
```

`PI_DADDY_DEBRIEF_FIXTURE=1` selects that same clearly marked demo through the existing plugin-open seam and
participates in pane reuse identity. Existing plugin-open ledger/protocol prerequisites still apply; the
standalone fixture CLI does not waive those native host guards. No environment/module/file loader can inject a decision writer. CLI
fixture case labeling is **disabled**, because it has no genuine harness writer. Fixture-only blind actions
use a session-memory checkpoint and known synthetic mapping; restart persistence or real blinded study is
not claimed. The fixed first four case IDs plus one blind slot never paginate into extra questions.

Programmatic integration uses the real host API:

```ts
const reviewer = createWorkCaseReviewer(harnessArchiveRoot, batchManifestId, verifiedOperatorIdentity);
const presenter = createDebriefPresenter({
  scope: hostOwnedPresentationScope, operatorIdentity: verifiedOperatorIdentity, reviewer,
  blind: genuineP12BlindPort, // optional: view/readArtifact/choose/reveal only
  persistence: hostOwnedAttentionCheckpoint,
});
await presenter.open({mode:'manual', userPresent:true}); // explicit operator action, not agent_end
await runDashboard(args, env, {debrief: presenter});
```

No second dashboard decision ledger is created. `reviewer.decide` writes only the harness-owned digest-bound
case history. P07's operator-selected capability is not a human authenticator; real identity remains the
host's responsibility. Callbacks are captured at construction, not resolved from incoming case metadata.

## Five-slot attention budget and reopening

One `scope` must be independently bound by the host to the actual batch/operator/presentation interval, not
a pane title, file tail, repeated agent_end or a new window. The first explicit open reserves a fixed set:
**at most five total cards/questions**, not five cases plus a blind choice. A blind comparison takes one
slot, leaving four case cards. With seven incidents this leaves three unexposed/unresolved. All variants
within the one bounded blind question share its slot. Current implementation supports two to four eligible
variants, up to four retained artifacts each, 64 KiB per artifact and short marked previews.

Reservation is checkpointed and exact host readback is checked before exposure; a callback returning success
without retained matching state is not sufficient. Closing/rendering/answering/skipping never refunds slots,
advances the page or fills a vacated blind slot with another case. A host may choose `offset` for a new
explicit weekly/manual budget; it is pinned in the checkpoint and cannot change within the same scope. `budgetSpent` remains visible even while
closed; exhausted allowance defers new questions and reopens only the same slots. Missing/failed checkpoint
state is unknown, never a fresh allowance. Changed batch/blind identity refuses rather than remapping cards.
Unanswered cases remain unanswered in harness history. Skip/uncertain and unselected blind choice remain
unresolved, not agreement or a quality vote.

`DebriefPersistence` is a **host-owned attention/transport** interface:
- `durability: 'host-owned'` for the configured host, or `'fixture-memory'` only in explicit fixture mode;
- `load()` returns null only if genuinely never initialized, otherwise an exact `DebriefCheckpoint`;
- `compareAndSwap(expectedDigest, next)` must durably/atomically bind the scope and whole checkpoint before
  returning. Missing/deleted/partial/rollback state, ambiguous commits and concurrent stale saves must refuse.
  A host cannot report null for lost prior state and thereby mint a fresh pause budget.

The product does not install a persistence store. Its checkpoint contains fixed card IDs/public blind digest,
immutable pending review requests, quality choice and reveal-attempt state—**not authoritative case decisions**.
Case decisions are always rechecked against actual harness history, including the separately configured
operator identity for acknowledgement. The host must configure the same legitimate identity in reviewer
and presenter; missing identity disables labels, and a different author is never credited to this request. Tests use a separately configured owned
fixture-host checkpoint with the existing non-expiring lock and synced append; this is not a deployed host
service or hostile-filesystem/rollback qualification. Without a checkpoint, manual viewing is session-only
and real label/choice actions are unavailable. Reuse the same presenter to retain its session budget; a
process restart without genuine host restoration cannot claim per-pause continuity.

## Explicit labels and unknown acknowledgement

`label({caseManifestId, priorDecisionId, disposition, note})` accepts only the real four-field P07 request and
only an exposed card. The CLI spelling is `label SLOT DISPOSITION NOTE`. The expected prior comes from the
shown snapshot, never silently advanced to overwrite a newer decision. One immutable request per card/pause
is saved before calling the genuine writer. Its replay calls history only; it never sends `decide` twice.
An exact current history record is required before displaying label-recorded. Unknown/failed/stale writer
acknowledgement is unresolved; `reconcile SLOT` reads the actual history without sending a label again.
A saved request whose writer was never reached remains unknown/unanswered; there is no blind automatic retry.
Corrections/new exposure require a separately governed host presentation, not unlimited questions this pause.

Dispositions: confirmed_defect, expected_behavior, exemplar, uncertain, skip. They are nominations/labels,
not scored-spec promotion, accepted work or agreement with a model. Render/schema success is not authority.

## Quality before configuration/cost

Before choice, the comparison exposes only public opaque labels and verified artifact previews; blind manifest/assessment,
configuration/cost, arm IDs and filenames are not in the frame. Known A/B fixture captions are removed.
Arbitrary artifact text can still disclose identity: the UI explicitly warns rather than claiming perfect
blinding. Public fixture seeds/hashes may be independently linkable and must never be used for live blinding.

`choose({kind:'one'|'tie'|'none'|'insufficient',labels:[...]})` validates exact opaque membership, persists the
choice, then calls the actual blind interface. Reveal stays locked until that choice is acknowledged.
Choices lock once recorded by this presenter (stricter than permitting pre-reveal corrections). `reveal()`
persists the attempt before calling the private host method, validates the same choice/mapping, then displays
configuration/cost. Failed persistence reveals nothing. Reopening a new presenter with saved choice requires
an explicit same-choice confirmation against the restored blind port before reveal; the host must restore
its private seed/mapping. No new vote or changed post-reveal choice is allowed. No evaluation, causal claim,
automatic routing or adoption follows any choice.

## Automatic/live status and remaining facts

**Automatic presentation is deliberately unqualified and deferred**, including a caller string claiming
verified-closing. There is no implemented verified suitable user closing pause/exposure-calibration-policy /
identity/durable-writer bridge. Repeated/transient agent_end, idle flags, file tails, busy work and absence
cannot authorize exposure. Busy/absent manual requests also defer. Existing host deferrals are not upgraded
by runDashboard. A <=5 page alone is not treated as proof of an attention budget.

Supported: actual existing manual render/action path, real pinned harness case writer and P12 primitive
integration in owned fixtures/programmatic ports, bounded checkpoint/reopen behavior, standalone frozen
CLI and fresh compiled plugin-command execution. Remaining: deployed genuine host writer/attention store,
verified automatic pause/policy/identity, private seed persistence, actual P12 live casting and live Herdr
qualification. Source fixture transpilation is not an installed harness package qualification.

P05 owned cancellation remains unfinished implementation work; general live steering remains unqualified.
P02/P04/P06 unsupported native/freshness/containment clauses remain. No worker messages, model/provider calls,
per-task model review, package lifecycle or publication is part of this implementation.
