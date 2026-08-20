# pi-daddy ledger contract — version 2

Canonical machine contract for one `ledgerVersion: 2` JSONL line:

- `ledger-event.schema.json` — JSON Schema draft 2020-12 union, closed by event discriminator.
- `fixtures/*.json` — deterministic examples generated in the repository by
  `scripts/generate-ledger-v2-contract.ts` through the production builders.

After the package version carrying this unreleased artifact is published, installed consumers can resolve
`pi-daddy/contracts/ledger/v2/ledger-event.schema.json` and the four fixtures as
`pi-daddy/contracts/ledger/v2/fixtures/{capability-decision,workspace-lease,child-lifecycle,check-receipt}.json`.
JSON module imports require the runtime's JSON import attribute; filesystem-based validators can resolve the
same exported package paths without importing the JSON as code.

## Dispatch and compatibility

1. No `ledgerVersion` and no `event` is a legacy 0.17 `GrantRecord`. It is intentionally not described by
   the v2 schema; pi-daddy's reader continues accepting it.
2. `ledgerVersion: 2` requires one of the four exact event discriminators and validation against this schema.
3. Any other explicit `ledgerVersion`, a missing discriminator, or an unknown discriminator must fail closed.
   Never reinterpret it as a legacy grant line. pi-daddy's `verifyLedger` enforces that dispatch boundary and
   required join fields; consumers needing full nested validation use this schema.

The v2 schema is closed (`additionalProperties: false`) so a pinned consumer cannot silently assign meaning
to a field it does not know. Adding/removing a field, event, enum member, requiredness rule, or changing a
field's meaning requires a new ledger version and a new versioned path. Correcting prose or adding a fixture
that does not change accepted records does not.

## Event field inventory

All v2 events require `ledgerVersion`, `event`, and RFC 3339 `ts`; all carry a joinable `childId` and may
carry bounded, non-authoritative `correlation` metadata.

- `capability_decision`: parent/child/depth, executor, requested/parent/effective/denied/clipped/gated sets,
  blocked/reason, trusted task and optional definition digests, approval source/scope/expiry/use facts,
  optional prior-task author, human/gate outcome, and structured refusal.
- `workspace_lease`: workspace/root/access, acquisition or release outcome, recovery fact, release reason,
  and structured refusal.
- `child_lifecycle`: starting/completed/failed state, executor, nullable exit code and signal, timeout/abort/
  truncation flags, and reason.
- `check_receipt`: receipt/workspace/check IDs and candidate tree identity. The full named-check receipt is a
  separate return artifact; the ledger event is its join record.

Trusted fields (`taskDigest`, `definitionDigest`) are outside `correlation`. Digest-looking correlation
values remain opaque and non-authoritative. `assurance_scope`, `schema_version`, access classification,
workspace attenuation, approval freshness, tree identity, lease-directory identity, and runtime-cycle
limitations remain exactly as documented in `docs/SPEC.md`; this artifact does not repair or hide them.
