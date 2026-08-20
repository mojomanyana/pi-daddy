# Handoff — canonical ledger v2 contract

## Completion and integration update — 2026-08-20

This section supersedes the operational Git/release state and the proposed-PR instructions below; those
sections are retained as the record of the handoff before the work was committed.

- The contract work was committed as `6bda1c9` and pushed in
  [PR #11](https://github.com/mojomanyana/pi-daddy/pull/11). It is no longer uncommitted or unpushed.
- While PR #11 was open, [PR #12](https://github.com/mojomanyana/pi-daddy/pull/12) advanced `main`, tag
  `v0.18.1`, and npm `latest` to `8feaacb`. That published security fix added the reachable
  `GRANT_ID_MALFORMED` refusal.
- PR #11 merged the new `main` into its public branch at `a26e2f2`, preserving both changelog sections and
  adding `GRANT_ID_MALFORMED` to the canonical v2 refusal enum. It belongs in v2 because 0.18.1 already
  emits it; omitting it would make the new canonical schema reject a published v2 event.
- The post-merge review added exact schema-to-production vocabulary, top-level and nested field inventory,
  requiredness, and minimal/maximal builder-shape checks, so those closed-contract dimensions cannot drift
  silently.
- PR #10 remains the follow-up and must merge after PR #11. It must not add the unshipped
  `WORKSPACE_NOT_AUTHORIZED` code to closed v2; unauthorized workspace routing can use the existing
  `CAPABILITY_ESCALATION` refusal with the exact `workspace:<id>` in `denied` and `details.workspace_id`.
- Nothing from PR #11 has been published. The latest GitHub Release remains `v0.17.1`; package/tag/npm state
  is 0.18.1, and the contract artifacts remain a candidate for the next release.

## Git and release state (superseded snapshot before commit)

- Base: `dde8eeb5632113d4a54705e16dc22ce70740fd4f` (`main`, peeled `v0.18.0`, merged PR #9).
- Current HEAD: `dde8eeb5632113d4a54705e16dc22ce70740fd4f`; all work remains uncommitted on
  `feat/ledger-v2-contract-artifacts`, so there is no proposed head commit SHA yet.
- Re-verified split on 2026-08-20: repository main/tag and npm `latest` are 0.18.0; npm reports the same
  `gitHead`. The latest GitHub Release remains `v0.17.1`.
- No commit, push, tag movement, GitHub Release, npm publish, package version change, or opt-in model run was
  performed.

## Changed files

- Release/current-state docs: `README.md`, `CLAUDE.md`, `docs/SESSION-LOG.md`, `docs/SPEC.md`, and this
  `docs/HANDOFF-ledger-v2-contract.md`.
- Decision and package docs: `docs/06-decisions/ADR-0034-runtime-enforcement-primitives-for-external-controllers.md`,
  `packages/pi-daddy/README.md`, `packages/pi-daddy/CHANGELOG.md`.
- Canonical contract: `packages/pi-daddy/contracts/ledger/v2/README.md`,
  `packages/pi-daddy/contracts/ledger/v2/ledger-event.schema.json`, and four files under
  `packages/pi-daddy/contracts/ledger/v2/fixtures/`.
- Builder/runtime wiring: `packages/pi-daddy/src/ledger-events.ts`, `src/ledger.ts`, `src/index.ts`, and
  `src/check-runner.ts`.
- Generation, packaging and tests: `packages/pi-daddy/scripts/generate-ledger-v2-contract.ts`,
  `scripts/smoke-installed.mjs`, `package.json`, `test/ledger-contract.test.ts`, and
  `test/runtime-ledger.test.ts`.

## Stable artifact paths

Schema:

```text
pi-daddy/contracts/ledger/v2/ledger-event.schema.json
```

Fixtures:

```text
pi-daddy/contracts/ledger/v2/fixtures/capability-decision.json
pi-daddy/contracts/ledger/v2/fixtures/workspace-lease.json
pi-daddy/contracts/ledger/v2/fixtures/child-lifecycle.json
pi-daddy/contracts/ledger/v2/fixtures/check-receipt.json
```

Repository generation command:

```bash
cd packages/pi-daddy
npm run contracts:generate
```

The generator calls `buildRecord`, `buildWorkspaceLeaseEvent`, `buildChildLifecycleEvent`, and
`buildCheckReceiptLedgerEvent`. The named-check production path now uses the last builder too; the contract
test compares every checked-in fixture with fresh builder output.

## Field inventory

Common v2 fields: `ledgerVersion`, `event`, RFC 3339 `ts`, `childId`, and optional bounded
`correlation`. Correlation is non-authoritative and holds the existing schema-1.0 join vocabulary, opaque
policy/assurance values, controller digest-looking strings, Git identities, and sequence floors.

- `capability_decision`: `parentId`, `depth`, `agentType`, `executor`, requested/parent/effective/denied/
  clipped/gated capability arrays, `blocked`, `reason`, approved capabilities, per-capability approval
  source/scope/expiry/use facts, prompt summary fields, trusted `taskDigest` and optional
  `definitionDigest`, `taskFrom`, and structured `refusal`.
- `workspace_lease`: `workspaceId`, canonical `root`, `access`, `outcome`, recovery fact, release reason, and
  structured refusal.
- `child_lifecycle`: state/executor, nullable `exitCode` and `signal`, timeout/abort/truncation flags, and
  reason.
- `check_receipt`: `receiptId`, `workspaceId`, `checkId`, and candidate `treeSha`. This is the ledger join
  event, not the full receipt returned by the named-check runner.

The schema is closed. Legacy 0.17 grant records have neither version nor event and remain readable outside
this schema. Explicit version 2 requires a recognized event and the complete v2 shape; every unsupported
explicit version fails closed and is never reinterpreted as legacy. pi-daddy's `verifyLedger` enforces that
version/discriminator boundary and required join fields; full nested validation uses the published schema.

## Pack/install evidence

`npm pack --dry-run --json` reported `pi-daddy@0.18.0`, 232 entries, including all six contract files:
the contract README, schema, and four fixtures. `npm run test:smoke` then packed, installed, imported the
schema and all fixtures through their public package exports, exercised the installed library/bin, and
reported:

```text
smoke: installed package imports and runs, and `pi-daddy init` scaffolds — OK
```

## Verification (superseded pre-commit snapshot)

The completion update above records the current state; these results are retained as the verification
performed before the original contract commit and subsequent 0.18.1 integration.

- `npm ci`: completed; 0 vulnerabilities. npm blocked the pre/postinstall scripts of `@google/genai` and
  `protobufjs` under its current allow-scripts policy.
- Unit, using the absolute executable requested by the owner:
  `/home/neman/.nvm/versions/node/v26.7.0/bin/node --test test/*.test.ts` — **591 pass, 0 fail,
  0 cancelled, 0 skipped, 0 todo**.
- `npm run typecheck` — pass.
- `npm run build` — pass.
- `npm run test:integration` — **44 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo** in the Node summary.
  The command also printed three suite declarations as skipped by the `PI_GRANTS_IT_MODEL=1` guard; the ten
  model-driven tests behind those suites were not run.
- `npm run test:smoke` — pass.
- `npm pack --dry-run --json` plus contract-file assertion — pass after correcting the local parser for npm
  11's keyed JSON output; the pack operation itself succeeded on both invocations.
- `git diff --check` — pass.
- Independent final review — **APPROVE**. Earlier passes found and drove fixes for full-schema validation
  overclaims, premature "shipped" wording, builder/schema digest mismatch, and empty-digest downgrade.

## Known limitations left unchanged

- Workspace selection does not attenuate down the delegation tree; CWD validation is not path confinement.
- Persisted approvals bind text/task/capabilities, not current head/tree identity or sequence freshness.
- Candidate tree identity ignores ignored paths, Git-internal state, and dirty submodule contents, and writes
  objects to the real object database.
- Lease identity omits the lease-directory/mount-namespace identity, so disagreeing agent roots can lock
  different files for one worktree.
- `assurance_scope` remains structurally under-validated and can carry up to its separate bound.
- Correlation `schema_version` remains an arbitrary bounded string rather than being compared with `"1.0"`.
- Access classification remains conservative, making many otherwise read-only grants writers.
- `verifyLedger` is an integrity/reporting reader, not a full JSON Schema engine; callers needing full nested
  v2 validation must apply the canonical schema.
- Two runtime value-import cycles remain safe only while no cross-module binding is read during module
  evaluation.
- The approval dialog still does not disclose every exact binding component.
- `bash`, unrelated processes, and named-check executables remain outside filesystem/network containment.

## Version decision (superseded pre-0.18.1 snapshot)

The 0.18.1 option discussed below is no longer available: 0.18.1 was subsequently published by PR #12,
and the completion update records the current next-release recommendation.

Do not attempt to republish 0.18.0: npm already contains it. **Recommend a minor release (0.19.0), not a
patch**, because this change adds stable public package export paths, a canonical compatibility obligation,
and a new exported check-receipt builder. Runtime v2 line semantics are unchanged, so 0.18.1 is defensible
only if the owner classifies the missing artifact as packaging/documentation repair. The repository's prior
practice uses minor releases for new public features; no version was changed here.

## Proposed PR (superseded; PR #11 opened)

**Title:** `feat: publish canonical ledger v2 contract`

**Body:**

```markdown
## Context

PR #9 shipped ledgerVersion 2, but external harnesses had no canonical machine-readable contract and had to
reconstruct the event union from TypeScript and prose.

## Changed

- ship a closed draft 2020-12 schema for all four v2 ledger events
- generate one deterministic fixture per event through the production builders
- route check-receipt ledger emission through its new builder
- export and package the schema/fixtures at stable versioned paths
- pin installed-package availability and strict unsupported-version behavior
- correct release-state docs to main/tag/npm 0.18.0 vs GitHub Release 0.17.1
- document compatibility, field inventory, versioning, and unchanged known limitations

## Verification

- 591/591 unit tests using an absolute Node executable
- 44/44 non-model integration tests
- typecheck and build
- installed-package smoke
- pack dry-run: schema, README and four fixtures present
- git diff --check

The PI_GRANTS_IT_MODEL=1 tier was not run. No version, tag, GitHub Release, or npm publication is included.

## Version note

Recommend deciding 0.19.0 before release because this adds stable public contract exports; 0.18.1 remains
possible only if treated as a packaging repair for already-shipped v2 behavior.
```
