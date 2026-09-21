# Work and learning in Pi

This guide targets **pi-daddy 0.28.1** with **skill-harness 0.17.0**. Completed ledger history now has
visible hidden counts and an h + Enter toggle. Existing installed-skill discovery remains unchanged.
Release qualification and publication are recorded in the release PR; version metadata alone is not proof.
The [current requirement register](./REQUIREMENTS.md) separates implementation from release evidence.
From an installed shell command, `pi-daddy guide` prints this guide; `pi-daddy current` prints the register.

## Start once

After the patch is published, install it with Pi's normal package manager:
`pi install npm:pi-daddy@0.28.1` and `pi install npm:skill-harness@0.17.0`.
Do not treat these planned version commands as evidence the packages are already available.
Start a **fresh Pi session** after upgrading the harness: its existing immutable bridge survives `/reload`.
The extension starts with local governance, observation and the timeline on; `/grants init` remains an optional way to save an explicit project ceiling, not a bootstrap requirement. Run `/grants` to see the root's observed tool ceiling and usable definitions.
Enabled installed runtime skills are used in place, using Pi's package filters and config directory.
No `.pi/skills/` copies are created for them. Existing local overrides and `.pi/pi-daddy/settings.json` are preserved;
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

## Activity timeline

When the extension runs, pi-daddy records a local activity timeline by default at
`.pi/pi-daddy/activity.jsonl`. It shows separate parent turns, governed child lifecycles, observed
skill-file availability/reads, and declared runtime-skill lifecycle. A compatible Herdr plugin opens one
right-side panel per parent tab without taking focus; `/grants dashboard` remains the visible Pi fallback
when Herdr/panel setup is unavailable. `PI_DADDY_GOVERNANCE=off` is the visible governance opt-out;
`PI_DADDY_ACTIVITY_TIMELINE=off` stops observation; and
`PI_DADDY_ACTIVITY_CONTENT=metadata-only` stores only digest/size metadata for new prompts/final answers.
Those choices do not silently add grants, tools or child authority.

The dashboard's Everything / Agents / Skills / Needs-you filters and `h` history toggle are keyboard
controls. Quiet completed roots and child tasks collapse with visible counts; failed, waiting and active
context remains visible. `d` reveals metadata and private-content controls. Rows use stable session-local
aliases such as `r1/t2`; use `p r1/t2` or `f r1/t2` to load the exact local finalized user message or final
response after path, size and digest checks. An alias never renumbers when the panel refreshes or another
root appears. The legacy `p <root-id:task-id>` / `f <root-id:task-id>` form remains valid; a bare task id is
refused so simultaneous roots cannot select each other's private content. Pi exposes the finalized user
message, not a separate pre-transform editor buffer, so entered-text provenance is explicitly unavailable
rather than guessed. Private detail text is rendered as literal local text: terminal controls are shown as
escapes, intentional line breaks remain, and long lines wrap to the panel width.

The timeline labels every state as text as well as color: **USER** prompts are blue, **AGENT** activity cyan,
**SKILL** facts purple, **WAIT** / **NEEDS YOU** amber, **FAIL** red, and **DONE** execution completion green.
`PARENT TURN ENDED` is deliberately separate from child outcome; a parent with failed launches shows a
red `OBSERVED CHILD FAILURES` total and never calls that accepted. Availability-only runtime skills stay out
of the default view (use Details or the Skills filter); read and declared active remain separate concise
facts. A skill being available, read, or declaring itself active proves neither compliance nor acceptance.
`--no-color`, `NO_COLOR`, non-TTY dashboard output and the programmatic `color: false` option keep the
same text/icons without terminal escapes.

Pi's public theme format supplies only a global `userMessageBg`, and the public extension API can select a
registered theme but exposes no per-extension renderer or background token for ordinary assistant transcript
messages. pi-daddy therefore does **not** alter Pi prompt/response transcript backgrounds or mutate messages;
the reversible visual presentation is the activity panel's accents and metadata only. Runtime skills can
honestly report declared state with a generic `activity_lifecycle` call; it adds no authority.

## Inspect the read-only execution ledger

Every ledger line is a record envelope chained to the previous line. If pi crashed mid-write, the dashboard shows
every intact record plus one "ledger damaged at line N" marker, new delegations refuse with `LEDGER_DAMAGED`, and
`pi-daddy ledger repair <path>` previews the torn tail by line number and size; `--yes` truncates it. An old
`.pi/grants.jsonl` is imported once at session start and left untouched.

The ledger dashboard (`pi-daddy-dashboard --ledger <path>`, without a connected host or daily inputs)
shows the latest three quiet roots per workflow and in the ungrouped tree, plus the latest two quiet
children per parent. Hidden roots have a visible count; hidden child subtrees retain their count.
Type `h`, then Enter, to expand all completed history; repeat to collapse. Active, failed, refused
and incomplete branches and their ancestors always stay visible. `d`, then Enter, toggles governance
details independently. These controls only change the display, and reset when the dashboard restarts.

## Read and steer the panel

The outcome comes first, followed by **Running**, **Waiting**, **Needs you** or **Finished**. Active rows
show observed model/effort; unknown observations stay unknown. Completed attempts are collapsed.
**Finished is not accepted.** In this connected daily panel, `d` opens diagnostics and attempt history. There are no guessed percentages or ETAs.

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

`.pi/pi-daddy/work-setups/` holds private setup history; `.pi/pi-daddy/work-current.json` selects work;
`.pi/pi-daddy/learning-workspace.json` and `.pi/pi-daddy/work-policy-registry.json` are navigation/binding records, not authority.
`.pi/pi-daddy/work-registry-bindings/` preserves settings-store bindings per work scope.
Original bounded run/control stores live under the operator's local state directory; `.pi/pi-daddy/work-last-run.json`
locates the most recent result. Do not hand-edit these records. Invalid/aliased/mismatched bytes refuse.

This governs **Pi's tool surface**, not a hostile process or same-UID actor. `bash` can escape governance;
workspace routing is not OS containment. Human authority, genuine labels, calibration and later outcomes
must actually exist. The UI cannot manufacture them, and this guide does not claim they have been obtained.
