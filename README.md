# pi-daddy

**Capability governance and coordination for [pi](https://github.com/badlogic/pi-mono)'s multi-level agent system.**
An orchestrator grants each sub-agent a deliberate subset of what it holds and withholds the rest. A sub-agent may
delegate further, but only ever a subset of what it holds. Enforcement is pi's own `--tools` allowlist on a separate
child process, with an append-only, hash-chained ledger of every grant and refusal.

This file is the product description, present tense. If code and this file disagree, fix this file. Agents start at
`AGENTS.md`, which carries the rules, the decisions still in force, the measured facts and the roadmap.

## Install and first run

```bash
pi install npm:pi-daddy
pi
```

In the session, `/grants` shows the tool ceiling this session holds and the definitions it can spawn. `/grants init`
scans the enabled installed packages that declare skills, asks which withheld capabilities to grant, and writes
`.pi/pi-daddy/settings.json`, the one reviewable file you commit. Nothing is governed until `init` has run;
installing alone initialises nothing.

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

`pruned` keeps recent turns plus turns naming the given files, and an enabled advisor then judges those candidates
against the task, keeping a subset. Whether either keeps what a reader would have kept is unmeasured, so `pruned` is
not a default.

## The guarantee, and its limit

```
effective = ( requested ∩ parentGrant ∩ ceiling ) \ (gated \ approved)
```

Escalation is impossible by construction on the tool surface: no policy engine, no model on the security path. Depth,
fan-out budget, approvals and workspace routing attenuate the same way. Every decision is recorded, and the `denied`
set is the signal: an agent repeatedly asking for what it does not hold is the escalation tell.

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

A gated capability needs a human's answer at the root, because every child runs `--print` with no UI. The answer is
**once**, **for this session**, or **always** (persisted for a bounded period, offered only for a named definition,
keyed `capability@subject`). Approvals inherit down the subtree intersected with each child's grant; a `once` never
crosses a spawn. The task text is never stored. `/grants approvals` lists what is persisted; `/grants revoke
<capability>@<definition>` or `--all` removes it. The store lives in pi's agent directory, not in the workspace.

## The ledger

`.pi/pi-daddy/grants.jsonl` holds every capability decision, child lifecycle and workspace lease. Each line is a
**record envelope** `{v, seq, prev, at, kind, id, body, digest}`: `prev` is the hash of the previous line, `digest` the
hash of the record. A damaged file is read up to the damage; the writer then refuses with `LEDGER_DAMAGED` until
`pi-daddy ledger repair <path> --yes` drops the damaged tail. A ledger written before the envelope existed is imported
once at session start (`pi-daddy ledger import <source> <target>` does it by hand) and never repaired. `/grants
ledger` reports records, escalation attempts, integrity, executors and which definition bodies ran, by digest. The
activity timeline (`activity.jsonl`, parent turns, child lifecycles, skill-file reads) uses the same envelope. The
contract is `packages/pi-daddy/contracts/ledger-record/v1`.

## Workspaces and leases

A registered worktree is named `workspace:<id>` and routing a child there is a capability that attenuates like any
other. A writer routed to a workspace holds an exclusive lease: a kernel `flock` held by a helper process the parent
owns, released on any death, refusing a second writer for the same root. It coordinates governed children only; it is
not a sandbox, not path confinement and not a proof of anything a child did.

## Executors and the dashboard

A child runs as a captured subprocess, or in a Herdr pane when a reachable Herdr server is probed at session start
(`PI_DADDY_HERDR=1` demands it, `0` refuses it). Panes opened by a run are reaped when the operator gets their prompt
back. `pi-daddy-dashboard` renders a ledger or activity timeline read-only in a terminal; `/grants dashboard` opens it
in a Herdr pane beside the session. It is a renderer in a separate process and never affects enforcement.

## Bounds and configuration

Every variable is `PI_DADDY_*`. The ones an operator sets: `PI_DADDY_GRANT` (overrides the stored grant; the
environment always wins), `PI_DADDY_ADVISOR` and `PI_DADDY_ADVISOR_KEY` (see below), `PI_DADDY_LEDGER`,
`PI_DADDY_HERDR`, `PI_DADDY_CHILD_IDLE_TIMEOUT` (seconds with no
activity before a child is stopped; default fifteen minutes; activity is any output byte, a change to the child's pi
session file, or CPU time in the child's process tree on Linux; every child writes a session file for the run, removed
afterwards unless it is a retention target), `PI_DADDY_CHILD_TIMEOUT` (seconds; the runaway ceiling for a child that never goes quiet; default six
hours), `PI_DADDY_WORKSPACE_REGISTRY`, `PI_DADDY_EXECUTION_ARCHIVE`
(opt-in retention of child stdout, stderr and result bytes). The rest are written by the parent for its children and
refused if set by hand. Refusals are thrown with stable codes (`CAPABILITY_ESCALATION`, `GATED_UNAPPROVED`,
`DEPTH_EXCEEDED`, `FANOUT_EXCEEDED`, `WORKSPACE_NOT_AUTHORIZED`, `CHILD_TIMED_OUT`, `LEDGER_DAMAGED`, …); the full
enumeration is `REFUSAL_CODES` and it is pinned by the contract.

## Advisors, and what leaves the machine

An advisor is a non-generative decider that answers typed questions. It may select, rank, annotate or propose, and
it can never widen a grant, satisfy a gate or replace a human's answer. Today it fills two blanks. When a
`delegate` call names no thinking level, it chooses one from the levels that model reports it supports. When a
context handoff is `pruned`, it picks which of the turns the mechanical rule already kept are worth carrying, and
it can only narrow that set.

It is **off unless you set `PI_DADDY_ADVISOR=jev` and `PI_DADDY_ADVISOR_KEY`**, both of which live in the
environment rather than in a committed file, because a file inside the workspace is writable by any child holding
`tool:write`. `PI_DADDY_ADVISOR_MODEL` overrides the model, also from the environment. A project's `advisor` block
in `settings.json` may turn one off for that project and shorten its timeout; it can never turn one on, choose its
model, or lengthen its bound.

**With an advisor on, what leaves the machine is more than you might assume.** A delegation that leaves the thinking
level blank sends its task text to a third party, TypeSafe's Jev through OpenRouter, because it cannot judge a task
it cannot see. A `pruned` context handoff sends the task and up to twelve of **your own session turns** for the
advisor to judge, which is your conversation rather than just the task. It is never written to the ledger: the record names the
decision, the answers and the timing, and the task is never stored, as it never has been. If you are not willing to
send task text off the machine, leave the advisor off, which is the default. `/grants` states which advisor is in
force, or why none is.

## The layers

The Files column names the main modules of each layer, not all of them; the module docstrings are the
specification of who owns what.


| Layer | Answers | Files |
| :--- | :--- | :--- |
| `src/kernel` | What may a child hold, and how is that carried? Mostly pure; the readers that discover what exists are the exception, and they are bounded. | `resolve`, `spawn`, `propagation`, `catalog`, `definitions`, `capabilities`, `approval`, `chain`, `context-handoff`, `fanout`, `correlation`, `refusals`, `env-names`, `project-paths`, `workspace`, `bounded-read` |
| `src/governance` | What was decided, and where is it written? | `record`, `ledger`, `ledger-events`, `ledger-report`, `approval-store`, `approval-prompt`, `grant-store`, `init`, `workspace-lease`, `execution-retention` |
| `src/executors` | How does a child process start and end? | `executor`, `run-herdr`, `herdr-*`, `pane-reaper` |
| `src/advisors` | Advice that can select, rank, annotate or propose, and never widen a grant, satisfy a gate or replace a human. Off by default (ADR-0077). | `decider`, `advisor`, `jev`, `settings` |
| `src/products` | What does the operator see? | `activity-timeline`, `dashboard-*` |
| `extensions/` | The pi extension and its wiring: hooks, the three tools, approvals flow, `/grants`. | `grants.ts` is the entry point |

## Tests

```bash
cd packages/pi-daddy
npm test                   # unit tests, no pi, no network
npm run typecheck
npm run test:integration   # against a real pi process and a real Herdr server, no model tokens
npm run test:smoke         # pack, install into a scratch project, import and use it
```

`pi-daddy` under `packages/pi-daddy` is the only published package; the workspace root is private.
