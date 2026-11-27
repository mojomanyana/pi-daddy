# pi-daddy

Coordinate Pi's engineering work and see the evidence behind a result. **[Start here](https://github.com/mojomanyana/pi-daddy#start-here)** for the tested ecosystem install, a first task you can check, and recovery after `/new`. To install pi-daddy on its own, use [Install and first run](#install-and-first-run).

**Capability governance and coordination for [pi](https://github.com/badlogic/pi-mono)'s multi-level agent system.**
An orchestrator grants each sub-agent a deliberate subset of what it holds and withholds the rest. A sub-agent may
delegate further, but only ever a subset of what it holds. Enforcement is pi's own `--tools` allowlist on a separate
child process, with an optional append-only, hash-chained governance ledger.

This file is the product description, present tense. If code and this file disagree, fix this file. Agents start at
`AGENTS.md`, which carries the rules, the decisions still in force, the measured facts and the roadmap.

## Highlights

- **One-command setup & diagnostics:** `npx --yes pi-daddy@latest setup --preset auto` installs updateable Pi sources and writes `~/.pi/agent/ecosystem.json`. Use `pi update --extensions` for later updates and `npx --yes pi-daddy@latest doctor` to check runtime requirements and package pins. Install Daddy on its own with `pi install npm:pi-daddy`.
- **5-Tab Terminal & Web Side-Panel Dashboard:** `/dashboard split` launches the CLI bundled with the loaded extension. Use `/dashboard open` for the browser view or `/dashboard` for the URL and the command for a second terminal.
- **Cross-OS `delegate` (`portable-child.ts` + `inprocess-readonly.ts`):** native sub-agent execution on macOS, Windows, and Linux x64, plus sub-150ms in-process `quick_review`.
- **Parallel Worktree Tournaments (`delegate_tournament`), Smart Auto-Escalation & 2-Stage Classifier Auto-Harvesting:** parallel isolated git-worktree candidates with cold-judge selection, 1-shot strong-model rescue on `principal:thrash-detected:v1` or manual `[x]`, and fail-closed 2-stage fast-LLM session harvesting into `~/.pi/agent/pi-daddy/harvested-evals/<repo>/` (`[h]` hotkey).
- **`principal-pi-skills@6.x` binding:** validates both v6 3-phase (`build`, `review`, `debug`) and legacy v5 manifests in `principal-agents.json`.

## Work mode: optional approach guidance

**Standard (current behavior)** is the default. It adds no work-mode prompt to the
parent or children. **Ambitious** adds concise guidance to choose useful methods,
challenge assumptions and verify the agreed outcome. It changes no permissions,
models, tools, or execution limits, and starts no separate provider call.

Open **Settings → Work mode → Choose work mode…**. The editor is a draft until
**Apply work mode**; **Cancel** leaves settings unchanged. Choose:

- **This session:** applies to subsequent requests; replacing it clears a queued
  next-request override. Resuming the same session restores its saved selection.
- **Next request only:** applies to the next Pi run and its descendants, including
  retries and continuations within that run. It is consumed at request start.
- Optional combined emphases: **Faster delivery**, **Better outcome**, **Deeper
  proof**, **Broader approaches**. No emphasis selected means balanced guidance;
  these are useful directions, not required workflow stages.

The Overview keeps Work mode separate from permissions. Settings distinguish
**active now**, **session default** and **next request only**. Changing a setting
while work is running leaves that run and its children on their captured mode.
`/new` starts Standard; it neither erases project memory nor repeats completed work.
A fork retains its branch's session preference but does not carry a one-shot override.

Without a separate dashboard, use `/work-mode` for the interactive chooser:

```text
/work-mode standard session
/work-mode ambitious session depth range
/work-mode ambitious next speed
/work-mode status
```

Principal and other installed runtime skills retain their assigned roles and
definitions. Read-only work remains read-only. Bookie, Scout and Harness are optional;
mode guidance requires no particular package, research run, memory write or evaluation.
A missing optional tool narrows methods and evidence claims rather than stopping
independent work. A mode does not grant standing monitoring or background work.

Selections are bounded metadata in Pi's native session, not instructions restored
from project notes. Unsupported or unreadable optional metadata falls back to
Standard with a settings notice. A failed save leaves the prior selection in force;
an override whose consumption cannot be recorded is not used.

Local scripted checks establish control behavior and propagation. They do not
establish that Ambitious improves a model's judgment, delivery quality or speed;
that requires a separately designed comparison.

## Reliable workflow handoffs

Native delegation accepts an optional stable `operation_id`. The session owner admits one
matching request; a concurrent or later duplicate returns its existing execution reference.
It does not launch another child, replay a completed mutation, or grant approval. A changed
request under the same ID refuses. The request covers the selected definition's `definitionId`, not
whether the call supplied it, `delegate_describe` filled it in or it was omitted: a describe or tree
navigation between identical calls leaves it the same request, and a changed definition makes it a
different one. An intentional retry needs a new attempt after the
previous operation is proven settled or never started; uncertainty stays blocked.
Principal 4.12.0 introduced automatic operation IDs and exact candidate/report references for this contract.

Stable-ID attempts also retain private producer evidence under
`<PI_CODING_AGENT_DIR>/pi-daddy/operation-results` (default agent directory: `~/.pi/agent`).
Admission is synchronized before dispatch; a restart with no published result leaves the attempt uncertain,
not safe to rerun. Exact visible finals and available visible partial output remain distinct from native
cleanup, successful work, review approval and current applicability. Diagnostics settings do not control this
required result store. No raw session, reasoning, environment or task request is captured here.

`OperationArtifactRef`, `openOperationArtifacts` and `readOperationArtifact` are available from the package
root without loading the extension, Principal or Bookie. Immutable references bind the original owner,
operation, execution, manifest hash and authored bytes. Historical reads require the selected agent directory,
check identity and confinement, and refuse missing, altered or oversized evidence. Authored content is bounded
at 4 MiB per result; manifests at 64 KiB. There is no automatic lifetime quota or deletion: the operator owns
retention and backup. Deleting evidence does not establish that an interrupted execution never started.

The live `pi-daddy:operation-status:v1` reply retains its original meaning and may add
`operation.artifact`. `pi-daddy:operation-history:v1` accepts `{version:1, requestId, sessionId, cwd,
operationId, reply}` for the currently bound session/canonical cwd only, returning `history:true`, the
historical `operation`, optional `artifact` and exact `final` or explicitly `partial` content. It never claims
live qualification or approval. Pi custom entries contain only `pi-daddy:operation-artifact:v1` references.
Bookie can register a reference afterward; a registration retry never dispatches the child again.

## Shared task history and controls

Select a task through Bookie to see its title and latest recorded event at the top of Overview and Tasks. Open the row to inspect the reporting tool, event time and dispatch state. Each tool retains its own execution receipts. The task view covers recorded observations. Bookie can recover enrolled admission, control and cleanup facts from the owner journal.

When Bookie supplies progress details, the task preview shows the latest reported step and whether its latest file checkpoint is awaiting publication or saved to private history. Open the row for up to four recent steps and the file coverage. A worker heartbeat can refresh its observation while the last reported step stays visible. The display updates when Bookie publishes or the dashboard refreshes its source.

In task details, press **p** to pause new work, **c** to request cancellation, **u** to resume or **b** to set a budget. Press Enter to apply. Pause lets admitted work settle. Cancel signals participating workers and displays pending cleanup. Resume after cancellation requires confirmed cleanup. These controls apply to task-bound operations participating in the local protocol. The individual tool still determines what it may execute.

Pausing or cancelling also holds new root Pi shell and file-editing calls (including shell commands used only to inspect files). Direct file reads, searches and task history remain available. Already running inline commands and custom tools outside the task protocol have their own lifecycle. Inline calls consume no delegated attempts.

Use `:task budget 12` to share twelve admitted attempts across participating operations, including children and their enrolled research or evaluation calls. Related subtasks inherit the parent’s allowance and pause state. Select the root task to change its shared controls. Each subtask retains its own observation history. Each distinct owner operation consumes one shared attempt. You can also limit an individual owner. For example, `:task budget scout 4` allows four Scout attempts in total for this task. `:task budget pi-daddy off` removes the parent-delegation cap. Counts and controls follow the selected project and task across sessions in this Pi agent directory. Reusing a retained result consumes no attempt. A budget requires an explicit value. External services, token usage and money have separate accounting. Participating Daddy writers share one reservation per working copy. For parallel edits, choose separate registered Git worktrees. Reads and receipt reuse can proceed alongside a writer. If Pi exits during reservation, its successor can release the writer after proving the original process died before native execution began. A recorded launch intent still requires a native cleanup receipt. The original admitted attempt remains in history and retains its budget charge. Other processes can still edit the filesystem.

## Current-session dashboard

Open **1 Overview** to see what needs your attention, what Pi is doing and the latest finished tasks. **2 Tasks** has the complete session list. **3 Reviews** opens pending handoffs. **4 Activity** groups related events into a timeline. **5 Evidence** lists saved results. **6 Settings** holds session controls.

Use the arrow keys to select an item and **Enter** to open it. A side-by-side preview appears on Overview, Tasks and Reviews when the pane is at least 92 columns wide. Press **x** for an expanded view from 82 columns. **Esc** returns to your selection. Press **r** for a session recap, **m** for models or **v** for package versions. Standalone ledger views and older owners retain the legacy display.

When a decision is pending, Overview directs you to the main Pi chat or to Reviews. Bookie handoffs show the command and the output to select. **Memory** and **Research** show current availability separately from saved topics, findings and gaps. Select either row and press **Enter** to browse the available content. Older producers retain their status-only display. A package can be installed while its live status is unobserved. After a disconnect the dashboard labels the last known state and withdraws current permission requests.

In a trusted interactive project, Bookie workspace memory starts by default and can save and recall routine notes for the current folder. Look for **Bookie memory · Ready in this folder** under Overview → Memory. With a Bookie version that reports saved choices, Overview and Tasks list them under **Open choices**. Select a question and press **Enter** to see its alternatives. A supported recommendation includes the reason and evidence. Pick an option or **Write my own answer**, check the answer, then save it in Bookie. **Decide later** leaves the question open. After `/new` in the same folder, Pi can recall the decision and the other questions stay open. Older Bookie versions can show questions in read-only mode. Turning off **Bookie workspace memory** in Ecosystem settings withdraws automatic memory access and hides those choices.

When Bookie supports corrections, **Not a separate decision** offers a separate confirmation: remove only that item from Open choices, keep the original note, and record no answer. Use it for a progress summary mistakenly presented as another decision. Decide later still leaves the choice open. Older Bookie versions retain their existing controls; no question is hidden by its wording.

The startup delegation summary may say **checking available tools** until Pi provides its first callable-tool inventory. It refreshes automatically when work starts, including after `/new`. A parent tool such as Scout can be available while a skill using it remains unavailable to children; **use the parent Pi session** identifies that restriction. More permission does not provide a missing child tool.

Task descriptions can come from a short public description supplied by the delegating model. When that description is unavailable, the dashboard uses the activity it actually observed. This works without a summarization request or JEV. Open details to inspect a source, and use **x** when offered to see exact references. Saved evidence, process completion and approval are separate facts. Explicit **p** and **f** reads use the existing retention controls.

The resource display covers the parent Pi process. Transcripts, private reasoning, shell commands and tool results are outside the session activity feed. The dashboard displays only the current owner's tasks and sources.

### Optional remote LLM telemetry

The dashboard's **Settings → Telemetry** row enables or disables a session-local hardware probe; it is off by default and disabling it cancels its active local SSH process and stops further probe steps. Pi session shutdown and reload await that same cleanup. It uses the configured SSH client and existing remote `amdgpu_top`; it does not install software, start services, or start the model. Telemetry is display-only and never enters a model prompt. Failures are isolated from delegation and the rest of the dashboard.

Configure these three values before starting Pi (they are not stored in the project or displayed back as credentials):

```bash
export PI_DADDY_LLM_TELEMETRY_SSH_TARGET='user@host'
export PI_DADDY_LLM_TELEMETRY_SSH_IDENTITY="$HOME/.ssh/your-diagnostics-key"
export PI_DADDY_LLM_TELEMETRY_SERVICE='your-llm.service'
pi
```

The account needs non-interactive SSH access, permission to run `~/.local/bin/amdgpu_top`, and permission to query the configured systemd service. Configure the service as a systemd unit name without shell punctuation; host targets must be a host or `user@host` form. Telemetry SSH settings are removed from delegated child environments. Each SSH command has its own timeout (2–4 seconds) and bounded output; the next probe starts at least two seconds after the previous probe finishes. In Settings select Telemetry and press Enter to enable; select it and press Enter again to stop. States distinguish disabled, missing SSH configuration/dependency, confirmed inactive model service, disconnected SSH, stale sample and connected. A failed service query other than systemd's inactive result is reported as disconnected. GPU activity and edge temperature are shown only when numeric samples exist. System RAM used/total comes from `/proc/meminfo` (`MemTotal` minus `MemAvailable`), including when the model is stopped. On an APU this is a shared system pool, not a GPU-only allocation; the `amdgpu_top` GTT/VRAM heaps are not substituted for physical RAM. Missing, malformed or inconsistent memory values remain unavailable. Prompt/generation speed remains unavailable; `llama.cpp --metrics` may expose aggregate metrics, but no verified per-token speed is claimed. A stopped model therefore remains stopped without an inferred rate.

To try a source checkout, build its dashboard before loading that checkout's extension; editing source does not change an installed package or an already running dashboard:

```bash
# From the checkout root, with its development dependencies already available:
npm run build
pi --no-extensions -e "$PWD/packages/pi-daddy/extensions/grants.ts"
```

This explicit test session loads only the selected extension. Keep other normal sessions separate. After testing, start Pi normally to use its installed extensions.

Controls remain the existing authenticated owner controls. Changes show pending, applied, refused or
unconfirmed status. Unconfirmed mutations need owner inspection before retry. Auto changes current
permission handling, and model/wall/idle edits apply to future children. Running children keep captured settings. The dashboard does not implement a
new pause/cancel/stop route: use the owning Pi control, and treat a reported request as unconfirmed until
its owner reports settlement.

Display storage is bounded and memory-only: at most eight source updates of 4 KiB, 32 parent activity
observations, 16 recent producer-reference identities, and four metadata files of at most 2 MiB. Unchanged
metadata is cached with a one-second file-check interval; package version inventory is cached for five seconds
per owner. Versions includes optional Scout/Bookie observations and separates installed bytes from loaded
generations; a local 0.0.0 Bookie manifest is not evidence of npm publication. The view does not scan historical artifact stores,
make provider calls, or write durable records on redraw. Larger ledger files are reported unavailable in
this view rather than silently truncated into a false complete history.

The optional event `pi-daddy:dashboard-source:v1` takes a trusted
`{version:1, sessionId, cwd, producer, producerVersion, reply}` registration for the actual current native
owner and canonical cwd. A successful reply supplies `{version:1, ok:true, generation, publish, close}`.
`publish({sequence, items})` accepts strictly increasing nonnegative sequence values, no more than eight
items and 4 KiB total. Each item has `id`, `kind` (`goal`, `next`, `work`, `review`, `evidence`, `status`),
`label`, `state` (`observed`, `running`, `dependency-wait`, `approval-wait`, `cancel-requested`, `settled`,
`failed`, `unknown`, `unavailable`), optional bounded `details`, and an optional opaque display `reference`.
IDs are bounded to 160 characters, labels to 240, details to six strings of 240, and references to 512.
Replacing a producer invalidates its prior publisher even at the same version; session/lifecycle changes
invalidate all publishers. Registered extensions own refresh/closure; no callback conveys permission,
review approval, a content resolver, or executable actions. The exported TypeScript interfaces document
this seam without making other ecosystem packages mandatory.

The dashboard shows the selected task's last observed tool event and time since that event.
Details include the actual recorded working directory and phase where available. Silence is
not proof of a hang, and a finished process is not an approved task. Tool observations include names, times, local call references and bounded descriptions of the action.
A delegating model can supply a short public `dashboardSummary` during its usual call. Metadata-only and off modes omit this model-authored text. Diagnostic retention remains operator opt-in.

The coordinator can use Principal's native tool-only Codemode adapter. Nested calls retain
Pi's normal permission and cancellation hooks. Governed children cannot request `codemode`
or `principal_codemode`; that child execution path is not qualified.

## Install and first run

```bash
pi install npm:pi-daddy
pi
```

Open Pi and start your task. An interactive parent discovers the agents Pi has selected and restores the
project's saved permissions automatically. Additional agents supplied by extensions become available before
the first task. In a fresh project the session uses its observed tools and the existing permission gates.
Run `/dashboard split` in Pi to open the 5-tab side panel. Run `/dashboard` for the browser URL and the command for a second terminal.

Use `/grants` to inspect access. To explicitly save a different project ceiling and enable the project governance
ledger, use `/grants init`. It also creates the review copy at `.pi/pi-daddy/settings.json` and stores the enforced
choice outside the workspace. Headless runs and children keep their existing setup. `PI_DADDY_GOVERNANCE=off`
still disables governance. The standalone `pi-daddy init` command prepares review files.

## Optional local public evidence capture

Set `PI_DADDY_PUBLIC_EVIDENCE_DIR` before starting the coordinating Pi process to retain exact public
`delegate_describe`, `delegate`, `delegate_all` and `delegate_chain` return content. It is off by default,
including source-byte retention. Create a private directory owned by your user first, then use its canonical
absolute Linux path (no symlink components):

```bash
mkdir -m 700 "$HOME/pi-public-evidence"
PI_DADDY_PUBLIC_EVIDENCE_DIR="$(realpath "$HOME/pi-public-evidence")" pi
```

Each returned result keeps its authored text, runtime evidence, error state and structured details. An added
`Public evidence capture:` text block gives `status: "captured"` and a reusable `{path, sha256}` reference to a
versioned `pi-daddy-public-evidence-v1` manifest. Read and hash-check that manifest and its referenced files;
the manifest's `response` copies the exact public `{isError, content}` before the reference block is appended.
This is the extension-return boundary, not a claim about downstream Pi hooks or provider wire serialization.

Selected definition sources are copied from the bytes admitted during discovery, including the inline skill,
Principal binding manifest, package identity and delegated agent where applicable. The exact dispatched body
is a separate file. Raw source-copy SHA-256 preserves every byte, including a BOM; `sourceHash` retains the
runtime's existing decoded-text hash semantics. Changing a source path later does not rewrite the snapshot.
Manifest `requestedDefinitionId` is the caller's claim; `definitionId` is the observed planner selection.
An ID Daddy filled from an earlier describe is no claim, so `requestedDefinitionId` stays null there.
Requested execution IDs are allocated occurrences, not proof that those children started. Runtime outcomes
contain only the existing allowlisted final and process-receipt projection, in original child/step order;
skipped steps have no invented outcome. The captured `response` holds the version 2 summary the model received,
computed from that complete version 1 projection alone. `finals` also copies each complete attributed public
final separately, with its ordinal, execution ID and native session/message/leaf identity. Its byte hash must
match the native final hash; unavailable finals remain null. Consumers never need to reconstruct a final from
report delimiters. Process settlement remains separate from workspace cleanup.

The configured root must already exist with owner-only permissions. Captures use exclusive ordinary files,
held directory descriptors and fsync before publishing a reference; each capture is limited to 64 MiB and
64 files. Files are mode 0600 and capture directories mode 0700. The operator owns total retention and disposal;
there is no automatic deletion or lifetime disk quota. Partial files can remain after a failure.
An unavailable source snapshot, bad path, permission error or capture limit produces a loud `failed` status
without a success reference. It does not rewrite work results, respawn children or turn a failed execution into
success. Typed exceptions before a result is returned preserve their original behavior and have no returned
capture. The directory setting is stripped from captured-child environments. The same Pi owner restores its own setting
on extension reload; unrelated owners do not inherit it. Set the value to literal `off` to explicitly disable
capture on reload; future calls use the replacement setting while in-flight calls retain their original root.

No request task text, tool arguments, credentials, private session/reasoning, raw `details` or hidden diagnostics
are collected by this feature. Public authored output can itself contain sensitive information, so choose the
local root deliberately. Hashes identify retained bytes; they do not authenticate against hostile processes
running as the same user. Capture integrity establishes neither reviewer approval nor task completion and
adds no grants, ledger events or automatic resumption. Future JEV/LoRA experiments may explicitly consume
reviewed public evidence offline; this feature sends nothing to an external evaluator.

## What a definition is

An [Agent Skills](https://agentskills.io/specification) `SKILL.md`. Its `allowed-tools` is the ceiling; its body is
the child's system prompt. The standard specifies `allowed-tools` as "pre-approved" and marks it experimental: it
declares intent and blocks nothing. Passed through `--tools` it becomes structural. That is the contribution.

```yaml
---
name: review-security
description: Reviews a diff for authn/authz, injection and secrets handling.
allowed-tools: Read, Grep
---
Review ONLY the diff you are given, for security. Report findings; never edit.
```

## The three tools

```
delegate({ agent: "review-security", task: "Review the diff." })
delegate_all({ children: [ { agent: "review-security", task: "…" }, { agent: "review-perf", task: "…" } ] })
delegate_chain({ steps: [ { agent: "plan", task: "…" }, { agent: "build", task: "Implement: {previous}" } ] })
```

Each child is a separate OS process with its own tool allowlist, its own instructions and no knowledge of its
siblings. `delegate_all` runs children concurrently under the active descendant capacity limit.
`delegate_chain` runs steps in sequence; each step receives its predecessor's complete verified final inside a
fenced, labelled, nonce-delimited block. A required final exceeding the 32 KiB handoff bound stops dependent steps;
the complete result remains available to the caller. The chain is planned and gated before any step runs. A child may itself hold `delegate` and spawn further, with the
same tools, one level deeper, under the same rules.

## What a child receives

By default a child gets its definition body, trusted locations for that selected definition, and the task. Parent conversation context is a
capability. `context:<mode>` names how much of the parent's own session crosses, and it attenuates like every other
id, so a child can never receive a richer handoff than the definition's ceiling and the parent's grant allow.

```
delegate({ agent: "review", task: "Independently inspect and review the current checkout diff." })

delegate({ agent: "build", task: "Implement it.",
           context: { mode: "files", files: ["src/kernel/resolve.ts"] } })
```

| Mode      | What crosses                                                                    |
| :-------- | :------------------------------------------------------------------------------ |
| `none`    | nothing beyond the definition and the task; the default                         |
| `files`   | the contents of paths the parent names, confined to the working directory       |
| `pruned`  | the last few turns of the parent's session, plus older turns naming those files |
| `summary` | what the parent writes in its own words                                         |
| `fork`    | the parent's whole session, as a fork; **gated**, so a human answers first      |

A `delegate_chain` step takes the same parameter, and because a chain is planned as one unit, a gate any step
raises is answered before the first step runs.

The modes are ordered, and each subsumes the weaker ones: a parent holding `context:fork` may hand a child
`context:files`. What crosses arrives inside a labelled, nonce-delimited fence marked as data rather than
instructions, capped at 32 KiB, with anything that did not fit said inside the fence. The capability decision record
names the mode the child actually received and how much crossed.

`delegate_describe` also returns `contextContract`: the selected definition's permitted modes, the explicit
`none` default and bounds for file inputs. This describes a ceiling, not a grant. For an independent reviewer
with read access to the same checkout, omit `context`; use `files` only when it is permitted and actual file
contents need handing over. A `summary` is not valid for a definition capped at `files`, and must not be
disguised as task or file content. Nothing automatically rewrites or drops a requested handoff.

A refused context request names the correction. If a new operation was recorded `not-started`, the error also
explains recovery: a bound workflow recovers its original operation; a standalone caller can make one corrected
attempt with a new operation ID. Existing operation IDs stay terminal and changed arguments never bypass their
identity check. If the original record cannot be written or already belongs to another attempt, inspect that
operation first; the current request's refusal is not proof that earlier work never ran.

`pruned` keeps recent turns plus turns naming the given files. The deterministic selector keeps those candidates
against the task, keeping a subset. A probe over the operator's sessions measured 0.737 delivered term recall at the
20-turn default; that is not task-success evidence and is not enough to make `pruned` the default.

## The guarantee, and its limit

```
effective = ( requested ∩ parentGrant ∩ ceiling ) \ (gated \ approved)
```

Escalation is impossible by construction on the tool surface: no policy engine, no model on the security path. Depth,
active descendant capacity, approvals and workspace routing attenuate the same way. When a governance ledger is configured, each
decision is recorded and the `denied` set is the signal: an agent repeatedly asking for what it does not hold is the
escalation tell.

What it does not do: contain an agent holding an execution primitive. A child granted `bash` can start a wholly
ungoverned descendant. Containing that is the operating system's job, so `bash` is **gated by default** in a
governed session and gating is closed under subsumption (gating `write` also gates `bash`). The escape is not made
impossible; it is made loud, which is what matters when the realistic threat is a confused or prompt-injected agent.

**`write`, `edit` and `edit-diff` are gated too, since 0.40.0, and the reason is the same one.** A review used
pi's own `write` from a governed child to rewrite the operator's stored grant — widening it from `tool:read` to
`tool:bash` — and to write the record that says which workspaces are routable. `write` takes an absolute path and
performs no confinement, so it reaches every operator-state file on the same account. It is therefore much closer
to `bash` than a tool allowlist suggests, and it is now loud for the same reason `bash` is. The cost is real:
most useful delegations write something, so they ask once until an approval is banked. `PI_DADDY_GATED` is the
escape hatch for an operator who wants the old behaviour, and an explicitly empty value gates nothing.

## Approvals

With Auto OFF, a gated capability needs a valid approval or the UI of the session executing the delegation. Captured children use Pi's JSON mode and cannot answer local permission dialogs; a gate with neither a valid approval nor an available UI is denied. The answer is **once**, **for this session**, or **always** (persisted for a bounded period, offered only for a
named definition, keyed `capability@subject`). Approvals inherit down the subtree intersected with each child's grant;
a `once` never crosses a spawn. The approval store and governance ledger never store raw task text. `/grants
approvals` lists what is persisted; `/grants revoke <capability>@<definition>` or `--all` removes it. The store lives
in pi's agent directory, not in the workspace.

**Auto mode** lets the operator approve every Daddy permission request for the current session and its descendants.
`/grants` marks an approval-only gate as `AUTO` when Auto is on. This is a preview of the permission step; actual delegation still rechecks Auto and all other execution conditions. Genuine refusals remain `BLOCK`.
Start Pi with `PI_DADDY_AUTO_MODE=1` for Auto ON, or `PI_DADDY_AUTO_MODE=0` (the default when unset) for Auto OFF.
In the connected dashboard, press **a** to switch it on or off. `/grants auto on` and `/grants auto off` control the
same session setting; `/grants` shows the current state and source. Reload preserves the session choice; a new
Pi session starts from the environment default. After `/new` in the same folder, use `/grants auto on` in the
new chat if you want automatic project memory and your launch default is OFF.

Auto is checked again before each delegation or chain step. Turning it OFF stops future automatic admissions;
already admitted work continues and independently granted manual approvals remain valid. Turning it ON can release
an outstanding Daddy approval prompt. An unavailable owning session never grants automatic permission. Automatic
decisions are recorded as `source: auto`, once for that admission, rather than banked as human or persistent approvals.
Capability grants, definition identity, workspace routing and execution settlement checks still apply. JEV calls and
LoRA storage retain their separate consent controls.

Monetary usage is observational. It never pauses, stops or authorizes a child. Available usage remains in
lifecycle records and episode reports; missing or partial coverage is not a zero-cost claim. Permission approvals,
depth, fan-out limits and execution timeouts are separate controls.

Child usage reaches the Pi session that delegated it. `delegate`, `delegate_all` and `delegate_chain` report their
children's observed model usage in Pi's tool-result usage field, which Pi adds to that session's usage totals,
footer and cost (Pi 1.0.4 and 1.5.2 record it). Each call is counted once, also when a child delegates further: a
child's lifecycle record and `pi-daddy report` keep its own calls, and its report to its parent adds what its own
delegations reported. `details.childUsage` gives measured and unmeasured children and the cost of the usage
reported; unmeasured usage is never estimated. A failed or timed-out child reports what it used, and so does a delegation that stops with an error after
its children ran, such as a critical-assurance veto: Daddy adds their usage to Pi's error result, whose text stays
unchanged. A reused operation reports nothing again. A child stopped while its own delegation was still waiting counts
that delegation as unmeasured, and a figure no delegation could plausibly reach (over 1e13 tokens, $1e8 or 1e7
executions in one value) is counted as unmeasured rather than added. The dashboard's ledger frame, with the owning Pi
session connected, and `pi-daddy report` say this usage is already in the delegating session's totals: compare, do
not add. The dashboard line counts the session's own delegation results only; a `delegate` run from a Codemode
script is in the session's totals through the `codemode` result, but not in that line. A `scout_research` call the
session ran for a child is in its totals on the same delegation result, as the session's own usage, not in that line.

## The ledger

When configured, `.pi/pi-daddy/grants.jsonl` holds capability decisions, child lifecycles, workspace leases, cost
and session configuration, and episode outcomes. Each line is a **record envelope**
`{v, seq, prev, at, kind, id, body, digest}`: `prev` is the hash of the previous line, `digest` the hash of the record.
A damaged file is read up to the damage; the writer then refuses with `LEDGER_DAMAGED` until `pi-daddy ledger repair
<path> --yes` drops the damaged tail. `/grants ledger` reports records,
escalation attempts, integrity, executors and which definition bodies ran, by digest.

The activity timeline (`activity.jsonl`, parent turns, child lifecycles, runtime-skill reads) uses the same envelope
and distinguishes extension-triggered custom runs from user turns. Extension turns retain their custom type
and the starting message's text, not unrelated queued messages; details and image payloads are excluded. This
is observation, not evidence of human authorization. The same content policy below applies to both kinds of turn.
The timeline is enabled by default. It may store private prompt and final content in `.pi/pi-daddy/content/`; set
`PI_DADDY_ACTIVITY_CONTENT=metadata-only` (or `off`) to keep only digests, or
`PI_DADDY_ACTIVITY_TIMELINE=off` to disable observation.

The default location is prepared during session startup, before product snapshots. Fresh ignore rules
cover activity/content and grants-ledger runtime files only; settings and unrelated files stay reviewable.
Existing ignore rules are preserved. Already tracked runtime data, unsafe storage paths or insufficient
exclusions report observation unavailable rather than silently changing repository policy. Custom and
transported timeline locations keep their existing policy. Non-Git roles can still record without Git;
an existing repository whose policy cannot be checked remains unavailable.

`pi-daddy outcomes` reads Git history, optional GitHub Actions results from `gh`, and narrowly recognized corrections
in the next recorded operator turn, then appends only changed `episode_outcome` signals. Only commits carrying a
`Pi-Episode: <episode-id>` trailer is considered; `pi-daddy report` can display attribution only when matching episode
data exists in the local ledgers and shows the latest label beside each such episode. These labels are delayed for 48 hours and are operational heuristics, not quality acceptance. The contract
is `packages/pi-daddy/contracts/ledger-record/v1`.

## Workspaces and leases

`/grants workspace <id>` inspects one workspace without changing grants, acceptance or destination pins.
It distinguishes saved acceptance, the current routing capability, pending activation, a moved or removed
destination, and invalid worktrees. It names the selected grant directory and its source. An active route
is only a current observation: candidate, selected task/input scope, approvals, writer lease and native
settlement remain dispatch-time checks. The dashboard retains the last explicit inspection with its time
and freshness; redraw does not scan repositories or refresh authority.

Startup uses the actual Pi working directory's existing root grant and runtime defaults, even when an
embedding process started elsewhere. Explicit environment grants still win; descendants never adopt a
target directory's broader root grant. Stored directory identity remains exact: an alias does not silently
borrow or migrate another spelling's saved grant or approvals. Canonical aliases of registered workspace
destinations continue to resolve through the existing Git/worktree validator.


A registered worktree is named `workspace:<id>` and routing a child there is a capability that attenuates like any
other. Acceptance is trust on first use: the first session accepts and announces every id already in the registry.
Later additions are refused until `/grants workspaces` accepts the current id set, effective next session. Each session
pins accepted ids to their resolved destinations, so a destination changed during that session is refused; the next
session repins an already accepted id without another acceptance step. A writer routed to a workspace holds an
exclusive lease. A kernel `flock` serializes live writers; execution-bound helper receipts separately prove that
the previous captured subtree settled. Unknown cleanup quarantines the workspace even after the lock disappears,
refusing a successor until the original ownership evidence proves settlement. It coordinates governed children only; it is not a sandbox, path confinement, or proof of
anything a child did.

## Executors and the dashboard

Captured subprocess execution owns and reaps cooperating child subtrees on Linux x64 via the packaged native worker, and uses the portable Node process-group child runner on macOS and Windows.
A packaged native helper owns and reaps the cooperating child subtree. The final is accepted only when Pi's native lifecycle
protocol settles and matches the exact persisted current turn and active branch. Complete final text is preserved;
work, final availability, subtree cleanup and optional observation completeness are separate result fields. A failed
execution returns `isError` with its available evidence. Display, diagnostics and optional recording cannot replace
the primary final. Unknown cleanup retains capacity and workspace exclusion. The coordinating model receives a
version 2 runtime evidence summary per child: those states, any timeout, cancellation, spawn-failure or truncation
flag, a bounded reason, the operation ID (or execution ID), and for a worker that did not exit normally the
receipt's cause and signal. Complete final identities and process receipts stay in the result details, which Pi
persists but does not send to the provider, and in opt-in public capture.

A child whose tools only read (`read`, `grep`, `find`, `ls`, plus context handoff) is replay-safe, and
`delegate_describe` (`replaySafe`), the `/grants` allow lines and the startup summary say so. When such a child
fails without answering (it exited without a final, timed out, could not launch for want of system resources, or its
model request failed), Daddy runs the same request once more in the same tool call: a new execution and process with
the same task, definition, model and context, planned with nobody asked and bounded by the first attempt's
wall-clock deadline. A child killed from outside the tool call (a person's `kill`, the OOM killer) exits like a
crash and is retried once. Daddy never retries a child its parent's tool call cancelled, one whose cleanup is not
settled, one that spent an approval (on a gated tool, or a gated context handoff such as the default-gated
`context:fork`) or one carrying an `operation_id`, and it never retries twice. The summary
then carries `"retry":{"attempts":2,"firstFailure":"…"}`, the details keep the first attempt complete, the
result details link the two executions, and the usage reported to the Pi session covers both attempts. A failure carrying an `operation_id` that would otherwise have been retried is
returned with `"replayable":true` instead, so its coordinator can retry it once as a new operation (Principal does).
A complete answer is never retried, including after a later idle timeout. Bound operation failures retain optional
owner-verified retry eligibility; a coordinator without that evidence keeps its manual retry path. `PI_DADDY_REPLAY_RETRY=0` turns off the retry and the
`replayable` mark; the replay-safe mark stays.

Pi and TypeBox are wildcard host-provided peers so Pi's extension loader supplies one shared runtime copy. Development dependencies pin Pi **1.0.4**; the additional **1.1.0** and **1.4.0** checks have the execution scopes described above. Prefer a Pi-managed install under a measured host and executor combination. An ordinary standalone npm install may resolve untested peer versions. In a Pi-managed no-peer install, standalone help, version and reporting remain available; use `/grants init` inside Pi for an explicit persistent project ceiling. Principal's native phases use `plan`, `build`, `review`, `debug`, and `investigate` after a `delegate_describe` of each, which binds its `definitionId`; independent parallel work uses one `delegate_all` batch.

Final capture preserves whitespace and concatenates text blocks without inserting separators. Tool-call terminals, empty visible finals and non-`stop` reasons are unavailable. Persisted message comparisons ignore object key order while preserving array order and every field value. The shared `final-conformance.json` table checks these semantics in both runtime and harness. Capture remains bounded: 4 MiB visible final, 32 MiB protocol line, 64 MiB persisted session, and a 3-second bounded session read. Exceeding a limit reports an unavailable final and blocks dependent handoffs; it does not imply the worker failed to settle.

Retained capacity is rechecked against the original bound ownership and settlement receipt before a new single, parallel or chain dispatch. Exact later proof refunds the reservation once; missing, malformed or mismatched proof and unbound ownership remain retained. Recovery does not rewrite the original failed/unknown outcome or mint new capacity on reload. A single delegation reserves its available subtree; use `delegate_all` to allocate independent parallel children.

Captured subprocess execution is the sole executor across Linux, macOS, and Windows (native subreaper worker on Linux x64; portable child runner on macOS and Windows). Native receipts prove subtree cleanup.

The trusted extension event `pi-daddy:runtime-snapshot:v1` supports Principal's explicitly armed resume checks.
It reports the actual Pi session/canonical working directory, a stable owner scope, current backend qualification,
outstanding execution identities and an exact settlement digest. A private runtime journal under the operator's
Pi agent directory records pending launches before execution and native ownership before the gate opens. An OS
lock excludes concurrent owners; clean same-session restart rechecks original receipts and preserves the digest.
Missing or changed receipts, interrupted unbound launches, live owners and failed control finalization refuse
resume. The journal contains process identities and receipts, never task text or an approval. A model-authored
list of children, successful prose or a progress flag cannot supply these facts. Principal separately verifies
operator authorization, candidate and artifacts before consuming its checkpoint and queueing a fixed continuation.
This bridge never grants capabilities, approves work or calls external models. The ledger schema is unchanged.
Same-user hostile filesystem or co-loaded-extension authenticity is outside this cooperative ownership boundary.

`pi-daddy-dashboard` and `/dashboard` show current work, live usage, and actual pending approvals first; completed history is collapsed by default.
Use **a** to switch Auto, arrow keys to select a row, **Enter** for details, **m** for session models, **h** for history,
and **?** for help. The view fits the terminal and follows resize events. A disconnected control displays its state
as unavailable until the owning session acknowledges a fresh snapshot.

On Pi versions that emit native prompt events, selections, confirmations and
text-entry dialogs appear under **Needs your input** while they are open. The row shows the question and directs you to answer or cancel in the main Pi chat; it clears when
the dialog closes or the session changes. A pending Daddy permission takes priority over a duplicate native
dialog row. Generic custom panels are not inferred to be questions:
informational views and loading screens stay out, while existing producer-owned approvals keep their own status.
The dashboard never grants authority or changes Auto without explicit operator action.

A connected dashboard sends explicit Auto choices and model edits over a private session-local socket. Model edits
use the same in-memory overrides and `session_config` audit path as `/grants models`; `m <definition>
<provider:model> <thinking>` and `m all ...` remain available in command mode. A standalone dashboard is read-only.
Execution history and cost remain observations, and incomplete usage is shown as unavailable rather than zero.

Press **s** for Settings. Select a setting with the arrows;
**Enter** opens or changes it. For child wall and idle times, **0** restores the startup default.
Settings belong to this owner session and survive reload; a different native session starts fresh.
Wall/idle edits affect future child launches from this parent, never a running child's captured deadline.
They are process safety controls, not model time/token budgets. `/grants` reports the effective overrides.

JEV controls require skill-harness in the owning Pi session. Enabling opens its existing paid-call and
LoRA-storage consent prompts in that parent; the dashboard shows waiting-for-consent, key readiness,
remaining calls, storage status and the selected provider/model, transport and shared local data root when reported by Harness. Auto cannot answer either consent prompt. Turning JEV off revokes
its activation, including an outstanding enable request; the switch itself makes no provider call.
No API keys, consent flags or training permissions can be set from this screen.

When Harness offers session controls, the **Call limit** row shows the session total, calls already used,
and how many remain available. Select it to enter a nonnegative whole number in the main Pi session.
The initial limit is **300**; **0** stops new JEV calls. Raising the limit does not reset spending.
**Choose JEV model and storage** opens the provider/model and consent choices. **Tool hints** lets
you opt in separately: a hint names an available tool only when JEV rates its fit above 90%.
Hints share the same call allowance. They do not execute the tool or grant permission.
Older Harness versions keep their existing JEV switch.

Active-descendant capacity and maximum depth are displayed with their startup environment variables;
start a new session to change them. The per-call bound is fixed. Settings does not replace live capacity
reservations or promise a limit change it cannot apply. Models and package versions keep their existing
**m** and **v** views, keeping the main task view focused on work.

Press **v** for ecosystem versions. Pi, Daddy, Principal and Harness each show the loaded package generation,
version currently installed on disk, source and path. A mismatch calls for a reload (restart for Pi itself).
Older extensions without the reporter show their installed version with the loaded version explicitly unknown.
Multiple sources are flagged for inspection rather than choosing one arbitrarily. Package versions describe
what is present; they do not establish compatibility qualification or that npm has no newer release.
Version details provide native Pi commands for changing an explicit npm pin and rechecking Principal's installed
agent definitions. `pi update --extensions` retains pinned versions; use `pi install npm:<package>@<version>` to
replace a pin, then deliberately reload. There are no background registry checks or silent installations.

**:** opens command mode, **Tab** changes the task filter, **p/f** shows retained prompt/final content,
**Esc** returns to the previous view and **q** closes the dashboard.

## Bounds and configuration

Every variable is `PI_DADDY_*`. Operator-facing controls are grouped below; the environment overrides stored
configuration where both exist.

| Area                     | Variables                                                                                                                                                                                                               |
| :----------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Governance               | `PI_DADDY_GOVERNANCE`, `PI_DADDY_GRANT`, `PI_DADDY_GATED`, `PI_DADDY_MAX_DEPTH`, `PI_DADDY_FANOUT`, `PI_DADDY_LEDGER`, `PI_DADDY_APPROVAL_TIMEOUT`, `PI_DADDY_AUTO_MODE`                                                |
| Child execution          | `PI_DADDY_CHILD_IDLE_TIMEOUT`, `PI_DADDY_CHILD_TIMEOUT`, `PI_DADDY_ALLOW_UNRESOLVED_MODELS`, `PI_DADDY_PARENT_TOOLS`, `PI_DADDY_REPLAY_RETRY` |
| Workspaces and retention | `PI_DADDY_WORKSPACE_REGISTRY`, `PI_DADDY_WORKSPACE_LEASE_DIR`, `PI_DADDY_EXECUTION_ARCHIVE`, `PI_DADDY_RETAIN_NATIVE_SESSIONS`, `PI_DADDY_NATIVE_SESSION_ROOT`                                                          |
| Activity                 | `PI_DADDY_ACTIVITY_TIMELINE`, `PI_DADDY_ACTIVITY_CONTENT`                                                                                                                                                               |

`PI_DADDY_FANOUT` bounds active cooperating descendant sessions. Its default remains 8; literal 0 means exhausted,
and malformed values refuse. A reservation includes the child and its disjoint descendant allowance, so concurrent
calls can refuse while an earlier subtree holds capacity even when that subtree is not using every slot. Repeated
settled work returns capacity; unknown cleanup does not. The same live owner retains reservations through reload.
Changing its capacity configuration requires a new owner after the old subtree has settled. Depth and per-call
limits still apply independently; this is not a lifetime call quota.

The retired `PI_DADDY_EPISODE_COST_CEILING`, `PI_DADDY_ADVISOR`, `PI_DADDY_ADVISOR_KEY`,
`PI_DADDY_ADVISOR_MODEL` and `PI_DADDY_ADVISOR_TASK_EGRESS` inputs are inert compatibility inputs.

Interactive approval prompts wait for the human by default. Set `PI_DADDY_APPROVAL_TIMEOUT` to canonical
whole seconds (1 through 2,147,483) for an explicit deadline; unset it or use literal `0` to wait indefinitely.
Expiry, user dismissal and caller cancellation have distinct `expired`, `dismissed` and `aborted` outcomes.
Each grants no permission and explains how to retry the delegation for a new prompt. Existing approvals
remain usable without consulting an unused timeout setting. Malformed values refuse a needed new prompt.

`/grants` shows effective child deadlines, approval waiting policy, and diagnostic retention settings.
Child wall/idle controls remain runtime safety bounds; zero or malformed child settings select their defaults.
They do not add time or token instructions to model prompts.

`PI_DADDY_CHILD_IDLE_TIMEOUT` is seconds without activity before a child is stopped (default fifteen minutes);
activity is output, a child-session-file change, or Linux process-tree CPU/descendant activity.
`PI_DADDY_CHILD_TIMEOUT` is the runaway ceiling for a child that never goes quiet (default six hours). The remaining
names in the source inventory are internal propagation, attribution, workspace-pin, or dashboard-transport fields;
do not set them manually. Prelaunch refusals use stable codes (`CAPABILITY_ESCALATION`, `GATED_UNAPPROVED`,
`DEPTH_EXCEEDED`, `FANOUT_EXCEEDED`, `WORKSPACE_NOT_AUTHORIZED`, `CHILD_TIMED_OUT`, `LEDGER_DAMAGED`, …); the full
enumeration is `REFUSAL_CODES` and is pinned by the contract.

### Child work attribution

Every governed child receives `PI_DADDY_EPISODE` (the ledger episode), `PI_DADDY_DEFINITION` (the definition name),
and `PI_DADDY_EXECUTION` (the lifecycle execution id). These are attribution metadata, not authority.

### Per-definition model and thinking

Child runtime defaults are reviewable beside each definition in `.pi/pi-daddy/settings.json`. Selection applies
explicit argument → session override → project definition settings → an intact authored model/thinking preference
row → normal defaults/current Pi. Authored rows are never combined into a new model/thinking pair. Unsupported
explicit pairs refuse; the runtime does not clamp effort or select a substitute model. Use `/grants models`
or a connected dashboard to edit session overrides. Delegation never opens an automatic model chooser.

```json
{
  "defaults": { "model": "openai-codex:gpt-5.6-sol", "thinking": "medium" },
  "definitions": [
    {
      "name": "review",
      "declares": ["tool:read"],
      "spawnable": true,
      "model": "anthropic:claude-opus-4-6",
      "thinking": "high"
    }
  ]
}
```

Valid thinking values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. `/grants` shows the
resolved value and source for every displayed definition.

### Keep evidence for one diagnostic session

Native child transcripts and execution diagnostics are separate opt-ins. To retain them for one Pi launch,
create private local directories outside the repository and scope the settings to that command:

```bash
diagnostic_root=$(mktemp -d "${TMPDIR:-/tmp}/pi-daddy-diagnostic.XXXXXX")
mkdir -m 700 "$diagnostic_root/native" "$diagnostic_root/archive"
PI_DADDY_RETAIN_NATIVE_SESSIONS=1 \
PI_DADDY_NATIVE_SESSION_ROOT="$diagnostic_root/native" \
PI_DADDY_EXECUTION_ARCHIVE="$diagnostic_root/archive" \
pi
```

Use `/grants` to confirm the session's opt-in and destinations. The native root must be an existing canonical
absolute path owned by your user, mode 0700, without symlink ancestors. Each delegated execution gets a fresh
native JSONL session. The coordinator keeps its normal Pi session. Diagnostic manifests and bounded captured
bytes go under `archive`; inspect each delegation result's retention status and manifest coverage for losses.
An opt-in is not a claim that every observation was retained. Keep the private directory until diagnosis is done;
the operator controls its lifetime and disposal.
Retention manifests now emit schema **2.1**. The reader still accepts historical 2.0 records; consumers
with a strict 2.0 schema must update before reading new manifests. A `pi-captured-final` branch observation
uses the executor's verified native final and an exact full-session byte hash. An ordinary JSONL file alone
does not establish its active branch. Changed, unavailable or truncated bytes keep that gap explicit.
The 1 MiB diagnostic session-copy bound remains a byte-storage limit, not a model token budget or work deadline;
a complete native source may exist even when its archived copy is truncated. Coverage remains incomplete and
retention never supplies task acceptance.

These files may contain task text, tool output and private model reasoning. Local diagnostic retention does not
enable JEV, provider egress, LoRA collection or training. Existing `/skill-harness` consent remains separate.
Without native-session opt-in, temporary child transcripts are removed after settlement and cannot be recovered
later from the activity timeline.

### Export a private diagnostic bundle

Use the offline exporter instead of asking a model to rewrite session records. Create a JSON selection
with only the files and retention roots you intend to inspect; relative paths resolve beside that selection:

```json
{
  "version": 1,
  "sources": [
    { "path": "/absolute/path/coordinator.jsonl", "format": "session" },
    { "path": "/absolute/path/review.md", "format": "text" },
    { "path": "/absolute/path/jev/selection.json", "format": "json" }
  ],
  "retentionRoots": ["/absolute/path/diagnostic/archive"]
}
```

```bash
pi-daddy diagnostics export selection.json /absolute/path/new-private-bundle
```

This offline command runs directly from the installed package without a Pi process or host-provided TypeBox.

The destination must be new with an existing canonical parent. It contains `inventory.json` and deduplicated
`objects/` files, with directories mode 0700 and files mode 0600. Originals remain untouched. Each entry records
its source digest and filtered-object digest separately; unchanged JSON strings inside packets retain their exact
spacing. Optional source `sha256` requires a matching input. Formats are `session` (native Pi v3 visible messages),
`json`, `jsonl`, and `text`. Native exports omit reasoning, images and unsupported entries; structured environment
and credential fields are removed, with omissions recorded. Text files receive heuristic credential filtering.

Retention roots are scanned one directory level for manifests. Referenced session, result and check-receipt
bytes must match their digest and size; raw streams and pane snapshots are excluded. Current losses and recovered
read observations are shown separately. Missing or invalid sources produce explicit inventory gaps and exit 1;
a fully collected selection exits 0. Neither exit code establishes task acceptance. File/count/storage bounds are
reported as gaps or refusals, never model time/token budgets. This is an individually checked collection, not an
atomic snapshot, and free-text secret detection is not exhaustive. Review the private bundle before sharing.
The command never uploads, calls a model, grants training rights, or changes LoRA eligibility.

## Retired intervention inputs

External advisors, monetary cost gates and the first-delegation model chooser were removed. These recognized old
inputs are inert, including malformed values; the package does not rewrite existing configuration or history:

| Input                                                                                                                                 | Compatibility behavior                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Tool argument `episodeCostCeiling` on single/all/chain                                                                                | Removed before Pi validates the remaining arguments                             |
| Settings `episodeCostCeiling`, `advisor`, `sessionModelPrompt`                                                                        | Ignored; active model and authority fields still validate                       |
| `PI_DADDY_EPISODE_COST_CEILING`, `PI_DADDY_ADVISOR`, `PI_DADDY_ADVISOR_KEY`, `PI_DADDY_ADVISOR_MODEL`, `PI_DADDY_ADVISOR_TASK_EGRESS` | Never select or execute an intervention; reserved environment stripping remains |

Historical advice/cost-gate records remain readable. Manual model choices and permission approvals remain active.
For future JEV or learned-policy experiments, existing versioned decision/lifecycle records and harness result exports
remain the observation boundary. A separately selected experimental adviser may propose a choice for evaluation; it
must never grant capabilities, approve work, start retries or silently change the selected model. No automatic remote
advisor call or training pipeline is installed. Dataset consent, supported training method and comparative value need
separate qualification.

## Command-line reference

Use `npx --yes pi-daddy@latest <command>` for standalone commands. For the ledger viewer,
use `npx --yes --package pi-daddy@latest -- pi-daddy-dashboard`.

```text
pi-daddy init [--force] [--dir <path>]
pi-daddy ledger repair <path> [--yes]
pi-daddy report [--since <date>] [--definition <name>] [--model <id>]
                [--group-by definition|model|thinking] [--json]
pi-daddy outcomes

pi-daddy-dashboard [--ledger <path>] [--once] [--details] [--no-color]
```

`pi-daddy init` prepares the review files but cannot apply a grant to an already-running session; use `/grants init`
for that. `--force` rewrites copied legacy runtime-skill definitions, never `settings.json`.

## Programmatic API

The package requires Node.js 22.19.0 or newer. Code is exported only from `pi-daddy`; schemas and fixtures are exported
from `pi-daddy/contracts/*`. Layer subpaths are private. The root exports kernel, governance, executor, and product
primitives, including `resolve`, `planSpawn`, `appendLedgerEvent`, `readRecords`, `runChild`, and `buildCatalog`.

## The layers

The Files column names the main modules of each layer, not all of them; the module docstrings are the
specification of who owns what.

| Layer            | Answers                                                                                                                                     | Files                                                                                                                                                                                                               |
| :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/kernel`     | What may a child hold, and how is that carried? Mostly pure; the readers that discover what exists are the exception, and they are bounded. | `resolve`, `spawn`, `propagation`, `catalog`, `definitions`, `capabilities`, `approval`, `chain`, `context-handoff`, `fanout`, `correlation`, `refusals`, `env-names`, `project-paths`, `workspace`, `bounded-read` |
| `src/governance` | What was decided, and where is it written?                                                                                                  | `record`, `ledger`, `ledger-events`, `ledger-report`, `approval-store`, `approval-prompt`, `grant-store`, `init`, `workspace-lease`, `execution-retention`                                                          |
| `src/executors`  | How does a child process start and end?                                                                                                     | `executor`, `captured-execution`, `owned-worker`, `portable-child`, `inprocess-readonly`, `worktree-tournament`                                                                                                      |
| `src/products`   | What does the operator see or report?                                                                                                       | `activity-timeline`, `dashboard-*`, `web-dashboard`, `terminal-panel`, `terminal-split`, `setup-doctor`, `provider-detect`, `session-harvest`, `episode-report`, `episode-outcomes`                                |
| `extensions/`    | The pi extension and its wiring: hooks, the three tools, approvals flow, `/grants`.                                                         | `grants.ts` is the entry point                                                                                                                                                                                      |

## Tests

```bash
npm run format:check
npm run typecheck
npm test
npm run build --workspace=pi-daddy
npm run test:integration:ci --workspace=pi-daddy # model-free CI subset
npm run test:integration --workspace=pi-daddy    # real Pi integration suite (model-free)
npm run test:smoke --workspace=pi-daddy          # pack, install into a scratch project, import and use it
PI_DADDY_IT_MODEL=1 npm run test:integration --workspace=pi-daddy # opt-in real-model tier; consumes tokens
```

`pi-daddy` under `packages/pi-daddy` is the only published package; the workspace root is private.

### Exact definition runtime choices (candidate)

A selected definition may author a single-line `runtime-preferences` JSON array:

```yaml
runtime-preferences: '[{"model":"provider/model-id","thinking":"high"},{"model":"provider/other-id","thinking":"medium"}]'
```

Call arguments, per-definition session controls, and per-definition project settings win per field.
The complete needed authored list validates before any candidate is selected. A partial override filters
intact rows; ordinary configured/current defaults may fill missing fields without being labeled an authored
pair. Unsupported explicit effort refuses rather than clamping. Resolution checks only named local models
and passive auth status. Unknown authentication stays unknown; there are no credential commands, remote
health probes, provider-wide searches, or post-launch substitution. With no explicit/current model supplied,
Pi's ordinary configured default remains in effect; this does not attest a resolved pair.

On Pi 1.0.4, the first request or native delegation reads the public selected skill inventory once. Native
`plan`, `build`, `review`, `debug`, and `investigate` binding requires the selected Principal package's
`principal-agents.json` paths and hashes. It freezes the generated delegated body and the intersection of
inline and delegated ceilings. An unrelated skill with the same name is never labeled Principal. Failed
binding has no inline fallback. Reload creates a new snapshot; observing provider tools never rereads bodies.

Call `delegate_describe({agent:"build"})` before delegating to it. Daddy remembers the returned `definitionId`
for that agent in this Pi session and uses it when a `delegate`, a `delegate_all` child or a `delegate_chain`
step names the agent without one; a supplied `definitionId` wins and is never remembered. Principal bindings
require a describe (or the ID). `/reload` keeps what was described; `/new`, resume, fork and tree navigation
drop it. Description starts no child and grants no authority. A stale ID, supplied or remembered, refuses
before approval or launch until the agent is described again. Tool result details record the ID used and its
source (`definitionBinding`); the ledger does not. This hash is an observation and precondition, not an
approval record or a learned-policy authorization.

The description also returns `selectedResources`: version `1`, `selectedSkill` and `definition` objects
containing `path` and `sha256`, and `resourceDirectory` for relative references. A verified Principal binding
adds `package: {name, root, version?}` for that selected package only. The same frozen locations accompany
the unchanged authored body in the child's system prompt and participate in `definitionId`. They do not
load additional runtime skills, grant tools, or attest the contents or availability of referenced helpers.

A tool visible to the parent is not necessarily deliverable to a child. Daddy checks the current public
Pi tool origins before asking for permissions. Native Pi tools and Daddy's explicitly loaded governance
tools are supported; granting a Daddy tool also requires the existing `tool:delegate` capability and its
entrypoint. External extension, MCP and SDK-only tools currently refuse with `child tool unavailable`.
Keep that work in the parent or select a definition using supported child tools; permission alone cannot
install a child provider. Ambient extensions stay disabled and `--tools` remains exact. A refused fan-out
child does not prevent an independent valid sibling from running; a chain refuses before any step starts.

One exception is a new path for authority, so its bounds are listed here. A tool on Daddy's fixed allowlist,
currently only `scout_research`, can be run **by the root session for its direct child**. The child loads Daddy's
`extensions/parent-tool-proxy.ts`, which registers a tool of the same name, description and argument schema;
calling it asks the root, over the owner socket descendants already use, to run the real tool through Pi's
`ctx.executeTool` inside the waiting `delegate`, `delegate_all` or `delegate_chain` call. The root's own hooks
and permission prompts therefore decide each call, and Pi records it as a nested call of that delegation.
Admission requires all of: a root session; a definition ceiling and grant naming `tool:scout_research` exactly
(an `ext:` alias does not count); the root holding the tool and Pi reporting it callable from another tool; the
delegation's tool context offering `executeTool`; and **the child using the root's own provider and model**. The
last means the `provider/id` Daddy passes the child as `--model` names exactly the provider and id of the root's
current model. A child that keeps the root's model (the default) qualifies; an explicit `model`, a per-definition
setting or authored `runtime-preferences` naming any other pair does not; and a child with no `--model` (Pi's
configured default) or a root with no model is unknown, which does not qualify either. Such a delegation gets
the refusal above with one more sentence saying the model is the reason. Only provider and id are compared: the
child resolves the api, endpoint and credentials for that pair itself after it starts, which the root does not
observe. A gated capability is asked about at delegation, like any other. The root checks again at launch and at
every call, against the same conditions, its own grant, the model Pi reports for it at that moment, and the
execution id and per-execution key of the running child it was granted to; an unknown, finished or different
child is refused, and after `/model` in the root a running child's next call is refused. Arguments are limited to
64 KiB of JSON and results to 64 KiB of text. Only text crosses, fenced as untrusted evidence; `details`, images
and other parts do not. A thrown tool error or a block by the root's own permission hooks crosses as an error
result with its text; failures outside Pi's tool pipeline cross as a fixed refusal. One call per child runs in the
root at a time, until that run settles; a call is cancelled when its child settles, exits or disconnects, and
waiting on it counts as child activity, so the child's wall-clock limit is what bounds it. A child cannot pass
such a tool to its own child. `delegate_describe` lists such tools as `parentRunTools` for a child that keeps
the root's model; the agent list and the startup summary leave the model to each delegation.

The tool runs in the root session, with the root's model, credentials, settings, working directory and Docker,
and what it writes is the root's. Scout's `scout_research` saves its brief under the root session's directory in
`~/.pi-scout-research/briefs/`, appends it to the root session, where it becomes the root's latest saved Scout
research (the reference the root model is then shown, in place of the root's own earlier one), and adds it to
the root's workspace research inventory, which keeps a bounded number of entries. Scout's answer text, including
the saved brief's path under the root's home directory, is what crosses to the child. `PI_DADDY_PARENT_TOOLS=0`
turns the path off and restores the refusal above; any value other than `1` or `0` also turns it off and is
reported at startup. Bookie recall tools are deliberately not on the allowlist: Bookie authorizes disclosure for
the model of the session that runs its tool, which here would be the root's while the text reaches the child's
model, and the same-model rule compares provider and id only, not the endpoint Bookie's approval binds.

### Optional retained-result consumers

`pi-daddy:operation-artifact-ready:v1` is a best-effort trusted extension hint containing `{ version: 1, reference }`. A missing or failing consumer cannot change the durable result or relaunch work. Pi's custom entry likewise holds only a reference. Consumers recover missed hints through the trusted `pi-daddy:operation-artifacts:v1` event; this is not a model-callable tool.

Requests carry `version:1`, a bounded `requestId`, current `sessionId` and canonical `cwd`, an `action`, and a reply callback. `list` accepts a limit of 1–64 directory entries and an optional opaque continuation cursor. Its response includes exact references, unfinished-admission and invalid-entry counts, completion and optional next cursor. Each page is bounded; traversal is not a snapshot under concurrent publication. Only the current owner is enumerated. A new traversal replaces the previous cursor; session replacement closes it. Consumers serialize scans and restart on failed pages rather than treating missing registration as completed.

`read` accepts an exact producer reference and optional expected `producerInstance`. The instance binds the canonical selected agent directory and filesystem identity. Artifact bytes and original admission/scope are verified under that selected root. A previous owner's exact read additionally requires a trusted asynchronous `authorize` callback, checked before and after reading. A consumer must derive that callback from its already retained, explicitly selected project registration; do not forward model-provided paths or permission flags. This does not grant live execution authority or semantic approval.

`openOperationArtifactScan(agentDirectory, owner)` and `operationArtifactInstance(agentDirectory)` are root package exports for trusted local consumers. A scan has `next(limit)` and `close()`; callers own closing it. No Bookie import or dependency is needed. Bookie may separately register reference metadata after operator consent. A failed/partial producer result remains failed/partial evidence; an admission without a result is not registration-ready completion proof.

### One-host initiative continuation

A trusted work-map owner can select an initiative through `pi-daddy:initiative:v1`. Bookie's optional
`/bookie-work` command supplies the exact selected Project/map/task revisions and asks the operator before
acquisition. Daddy remains usable without Bookie: normal delegation is unchanged and initiative association
stays unavailable until a trusted owner selects a map. There is no background scheduler or new model call.

After selection, `initiative_task` associates a selected `taskId`/`taskRevision` with the intended
`operationId`. Use that ID as ordinary delegation's `operation_id`. Association does not dispatch, approve,
or grant tools. Ordinary delegation still checks current capabilities, selected definition and workspace
routing; actual writers still use the existing workspace lease. A trusted `assertExecutionScope` callback
also compares the actual routed child directory/workspace with this task's selected resource roots before
spawn. General permission for another repository does not make it this task's target. The original session, operation and
execution identities remain in durable attempt records when a later coordinator takes over.

One coordinator holds the existing OS ownership lock per initiative on this host. Acquisition requires an
exact previous record revision, and every mutation checks the owner generation and selected-map callback.
A lost process or an old timestamp is insufficient for takeover. Every earlier attempt must have exact
producer no-start/native-cleanup evidence. External or unknown effects additionally need a selected exact
canonical receipt, verified by the trusted work-map owner against original owner/task/operation/execution
identity and current receipt content. A human confirmation can establish operator-confirmed reconciliation;
it never invents provider success or task acceptance. Missing or changed receipts remain blocked. Local
cleanup is process settlement, not semantic acceptance, a sandbox, or a way to stop arbitrary shell writes.

The owner status is a cached dashboard contribution with an explicit initiative scope, known session count,
and bounded task observations. It knows only recorded relationships. Task reviews, releases and registry
publication remain separate owner facts. The six terminal views do not become a global initiative registry.

After restart, trusted `recover` acquires the same lock and exact state revision without changing the old
owner/generation or allowing dispatch. The handle lists bounded pending effects and reconciles only a selected
exact receipt. Release then normal acquisition establishes the next generation. Native process settlement
is required independently; a receipt cannot authorize takeover while an owned process remains unresolved.

State is a private, bounded per-initiative record under the selected agent directory (256 task revisions,
1,024 attempt links, 512 KiB). A retained initialization marker makes a deleted record fail closed; restore
trusted state instead of treating deletion as a new initiative. Closed or revoked selection does not erase
unresolved attempts. No record is written by dashboard redraws.

Trusted event requests include `version:1`, `requestId`, `sessionId`, `cwd`, `initiativeId`, and `reply`.
`action:"status"` returns an exact `revision` or null for never-initialized state. `action:"acquire"` additionally
requires `expectedRevision`, selected `tasks:[{taskId,taskRevision,effectScope}]`, and a trusted
`assertSelection()` and task-specific `assertTaskReady({taskId,taskRevision})` callbacks. The latter is
rechecked at association, admission and launch; current inputs alone do not establish dependency readiness.
The reply echoes request/owner identity and returns a handle with
`associate`, `observe`, `release` (clean transfer), and `close` (abandon cooperative ownership; no settlement
claim). `observe` is read-only and returns an `assertCurrent` recheck for exact generation, task revision
and observed execution states. A callback or opaque identifier supplied by model text is not this authority.

`action:"recover"` uses those same selected-scope callbacks but returns `recoveryOnly:true`. Both handle modes
provide `pendingEffects()` and `reconcileEffect({initiativeId,taskId,taskRevision,owner,operationId,executionId,
effectScope,receipt:{reference,sha256}})`. Only the trusted `assertEffectReconciled` callback can verify that
receipt. No callback means unresolved effects. Task revisions retain their exact `sha256:<64hex>` source
identity (bare 64-hex revisions are also accepted); receipt digests are bare 64-hex values. Revalidation of a
previous receipt is required in the new session, using the original attempt identity, not the new owner.

Selected tasks may include one bounded neutral `effectTarget:{owner,kind,reference}`. Its responsible owner
binds the exact target into the task revision. Receipt `observation` is optional for old records; when present
it names the same target, an `applied`, `not-applied` or `unknown` outcome, and `operator-attested` or
`owner-verified` provenance. Daddy does not interpret package, registry or other business semantics.
`unknown` never resolves effects. Applied/not-applied reconciliation never accepts the task or grants execution.
An old receipt without an outcome remains readable without inventing an outcome during upgrade.

`observe` returns the selected revision's `effectObservation`: pending only when no attempt exists or exact
no-start evidence exists, otherwise unknown until native settlement and a current exact receipt establish an
outcome. Older revisions can independently require reconciliation; their outcome is never rebound to a new
target. `pendingEffects` includes each original target, and `reconcileEffect` returns that historical attempt's
exact observation. Recovery can therefore confirm an old target after a plan amendment while the current
selected target remains pending. The work-map owner still validates current target resources separately.

Task-readiness callbacks must not turn the newly admitted attempt's honest unknown state into a self-block
at launch. Daddy's `begin` refuses a new attempt while any prior attempt or effects are unresolved; the
work-map owner separately rejects repeating an already-applied target and enforces semantic prerequisites.
Immediately before start, Daddy rechecks prior attempts across all revisions of that task, excluding only the
exact already-admitted owner/operation/execution/request identity. Revoking an older receipt after admission
therefore blocks launch without misclassifying the current admitted attempt as evidence of earlier effects.

For a selected target, changing only the task revision does not authorize applying that identical target again.
Admission and launch refuse a current exact applied receipt from any retained revision of the same task. This
prevents duplicate effects; it does not reclassify the old receipt as current task acceptance. A different target
still needs normal readiness, permission, resource validation and reconciliation of earlier attempts.

Initiative dashboard refresh is display-only: it uses at most five cached observations from real owner reads,
keeps their original timestamps and labels missing or invalidated facts unavailable/stale. It performs no
semantic currentness scan, native read, model call or durable write. Work-map reads and every admission/start
boundary still invoke their authoritative currentness checks; cached display facts never authorize execution.

Trusted work-map clients may provide `assertObservationAuthority` for exact runtime-fact reads. It binds current read permission and selected owner; it does not certify current authored intent, task acceptance or permission to execute. The client still checks canonical inputs before disclosing or reusing a projection. Missing read callbacks use the original full selection guard. Claim, begin, start, reconciliation and release always keep the full guard; native receipts, held ownership and exact generation checks also remain on observations.

Exact effect-receipt validators also use the observation guard: checking an existing receipt cannot itself authorize a mutation. Coordinator acquisition, claim, begin, start, reconcile and release independently bracket those awaits with full mutation authority, including a final check before retaining an attestation.

After safe exclusive coordinator takeover, a settled previous-generation task is reported as `unclaimed` until explicitly claimed. Observation does not rewrite its historical generation or attempts. Recovery-only handles, running attempts and uncertain settlement remain non-free; current-generation claims remain `owned`.
