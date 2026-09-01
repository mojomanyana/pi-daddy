# ADR-0037: `/grants init` is the one-time project-ledger opt-in

**Date:** 2026-09-01
**Status:** Accepted (2026-09-01, by the user — explicit once per project, never merely because the package is installed)
**Driver:** the released dashboard requires a ledger, but the setup that `/grants init` otherwise completes still
leaves every later plain `pi` session warning that no ledger is configured. The operator asked for init and the
ledger to be on by default, then selected one explicit project opt-in over silently initializing every directory.

## Context

ADR-0030 made `/grants init` a durable, project-scoped governance choice: it stores the grant outside the
workspace, applies it to the current session, and lets later sessions start with plain `pi`. The ledger remained
a separate environment-only choice. That split produces a half-initialized project: governance survives the
restart, while its audit trail and `/grants dashboard` do not.

The existing constraints remain:

- merely installing pi-daddy must not govern or write into every directory where `pi` runs;
- a child is governed only by its inherited environment, never by a store found in its changed cwd;
- an explicit environment configuration must outrank a root-session store;
- configuring a ledger makes it load-bearing, so an unwritable default must refuse delegation rather than
  silently stop recording;
- a pre-0.21 stored grant was consent to governance, not consent to persistent recording, and cannot be
  reinterpreted after upgrade.

## Options considered

### Option 1 — keep grant and ledger as two independent opt-ins

No compatibility work and no new stored state. It preserves the current contract, but keeps the exact setup
failure that prompted the decision: `/grants init` says the project is live while every restart loses the
ledger and the dashboard remains unavailable.

### Option 2 — enable a default ledger whenever pi-daddy is installed

The fewest commands: every `pi` session gets a ledger. Rejected because installation is global while consent,
retention, and storage are project decisions. It would create files and make delegation fail closed in unrelated
directories that never ran init.

### Option 3 — bind the default ledger to the explicit `/grants init` decision

Chosen. One deliberate project action enables both the stored grant and that project's audit trail. Package
installation alone still does nothing.

## Decision

`/grants init` atomically stores one version-2 project configuration containing the decided grant and an
explicit `projectLedger: true` marker in the existing outside-workspace grant store. After that write succeeds,
it synchronously adopts both in the running session. On later roots, when `PI_GRANTS_GRANT` is absent, the v2
marker resolves to `<project>/.pi/grants.jsonl`; the root publishes that absolute path to descendants as an
environment-configured ledger is propagated today.

Environment configuration still wins. Presence of `PI_GRANTS_GRANT` bypasses the project store entirely,
including its ledger choice, so a child cannot activate state from its cwd. When the store is eligible,
presence of `PI_GRANTS_LEDGER` **at session construction** overrides the default path; an explicitly empty
value disables it for that run. Provenance is captured before pi-daddy republishes its own derived value into
`process.env`, so a later `/grants init` for a changed cwd does not mistake pi-daddy's old default for an
operator override.

Version-1 grant stores remain governed without a ledger. Existing projects must rerun `/grants init` once to
make the new recording choice; upgrade alone never supplies consent. A newly generated `.pi/grants.env` makes
the same decision reviewable by exporting `.pi/grants.jsonl` rather than leaving it commented. Existing
reviewed environment files remain untouched — including custom or commented ledger lines — while the init
notice and outside-workspace v2 store record the new choice. `npx pi-daddy init` still chooses no capability
ceiling and does not create a live outside-workspace store, but sourcing a newly generated environment enables
the ledger consistently.

## Consequences

- After one `/grants init`, plain `pi` starts governed, records grants and refusals, and can open the dashboard
  without a shell export.
- The ledger is project-local and may appear as an untracked file after the first event. pi-daddy does not edit
  `.gitignore` or choose retention; those remain repository/operator decisions.
- The default is load-bearing. A read-only project or unwritable `.pi` directory causes delegation to refuse,
  visibly, instead of silently dropping audit records.
- Existing v1 stores do not change behaviour. The cost is one explicit rerun for existing projects.
- A user who wants environment-only governance or a different ledger keeps both controls. A permanently stored
  grant with no default ledger is not a new init mode in this change; use explicit environment configuration,
  or remove the store and choose again.
- No model-callable tool can activate this. `/grants init` remains a human-invoked slash command.
- Existing malformed-store semantics are not repaired here: absent and invalid both read as no store, which
  makes the root ungoverned. R-175 records the required tri-state follow-up; parser rejection alone is not
  described as session-level fail-closed behavior.

## Revisit trigger

Revisit if a project-local ledger causes repeated repository clutter or unwritable-path refusals, if operators
need a first-class ledger-only disable command, or if any child with an inherited grant is observed consulting a
cwd store instead of its environment. The last observation is a capability-boundary defect, not a UX trade-off.
