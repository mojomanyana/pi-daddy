# pi-daddy work-v4 contract — candidate

**Opt-in source candidate, not production acceptance integration.** At release preparation on 2026-09-11,
the package version is staged as 0.24.0; consult npm and GitHub Releases for current publication status.
This directory declares the versioned package artifacts; their presence does not establish compiled exports,
installed-package behavior, task acceptance or qualification.
See [SPEC](../../../../../docs/SPEC.md#opt-in-work-v4-evidence-candidate) and
[ADR-0044](../../../../../docs/06-decisions/ADR-0044-opt-in-work-v4-evidence.md).

## Artifacts and reproduction

- [ledger-event.schema.json](ledger-event.schema.json): hand-authored, closed draft 2020-12 schema
  for **one event**, with four discriminator branches.
- [work-revision.json](fixtures/work-revision.json), [work-snapshot.json](fixtures/work-snapshot.json),
  [work-occurrence.json](fixtures/work-occurrence.json), [work-acceptance.json](fixtures/work-acceptance.json):
  deterministic individual event objects from the four real production builders.
- [layout-options.json](fixtures/layout-options.json): a complete generic layout graph as an **array** of
  eleven production-builder events: six revisions, one snapshot, three occurrence joins and one claim.
- [generate-ledger-v4-contract.ts](../../../scripts/generate-ledger-v4-contract.ts): pure
  `buildLedgerV4ContractFixtures()` (the four standalone objects), `buildLayoutOptionsFixture()` (the array),
  explicit-absolute-target `writeLedgerV4ContractFixtures(target)`
  and `generateLedgerV4Contract(target, schemaSource?)`. Importing the module performs no writes.

The writer targets a fixture directory; the complete generator targets a contract root containing the
schema and `fixtures/`. The optional absolute schema source supports initial hand-authoring/staging;
otherwise the generator copies this hand-authored schema verbatim. It does not infer a schema from
objects, invoke the historical generator, or construct authority. The CLI requires a target and resolves
its explicit path; it has no default output. A missing target fails before writes.

From the repository root, for a **fresh owned absolute output directory**, invoke Node directly:

```sh
node packages/pi-daddy/scripts/generate-ledger-v4-contract.ts /absolute/fresh/contract-root
```

Initial staging can explicitly supply a second argument naming the hand-authored schema source.
`contracts:generate:v4` is a separate manifest script explicitly targeting only `contracts/ledger/v4`;
`contracts:generate` and every v2/v3 artifact remain unchanged. Tests generate only into fresh explicit
temporary targets and compare repository collateral before/after. Generation is a developer write tool,
not a sandbox or transactional multi-file writer; use only authorized targets and preserve failed output.

There are two fixture container forms, neither itself JSONL. Each `work-*.json` is one individual event
object. The four standalone objects deliberately omit referenced goal, obligation, policy and artifact
bodies: they demonstrate wire shapes, not a self-contained graph or accepted work. `layout-options.json`
is an array, **not an event**: validate every element against the event schema, then explicitly convert it:

```ts
const events = JSON.parse(layoutOptionsText);
const jsonl = events.map(event => JSON.stringify(event)).join("\n") + "\n";
```

The layout array contains two distinct execution IDs using the same logical designer ID, three variants,
one selected obligation and one artifact. Three joins do not mean three launches. The array contains no
trusted receipts or availability. The independent, fixed positive controller remains only in
[test/work-ledger-fixtures.ts](../../../test/work-ledger-fixtures.ts), never an authority loader accepting
incoming claims. The real builder → strict JSONL → dedicated append → explicit inspection demonstration
reports **fixture trust-boundary simulation; for selected snapshot; under fixture authority**. Selection
without authority is unresolved `0/1`; under the fixed fixture authority it is exactly `1/1`, with two
attempts and three variants. Neither result authenticates a real designer or authorizes a model call.

Declared artifact exports are `pi-daddy/contracts/ledger/v4/ledger-event.schema.json` and
`pi-daddy/contracts/ledger/v4/fixtures/*.json`. The source API is declared at `pi-daddy/work-ledger`.
Manifest-string tests are not compiled-export or installed-smoke proof.

## Wire shape and domains

All fields are required, with explicit nulls where indicated. Every object is closed; there is no
correlation object, extension bag, task prose, prompt, arguments, result, transcript, credential or
trusted receipt field. IDs and digests can still be sensitive/linkable; they are not anonymization.

Every event has exactly `ledgerVersion:4`, `event`, `eventId`, `ts`, `payload`, `digest`:

| Discriminator | Payload |
|---|---|
| `work_revision` | `{revision}`: kind, stable ID/revision/scope, predecessor, content digest, parent, dependencies, owner, permitted effects, policy and own digest |
| `work_snapshot` | `{snapshot}`: snapshot ID, exact scope, selected revision inventory, obligation bindings and own digest |
| `work_occurrence` | Exact scope/obligation, execution and parent identities, nullable logical child/variant/artifact, provenance, state and closed labels |
| `work_acceptance` | Unauthenticated authority ID and exact snapshot/scope/intent/obligation/artifact revision/artifact-byte/policy/evidence binding |

Revision kinds are `scope`, `goal`, `node`, `obligation`, `artifact`, `policy`. Ordinary IDs use
`[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}`; digests are 64 lowercase hexadecimal characters. Revisions are
integers from 1 through 9007199254740991. Execution IDs use the unchanged
[execution-id.ts](../../../src/execution-id.ts) grammar. Timestamps are UTC
`YYYY-MM-DDTHH:mm:ss.sssZ`, years 0001–9999, valid calendar dates, seconds 00–59.

Bounds: 64 KiB per delivered nonblank record, 16 MiB per supplied JSONL text, 10,000 nonblank records,
maximum nesting depth 16 and 256 entries per input array. Aggregate output collections can exceed 256.

The schema enforces closed fields, discriminator/enumerated domains, reference kinds, scalar and array
bounds, nonempty evidence, unique full array entries, revision-specific parent/policy/effect shapes,
and null initial/non-null successor predecessor shape. **It is not the whole validator.** Use
[parseWorkLedgerText](../../../src/work-ledger.ts) for strict text ingestion:

- Detect decoded duplicate member names before object materialization, including nested/escaped names.
- Reject malformed JSON, lone surrogates and unsupported object values; check numeric tokens exactly
  before conversion, rather than accepting values that round into safe integers.
- Enforce UTF-8 byte/depth/record limits and actual calendar validity independent of schema format support.
- Enforce canonical ordering and semantic-key uniqueness of sets; check scope ID equality and exact
  predecessor kind/ID/arithmetic. Schema `uniqueItems` cannot replace binding-key uniqueness.
- Recompute every supplied event, revision and snapshot digest.

Graph selection/history, cross-field equality, conflicting delivery reachability, availability and
trusted-context matching require the runtime projector, not schema acceptance. No schema-only claim
is accepted work. Unknown explicit versions are not reinterpreted as legacy.

## Semantic identity and replay

After closed validation, identity is SHA-256 over UTF-8 RFC 8785 canonical JSON in the restricted safe
integer profile. Each own digest excludes only its own `digest` field and includes all other fields,
including nested digests. Timestamps affect event identity; formatting and object property order do not.
Raw archived byte hashes are a separate identity. Arrays preserve order. Builders sort detached set
copies and reject duplicates; readers reject unsorted/duplicate sets instead of repairing them. String
sets use ASCII order, structured sets use canonical JSON keys, and snapshot bindings use obligation refs.

The complete supplied delivery group is reconciled before facts: identical canonical events collapse
for replay, while an event ID with alternative digests quarantines all alternatives. Redelivering an
exact conflicted revision/occurrence under another ID does not cleanse it. Malformed input suppresses
progress and acceptance while retaining diagnostics. Disconnected well-formed conflicts stay visible
without erasing an unrelated healthy selected scope. There is no first/last-arrival winner.

## Selection, authority and counts

Only `projectWorkLedger(text, context?)` is public projection; there is no unchecked parsed-object route.
Context has exactly `selectedSnapshot` and `authority`, both defaulting to null. Selection names both the
snapshot's nested identity and its event identity. No latest revision/head or time election exists.
Inventory, bindings, same-scope ancestors, readable predecessors and exact selected dependencies must
resolve without structural contradictions/cycles. Missing selected artifact bodies are obligation-local
coverage gaps; they do not remove that obligation from an otherwise valid denominator.

The host supplying context is the **trusted computing base**. Its closed authority snapshot separately
supplies exact decisions and artifact/evidence availability. A matching decision must bind the claim
ID/digest, authority ID and entire selected binding. The claim's artifact byte digest must equal the
selected artifact revision's `contentDigest`, even when a supplied decision agrees with a wrong digest.
Required evidence must be available and its support closure clean. New selected snapshots require fresh
matching receipts; old claims become superseded for that selection, not historically rewritten.

No file loader, callback, environment variable, event-nominated path, provenance label, successful check,
capability approval or runtime completion supplies this authority. P01 has **no production authentication**
or positive authority adapter. The fixed test controller accepts no incoming claims and derives its
expected world separately. Its positive result is **fixture trust-boundary simulation; for selected
snapshot; under fixture authority**, not attestation or qualification.

An unambiguous exact trusted rejection is unaccepted; opposite trusted decisions are unresolved with
`DECISION_CONFLICT`. Distinct receipt IDs do not manufacture a receipt-ID collision. Same-ID alternative
receipt bodies and contradictory availability are quarantined/reported. Global relevant blockers take
precedence; otherwise one fully supported exact claim accepts an obligation once. Unsupported siblings
remain unresolved with honest coverage gaps but do not revoke independent complete support.

`scopeState` is `unselected`, `valid`, `unresolved` or `invalid`. Progress is null without a valid selected
scope; otherwise `{accepted,total}` counts **obligations**, including unresolved/unaccepted ones in the
denominator. An empty valid scope is `0/0`, not a success percentage. Accepted state is explicitly
`accepted-under-supplied-authority`. Coverage, applicability, supersession and conflicts remain separate.

Execution identity is global, not a logical child position or scope/obligation tuple. One execution may
have multiple selected associations and variants, but yields one attempt row. Declarations do not fill
observed labels. Parent/logical identity contradictions and quarantined evidence remain unresolved;
completion is not acceptance. Runtime problems gate acceptance only through required evidence, not
unrelated telemetry. [Attempt tests](../../../test/work-ledger-attempts.test.ts) exercise repeated logical
names, explicit/missing/cyclic parents, unknown branches, independent declared/observed label alternatives,
shared selected associations, global conflicts from nonselected associations, and exact successor receipts.
A scope successor rebases its goal, node and obligation references through real revision predecessors;
even a fresh snapshot with otherwise unchanged revisions cannot reuse the old receipt. Previously returned
results remain immutable. Complementary observations fill nulls, contradictory observations leave the
conflicted field null, and completed/failed observations cannot contribute a resolved completion count.
These are bounded source tests, not production authority or fresh compiled/whole-change approval.

## Dedicated append and read-only inspection

`appendWorkLedgerEvent({path,grantLedgerPath}, event)` is always strict. Both paths must be absolute,
nonempty and NUL-free; the protection field is required, and null explicitly means the host declared no
grant destination. There is no ambient default. Options/candidate validation and canonicalization precede
filesystem access. Preflight compares normalized filesystem UTF-8 spellings, canonical paths and available
inodes for both work leaves and every existing/prospective ancestor against both protected grant leaves.
A protected filename remains reserved even when it is a directory. Proven aliases refuse before mutation.

Only then are work parents created and the shared producer lock acquired with non-expiring v4 ownership.
The existing two-second waiter timeout and own-token release remain; **no age/liveness reclaim** occurs.
Slow validation keeps ownership. An orphan can block future writers indefinitely and requires separately
authorized quiescent operator recovery; there is no automatic recovery API. Legacy callers retain their
existing age-recovery policy and serialization/strict/callback behavior.

In this candidate, a lock close/read/removal failure after an otherwise successful v4 body is reported as
`WORK_LEDGER_WRITE_FAILED`, not silently treated as success. Safe token-checked removal is attempted even
after close failure; a failed ownership read never permits deletion, and a different owner's token remains.
Primary body/validation errors keep precedence over secondary cleanup errors. The entire appended line may
already be present despite rejection; a remaining lock may indefinitely block later writers. Blind retry
is not promised safe or exactly-once: it can add a physical redelivery and consume capacity when the lock
was removed, or fail while the lock remains. No bytes are rolled back and no automatic recovery is added.
Legacy default/explicit-age cleanup remains best effort.

The same regular-file descriptor validates bounded existing bytes and resulting byte/record capacity,
rechecks identities, then appends canonical JSON plus LF under that lock. Nonempty existing content must
end in LF and pass strict work-v4 ingestion. Existing bytes are never reserialized, truncated or repaired.
Preflight refusals have no mutation; later refusals may follow own-parent/lock activity. A failed write may
leave partial bytes; they remain evidence and subsequent strict reading refuses them. This is cooperative
misrouting protection on supported filesystems, not containment against dishonest hosts, malicious
same-user races, external lock deletion or mount aliases.

`inspectWorkLedger({version:4,path}, context?)` reads bounded regular-file bytes without creating or repairing
anything. `missing` means ENOENT with `exists:false`; `error` has null ingestion/projection; `read` carries
actual ingestion/projection. **Read is not content validity or acceptance.** Malformed content remains a
read result with ingestion diagnostics and unmeasured projection. Returned data are detached and deeply
frozen; errors contain fixed codes/line numbers, not raw text, paths or native messages.

| Operation | Input/domain failure | Other result |
|---|---|---|
| Four builders | Throw `WorkInputError` | Computed frozen event |
| Parser/projector | Return input/context diagnostics | Ingestion/selected projection |
| Append | Throw validation errors unchanged | Throw `WorkLedgerWriteError` for destination/I/O; resolve only after append and disabled-mode cleanup |
| Inspector | Return option/version/context diagnostics | Return missing/error/read; never repair |

Input codes: `WORK_JSON_INVALID`, `WORK_DUPLICATE_MEMBER`, `WORK_LIMIT_EXCEEDED`,
`WORK_VERSION_UNSUPPORTED`, `WORK_SCHEMA_INVALID`, `WORK_DIGEST_MISMATCH`, `WORK_CONTEXT_INVALID`.
Write codes: `WORK_DESTINATION_INVALID`, `WORK_DESTINATION_ALIAS`, `WORK_LEDGER_WRITE_FAILED`.
Inspection-specific codes: `WORK_INSPECTION_PATH_INVALID`, `WORK_INSPECTION_NOT_REGULAR`,
`WORK_INSPECTION_READ_FAILED`. These do not extend historical governance refusal enums.

Append precedence is options → candidate → path values → proven protected alias → unresolved filesystem
failure → invalid topology → persistence → existing content → resulting capacity. Existing content checks
bounded read first, then parser diagnostics, then terminal LF. Known filesystem/lock errors are translated;
unexpected programming exceptions remain exceptions. Full result/problem/reference types are in
[work-ledger-types.ts](../../../src/work-ledger-types.ts).

## Compatibility and remaining gates

`LEDGER_VERSION = 3`, its five-event union, correlation 1.0, old builders, defaults, legacy callbacks and
historical v2/v3 bytes remain unchanged. Integrity/dashboard readers reject v4 rather than widening their
grant or lifecycle counts. No migration, CLI/dashboard activation, default-v4 switch or publication is
performed. Stop use of this opt-in candidate to roll back and retain its evidence; do not rewrite history.

[Contract tests](../../../test/work-ledger-contract.test.ts) check schema/runtime domains, required/extra
members, byte reproduction, import purity, explicit generation, old-reader rejection and documentation
structure/links and both container forms, including two fresh byte-for-byte layout reproductions and
actual JSON artifact export resolution (not installed smoke). [Path tests](../../../test/work-ledger-path.test.ts) exercise actual append/inspection,
conditional fixture authority, capacity, alias-before-mutation and live non-expiring ownership. Text-presence
assertions are not independent semantic ADR review. By explicit user direction on 2026-09-07,
mutation-testing machinery and active invocations are removed; the requirement is removed, not passed.
Ordinary behavioral regressions and runtime guards remain. Fresh compiled code verification,
full-suite/integration/installed-smoke handling and final overall review remain separate evidence.
Frozen earlier plans and receipts remain historical, with native acceptance pending where old gates
cannot represent the changed workflow. This document does not claim those passes.
