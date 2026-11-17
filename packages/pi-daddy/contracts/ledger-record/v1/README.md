# pi-daddy ledger-record contract — version 1

Canonical machine contract for the append-only governance ledger:

- `record.schema.json` — the JSON Schema draft 2020-12 record envelope
  `{v, seq, prev, at, kind, id, body, digest}` written as one JSON object per line.
- `governance-event.schema.json` — the closed `ledgerVersion: 3` union carried in a governance record's `body`.
- `fixtures/ledger-record.jsonl` — deterministic envelope examples.
- `fixtures/*.json` — deterministic governance-body examples generated through the production builders by
  `scripts/generate-ledger-record-contract.ts`.

The current governance events are `capability_decision`, `workspace_lease`, `child_lifecycle`, `cost_gate`,
`session_config`, and `episode_outcome`.

## Reading and compatibility

The envelope reader verifies sequence, previous-record hash, digest, and known envelope kind. A torn or tampered tail
is reported as damage; writers refuse to append until the operator explicitly repairs it. Pre-envelope ledgers are
imported into envelopes and are never repaired in place.

Within a governance body:

1. No `ledgerVersion` and no `event` is a legacy grant record.
2. Imported `ledgerVersion: 2` events are retained as historical records using their frozen identity rules.
3. Every known `ledgerVersion: 3` event is validated against `governance-event.schema.json`, including known kinds a
   particular reader does not render.
4. The dashboard projection skips a non-empty unknown v3 event discriminator so a newer writer does not crash an
   older dashboard. Missing discriminators, unsupported explicit versions, and malformed known events are corrupt.
   `/grants ledger` is currently closed-world and reports valid event kinds it does not render, including future
   discriminators, as corruption; that is a known compatibility gap rather than part of the contract.

The governance schema is closed. Adding or removing a field, event, or enum member, changing requiredness, or changing
meaning requires an explicit compatibility decision and regenerated fixtures. Run `npm run contracts:generate` from
the repository root and commit the generated contract with the runtime change.

## Capability namespace correction (2026-10-07)

The published schema now derives its capability namespaces from the runtime list, including `context:`.
Earlier schema snapshots omitted `context:` even though the runtime emitted and accepted it. This corrects
validation of existing records; it changes no grant or execution authority. Consumers pinned to older schemas
must explicitly adopt the corrected contract. The closed field and identifier-tail rules remain unchanged.

## Execution identity

Every v3 execution event carries:

- `executionId`: globally unique identity of one execution occurrence.
- `parentExecutionId`: the unique governed execution that delegated it, or explicit `null` at a root.
- `childId`: the readable logical tree position, retained for operators and deterministic comparisons.

Consumers join capability, lifecycle, and lease events by `executionId`, never by `childId`. Repeated or concurrent
calls may reuse a logical position such as `d0.1`; they may never reuse an execution id.

A lifecycle `running` event may include `herdrPaneId` and `herdrAgentName` for navigation. These are runtime
observations, not enforcement boundaries. `deadlineAt` is immutable within one occurrence and bounds how long a
non-terminal start can be rendered as live; after it, the truthful state is incomplete.

All timestamp fields share one schema/runtime profile: JSON Schema `date-time` with seconds restricted to `00`–`59`.
Leap-second strings are excluded because JavaScript deadline and duration arithmetic cannot represent them.

## Privacy and provenance

Governance bodies contain no raw task text, prompts, tool arguments, child output, or tool results. Task and
definition digests identify content without reproducing it; a digest is an identifier, not anonymisation. Correlation
metadata is caller-declared join data and never authority. The separate local activity timeline may retain private
prompt and final content according to `PI_DADDY_ACTIVITY_CONTENT`; it is not part of this governance contract.
