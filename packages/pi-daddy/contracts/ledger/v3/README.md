# pi-daddy ledger contract — version 3

Canonical machine contract for one `ledgerVersion: 3` JSONL line:

- `ledger-event.schema.json` — closed JSON Schema draft 2020-12 event union.
- `fixtures/*.json` — deterministic examples generated through the production builders by
  `scripts/generate-ledger-v3-contract.ts`.

## Dispatch and compatibility

1. No `ledgerVersion` and no `event` is a legacy 0.17 grant record.
2. `ledgerVersion: 2` is validated against the frozen v2 contract.
3. `ledgerVersion: 3` requires one known event and validation against this schema.
4. Any unsupported explicit version, missing discriminator, unknown event, or malformed required identity is corrupt. It is never reinterpreted as legacy.

The schema is closed. Adding/removing a field, event or enum member, changing requiredness, or changing meaning requires a new ledger version and versioned path. V3 is still unreleased, so its review repairs are folded into this one initial contract rather than creating a public v4.

## Execution identity

Every v3 **execution** event carries:

- `executionId`: globally unique identity of one execution occurrence.
- `parentExecutionId`: the unique governed execution that delegated it, or explicit `null` at a root.
- `childId`: the readable logical tree position, retained for operators and deterministic comparisons.

`workflow_fact` is not an execution event; it carries its own `factId` and explicit provenance instead.

Consumers join lifecycle and lease events by `executionId`, never by `childId`. Repeated or concurrent calls may reuse a logical position such as `d0.1`; they may never reuse an execution id.

A lifecycle `running` event may include `herdrPaneId` and `herdrAgentName` for navigation. These are runtime observations, not enforcement boundaries. `deadlineAt` is immutable within one occurrence and bounds how long a non-terminal start can be rendered as live; after it, the truthful state is incomplete.

All timestamp fields share one schema/runtime profile: JSON Schema `date-time` with seconds restricted to `00`–`59`. Leap-second strings are excluded because JavaScript deadline and duration arithmetic cannot represent them.

## Privacy and provenance

The privacy boundary is unchanged: no task text, prompts, tool arguments, child output, or tool results. Fields displayed as identities and every capability use explicit ASCII identifier grammars in both schema and runtime; public builders assert that their serialized event passes the same exact reader. Correlation display fields use the identifier grammar rather than free-form prose, and a top-level null `assurance_scope` is omitted/rejected consistently. Trusted task/definition digests remain outside `correlation`. Correlation is caller-declared join metadata and never becomes proof that a workflow transition was validated or that an inline skill executed.
