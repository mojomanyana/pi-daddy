# pi-daddy

**Capability governance and coordination for [pi](https://github.com/badlogic/pi-mono)'s multi-level agent system.**
An orchestrator grants each sub-agent a deliberate subset of what it holds and withholds the rest. A sub-agent may
delegate further, but only ever a subset of what it holds. Enforcement is pi's own `--tools` allowlist on a separate
child process, with an optional append-only, hash-chained governance ledger.

This file is the product description, present tense. If code and this file disagree, fix this file. Agents start at
`AGENTS.md`, which carries the rules, the decisions still in force, the measured facts and the roadmap.

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
siblings, optionally in a visible [Herdr](https://herdr.dev) pane. `delegate_all` runs children concurrently under a
session-wide fan-out budget. `delegate_chain` runs steps in sequence; each step's task is composed from the previous
step's output, which crosses as a fenced, labelled, nonce-delimited block capped at 32 KiB, and the whole chain is
planned and gated as one unit before any step runs. A child may itself hold `delegate` and spawn further, with the
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
fan-out budget, approvals and workspace routing attenuate the same way. When a governance ledger is configured, each
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

A gated capability needs the UI of the session executing the delegation. Process children normally run `--print`
without a UI; Herdr children are interactive, but a gate with neither an inherited approval nor an available UI is
denied. The answer is **once**, **for this session**, or **always** (persisted for a bounded period, offered only for a
named definition, keyed `capability@subject`). Approvals inherit down the subtree intersected with each child's grant;
a `once` never crosses a spawn. The approval store and governance ledger never store raw task text. `/grants
approvals` lists what is persisted; `/grants revoke <capability>@<definition>` or `--all` removes it. The store lives
in pi's agent directory, not in the workspace.

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
exclusive lease: a kernel `flock` held by a helper process the parent owns, released on any death, refusing a second
writer for the same root. It coordinates governed children only; it is not a sandbox, path confinement, or proof of
anything a child did.

## Executors and the dashboard

A child runs as a captured subprocess, or in a Herdr pane when a reachable Herdr server is probed at session start
(`PI_DADDY_HERDR=1` demands it; `0` forces captured subprocesses). Non-writer panes are reaped when the owning parent
agent settles, normally when the operator gets its prompt back; writer panes close when their child settles so the
workspace lease can be released. `PI_DADDY_HERDR_KEEP_PANE=1` preserves non-writer panes only.
`pi-daddy-dashboard` renders a ledger or activity timeline in a terminal; `/grants dashboard` opens it in a Herdr pane
beside the session. Its execution history and current episode cost are
read-only. A dashboard connected through `/grants dashboard` accepts
`m <definition> <provider:model> <thinking>` (or `m all ...`) over a private session-local socket and applies the same
in-memory overrides and `session_config` audit event as `/grants models`; a standalone dashboard is read-only, and
neither form can affect enforcement.

## Bounds and configuration

Every variable is `PI_DADDY_*`. Operator-facing controls are grouped below; the environment overrides stored
configuration where both exist.

| Area | Variables |
| :--- | :--- |
| Governance | `PI_DADDY_GOVERNANCE`, `PI_DADDY_GRANT`, `PI_DADDY_GATED`, `PI_DADDY_MAX_DEPTH`, `PI_DADDY_FANOUT`, `PI_DADDY_LEDGER`, `PI_DADDY_EPISODE_COST_CEILING`, `PI_DADDY_APPROVAL_TIMEOUT` |
| Child execution | `PI_DADDY_HERDR`, `PI_DADDY_HERDR_WORKSPACE`, `PI_DADDY_HERDR_KEEP_PANE`, `PI_DADDY_CHILD_IDLE_TIMEOUT`, `PI_DADDY_CHILD_TIMEOUT`, `PI_DADDY_ALLOW_UNRESOLVED_MODELS` |
| Workspaces and retention | `PI_DADDY_WORKSPACE_REGISTRY`, `PI_DADDY_WORKSPACE_LEASE_DIR`, `PI_DADDY_EXECUTION_ARCHIVE`, `PI_DADDY_RETAIN_NATIVE_SESSIONS`, `PI_DADDY_NATIVE_SESSION_ROOT` |
| Advisor | `PI_DADDY_ADVISOR`, `PI_DADDY_ADVISOR_KEY`, `PI_DADDY_ADVISOR_MODEL`, `PI_DADDY_ADVISOR_TASK_EGRESS` |
| Activity | `PI_DADDY_ACTIVITY_TIMELINE`, `PI_DADDY_ACTIVITY_CONTENT` |

`PI_DADDY_CHILD_IDLE_TIMEOUT` is seconds without activity before a child is stopped (default fifteen minutes);
activity is output, a child-session-file change, or Linux process-tree CPU/descendant activity.
`PI_DADDY_CHILD_TIMEOUT` is the runaway ceiling for a child that never goes quiet (default six hours). The remaining
names in the source inventory are internal propagation, attribution, workspace-pin, or dashboard-transport fields;
do not set them manually. Refusals are thrown with stable codes (`CAPABILITY_ESCALATION`, `GATED_UNAPPROVED`,
`DEPTH_EXCEEDED`, `FANOUT_EXCEEDED`, `WORKSPACE_NOT_AUTHORIZED`, `CHILD_TIMED_OUT`, `LEDGER_DAMAGED`, …); the full
enumeration is `REFUSAL_CODES` and is pinned by the contract.

### Child work attribution

Every governed child receives `PI_DADDY_EPISODE` (the ledger episode), `PI_DADDY_DEFINITION` (the definition name),
and `PI_DADDY_EXECUTION` (the lifecycle execution id). These are attribution metadata, not authority.

### Per-definition model and thinking

Child runtime defaults are reviewable beside each definition in `.pi/pi-daddy/settings.json`. Model precedence is
explicit argument → session override → definition → global default → pi for model and thinking. Use `/grants models`
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
npm run test:integration --workspace=pi-daddy    # real pi when available; Herdr needs a reachable server
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
