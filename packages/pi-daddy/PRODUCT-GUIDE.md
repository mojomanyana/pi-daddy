# Work and learning in Pi

This guide targets **pi-daddy 0.27.1** with **skill-harness 0.16.0**. The 0.27.1 patch references enabled
installed runtime skills directly and prevents setup from creating duplicate project copies.
Release qualification and publication are recorded in the release PR; version metadata alone is not proof.
The [current requirement register](./REQUIREMENTS.md) separates implementation from release evidence.
From an installed shell command, `pi-daddy guide` prints this guide; `pi-daddy current` prints the register.

## Start once

After the patch is published, install it with Pi's normal package manager:
`pi install npm:pi-daddy@0.27.1` and `pi install npm:skill-harness@0.16.0`.
Do not treat these planned version commands as evidence the packages are already available.
Start a **fresh Pi session** after upgrading the harness: its existing immutable bridge survives `/reload`.
In the project, run `/grants init`, review capability consent, then `/grants` to see usable definitions.
Enabled installed runtime skills are used in place, using Pi's package filters and config directory.
No `.pi/skills/` copies are created for them. Existing local overrides and `.pi/grants.env` are preserved;
review old copies before removing one to follow installed package updates. Unregistered npm packages retain
legacy copy scaffolding. This works for any runtime skill package; there is no Principal-specific policy.
A definition without `allowed-tools` remains unavailable until its author declares a ceiling.
Select an available authenticated Pi model; this product never copies credentials or chooses a fallback.

## Declare, run, inspect

1. **`/grants work new`** asks for an overall outcome, then one to eight tasks. Each task has its own
   outcome/instructions, agent definition (or **No tools**), explicit model and requested effort.
2. Choose which earlier tasks each task depends on, then the maximum parallel agents (one to eight).
   No dependencies means independent work; a chain expresses sequential work. Review and save.
   **Saving does not run anything.** Text is retained in owner-only local files, not governance ledgers.
3. In Herdr, **`/grants host`**, then **`/grants dashboard`**, connects the existing owner to a right panel
   without moving focus. The plugin/install handshake and actual Pi pane ownership still apply.
4. **`/grants work run`** shows the exact setup and bounds, then asks before launching. Every child goes
   through the original delegation/grant/approval/executor path. Failed predecessors block only their
   dependent branch. Complete predecessor output is handed over only within the 32 KiB bound; it is
   never silently truncated. Child deadlines/output limits and the subtree budget remain enforced.
5. **`/grants work results`** opens retained output. Editor changes are discarded; control characters are
   escaped. A digest mismatch is an error, not permission to substitute another artifact.

The run is finite, with no automatic retry or restart recovery. Esc requests cancellation and waits for
original children to settle. Ordinary model work has **no universal dollar/token cap**; provider usage is
not invented from output size. Effort is an observed/requested launch setting, not measured internal thought.

## Read and steer the panel

The outcome comes first, followed by **Running**, **Waiting**, **Needs you** or **Finished**. Active rows
show observed model/effort; unknown observations stay unknown. Completed attempts are collapsed.
**Finished is not accepted.** `d` opens diagnostics/history. There are no guessed percentages or ETAs.

Enter a displayed **number** for its action. A repaint never gives an old number a new meaning; stale
choices refuse. Feedback distinguishes acknowledgement, applied control, pending and unknown results.
Pause stops new admission, not active children. Pending bounded tasks wait for resume. Stop-agent targets
one original active handle and does not cancel siblings. A pause racing an approval can still refuse that
attempt at the original boundary; it is not automatically retried. Reads/redraws never request work.

**`/grants work`** also selects saved setups or the task for ordinary `delegate`, changes priorities,
and records scope revisions or alternatives. Live changes use the existing owner's validation/CAS.
Topology changes require new work; active runs are never rebound. A selected-scope change prevents the
old bounded order's remaining children from starting. **`/grants host stop` refuses while paused: choose
Resume new work in the original dashboard first.** Busy/pending controls must finish or be explicitly
reconciled first. Unknown acknowledgements keep the host for readback; stop never silently releases them.
Ending the whole Pi session disconnects the host, but does not reconcile unknown effects. A successful
stop preserves evidence, not a recoverable controller, and cancels no child. **Disconnected** means live
actions are unavailable, not that children stopped.

For shell inspection only: `pi-daddy work list` and `pi-daddy work show` (`--dir` is optional).
The existing `pi-daddy work add --id … --outcome …` single-obligation entry point remains supported.

## Learn deliberately; earn interruptions separately

1. **`/grants learning`** creates or explicitly connects a local learning workspace for this exact work
   snapshot, archive, population and author. Scope changes require a new explicit connection, not reuse.
2. Start the daily host, then choose **Retain current work for learning**. This captures actual P01
   observations and binds the real resulting case batch. An empty batch remains empty.
3. Open the guided learning review. Review retained cases; connect qualified retained comparisons;
   inspect **all** comparison artifacts. Record an explicit durable quality choice **before** revealing
   model/cost. Artifact contents themselves may reveal identity; prior excerpt feedback remains prior
   feedback, never a full-artifact or fresh-blind judgment.
4. Record **adopt / reject / defer** separately. Quality preference is neither adoption authority nor
   activation. Missing evidence, unresolved cases and unavailable artifacts have explicit defer reasons.
5. The harness's **Trust / independent labels** forms freeze a scoped population/policy and separately
   obtain independent case and unflagged-sample labels. A nomination, success exit or human click is not
   calibration. Unconfigured/insufficient/stale trust remains silent or deferred; attention is not reset.

Deliberate review does **not** reserve earned automatic exposure. For an automatic closing request use
`/grants host closing`, pause new work and settle/cancel active children. The panel offers retained case
cards only under the original presence/quiescence/trust/attention rules. A visible acknowledgement is
separate from preparation. If trust changes, explicitly resume new work, then stop/start the host to bind
the original configured trust store; its retained attention is reused, never refilled.

## Adopt settings for later orders

Under **`/grants learning` → Adoption / rollback for next orders**, create the scoped registry and prepare a named
model/effort profile. This records candidate bytes, **not evidence that they are better**. A qualified
comparison must bind that exact candidate digest to real outputs and its actual original hypothesis/case.
Use the guided review to link those retained origins; missing qualifying data remains a scoped defer.

**Activate adopted comparison** configures that binding, separately asks for independent current
eligibility and exact activation consent, then applies the original registry and links its real receipt.
Only model/effort for the same task IDs and definition names can vary. Task instructions, topology,
capabilities and assessment meaning cannot expand through this profile. Normal definition-digest/approval
checks still run; this does not freeze definition files or the project tree. Fixed-policy contracts are unchanged.
Subsequent bounded `/grants work` runs ask for fresh eligibility and pin the profile; active/old runs never
migrate. Ordinary direct `delegate` calls keep their explicit caller configuration. After selecting different work,
this menu explicitly reconnects that scope's saved settings or creates a fresh baseline; old stores remain.

**Roll back active adoption** shows the immutable restore digest and each task's exact retained model/effort
before separate consent for next orders. With nested adoptions, this is the previous profile, not necessarily
baseline. Missing or inconsistent registry lineage refuses instead of substituting a named profile.
If effect and learning linkage separate on failure, **Recover learning link** reconnects the original
registry observation without replaying activation/rollback.

After actual adopted work, **Link observed result from latest adopted order** shows real retained bytes,
asks for an independent outcome/note, previews its scoped classification and confirms the link.
**Unknown** is valid. Acceptance stays absent; runtime completion is not confirmed quality, calibrated
improvement or automatic rollback. More extensive independent observation entry is available in the harness.

## Boundaries and local state

`.pi/work-setups/` holds private setup history; `.pi/work-current.json` selects work;
`.pi/learning-workspace.json` and `.pi/work-policy-registry.json` are navigation/binding records, not authority.
`.pi/work-registry-bindings/` preserves settings-store bindings per work scope.
Original bounded run/control stores live under the operator's local state directory; `.pi/work-last-run.json`
locates the most recent result. Do not hand-edit these records. Invalid/aliased/mismatched bytes refuse.

This governs **Pi's tool surface**, not a hostile process or same-UID actor. `bash` can escape governance;
workspace routing is not OS containment. Human authority, genuine labels, calibration and later outcomes
must actually exist. The UI cannot manufacture them, and this guide does not claim they have been obtained.
