# pi-daddy

Source target: **0.48.0**. Before installation, verify that `npm view pi-daddy version` and Git tag `v0.48.0` both resolve to this release.

**Capability governance and coordination for [pi](https://github.com/badlogic/pi-mono)'s multi-level agent system.**
An orchestrator grants each sub-agent a deliberate subset of what it holds and withholds the rest. A sub-agent may
delegate further, but only ever a subset of what it holds. Enforcement is pi's own `--tools` allowlist on a separate
child process, with an optional append-only, hash-chained governance ledger.

This file is the product description, present tense. If code and this file disagree, fix this file. Agents start at
`AGENTS.md`, which carries the rules, the decisions still in force, the measured facts and the roadmap.

## Reliable workflow handoffs

Native delegation accepts an optional stable `operation_id`. The session owner admits one
matching request; a concurrent or later duplicate returns its existing execution reference.
It does not launch another child, replay a completed mutation, or grant approval. A changed
request under the same ID refuses. An intentional retry needs a new attempt after the
previous operation is proven settled or never started; uncertainty stays blocked.
Principal 4.12.0 supplies these IDs and exact candidate/report references automatically.

The dashboard shows the selected task's last observed tool event and time since that event.
Details include the actual recorded working directory and phase where available. Silence is
not proof of a hang, and a finished process is not an approved task. Tool observations retain
names and timestamps, not arguments or output. Diagnostic retention remains operator opt-in.

The coordinator can use Principal's native tool-only Codemode adapter. Nested calls retain
Pi's normal permission and cancellation hooks. Governed children cannot request `codemode`
or `principal_codemode`; that child execution path is not qualified.

## Install and first run

```bash
pi install npm:pi-daddy
pi
```

In the session, `/grants` shows the tool ceiling this session holds and the definitions it can spawn. Governance is
on after installation unless `PI_DADDY_GOVERNANCE=off`; before initialization a root session is bounded by its
observed tool surface, but no project grant or ledger consent has been stored. `/grants init` scans enabled packages
that declare runtime skills, asks which withheld capabilities to grant, writes the review copy at
`.pi/pi-daddy/settings.json`, stores the enforced grant outside the workspace, enables the project ledger, and applies
both decisions to the running session. Commit the review copy when the project's ignore rules permit it. The
standalone `pi-daddy init` command scaffolds files only; it cannot mutate a live pi session.

## Optional local public evidence capture

Set `PI_DADDY_PUBLIC_EVIDENCE_DIR` before starting the coordinating Pi process to retain exact public
`delegate_describe`, `delegate`, `delegate_all` and `delegate_chain` return content. It is off by default,
including source-byte retention. Create a private directory owned by your user first, then use its canonical
absolute Linux path (no symlink components):

```bash
mkdir -m 700 "$HOME/pi-public-evidence"
PI_DADDY_PUBLIC_EVIDENCE_DIR="$(realpath "$HOME/pi-public-evidence")" PI_DADDY_HERDR=0 pi
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
Requested execution IDs are allocated occurrences, not proof that those children started. Runtime outcomes
contain only the existing allowlisted final and process-receipt projection, in original child/step order;
skipped steps have no invented outcome. `finals` also copies each complete attributed public final separately,
with its ordinal, execution ID and native session/message/leaf identity. Its byte hash must match the native
final hash; unavailable finals remain null. Consumers never need to reconstruct a final from report delimiters.
Process settlement remains separate from workspace cleanup.

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

By default a child gets two things: its definition body as its system prompt, and the task. Anything more is a
capability. `context:<mode>` names how much of the parent's own session crosses, and it attenuates like every other
id, so a child can never receive a richer handoff than the definition's ceiling and the parent's grant allow.

```
delegate({ agent: "review", task: "Review the diff.",
           context: { mode: "summary", summary: "we chose flock over mtime; the lease is a helper process" } })

delegate({ agent: "build", task: "Implement it.",
           context: { mode: "files", files: ["src/kernel/resolve.ts"] } })
```

| Mode | What crosses |
| :--- | :--- |
| `none` | nothing beyond the definition and the task; the default |
| `files` | the contents of paths the parent names, confined to the working directory |
| `pruned` | the last few turns of the parent's session, plus older turns naming those files |
| `summary` | what the parent writes in its own words |
| `fork` | the parent's whole session, as a fork; **gated**, so a human answers first |

A `delegate_chain` step takes the same parameter, and because a chain is planned as one unit, a gate any step
raises is answered before the first step runs.

The modes are ordered, and each subsumes the weaker ones: a parent holding `context:fork` may hand a child
`context:files`. What crosses arrives inside a labelled, nonce-delimited fence marked as data rather than
instructions, capped at 32 KiB, with anything that did not fit said inside the fence. The capability decision record
names the mode the child actually received and how much crossed.

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

With Auto OFF, a gated capability needs a valid approval or the UI of the session executing the delegation. Captured children use Pi's JSON mode
without a UI; a gate with neither a valid approval nor an available UI is denied. The answer is **once**, **for this session**, or **always** (persisted for a bounded period, offered only for a
named definition, keyed `capability@subject`). Approvals inherit down the subtree intersected with each child's grant;
a `once` never crosses a spawn. The approval store and governance ledger never store raw task text. `/grants
approvals` lists what is persisted; `/grants revoke <capability>@<definition>` or `--all` removes it. The store lives
in pi's agent directory, not in the workspace.

**Auto mode** lets the operator approve every Daddy permission request for the current session and its descendants.
Start Pi with `PI_DADDY_AUTO_MODE=1` for Auto ON, or `PI_DADDY_AUTO_MODE=0` (the default when unset) for Auto OFF.
In the connected dashboard, press **a** to switch it on or off. `/grants auto on` and `/grants auto off` control the
same session setting; `/grants` shows the current state and source. Reload preserves the session choice; a new
Pi session starts from the environment default.

Auto is checked again before each delegation or chain step. Turning it OFF stops future automatic admissions;
already admitted work continues and independently granted manual approvals remain valid. Turning it ON can release
an outstanding Daddy approval prompt. An unavailable owning session never grants automatic permission. Automatic
decisions are recorded as `source: auto`, once for that admission, rather than banked as human or persistent approvals.
Capability grants, definition identity, workspace routing and execution settlement checks still apply. JEV calls and
LoRA storage retain their separate consent controls.

Monetary usage is observational. It never pauses, stops or authorizes a child. Available usage remains in
lifecycle records and episode reports; missing or partial coverage is not a zero-cost claim. Permission approvals,
depth, fan-out limits and execution timeouts are separate controls.

## The ledger

When configured, `.pi/pi-daddy/grants.jsonl` holds capability decisions, child lifecycles, workspace leases, cost
and session configuration, and episode outcomes. Each line is a **record envelope**
`{v, seq, prev, at, kind, id, body, digest}`: `prev` is the hash of the previous line, `digest` the hash of the record.
A damaged file is read up to the damage; the writer then refuses with `LEDGER_DAMAGED` until `pi-daddy ledger repair
<path> --yes` drops the damaged tail. A ledger written before the envelope existed is imported once at session start
(`pi-daddy ledger import <source> <target>` does it by hand) and never repaired. `/grants ledger` reports records,
escalation attempts, integrity, executors and which definition bodies ran, by digest.

The activity timeline (`activity.jsonl`, parent turns, child lifecycles, runtime-skill reads) uses the same envelope
and is enabled by default. It may store private prompt and final content in `.pi/pi-daddy/content/`; set
`PI_DADDY_ACTIVITY_CONTENT=metadata-only` (or `off`) to keep only digests, or
`PI_DADDY_ACTIVITY_TIMELINE=off` to disable observation.

`pi-daddy outcomes` reads Git history, optional GitHub Actions results from `gh`, and narrowly recognized corrections
in the next recorded operator turn, then appends only changed `episode_outcome` signals. Only commits carrying a
`Pi-Episode: <episode-id>` trailer is considered; `pi-daddy report` can display attribution only when matching episode
data exists in the local ledgers and shows the latest label beside each such episode. These labels are delayed for 48 hours and are operational heuristics, not quality acceptance. The contract
is `packages/pi-daddy/contracts/ledger-record/v1`.

## Workspaces and leases

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

Captured and Herdr pane execution share the native owner and current-final validator on Linux x64. Qualification is limited to the measured Ubuntu WSL2 environment: kernel `6.18.33.2-microsoft-standard-WSL2`, x86_64, Node `v26.7.0`, and exact Pi 1.0.4. Other kernel/runtime combinations, native Windows, and WSL-to-Windows worker interop remain unqualified.
A packaged native helper owns and reaps the cooperating child subtree. The final is accepted only when Pi's JSON
protocol settles and matches the exact persisted current turn and active branch. Complete final text is preserved;
work, final availability, subtree cleanup and optional observation completeness are separate result fields. A failed
execution returns `isError` with its available evidence. Display, diagnostics and optional recording cannot replace
the primary final. Unknown cleanup retains capacity and workspace exclusion.

Pi and TypeBox are wildcard host-provided peers so Pi's extension loader supplies one shared runtime copy. Development and release qualification pin exact Pi **1.0.4**; later Pi versions require new qualification. Prefer a Pi-managed install under a host pinned to 1.0.4. An ordinary standalone npm install may resolve newer peer versions and is outside this qualification. In a Pi-managed no-peer install, standalone help, version and reporting remain available; run initialization inside Pi with `/grants init`. Use Principal **4.11.2** with this runtime's `delegate_describe` contract. Native phases use `plan`, `build`, `review`, `debug`, and `investigate` with their returned `definitionId`; independent parallel work uses one `delegate_all` batch.

Final capture preserves whitespace and concatenates text blocks without inserting separators. Tool-call terminals, empty visible finals and non-`stop` reasons are unavailable. Persisted message comparisons ignore object key order while preserving array order and every field value. The shared `final-conformance.json` table checks these semantics in both runtime and harness. Capture remains bounded: 4 MiB visible final, 32 MiB protocol line, 64 MiB persisted session, and a 3-second bounded session read. Exceeding a limit reports an unavailable final and blocks dependent handoffs; it does not imply the worker failed to settle.

Retained capacity is rechecked against the original bound ownership and settlement receipt before a new single, parallel or chain dispatch. Exact later proof refunds the reservation once; missing, malformed or mismatched proof and unbound ownership remain retained. Recovery does not rewrite the original failed/unknown outcome or mint new capacity on reload. A single delegation reserves its available subtree; use `delegate_all` to allocate independent parallel children.

Set `PI_DADDY_HERDR=0` for captured execution or `PI_DADDY_HERDR=1` to demand Herdr panes. An unset value
probes for a responding server. The qualified Herdr transport requires client/server 0.8.2 and protocol 20;
a version mismatch refuses governed work with no backend fallback. Each owned pane starts a packaged launcher
connected to the coordinator over a private bounded Unix socket. The launcher uses the same pinned native
subreaper, and the coordinator binds its identity before releasing the worker gate. Child environment and
arguments come from the governed plan, without inheriting the Herdr daemon's environment. Only public text is
shown in the pane; raw protocol/private reasoning is not used as a display channel.

Native receipts, not pane closure or idle screen state, prove subtree cleanup. Model-free qualification covers
actual Pi CLI success, retry, nested tool and failed-final cases, cancellation, coordinator SIGKILL and loss of
the independently owned Herdr server, including detached descendants. Retained panes have no live Pi writer.
An unavailable pane display cannot replace a missing final or cleanup receipt. Dashboard display remains independent.

The trusted extension event `pi-daddy:runtime-snapshot:v1` supports Principal's explicitly armed resume checks.
It reports the actual Pi session/canonical working directory, a stable owner scope, current backend qualification,
outstanding execution identities and an exact settlement digest. A private runtime journal under the operator's
Pi agent directory records pending launches before execution and native ownership before the gate opens. An OS
lock excludes concurrent owners; clean same-session restart rechecks original receipts and preserves the digest.
Missing or changed receipts, interrupted unbound launches, live owners and failed control finalization refuse
resume. The journal contains process identities and receipts, never task text or an approval. A model-authored
list of children, successful prose or a progress flag cannot supply these facts. Principal separately verifies
operator authorization, candidate and artifacts before consuming its checkpoint and queueing a fixed continuation.
This bridge never grants capabilities, approves work or calls JEV/OpenAI/other models. The ledger schema is unchanged.
Same-user hostile filesystem or co-loaded-extension authenticity is outside this cooperative ownership boundary.

`pi-daddy-dashboard` shows current work and actual pending approvals first; completed history is collapsed by default.
`/grants dashboard` opens it beside the session in a Herdr pane. The header shows Auto ON/OFF and connection state.
Use **a** to switch Auto, arrow keys to select a row, **Enter** for details, **m** for session models, **h** for history,
and **?** for help. The view fits the terminal and follows resize events. A disconnected control displays its state
as unavailable until the owning session acknowledges a fresh snapshot.

A connected dashboard sends explicit Auto choices and model edits over a private session-local socket. Model edits
use the same in-memory overrides and `session_config` audit path as `/grants models`; `m <definition>
<provider:model> <thinking>` and `m all ...` remain available in command mode. A standalone dashboard is read-only.
Execution history and cost remain observations, and incomplete usage is shown as unavailable rather than zero.

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

| Area | Variables |
| :--- | :--- |
| Governance | `PI_DADDY_GOVERNANCE`, `PI_DADDY_GRANT`, `PI_DADDY_GATED`, `PI_DADDY_MAX_DEPTH`, `PI_DADDY_FANOUT`, `PI_DADDY_LEDGER`, `PI_DADDY_APPROVAL_TIMEOUT`, `PI_DADDY_AUTO_MODE` |
| Child execution | `PI_DADDY_HERDR`, `PI_DADDY_HERDR_WORKSPACE`, `PI_DADDY_HERDR_KEEP_PANE`, `PI_DADDY_CHILD_IDLE_TIMEOUT`, `PI_DADDY_CHILD_TIMEOUT`, `PI_DADDY_ALLOW_UNRESOLVED_MODELS` |
| Workspaces and retention | `PI_DADDY_WORKSPACE_REGISTRY`, `PI_DADDY_WORKSPACE_LEASE_DIR`, `PI_DADDY_EXECUTION_ARCHIVE`, `PI_DADDY_RETAIN_NATIVE_SESSIONS`, `PI_DADDY_NATIVE_SESSION_ROOT` |
| Activity | `PI_DADDY_ACTIVITY_TIMELINE`, `PI_DADDY_ACTIVITY_CONTENT` |

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

## Retired intervention inputs

External advisors, monetary cost gates and the first-delegation model chooser were removed. These recognized old
inputs are inert, including malformed values; the package does not rewrite existing configuration or history:

| Input | Compatibility behavior |
|---|---|
| Tool argument `episodeCostCeiling` on single/all/chain | Removed before Pi validates the remaining arguments |
| Settings `episodeCostCeiling`, `advisor`, `sessionModelPrompt` | Ignored; active model and authority fields still validate |
| `PI_DADDY_EPISODE_COST_CEILING`, `PI_DADDY_ADVISOR`, `PI_DADDY_ADVISOR_KEY`, `PI_DADDY_ADVISOR_MODEL`, `PI_DADDY_ADVISOR_TASK_EGRESS` | Never select or execute an intervention; reserved environment stripping remains |

Historical advice/cost-gate records remain readable. Manual model choices and permission approvals remain active.
For future JEV or learned-policy experiments, existing versioned decision/lifecycle records and harness result exports
remain the observation boundary. A separately selected experimental adviser may propose a choice for evaluation; it
must never grant capabilities, approve work, start retries or silently change the selected model. No automatic remote
advisor call or training pipeline is installed. Dataset consent, supported training method and comparative value need
separate qualification.

## Command-line reference

```text
pi-daddy init [--force] [--dir <path>]
pi-daddy ledger repair <path> [--yes]
pi-daddy ledger import <source> <target>
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


| Layer | Answers | Files |
| :--- | :--- | :--- |
| `src/kernel` | What may a child hold, and how is that carried? Mostly pure; the readers that discover what exists are the exception, and they are bounded. | `resolve`, `spawn`, `propagation`, `catalog`, `definitions`, `capabilities`, `approval`, `chain`, `context-handoff`, `fanout`, `correlation`, `refusals`, `env-names`, `project-paths`, `workspace`, `bounded-read` |
| `src/governance` | What was decided, and where is it written? | `record`, `ledger`, `ledger-events`, `ledger-report`, `approval-store`, `approval-prompt`, `grant-store`, `init`, `workspace-lease`, `execution-retention` |
| `src/executors` | How does a child process start and end? | `executor`, `run-herdr`, `herdr-*`, `pane-reaper` |
| `src/products` | What does the operator see or report? | `activity-timeline`, `dashboard-*`, `episode-report`, `episode-outcomes` |
| `extensions/` | The pi extension and its wiring: hooks, the three tools, approvals flow, `/grants`. | `grants.ts` is the entry point |

## Tests

```bash
npm run format:check
npm run typecheck
npm test
npm run build --workspace=pi-daddy
npm run test:integration:ci --workspace=pi-daddy # model-free CI subset
npm run test:integration --workspace=pi-daddy    # real Pi; Herdr creates and stops only its own named test server
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

Call `delegate_describe({agent:"build"})` and carry its `definitionId` into `delegate`, a `delegate_all`
child, or a `delegate_chain` step. Principal bindings require that precondition. Description starts no child
and grants no authority. A stale ID refuses before approval or launch. This hash is an observation and
precondition, not an approval record or a learned-policy authorization.
