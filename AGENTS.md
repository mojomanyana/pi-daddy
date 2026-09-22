# pi-daddy — orientation for agents

This is the only orientation file. There is no `docs/` folder and no `CLAUDE.md`: what a fresh session needs is
here, what a human needs is in `README.md`, and everything else is git history. Decisions that were reversed are
recorded in this file with a date, never rewritten.

## What this is

pi-daddy governs and coordinates pi's multi-level agent system. An orchestrator holds a catalog of tools and Agent
Skills definitions; when it delegates, each child receives a deliberate subset and nothing more, and a child may
delegate further only a subset of what it holds. Enforcement is pi's own `--tools` allowlist on a separate child
process, with an append-only ledger of every grant and refusal. What it governs is the **tool surface**; a child
holding `bash` can still escape, and containing that is the operating system's job (ADR-0012 below).

The operator's stated goal is a **session coordinator**: coordination of agents, runtime skills and context, on top
of the governance that already works. The roadmap at the end of this file is the path there.

## Where things live

```
AGENTS.md                         — this file: rules, decisions, measured facts, glossary, roadmap
README.md                         — what the product is and how to use it, present tense, one section per layer
packages/pi-daddy/                — the package
  src/kernel/                     — pure functions: resolve, spawn plan, propagation, catalog, definitions, approval maths
  src/governance/                 — stores and the ledger: record envelope, ledger events, approvals, grant store, leases, retention
  src/executors/                  — how a child process is started: captured subprocess or Herdr pane
  src/advisors/                   — advice only: a Decider answering typed questions, never authority (ADR-0077)
  src/products/                   — activity timeline and the read-only dashboard
  extensions/                     — composition: the pi extension pi loads (grants.ts) and its helpers
  src/index.ts, src/cli.ts        — composition: the public root export and the `pi-daddy` bin
  contracts/ledger-record/v1/     — the one shipped contract: record envelope + governance event schema + fixtures
  test/, test-integration/        — unit tests (no pi), and tests against a real pi process
```

The import direction between the layers is enforced by `test/layering.test.ts`. Composition may import anything and
is imported by nothing.

## Hard rules

- **`main` is only ever advanced by merging a pull request.** Check the branch before the first edit of a task, not
  before the commit (R-85). If you find work already on `main` and unpushed: `git switch -c <branch>` at HEAD, then
  `git branch -f main origin/main`. Never force-push. There is no pre-commit hook and no branch protection; the
  operator merges deliberately and nothing mechanical stops a mistake.
- **Files are the memory.** A decision that exists only in chat does not exist. New decisions go in this file under
  "Decisions still in force" with a date; a reversal is a dated sentence beside the original, not an edit of it.
- **Measure before asserting, and say which you did.** When a change advertises a property, add the check that forces
  it in the same commit, or do not write the claim. State what the evidence does not cover.
- **A test that cannot fail is worse than no test.** Name the production change that would break it.
- **Prefer failing closed, and be loud about it.** Malformed configuration disables spawning rather than falling back;
  every refusal names the variable or file.
- **Counts and versions do not belong in orientation documents.** Ask the commands.
- **Terminology:** "workflow skills" are `.claude/skills/` (local-only process tooling, gitignored). The runtime tools
  and skills this project governs are "tools" or "runtime skills", never bare "skills" where ambiguous.
- **Review is per PR.** Anything touching behaviour gets one independent pass (a review subagent with written
  hypotheses, or the operator) recorded in the PR body before it merges. Docs-only changes may merge on the author's
  own read, said out loud in the PR.
- **Prettier runs from the repository root** so `.prettierignore` applies; `src/executors/vendor/` is hash-pinned and
  must never be reformatted.

## Working here

```bash
cd packages/pi-daddy
npm test                   # unit tests: no pi, no network, about 40s (it spawns real lock helpers)
npm run typecheck          # src + extensions + tests + integration tests
npm run test:integration   # against a REAL pi process and a real Herdr server, no model tokens
npm run test:integration:ci# the model-free, Herdr-free subset CI runs
npm run test:smoke         # pack, install into a scratch project, import and use it
npm run contracts:generate # regenerate contracts/ledger-record/v1 from the runtime builders
PI_DADDY_IT_MODEL=1 npm run test:integration    # adds an end-to-end tier with a real model (costs money)
```

The clone may be shared with other sessions, which can switch the checked-out branch under you. Print
`git rev-parse HEAD` in the same command as any measurement you write down, or take a worktree. Pushes to the
GitHub repository use the repository owner's token per command, never a global account switch.

`.claude/` is gitignored, so everything in it is local-only and nothing there is required.

## Making a change here

Measured by the fresh-session probe below: the rest of this file tells you where code lives and what good looks like,
and every one of these was something a fresh session had to guess.

- **Where a change goes.** The layer tables in `README.md` name the main modules, not all of them. The module
  docstrings are the real specification of who owns what, and they are unusually complete; read the one at the top of
  the file you are about to change before deciding it is the right file.
- **Test files.** A unit test is `packages/pi-daddy/test/<kebab-case>.test.ts`. The name must match
  `^test/[a-zA-Z0-9-]+\.test\.ts$`: `scripts/unit-tests.ts` throws `exact ordinary file inventory required` for
  anything else, which fails the whole suite with a message that does not mention file names. Tests that need a real
  pi process go in `test-integration/` as `<name>.it.ts`.
- **Module size.** `test/file-size.test.ts` caps a module at 400 statements and any line at 200 characters. Split the
  module rather than raising the cap; several modules here exist because of that rule.
- **Formatting.** `npm run format` and `npm run format:check`, from the repository root so `.prettierignore` applies.
  CI runs the check.
- **Contracts.** `npm run contracts:generate` rewrites `contracts/ledger-record/v1` from the runtime builders. A new
  refusal code or a new ledger field needs it, and the regenerated files are committed with the change.
- **The changelog.** `packages/pi-daddy/CHANGELOG.md` is part of the published package, newest first, and a behaviour
  change adds an entry that says what to do about it. A change that is only comments, tests or documents does not.
- **What CI gates on**, on Node 22.19.0 and 24.x: `format:check`, `typecheck`, `npm test`, `test:integration:ci`, an
  assertion that the suite left the tree clean, and `test:smoke`. The full `test:integration` tier needs a live Herdr
  daemon and stays local, as does `PI_DADDY_IT_MODEL=1`.
- **The record.** A decision gets a dated paragraph under "Decisions still in force"; a reversal gets a dated sentence
  beside the original, never an edit of it. A gap in the list below is closed by rewriting its bullet with what was
  measured and when, keeping what the bullet used to claim if that claim turned out to be false.

## The big cleanup of 2026-09-22 (what became untrue)

Two cleanups removed most of the package. The first (2026-09-21) deleted five lab features: the bwrap digest effect
profile, factory orders, measured orders and sessions, the producer IPC bridge and `delegate_all`'s primary/shadow
mode. The second (2026-09-22, version 0.31.0) deleted everything that was not the delegate path or its record:

- the skill-harness learning product (`/grants host`, `/grants learning`, the daily dashboard host, debrief and blind
  interventions, adoption policy, experiments, resource budget, intent and dispatch control, ordinary-children
  cancellation) and with it the skill-harness dependency and its vendored fixtures;
- the work DAG (`/grants work`, `pi-daddy work *`, work setups and runs) and the separate work ledger v4;
- the daily view and panel, the check runner, workflow facts, the `check_receipt` and `workflow_fact` ledger event
  kinds, the four `CHECK_*` refusal codes, the `guide` and `current` CLI commands;
- every contract except `contracts/ledger-record/v1`, every `*-public.ts` barrel and every export-map subpath (the
  root and `contracts/*` are the only exports);
- the `docs/` folder, `CLAUDE.md`, and the `hooks/pre-commit` branch guard.

**ADR-0076's non-goal "no user-facing capability is deleted" is therefore false, twice, by operator decision.**
ADR-0076 PR 3d-ii (work ledger onto the envelope) and PR 4 (skill-harness as optional peer) were done by deletion.
Anything a historical document says about the features above describes something that no longer exists; the text
is at `git show 9cf2904:docs/...`.

## Fresh-session probe, 2026-09-22

The acceptance test for this file and `README.md`: a fresh agent session, given only those two documents and the code,
with git history and every other document withheld, was asked to close one bullet from the gap list below.

**It shipped the change.** It found the right module, wrote a test in the house style, verified the test by reverting
its own fix, and ran typecheck, the unit suite, the real-pi tier and the smoke test. So the documents are sufficient to
locate code and to know what good looks like.

**Three things they were not sufficient for**, all now addressed above: process (test-file naming, module size caps,
the format command, the changelog's existence, what CI gates on, what closing a gap in the record looks like), the
file lists in the layer tables being partial while reading as complete, and one gap bullet that was simply false. The
probe's most expensive step was measuring that the bullet it had been asked to close described behaviour that no
longer happens; had it trusted the document it would have changed a path that already worked.

What the probe did **not** establish: that a session without this codebase's unusually complete module docstrings
could do the same, which the probe said plainly and is the honest limit of the result. Its own words: the documents
"would not have survived a codebase with ordinary comments."

## Pruned-handoff probe, 2026-09-22

`selectPrunedTurns` shipped saying of itself that whether it keeps what a reader would have kept "stays unmeasured
until the handoff probe". This is that probe. It runs against the operator's own pi sessions, it found a real
defect — and two independent reviews then found the first version of the MEASUREMENT wrong in ways large enough to
change what it concluded. Both corrections are below, because a probe whose errors are not recorded is worth less
than no probe.

**What it measures.** For each session the last message turn stands in for a task. From its PROSE — the text a
human or a model actually wrote, not the JSON envelope — a term set is extracted; a term is *recoverable* if some
earlier turn's prose contains it. Recall is the share that survives into what the child receives.

**The defect it found.** Turn sections are pushed oldest-first and the 32 KiB budget was spent in array order, so
when the cap bound the turns cut were the ones NEAREST the task. The cap bound in 13% of handoffs at the old
default of six turns and 60% at twenty. End to end, delivered recall peaked at 20 turns and then **fell** at the
50-turn ceiling: asking for more context made the child worse off, and the parameter read as if it did the
opposite.

**What changed as a result.** `ContextSection` gained `keepRank` and the budget is spent by rank while
presentation stays chronological. The bands are named in `CONTEXT_RANK`: what the parent chose (a summary, a named
file) outranks what a rule chose, and within the rule's output a turn kept for NAMING a file outranks one kept for
being recent. Only then was `DEFAULT_CONTEXT_TURNS` raised from 6 to 20.

| turns | selected | delivered | mean KiB | `longest` control | `oldest` control |
| ----- | -------- | --------- | -------- | ----------------- | ---------------- |
| 6     | 0.545    | 0.532     | 12.6     | 0.642             | 0.413            |
| 12    | 0.727    | 0.671     | 20.9     | 0.705             | 0.592            |
| 20    | 0.838    | 0.737     | 25.8     | 0.723             | 0.639            |
| 50    | 0.924    | 0.747     | 27.2     | 0.708             | 0.669            |

**Correction 1: the first ground truth was measuring the file format.** It came from `JSON.stringify(message)`, and
48.9% of the scored terms never appeared in anything anyone wrote — `timestamp` was recoverable in 78 sessions out
of 78, `cacheRead` and `stopReason` in 75 — scoring near 1.00 because every turn carries them. The headline was
0.870; on the task's own words it is **0.737**.

**Correction 2: "a rule that kept the wrong turns would score badly here" was asserted and was false.** On the old
metric twenty turns chosen at RANDOM scored 0.899 against recency's 0.921, and the twenty LONGEST turns beat it
outright. Controls are now measured every run and printed beside the rule. On the corrected metric recency does
win at 20 turns and above, but `longest` beats it at 6 — a finding about the rule, left in the table rather than
explained away.

**What it does not establish.** That term recall is task success: no child was run and no model was called. That
these sessions resemble delegation; they are ordinary sessions from 32 projects and three are this project's own.
Precision, which an early draft reported as 1.00 and which measured nothing, since kept turns are adjacent to the
task. Stability better than about 0.02, because the corpus is live — identical code rerun four times in 25 minutes
spanned 0.011, which is why the corpus fingerprint is printed and why the gap between 20 and 50 turns is not
treated as meaningful. And **it does not support making `pruned` the default mode**: a quarter of what a task names
is missing at the default, and the cost of being wrong is the operator's own session leaving the machine. `none`
stays the default.

Rerun: `PI_DADDY_PROBE_SESSIONS=~/.pi/agent/sessions npm run test:integration`. Without the variable the probe says
it measured nothing rather than passing quietly.

## Decisions still in force

One paragraph each: the decision, the reason, what was rejected. The ADR numbers are pointers into git history
(`git show 9cf2904:docs/06-decisions/`).


**ADR-0008 — capabilities attenuate monotonically.** A child's effective grant is
`(requested ∩ parentGrant ∩ ceiling) \ (gated \ approved)`, and the `∩ parentGrant` term is the invariant: no agent
can confer what it does not hold, so escalation is impossible by construction rather than by policy. The root
orchestrator holds the full catalog and grants freely; every level below can only subtract, and because the spawn
tool is itself a capability, depth control falls out of the same rule (a numeric depth bound remains as a cheap
backstop). Every decision is recorded and the `denied` set is the security signal, since an agent repeatedly asking
for what it does not hold is the escalation tell. Rejected: a policy engine adjudicating each grant (a complexity
magnet that puts model judgement on the security path), static grants only (declines what was asked for), and
trusting the orchestrator (fails silently the moment untrusted content reaches a grant decision). Amended
2026-08-12 to add the fan-out budget as a cardinality companion: grant, depth, budget and approvals all shrink downward.

**ADR-0010, ADR-0014, ADR-0021 — approvals are once, session or always; the task is never stored.** A gate is
answered by a human at the root, because every governed child runs `--print` with no UI and pi's non-interactive
`confirm` resolves false; approvals are inheritable, riding down the subtree intersected with each child's grant,
because a memory-only non-inheritable model (the pi-fabric shape) would confine gated work to one level below a
human. `always` persists for a bounded period keyed `capability@subject` and is offered only when the subject is a
human-authored definition; the model-chosen `tools:` path gets deny, once or session and never writes to disk, and a
model-supplied role as key was rejected because a key the model controls is not a key. ADR-0014 moved the store out of
agent-writable workspace into the user's pi agent directory, threaded scope and subject through propagation so a
`once` never crosses a spawn and one subject's yes cannot satisfy another, and made writes atomic with no symlink
following; signing was rejected as an addition rather than an alternative, and dropping `always` was rejected because
repeated prompting is what produces reflexive approval. ADR-0021 removed the task text from the store entirely (the
write path projects entries through a whitelist), rejecting both a stored digest-as-provenance and a narrowed rule; the
task is shown only in the dialog, where a human needs it and where it is not at rest. ADR-0014 also records the
proportionality: once a child holds `bash`, hardening this store buys confidence, not security.

**ADR-0012 — `bash` is a governance hole and containing it is the operating system's job.** A child granted `bash`
can start a completely ungoverned pi descendant with no ledger line, no depth increment and no grant computed
(probe `g5-bash-escape`); the mechanism is "the child can execute programs", so `--tools` is not defeated but
bypassed. The decision: gating is closed under subsumption (gating `write` also gates `bash`, never the reverse, so
least privilege is not inverted), `bash` is gated by default in any governed session (an explicitly empty gated list
turns that off; absent and empty are distinguishable), and the product's guarantee is scoped to the tool surface pi
exposes. Rejected: refusing every `bash` grant (makes the package useless for real delegations) and requiring an OS
sandbox for any grant containing `bash` (the only true fix, disproportionate for a threat model of cooperative but
fallible or prompt-injected agents; it becomes live if a deliberately adversarial child is ever in scope). The
revisit trigger fired 2026-09-04 when a child in an empty working directory edited a file in another checkout
(probe `g38-cwd-is-not-containment`); that confirmed the boundary and did not select the sandbox option.

**ADR-0016 — this package is the spawner, not a fence.** `delegate` is the only spawn path and can spawn a named
definition; Agent Skills `SKILL.md` is the definition format, `allowed-tools` is the ceiling and the body is the
child's system prompt, with anything the spec lacks placed under `metadata` with `pi-daddy-` keys rather than invented
frontmatter. The standard declares intent and enforces nothing; passed through `--tools` it becomes structural, which
is the product's one sentence. `allowed-tools` patterns such as `Bash(git:*)` are refused loudly because pi's
allowlist is name-granular and every reinterpretation either widens or silently narrows. Governing `@tintinweb/pi-subagents`
from outside was impossible: its `SpawnOptions` has no `tools` field, its RPC is `ping`/`spawn`/`stop` with no
configuration query, `subagents:rpc:spawn` never produces a `tool_call`, its children are in-process sharing one
`process.env`, and its registry is unreachable by import (probe `g13-subagents-coupling`), so an interceptor
could refuse or allow but never narrow. The interceptor was therefore demoted to a tripwire and the ported ceiling rules
deleted; keeping the pi-subagents frontmatter, inventing a format, or keeping the full fence were all rejected. Herdr is
a supported executor, not the only one; ADR-0031 later changed selection so that an unset executor variable means
"probe for a reachable Herdr server", never "a binary is on PATH".

**ADR-0017 — a definition is spawnable only when the grant names it.** The catalog emits `agent:<name>` for every
definition, and this ADR made holding that id (or `tool:*`) a real prerequisite in the planner, so "may spawn
`review`, not `deploy`" becomes expressible and attenuates downward like every other capability, with a definition's
own `allowed-tools` declaring which definitions it may spawn in turn. It first fixed the observation step that was
silently dropping every non-tool namespace from a session's own grant. Rejected: deleting the namespace (the "a child
with `bash` escapes anyway" argument proves too much, since it would also retire the depth bound, the ledger and the
fan-out budget), and an opt-in form where an absent `agent:` id permits everything (the inversion ADR-0016 had just
removed from pi-subagents' format, and unreasonable about locally). The format decision itself, SKILL.md as the
definition, is ADR-0016's; this one supplies its authorisation half.

**ADR-0020 — the approval store moves without migration.** Persisted approvals live in one file per governed
directory, named by the project's basename and a hash of its path, so the keyspace collision that let one project's
`always` delete another's becomes inexpressible rather than handled, and `revoke --all` cannot reach another
project's file. The old shared file is ignored, not migrated, and named once at session start so an operator whose
approvals stopped applying learns why; entries keep their `cwd` field so a copied file still authorises nothing.
Rejected: nesting projects inside one file (every write still rewrites everything, the bet that had already lost four
times), migrating the old file (code that runs once, on one input per machine, in the layer with the most recorded
defects), and deleting persistence entirely, which was steelmanned and lost only because the cost lands on the default
`bash` gate, the one an operator does not opt into and the one most exposed to fatigue. ADR-0076 PR 3c applied the
same precedent literally when the user-level stores moved under one `pi-daddy/` directory: nothing copies authority.

**ADR-0033 — a chain is planned as one unit, and a prior agent's output is data.** `delegate_chain` is a single tool
call planned in full before any step runs; each step is authorised, gated, audited and bounded exactly as `delegate`
is, so a chain is composition, not a new privilege path. The previous step's output crosses as a fenced, labelled,
nonce-delimited verbatim block whose nonce is generated after the producing child has finished (so it cannot forge its
own closing fence), capped at 32 KiB keeping the tail with truncation labelled inside the fence; each step spends one
fan-out unit, a failed step aborts the remainder while completed results are returned, a chain is a straight line with
no branching, and each step's ledger record names the child whose output composed its task. Rejected: quarantining
output in a file (makes `tool:read` a hidden prerequisite and a step that never reads it fails silently), a structured
contract (every definition rewritten), and raw verbatim (what the ungoverned extension did). The gate as first written,
"asks once for the union", was unimplementable because one dialog means one subject; it was amended 2026-08-17 to
"every dialog raised upfront, at most one per `capability@subject`", and amended again 2026-08-18 after the gate was
found ignoring `plan.ok`, letting one `once` authorise siblings and recording no approval. The transferable lesson is
recorded there: a new caller of an existing mechanism must list every rule the ordinary caller obeys and inherit them.

**ADR-0034, ADR-0035 — workspace leases are exclusion, not shared memory; routing is a capability.** A governed
writer lease is a kernel `flock` held by a helper process whose stdin the parent owns, so the kernel releases it on
any death and the helper stops the attached child first; read-only children take no exclusive lock, writers for one
canonical root contend on one lock regardless of the model-chosen id, and the lease coordinates pi-daddy-governed
children only. It is not a filesystem lock, a sandbox, a proof of prompt compliance or an implementation of another
controller's `writer` field. Rejected: process-local maps (separate pi processes could both be writers and SIGKILL
leaks ownership) and reusing the mtime-stale file lock (transfers ownership after ten seconds with no liveness check).
Correlation metadata is copied verbatim, bounded, and never consulted for capability resolution; the planner records
digests it computes itself. ADR-0035 then made the destination a capability: routing to workspace `W` requires
`workspace:W` in the caller's effective grant, refused with `WORKSPACE_NOT_AUTHORIZED` and recorded as a denial, with
`workspace:*` held but never inherited; it shipped as a deliberate breaking change because failing open for
compatibility is the one thing an attenuation fix must not do. Rejected: re-supplying a narrowed registry file per
child (temp-file lifecycle, no gate, a second governance mechanism; it composes and may come later), an explicit
allowlist argument (a third propagation channel), and recording routing as a non-goal (unlike the `bash` escape, the
ledger would then assert an authorisation nobody granted). Access level is still derived from requested tools, not
from the id.

**ADR-0038 — the child timeout is a wall clock, now sixty minutes, and the wall clock was never the real
problem.** The default child limit is inherited by descendants, measured in seconds, operator-overridable, and zero
or a malformed value selects the default rather than disabling it. It was raised from ten to twenty minutes on
2026-09-02 after repeated `CHILD_TIMED_OUT` outcomes, and to sixty on 2026-09-21 when the operator saw a build
running the test suite killed at twenty; keeping the shorter value was rejected each time because it preserved the
observed cutoff. The dated note records why the number cannot be right: a `pi --print` child gives its parent no
activity signal until it exits, so no wall-clock value distinguishes working from hung.

**2026-09-22 (PR 3e, 0.32.0): the working bound is inactivity; the wall clock is a runaway ceiling.** A child is
stopped when `PI_DADDY_CHILD_IDLE_TIMEOUT` seconds (default fifteen minutes; zero or malformed selects the default)
pass with no activity. Activity is any stdout or stderr byte, a change to the child's pi session file, or, on the
process executor on Linux, CPU time consumed by the child's process tree or a change in its descendants (read from
`/proc`). Every child now gets a session file: the plan's `--session` when native retention asked for one, otherwise a
private temporary file removed on every path after the run, except when the operator keeps a Herdr pane, where the
interactive pi inside is still writing to it. That means every child's transcript is on disk for the duration of its
run, under a 0o700 directory in the temp dir, whether or not retention is on. The session file alone is not enough,
and the review of this PR is where that was learned: pi persists an entry only when a message or a tool result ends,
and writes nothing before the first assistant message completes, so one long tool call is silent on the file; the
process-tree signal covers that case. Not covered: a child whose very first model response takes longer than the
bound while the model is rate-limited, and a tool call that waits on a remote consuming no CPU; both are stopped as
idle, and that is the bound's meaning. On the Herdr executor, whose child is started by the daemon, the signals are
the session file and, when a progress display is attached, the pane text. `PI_DADDY_CHILD_TIMEOUT` keeps its semantics (seconds, inherited, zero or malformed selects the default) but
its default is six hours and its role is the ceiling for a child that never goes quiet, recorded as `deadlineAt`; the
inactivity bound is recorded as `idleTimeoutMs` on the starting and running lifecycle events, and a stop is recorded
with reason `idle-timeout` or `wall-clock`. Rejected: pi's `--mode json` event stream, because it would have moved the
child's answer into a JSON envelope and put every tool result under the output cap; the session file gives the same
signal with no change to the answer path and is also the substrate context handoff will fork from.

**ADR-0076 — five layers, one ledger, one state directory, one environment prefix, then context handoff.** The
source is `kernel/`, `governance/`, `executors/`, `advisors/`, `products/` with a test that fails on any upward
import; `extensions/`, `src/index.ts` and `src/cli.ts` are composition, allowed to import anything and forbidden to
be imported. Every append-only store shares one record envelope (`v`, `seq`, `prev`, `at`, `kind`, `id`, `body`,
`digest`) with one reader, a writer that refuses `LEDGER_DAMAGED` on a torn or tampered tail, and a repair command that
truncates only with explicit consent; project state lives under `.pi/pi-daddy/` with `settings.json` the only
committable file; environment names are `PI_DADDY_*` only, with the kernel exporting the closed list of governance
keys that the child-environment hook refuses to set; exports are collapsed and Prettier at width 120 plus a
statement-count guard replace the newline-count guard. Rejected: letting the feature pull the cleanup (this is the
process that produced the state being cleaned), a strangler copy of the kernel (two copies of one truth diverge,
which the register records happening three times), and keeping every public contract (would keep every store alive).
The advisors boundary is fixed here: types in `advisors/` carry no `Capability` and no refusal code, no kernel or
governance function accepts an advisor result, and an advisor may select, rank, annotate or propose but can never
widen `effective`, satisfy a gate or replace a human answer. The first advisor is Jev, TypeSafe's non-generative
decision model, reached through OpenRouter's `POST /api/alpha/decisions` for model `typesafe/jev-1.13`; it is default
off, toggled from the dashboard, usable at four decision points, degrades to "no advice" on a two-second timeout, and
every use is an `advice` record. ADR-0077 (advisors are advice: decision points, settings block, advice event,
privacy rule, and the package boundary) and ADR-0078 (context handoff as an attenuating dimension: `none`, `files`,
`pruned`, `summary`, `fork` under an inherited ceiling) are deferred to their own records and are not yet written.
The ADR's non-goal "no user-facing capability is deleted" was reversed by amendment for five lab features and is
reversed further by this cleanup; since the ADR file no longer exists, AGENTS.md is where that reversal must be
recorded. Revisit triggers: an exemption added to the import-direction test instead of a hook, a `Capability` field
or refusal code appearing in `advisors/`, the second fresh-session probe failing, or the programme exceeding twelve
pull requests before context handoff lands.

**ADR-0078 — context handoff is an attenuating dimension, not a parameter (2026-09-22).** Until this, a governed
child received two things: its definition body and one task string. That floor is deliberate — everything that can
influence a child should be something the grant names — and it is also why delegation here was cheaper to govern
than to use, since a parent had to restate in the task anything the child needed to know. So what crosses is a
capability. `context:<mode>` is a sixth namespace, intersected with the parent's grant and the definition's ceiling
like any other id, visible in `/grants`, present in the ledger's effective set, gateable, and impossible for a child
to widen. Rejected: a separate inherited bound of the shape depth and fan-out use, because ADR-0035 already refused
to add a propagation channel for routing and the argument holds twice as hard for a second one; and a frontmatter
field honoured at spawn, which would not attenuate at all.

The five modes are ordered `none < files < pruned < summary < fork`, and each subsumes every weaker one through the
same table that makes `tool:bash` subsume `tool:read`, so a parent holding `context:fork` may hand a child
`context:files` without holding that id separately. The order is by how much of the parent's session can cross:
`files` carries content the parent names, `pruned` carries turns a rule selected, `summary` carries whatever the
parent chose to write, `fork` carries everything the parent has seen. `summary` outranks `pruned` because a sentence
the parent composes is unbounded in what it may reveal, while a pruned selection is at least traceable to turns that
happened. A definition's `allowed-tools` declares the CEILING; the mode on a given call is the request, so a
definition permitting `fork` does not fork on every spawn, and a definition declaring no `context:` id receives
nothing. That check is in the planner rather than in `resolve`, because on the `agent` path the requested set IS
the ceiling: review measured the first version handing `context:fork` to a definition capped at `context:files`,
and `context:files` to one that named no context at all. A chain step asks for context the same way, and its gate
is raised in the upfront pass ADR-0033 requires, so a human answers for a fork step 3 wants before step 1 starts.
That pass deliberately does not stage anything: its plans are thrown away and remade when each step runs, so
staging there would read every step's files upfront and allocate a fork directory nothing would dispose.

**`context:fork` is gated by default**, beside `tool:bash` and for the neighbouring reason: it is the one mode that
can carry content an untrusted repository put in front of the parent into a fresh child, and prompt injection is in
scope (ADR-0012). The gate does not make that impossible; it makes it loud. What crosses is fenced with its own
delimiter, distinct from the chain handoff's, so a child can tell context from its parent apart from a prior step's
output and weigh them differently. One 32 KiB budget governs both channels, and what did not fit is said inside the
fence. Paths are confined to the session's working directory because they are model-supplied; that bounds the
parameter and is not a claim of containment, since the parent process can already read what its own grant allows.

`pruned` keeps the last N turns plus older turns naming one of the given files, and with an advisor enabled those
candidates are then judged one by one against the task the child is about to be given — narrowing only, never
adding. That rule is deterministic and
explainable, and its recall is **unmeasured**: whether it keeps what a reader would have kept is exactly what the
handoff probe is for, and `pruned` is not a default until that probe says so. The rule names itself in the ledger so
a later advisor can replace the selection without anything else changing. Also not established: any measurement of
what a forked child does differently from one given a summary.

Two interactions worth knowing, both found by review rather than by reasoning. pi refuses `--fork` beside
`--session` or `--no-session`, and PR 3e gives every child a session file for the inactivity deadline; a forked
child therefore gets `--fork` with `--session-dir` and `--session-id`, and the activity probe watches that
directory instead of a fixed path. And the Herdr executor stages a system prompt to a file because it refuses a
multi-line argument — it staged only the FIRST such flag, so the second one this change adds left a fence full of
newlines inline and every non-fork handoff failed on that executor after the gate had already been answered.

Path confinement resolves symlinks. Lexical resolution passed a link inside the working directory pointing
anywhere, which made `context:files` a general read primitive in any checkout containing one; and a path that is
not a regular file is refused outright, because a FIFO satisfies `stat` and then blocks the session forever with
no watchdog.

**ADR-0077 — an advisor is advice, and the boundary is structural (2026-09-22).** `src/advisors/` holds a `Decider`
that answers typed questions: `noul` (a boolean), `choice` (one of the options the caller already had) and `score`
(a level from the caller's own list), each with a probability. It may select, rank, annotate or propose. It can
never widen an `effective` set, satisfy a gate or replace a human's answer — and that is enforced rather than
promised: no type in the layer names a `Capability` or a refusal code, and no module in `kernel/` or `governance/`
imports it, both checked by `test/advisors.test.ts`. Nothing on a governance path can receive what an advisor
returns, so an advisor cannot become load-bearing by accident.

Every use is an `advice` record on the one ledger envelope, **including the uses that produced nothing**, because an
advisor that quietly stopped answering would otherwise look exactly like one nobody called. The record names the
purpose, the decider, the question keys, the answers and the duration. It does **not** contain the state the caller
composed: that can carry task text and file contents, the ledger has never stored a task (ADR-0021), and an advisor
must not become the way it starts.

Default off. **`PI_DADDY_ADVISOR=jev` plus `PI_DADDY_ADVISOR_KEY` is the only thing that turns one on**, and
0.34.0 got this wrong: it read the enable from `.pi/pi-daddy/settings.json`, which `grant-store.ts` is explicit
about — that file is writable by any child holding `tool:write`, so it is "the reviewable record of the decision,
not the thing the enforcer reads". A grant lives outside the workspace precisely so a child cannot widen the next
session's ceiling; an advisor switch a child could flip would make the operator's next session ship its own
description to a third party, which is the same self-defeating shape one step sideways. Corrected in 0.35.0: the
settings block may narrow — a model, a timeout, or `enabled: false` for one project — and can never switch one on.
Both the switch and the key are stripped from a child spawned by the PROCESS executor. A Herdr pane inherits the
daemon's environment (R-148), which `mergeChildEnv` never sees, so a daemon started from a shell exporting them
hands them to every pane child; that is named rather than claimed away, and closing it means stripping in the pane.
On the process path: review measured it reaching a child granted
`tool:bash` while the constant's own comment claimed it never did, because it had been added to the list the
`childEnv` hook may not write and not to the list `mergeChildEnv` strips. A credential is not something a child
inherits by being spawned. Malformed configuration disables the advisor and names the field, rule 8's shape: an
operator who mistypes must not get silence, and must not get a third party reading their session either. A caller
must behave identically under the null decider, which is why that is the default and why degradation is always "no
advice" — disabled, missing key, two-second timeout, transport error, or a response we do not recognise all return
the same nothing.

**What an advisor costs in egress, said once and plainly.** With one enabled, a delegation that leaves `thinking`
blank sends its task text to a third party, and a `pruned` context handoff sends the task plus up to twelve of the
operator's own session turns, two thousand characters each. That is the operator's conversation, not only the task,
and it is the reason an advisor is off by default and enabled only from the environment. Nothing of it is recorded:
the `advice` record names the decision, the question keys, the answers and the timing. `/grants` states which
advisor is in force and what it sends.

**Neither decision point is asked for a delegation the executor or the model preflight has already refused, and
the pruning one is asked only after a plan says the handoff survived the ceiling, the grant and the gate.** Review
measured the first version of pruning asking straight from the model-supplied request: a delegation the grant then
refused had already shipped a dozen session turns. `context:` is a capability precisely so a parent's session
cannot cross without a named grant, and asking first shipped it with no grant at all. **The effort point is weaker
and deliberately so:** it runs before the capability plan, so a delegation the grant goes on to refuse for
escalation has still sent its task text. Task text crosses on any `delegate` call that names no thinking level;
session turns cross only behind a granted `context:pruned`. That asymmetry is the one to hold in mind, and it is
why the egress paragraph above is written in terms of a call rather than a spawn.

**The first decision point (2026-09-22, roadmap PR 8): how hard a child should think.** When a `delegate` call
names no `thinking` level, the advisor is asked to choose one from the levels this session's own model reports it
supports. That is the shape the boundary was designed for: the options are not invented by the advisor, they are
what `supportedModelEfforts` already returns, so it picks among things the caller had. It touches no capability, no
gate and no grant — the worst an advisor can do is make a child think harder or less hard than a human would have,
and the ledger says it did. An explicit level is never second-guessed; advice fills a blank. With no advisor, no
key, no answer, a timeout or an unrecognised response, the blank stays blank and the child is spawned exactly as it
was before, which is the property that keeps advisors optional rather than load-bearing.

The task text IS sent to the advisor, because an advisor cannot judge a task it cannot see, and it is still never
recorded. An operator unwilling to send task text to a third party leaves the advisor off, which is the default.

Three guards, and the third came from review. The layer names no authority; no `kernel/` or `governance/` module
imports it; and the composition modules that may consult an advisor are an explicit list, because composition may
import both sides and is where decision points live. A rule of the form "advice and the gate may never meet in one
module" was tried and discarded — the delegation runner legitimately does both, and splitting it would buy nothing
— so what is checked instead is that the set of consulting modules is written down, and that the answers an advisor
gives are spent on `thinking` and on narrowing a `pruned` handoff's kept turns, and on nothing else.

**What the workspace settings file may and may not do.** It may switch an advisor off for one project, and shorten
its timeout. It may not enable one, choose its model, or lengthen its bound — a model is a destination and a longer
bound is not a narrowing, and this file is writable by any child holding `tool:write`. Review measured both holes
after the enable switch had already been moved for exactly that reason; the same argument had to be applied twice
more. Anything that is not exactly `true` on `enabled` disables, because the one control the file keeps must fail
closed like everything else. Key names are sanitised before they reach `/grants`, which is a trust surface a
child-writable file was able to forge lines in.

**Deliberate departure from the programme's sketch:** there is no dashboard toggle. The dashboard is a read-only
renderer that "never affects enforcement" (ADR-0036), and a control there writing to settings would be the first
thing it ever wrote. Turning an advisor on is an operator decision in the reviewable file.

**What is verified about Jev, and what is not.** The request shape is OpenRouter's documented one for
`POST /api/alpha/decisions`: `{model, state, questions}` with `noul` carrying `criteria.true`/`criteria.false`,
`choice` a map of option to description, and `score` an array of level descriptions; the model is
`typesafe/jev-1.13`. The RESPONSE is described there as an `answers` object beside `id`, `model`, `provider` and
`usage`, with probabilities and confidence mentioned and never shown, and the one public guide to this endpoint
states it has not run paid calls either. **No response shape here has been confirmed against a live call.** The
parser accepts what the documentation describes, tolerates the obvious variants, and treats anything else — including
a `choice` that was never offered or a `score` outside the levels — as no advice rather than a guess. A `score` is
read as a 0-based index into the documented `criteria` array and carries the level STRING beside the number, so a
caller never indexes it: the first draft accepted a 0-based and a 1-based reading at once, which meant the middle of
any scale was ambiguous and `levels[value]` could read "high" where the model meant "mid". That single reading is
itself an assumption the unrun live tier would settle; if Jev is 1-based, its top level falls outside the array and
the answer is refused as unrecognised, which is the loud failure rather than a silently shifted one. A dead endpoint
is recorded as `error` and an advisor with nothing to say as `declined`, because a revoked key must not read as an
opinion-free advisor forever; and the two-second bound is raced rather than merely signalled, since a decider that
ignores its abort would otherwise run as long as it liked and still be recorded as a timeout. Confirming it
is the `PI_DADDY_IT_JEV=1` tier, unrun. Until somebody runs it, this adapter's response handling is a reading of
documentation, not a measurement.

**Working rules that survive the deletion of the working-rules document.** Decisions, load-bearing claims and
failure modes are written down or they do not exist; reversals get a dated note, never a rewrite; measure before
asserting and say which you did, and state what the evidence does not cover; a test that cannot fail is worse than
none, so name the production change that would break it; prefer failing closed and being loud about it; "workflow
skills" are `.claude/skills/` and the governed runtime things are "tools" or "runtime skills"; `main` advances only by
merging a pull request, with the branch checked before the first edit (R-85), a review pass recorded in the PR for
anything touching behaviour, and the recovery for work found on `main` being a new branch at HEAD and a reset of the
local `main` pointer, never a force-push. The pre-commit branch guard was removed on 2026-09-22 at the operator's
request, and `main` has no branch protection or ruleset on GitHub (measured 2026-09-22: the protection endpoint
returns 404), so nothing mechanical prevents a direct push. The rule is kept by the operator, not by a control.

## Facts established by measurement

Each line names the probe directory that measured it; the probe text is gone, and the name is the pointer into git
history (`git show 9cf2904:docs/probes/<name>/README.md`).

*About pi:*

- pi persists one JSON line to the `--session` file per entry, synchronously, when a message or a tool result ENDS
  (`dist/core/agent-session.js` on `message_end`; `dist/core/session-manager.js` `_appendEntry`/`_persist`,
  `appendFileSync`). Nothing is written before the first assistant message completes (entries are buffered until then)
  and nothing is written while a tool is executing. Read from source 2026-09-22, not measured live. This is why the
  inactivity deadline also watches the child's process tree.

- `--tools` and `--no-tools` hard-enforce, including against tools an `-e`-loaded extension tries to add; this is the
  enforcement point and why no runtime is needed inside a descendant (`pi-fabric-eval`, probes 9–11; confirmed inside a
  Herdr pane by `g16-herdr`).
- A child holding `bash` can start an ungoverned pi descendant with the full default tool surface, no ledger line, no
  depth increment and no grant computed; `--tools` is bypassed, not defeated (`g5-bash-escape`).
- `bash` subsumes the file and search tools, so a grant of `read, bash` is not narrow; subsumption is modelled and
  reported per spawn (`g5-bash-escape`; ADR-0012).
- A model-controlled string must never occupy an argv position pi parses: an element beginning with `@` is read as a
  file and injected into the prompt before any tool exists, so a `--no-tools` child obeyed the instructions inside an
  arbitrary file; the task is passed with a leading space (`g1-argv`).
- pi has separate switches per resource class: `--no-extensions` does not disable skills or context files, so a child
  spawned with only `--tools read` loaded every operator skill and `CLAUDE.md` (`g16-herdr`, findings 4 and 5).
  `--skill` adds to the discovered set unless `--no-skills` is also passed (stated in the former SPEC and pinned by the spawn
  argv; no probe README itemises it).
- `--append-system-prompt` accepts a file path as readily as literal text, which is how a multi-line definition body
  reaches a Herdr child (`g16-herdr`, addendum finding 9).
- `--print` makes pi process one prompt and exit, so it is incompatible with `herdr agent start`, which waits for
  interactive readiness; the Herdr executor builds an interactive plan (`g16-herdr`, addendum finding 8).
- In non-interactive modes pi installs a no-op UI whose `confirm` resolves false, so a `--print` child can never be
  asked anything; approval is structurally a root-only, human-at-the-terminal act, and inheritance is the whole
  mechanism below the root (ADR-0010 facts from pi's source; the three scopes, three kinds of no, persistence and
  revocation were exercised live in `approval-ux`).
- `AgentToolResult` has no `isError` field; pi sets it only when `execute` throws, and a returned `isError: true` is
  silently discarded, so every refusal here is thrown (measured live and recorded in the archived session log and in
  the comment at the refusal site in `extensions/delegation.ts`; no probe directory).
- `pi.getAllTools()` is available to an extension immediately; the first-provider-request tool array is not, so the
  startup summary classifies against the inherited grant before the tool surface is observed (archived session log and
  risk register; no probe directory).
- pi's built-in tool list drifts between releases (`parallel` appeared unannounced); the pinned list is a modelling
  input for the catalog and never an authority, because `--tools` is (`g16-herdr`, finding 6).
- Node refuses to strip TypeScript types under `node_modules`, so library entry points must be compiled; pi's own
  loader reads extension TypeScript from `node_modules` fine (archived review 2026-08-10 finding B-I12 and ADR-0028;
  pinned by the smoke test; no probe directory).
- pi core has no native subagent tool, only a bundled example extension, and it ships `--fork`, `--session`,
  `ctx.fork()` and `ctx.compact()`, which context handoff builds on (ADR-0016 context and ADR-0076 survey; not a probe).

*About Herdr (the executor):*

- `herdr agent start … -- <args>` delivers argv verbatim, echoed back in the reply, and `--tools` is enforced inside a
  pane exactly as for a direct spawn; a pane is a terminal, not a runtime or a security boundary (`g16-herdr`).
- Herdr has no `--env`; the grant goes on the pane's environment, which the shell launching the agent inherits
  (`g16-herdr`, working run in the addendum). A pane child inherits the Herdr daemon's environment and only what the
  plan adds, unlike the process executor which strips inherited governance keys first (R-148, measured; no probe
  directory).
- `agent start` types argv into a shell and refuses any argument it cannot encode, so a multi-line definition body
  must be staged to a file and the path passed (`g16-herdr`, addendum finding 9).
- `agent wait --until idle` matches the state the agent was already in, so settling must wait for `working` first or
  require the state counter to advance past the value seen at prompt time (`g16-herdr`, finding 7).
- `herdr agent stop` does not exist: it prints the usage banner and exits zero, which a wrapper reading the exit code
  records as success; the only way to end a child is `herdr tab close <tab-id>`, and there is no way to stop an agent
  while keeping its pane (`g16-herdr`, falsification note 2026-08-17).
- Agent names must match `[a-z][a-z0-9_-]{0,31}`, so hierarchical child ids with dots are rejected and the executor
  rewrites them (`g16-herdr`, second finding 2026-08-17).
- A freshly created pane is not yet at a shell prompt (`agent_pane_busy`), so `agent start` is retried on exactly that
  condition until the deadline; `agent read` returns raw terminal text, not Herdr's JSON envelope (`g16-herdr`,
  addendum findings 10 and 11).
- Pane cleanup runs in a `finally` and so does not cover the process being killed between `tab create` and that block;
  a fan-out that dies mid-flight can leave panes behind (`g16-herdr`, addendum).

*About workspace routing and governed-writer leases:*

- A kernel-held `flock` lease refuses a second writer for the same canonical root, lets writers for distinct roots
  coexist, and on SIGTERM or SIGKILL of the parent the helper stops the attached writer before releasing, with the next
  acquisition recording recovery; a named check with hostile metacharacters stays one literal argv element
  (`g34-runtime-enforcement`). It establishes no filesystem confinement, no exclusion of unrelated writers, no
  network isolation and no portability beyond util-linux `flock` on Linux.
- The command `flock` execs inherits the lock file descriptor: killing the wrapper alone leaves the lock held, killing
  the command frees it, and `-o/--close` exists, so teardown must kill the whole holder group (`g35-flock-fd-inheritance`).
- Before ADR-0035 the workspace registry rode in the inherited environment and a child routed to `staging` could plan a
  grandchild for `prod` with no refusal and a real write lease (`g36-workspace-attenuation`). The same probe records
  the lesson that carried a wrong "measured": it constructed its own inputs with no catalog, so it confirmed the fix on
  a path production does not take while the real path refused every `workspace:` id as unknown.
- Routing attenuates by id, not by destination: a child holding `workspace:staging` and `tool:write` (no `bash`) can
  repoint the `staging` registry entry at the `prod` worktree and route its grandchild there with an exclusive write
  lease; file permissions cannot stop it because a governed child runs as the parent's uid (`g37-registry-tamper`;
  R-137 open, ADR-0042 decided, implementation deferred).
- An initial working directory, including an empty one, is not path confinement: an unsandboxed child holding search
  and `edit` tools left it and edited a file in another checkout by absolute path, unprompted (`g38-cwd-is-not-containment`).

*About `pi-daddy init` and the approval flow:*

- `init` reads the installed package's own manifest under `node_modules`, copies declared definitions into the project
  skill root, and generates a grant whose `agent:` ids are the union of what can be spawned, written to be edited down;
  `/grants` previews through the same planner without starting a process (`b2-init-principal-pi-skills`).
- Inherited approvals must be resolved the same way on both spawn paths or one path applies them without recording
  them; a per-call gate builds a fresh empty queue, so single-flight needs a shared gate provider (`approval-ux`,
  resolution notes).

*About `@tintinweb/pi-subagents` (no longer a dependency, ADR-0016):*

- `SpawnOptions` has no `tools` field and the RPC is `ping`/`spawn`/`stop` with no configuration query, so an
  interceptor there can refuse or allow but never narrow (`g13-subagents-coupling`).
- `subagents:rpc:spawn` goes over the event bus straight to the manager, never produces a `tool_call`, and its children
  are in-process sharing one `process.env`; the tripwire cannot see it and nothing here can fix that (`g13-subagents-coupling`).

*About `pi-fabric` (evaluated, not installed):*

- `recursive: true` overrides `tools: []` and `extensions: false`, so recursion and containment are mutually exclusive
  there; `maxDepth` is a depth cliff, not attenuation (`pi-fabric-eval`).

*About the field (surveyed 2026-09-21, sources in ADR-0076):*

- No other surveyed harness enforces child ⊆ parent on the tool surface, and Claude Code's own documentation says a
  skill's `allowed-tools` does not restrict; every surveyed competitor offers a richer context channel than this
  package does today (ADR-0076 context; not a probe).

## Glossary

- **grant** — the set of capabilities a session holds, as `tool:<name>`, `agent:<name>`, `workspace:<id>` entries or `tool:*`; carried to children in the environment and only ever narrowed.
- **ceiling** — a definition's `allowed-tools` field; the most a child spawned from that definition may hold.
- **effective** — what a child actually receives: `(requested ∩ parentGrant ∩ ceiling) \ (gated \ approved)`.
- **gated** — a capability that needs a human's approval before a child may hold it; `tool:bash` by default, closed under subsumption.
- **attenuation** — the invariant that grant, depth, fan-out budget and approvals can only shrink going down a delegation tree (ADR-0008).
- **definition** — an Agent Skills `SKILL.md` file whose `allowed-tools` is the ceiling and whose body is the child's system prompt (ADR-0016, ADR-0017).
- **catalog** — the list of definitions and tools the current session can name, derived from pi's own tool surface and the discovered SKILL.md files.
- **ledger** — the append-only record of every capability decision and child lifecycle under `.pi/pi-daddy/`; each line is a record envelope; a damaged file is readable up to the damage and refuses appends until `pi-daddy ledger repair`.
- **record envelope** — the shared line shape of every append-only store: `v`, `seq`, `prev`, `at`, `kind`, `id`, `body`, `digest`; `contracts/ledger-record/v1/record.schema.json`; the activity timeline uses the same envelope with kind `activity`.
- **LEDGER_DAMAGED** — the refusal a writer raises when its ledger has a torn or tampered tail; cleared by `pi-daddy ledger repair --yes`; a pre-format file is imported (`pi-daddy ledger import`), never repaired.
- **refusal** — a thrown error with a stable code (`CAPABILITY_ESCALATION`, `GATED_UNAPPROVED`, `WORKSPACE_NOT_AUTHORIZED`, `CHILD_TIMED_OUT`, …); thrown rather than returned because pi discards a returned `isError`.
- **approval** — a human's answer to a gate: once, for the session, or "always" for a bounded period for a named definition; keyed `capability@subject`; the task text is never stored (ADR-0010, ADR-0014, ADR-0021).
- **approval banking** — recording a dialog's answer so later steps or sessions with the same `capability@subject` do not re-ask; a `once` answer is never banked.
- **correlation** — caller-supplied metadata (schema version, an assurance scope, external ids) recorded beside a decision and never used as authority.
- **executor** — the way a child process is started: directly as a `pi` process, or inside a Herdr pane; chosen by probing for a reachable Herdr server, never by a binary on PATH (ADR-0031).
- **Herdr** — the terminal agent host at herdr.dev used as an executor and as the dashboard's window; not required.
- **tripwire** — a `tool_call` hook that blocks known third-party spawn tools so an ungoverned spawn cannot happen silently.
- **workspace routing** — starting a child in a registered worktree named by `workspace:<id>`; the id is a capability that attenuates (ADR-0035).
- **workspace lease** — an exclusive writer lock on a routed workspace directory, a kernel `flock` held by a helper process; an exclusion mechanism among governed children, not shared memory and not confinement (ADR-0034, ADR-0035).
- **retention (execution retention)** — opt-in storage of a child's stdout, stderr and result bytes with a manifest.
- **content store** — the content-addressed blob directory `.pi/pi-daddy/content/` shared by retention and activity content, and later an artifact store.
- **activity timeline** — the local record of parent turns, child lifecycles and skill-file reads, on the record envelope beside the ledger.
- **dashboard** — the read-only projection of the ledger (`pi-daddy-dashboard`, `/grants dashboard` in a Herdr pane); a renderer in a separate process that never affects enforcement (ADR-0036).
- **chain** — `delegate_chain`: a straight line of steps planned as one unit, each step's task composed from the previous step's fenced output (ADR-0033).
- **handoff fence** — the nonce-delimited, labelled block a prior step's output crosses in; the nonce is generated after the producer has finished.
- **kernel, governance, executors, advisors, products** — the five source layers with a mechanically enforced import direction; `extensions/`, `src/index.ts` and `src/cli.ts` are composition (ADR-0076).
- **advisor / Decider / advice** — a non-generative classifier (`choice`, `score`, `noul`) whose output can select, rank, annotate or propose and can never widen a grant, satisfy a gate or replace a human answer; each use is an `advice` ledger record.
- **Jev** — TypeSafe's decision model (`typesafe/jev-1.13`), reached through OpenRouter's `POST /api/alpha/decisions`; the first advisor adapter; default off.
- **context handoff** — what a child receives beyond its definition body and task: `none`, `files`, `pruned`, `summary` or `fork`, each a `context:` capability that attenuates and is capped by the definition's ceiling (ADR-0078).
- **handoff fence (parent context)** — the `<<<PARENT-CONTEXT …>>>` block a granted handoff crosses in, distinct from the chain's `<<<PRIOR-AGENT-OUTPUT …>>>` so a child can weigh the two differently.
- **settings.json** — the one committable file under `.pi/pi-daddy/`, written by `pi-daddy init`, holding the grant, per-definition declarations, withheld capabilities, routable workspaces and the default gate.

## Roadmap

What remains of ADR-0076's sequence after this cleanup, one line each with what "done" means.

- **PR 3d-ii (work ledger and controller journals on the envelope)** — done by deletion in this cleanup: the work
  ledger and the private controller journals no longer exist, so the only append-only writers are the grants ledger
  and the activity timeline, both on `governance/record.ts` (verified 2026-09-22: no other writer appends to a
  `.jsonl` path).
- **PR 3e (inactivity deadline)** — done 2026-09-22 (0.32.0) on the session-file signal rather than JSON event mode;
  see the ADR-0038 paragraph. Not established: a live measurement that pi appends to the session file mid-run under a
  real model (source-read only), and live dashboard progress from that file, which is left for the context-handoff
  work that will read the same file.
- **PR 4 (skill-harness as optional peer; contracts pruned)** — done by deletion: the learning product and its
  harness bridge are gone and one contract remains (`contracts/ledger-record/v1`); verified 2026-09-22: `package.json`
  names no harness and `contracts/` holds that one directory.
- **PR 5 (SPEC as the layer map, now the README)** — done 2026-09-22: the README is the layer map, `docs-drift.test.ts`
  checks both documents against the code, and the first fresh-session probe shipped its change (see the probe record
  above). The drift guard checks what rots — paths, variables, refusal codes, verbs, scripts — rather than the hex
  pattern the entry first proposed, because a commit SHA attributing a measurement is required by the hard rules.
- **PR 6 (advisors layer)** — done 2026-09-22 as an in-repo layer, since the consumer that wanted a shared package
  is deleted. The `Decider` interface, the null decider, the Jev adapter, a settings block and `advice` records, with
  both boundary rules enforced by tests. No dashboard toggle, for the reason in ADR-0077. Not established: any live
  call to the Decisions endpoint, so the response parsing is documentation-read; and no decision point uses an
  advisor yet, which is PR 8.
- **PR 7 (context handoff)** — done 2026-09-22: all five modes, `context:` as an attenuating capability with
  `fork` gated, the parent-context fence, and `handoff` on the capability-decision record. `none` remains the
  default. Not established: the `pruned` rule's recall, and any behavioural comparison between a forked child and a
  summarised one; both are what PR 9's probe is for.
- **PR 8 (applying advisors at decision points)** — two slices done 2026-09-22: child effort, chosen from the
  levels the model reports, filling a blank the caller left; and `pruned` handoff selection, which may only narrow
  the set the mechanical rule already kept and is asked after the plan authorizes the handoff. Remaining
  candidates: chain output selection and completion/failure signals. Not established: whether the advice is any
  good — nothing measures that, and PR 9's probe is the only thing that would.
- **PR 9 (handoff probe)** — done 2026-09-22; see the probe section above. It measured recall over 78 real pi
  sessions, found that the byte budget was cutting the turns nearest the task, fixed the fill order and raised the
  default turn count on the strength of the numbers. **It answered the `pruned`-as-default question with a no**:
  0.874 delivered recall at best is not enough to start sending the operator's session by default. Precision was
  dropped as a metric rather than reported, because as defined it was always 1.00 and meant nothing. Still to do
  from this line: **a second fresh-session probe** shipping a delegate-path change without opening history, and
  a Jev comparison — nothing yet measures the advisor's selection against the mechanical rule.
- **Registry integrity (ADR-0042, decided, implementation deferred)** — routing must attenuate by destination, not
  only by id; done means `g37-registry-tamper`'s control stays green while its tamper case turns into a refusal.
- **Record the reversal** — done: see "The big cleanup" above.

## Known gaps / live risks

Kept features only. Numbers are dropped except the two that code and rules cite.

- `bash` escapes governance: a child holding it can start an ungoverned descendant, and containing that is the
  operating system's job (ADR-0012, `g5-bash-escape`); a grant containing `bash` reads narrow and is not.
- Workspace leases coordinate only cooperating pi-daddy children; they do not exclude the operator, an IDE, hooks or
  another runtime, and they do not confine paths — a child left an empty working directory and edited another checkout
  (`g38-cwd-is-not-containment`). Write leases require util-linux `flock` and refuse `WORKSPACE_LEASE_STALE` elsewhere.
- Routing attenuates by id, not by destination: a child holding a workspace id and `tool:write` can repoint the
  registry entry (`g37-registry-tamper`; ADR-0042 decided, not implemented).
- A gated routing attempt used to take the destination's exclusive writer lease before the human was asked; ADR-0041
  moved the approval before acquisition. The approval dialog itself still has no timeout.
- ~~A registry the reader refuses produces no message anywhere: one malformed id silently removes every workspace
  from `/grants`, the catalog and `init`.~~ **Closed 2026-09-22.** Verified first: `buildCatalog` caught with
  `() => []` and `registeredWorkspaceIds` with `catch { return [] }`, so the reason was discarded at both sites and
  no surface held it. Failing SOFT was right and is unchanged — a malformed registry must not stop a session
  starting, because nothing in the catalog is an authority — so what changed is that the reason now rides on
  `Catalog.registryRefusal`, `/grants` prints it under `routable`, and both `init` paths say it. Restoring either
  swallow fails `registry-refusal-is-loud.test.ts`.
- ~~The registry read deadline is forced by no test; deleting it leaves the suite green.~~ **Closed 2026-09-22,
  after review corrected the entry twice.** Measured at `7096f78`: replacing the `Date.now() > deadline` branch
  with `if (false)` left all 876 tests passing. That much was right, and the deadline is the ONLY guard that was
  unforced — the first write-up claimed the size and file-type checks were unforced too, and they were not:
  `workspace-capability.test.ts` already covered both. The reader's clock is now injectable so a test forces the
  deadline without a slow disk. Two further guards review found unforced are forced now as well: the deadline's
  POSITION (hoisting the check out of the chunk loop left 887 passing, and "between chunks" is the whole point of
  the shape), and `grew-while-reading`, the second half of the "bound checked twice" — deleting it turned an
  overrun into a silent truncation reported as success, which for a registry becomes a misleading "not valid
  JSON". `/proc/self/maps` forces it with no race. `O_NONBLOCK` was under-claimed rather than over-claimed: it is
  forced, by two tests.
- ~~Two session-start reads (a definition's `SKILL.md` and the registry) have no file-type check or bound; a FIFO at
  either path blocks the session forever and pins a libuv thread so a watchdog cannot fire.~~ **Corrected and
  closed 2026-09-22, and the bullet was half wrong.** The REGISTRY already had all of it — non-blocking open, an
  `fstat` on the held descriptor, a 1 MiB bound and a deadline — added when ADR-0035 moved that read to session
  start; this entry was stale. The `SKILL.md` read was the real one: `resolveSkillResources` filtered by
  `statSync(...).isFile()`, but the read that followed was `readFile` **by name**, which is the TOCTOU the
  registry's own comment block describes, and there was no size bound at all (measured at `7096f78`: an 8 MiB
  `SKILL.md` read whole in 8ms). It turned out there was a THIRD reader, in `skill-packages.ts`, feeding
  `planInit` — so bounding only the first two made `init` grant `agent:<name>` for a definition the runtime
  refused, whose only symptom was `unknown agent "x"` at delegation time. All three now go through one
  `readBoundedBytes`, and a test asserts `init` and the runtime agree.

  **The first write-up of this said `mkfifo` was unavailable here. That was wrong**, and it is worth recording
  because it is the same defect class as the ones above: an earlier probe died on an unrelated 40 MiB
  allocation and the environment got the blame. `mkfifo` works, the suite already created FIFOs elsewhere, and
  the FIFO case is now measured directly — dropping `O_NONBLOCK` fails the suite.

  **Still open, recorded rather than fixed:** a definitions-discovery failure suppresses the registry refusal.
  `loadDefinitions` can throw (a malformed settings file), and `buildCatalog` calls it, so on that path the
  catalog never exists and its `registryRefusal` never reaches the banner. Two independent faults collapse into
  one message naming only the definitions. Fixing it means changing the catalog's error model, which is a
  larger change than this one and does not belong bolted onto it.
- The Herdr executor passes only the plan's environment to the pane, so a pane child receives neither the workspace
  registry nor the lease directory, and the pane inherits the daemon's environment rather than a stripped one.
- A relative inherited ledger path resolves inside a routed child's worktree, splitting state and leaving `?? .pi/` in
  `git status`; a `read` lease takes no kernel lock, so a grandchild can take a write lease on a root already held.
- Pane cleanup is not leak-proof: a killed process orphans one pane per in-flight child, and on process exit the pane
  reaper and the lock helper race to close the same tab.
- The lease helper signals a recorded pid with no start-time identity check; in a narrow window it may signal a
  recycled pid. Accepted, bounded by the parent's uid.
- One `session` yes on the model-chosen `tools:` path (fixed subject `<delegate>`) pre-authorises the whole subtree
  with no further dialog. Open by decision.
- A child can never be asked anything: it runs `--print`, so a gate it hits is satisfied by an inherited approval or
  refused.
- Persisted approvals are validated against a session-start snapshot of definitions, so "void the moment either
  changes" means "void at the next session start"; a definition edited mid-fan-out produces siblings that disagree;
  a session started in a subdirectory is a different project with its own store.
- A definition's instructions are ungoverned: the operator authorises a file, the ledger identifies which body ran by
  digest and cannot recover what was lost if it changed.
- A definition copied by `init` does not track the package it came from (`npm update` changes `node_modules`, not the
  committed copy; `init --force` is the only re-sync); `init` writes into a pi skill root, so the operator's own
  session loads the copied bodies as skills while children are protected by `--no-skills`; `.pi/skills/` shadows the
  global skill directory.
- The startup spawnable count is an upper bound classified before the tool surface is observed; it over-reports and
  authorises nothing.
- ~~An `allowed-tools` entry that already carries a namespace prefix is prefixed again, and the refusal names the
  mangled id rather than the mistake.~~ **Closed 2026-09-22.** Two corrections came with the fix. First, this bullet
  said `tool:read` doubles; measured at `5bccb76`, it does not — a lower-case prefix passes through, and the doubling
  needs a capitalised one, because the prefix test is case-sensitive: `Tool:Read` becomes `tool:tool:read` and
  `Workspace:prod` becomes `tool:workspace:prod`. That matters more than the original claim, because the README's own
  example writes `allowed-tools: Read, Grep` in the capitalised style the standard uses. Second, the surface is not
  the one the bullet implied: `isSafeCapability` rejects the extra colon at discovery, so the definition is refused by
  `pi-daddy init` and never reaches a spawn refusal or a caution. `explainDoubledNamespace` now names the mistake in
  both the `init` refusal and the `UNKNOWN_TOOL` hint. Not established: whether the suggestion is right for a
  workspace or definition id whose own capitalisation matters, because the bare-entry path folds it before anything
  can see it; the message says so rather than implying the suggestion can be copied verbatim.
- The pinned built-in tool list is an observation of one pi release; drift misfiles a capability in the catalog and
  cannot grant one.
- The default project ledger under `.pi/pi-daddy/` makes repository writability a delegation precondition after
  `init`; an unwritable ledger refuses the spawn loudly rather than running unrecorded. Accepted.
- The ledger writer and repair command inspect only the tail: a mid-file tamper is detected by the reader on full
  replay, not by the writer, and the repair preview warns when dropped lines still parse.
- Imported pre-format ledger bodies are kept verbatim with source markers; their lifecycle rows cannot be joined into
  unique occurrences without fabricating facts.
- The dashboard rereads and reprojects the whole file on every poll; it flips to incremental replay only when the
  ledger grows large or projection time climbs.
- A task digest is a privacy identifier, not anonymisation: a short task can be guessed from a dictionary and equality
  across runs is visible. Correlation metadata is never authority; any authorisation branch reading it is a defect.
- `subagents:rpc:spawn` bypasses the tripwire and cannot be caught from here.
- The first advisor rides an endpoint OpenRouter marks alpha and a model with almost no published calibration;
  advisors stay default off and degrade to "no advice" on timeout, and `pruned` handoff cannot become a default before
  the handoff probe measures it.
- The load-bearing `allowed-tools` field is marked experimental in the Agent Skills specification and its reference
  implementation says it does not restrict; a rename upstream leaves every ceiling undeclared, which already refuses to
  spawn rather than widening.
- **R-60** — every `await` inside `session_start` needs its own `try`: one rethrown read error under the blanket
  catch silenced every session-start notification, including the line that shows governance is on at all.
- **R-85** — work reaches `main` by drift, not decision: check the branch before the first edit of a task, and if work
  is already on `main`, branch at HEAD and reset the local pointer rather than rewriting history.
