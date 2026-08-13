# pi-daddy — what it is, precisely

**The current-state document.** No history, no reasoning about alternatives, no record of how anything came
to be decided. Where this disagrees with an ADR, the ADR is right and this file is stale — say so.

Last synced against the code: **2026-08-13**, `pi-agent-grants` 0.10.0, pi 0.84.1, herdr 0.7.5.

---

## The claim

**A sub-agent can never hold more capability than its parent, and a governed spawn is always recorded.**

The grant shrinks monotonically down a delegation tree. Enforcement is **pi's own `--tools` allowlist** in a
separate OS process — not a policy engine, not an LLM, and nothing this package runs inside the child.

```
effective = ( requested ∩ parentGrant ∩ ceiling ) \ (gated \ approved)
```

Escalation is impossible by construction. The root holds the catalog; every level below can only subtract.

## What it governs, and what it does not

**Governs: the tool surface** — which tools pi exposes to a model. Structural, not advisory. A child granted
`read` has no write tool and no prompt can talk it into one.

**Does not govern: an agent holding an execution primitive.** A child granted `bash` can run
`env -u PI_GRANTS_GRANT pi …` and get a wholly ungoverned descendant — no grant, no depth increment, no
ledger line. Measured (`docs/probes/g5-bash-escape`). Containing that is the OS's job and is out of scope.

So `bash` is **gated by default in a governed session** — a human is asked before any child receives it —
and gating is closed under subsumption: gating `write` also gates `bash`, because `bash` can write. Neither
makes the escape impossible; both stop it happening silently, which is what matters when the realistic
threat is a confused or prompt-injected agent rather than a determined one.

**Also not a boundary:** a herdr pane. It is a terminal, and it is attachable by design, so a *human* can
type into a governed child.

## Definitions are Agent Skills

A spawnable agent is a **`SKILL.md`** file — the open [Agent Skills](https://agentskills.io/specification)
standard, read by 16+ tools. Its `allowed-tools` field is the grant; its body is the child's system prompt.

```yaml
---
name: review-security
description: Reviews a diff for authn/authz, injection and secrets handling.
allowed-tools: Read, Grep
---
Review ONLY the diff you are given, for security. Report findings; never edit.
```

Discovered from `<cwd>/.pi/skills/` and `~/.pi/agent/skills/`, project first. Identity comes from the
**directory name**, never the frontmatter `name` — the spec requires them to match, so a mismatch is the
file's defect.

**The spec calls `allowed-tools` "pre-approved" and marks it experimental: it declares intent and blocks
nothing.** Passed through `--tools` it becomes enforced. That is this package's contribution — *the standard
declares intent; pi-daddy makes it structural.*

Three rules, and each fails in the safe direction:

| Case | Result |
|---|---|
| The session does not hold `agent:<name>` | **Refused before the file is even read**, naming the missing capability and listing the definitions it *may* spawn. `tool:*` satisfies any of them, so an ungoverned session is unaffected. |
| `allowed-tools` **absent** | **Not spawnable.** Undeclared is the weakest state, never the strongest. |
| `allowed-tools:` present but empty | Spawnable with **zero** tools — deliberately distinct from absent. |
| A sub-tool pattern, e.g. `Bash(git:*)` | **Refused, naming the pattern.** `--tools` matches whole names only; granting bare `bash` would widen the declaration and dropping it would silently narrow. |
| An unknown definition name | **Refused, listing what exists.** There is no fallback. |

**Spawning a definition requires holding `agent:<name>`** (ADR-0017), so *which* definitions may run here is
an operator decision, expressed in the grant like any other capability — and refused as a **denial**, so the
attempt reaches the escalation signal. It attenuates like everything else: a definition's own `allowed-tools`
may list `agent:other`, which is how a delegator is told which definitions **it** may spawn, and a parent can
never hand down one it does not hold. The id authorises; it is never passed to `--tools`.

Capability ids are `tool:<name>`, `ext:<pkg>/<tool>`, `skill:<name>` and `agent:<name>`. Only the first two
name tools, and **only those two are filtered against a session's observed tool surface** — an observation
says nothing about a namespace that is not tools.

Anything pi-daddy needs beyond the standard goes under the spec's `metadata:` map with `pi-daddy-` keys —
never as invented top-level frontmatter, so the file stays valid for every other tool that reads it.

## The two tools

**`delegate({ agent, task })`** — one child, blocking. `agent` names a definition; `tools` is a fallback for
when no definition fits, and it lets the *model* choose the capability set (still bounded by the session
grant, but reviewed by nobody).

**`delegate_all({ children: [...] })`** — several children **concurrently**, returning when the last
finishes. Each is planned, gated, audited and bounded by identical rules; each is a separate process with no
shared context and no knowledge of its siblings. Every child's outcome is reported, including failures — the
call throws only if *all* of them fail.

There is deliberately **no background mode, no result-by-id and no child registry.** Because the turn still
owns the children: the parent cannot exit first, the tool-call signal stays live, the timeout outlives every
child, results are returned rather than stored, and no ids dangle across a compaction.

Both tools are registered **only** when the session holds `tool:delegate`. Withhold it and the session is a
leaf.

## Bounds

| Bound | Variable | Default | Behaviour |
|---|---|---|---|
| Depth | `PI_GRANTS_MAX_DEPTH` | `2` | `0` disables spawning. Malformed ⇒ `0` plus a startup warning. |
| **Cardinality** | `PI_GRANTS_FANOUT` | `8` | **Subtree budget**: total descendants this session may create. Spawning spends from it before the remainder is divided among children, so a subtree can never exceed what its root held. Malformed or `0` ⇒ the default. |
| Blast radius | — | `8` | Maximum children in a single call. |
| Wall clock | `PI_GRANTS_CHILD_TIMEOUT` | `600`s | Per child. SIGTERM then SIGKILL. |
| Output | — | 1 MiB | Per child; beyond it the child is killed and the result flagged truncated. |

Depth and budget **attenuate downward** through the environment; the timeout is an operator preference and
deliberately just inherits.

A budget rather than a per-call cap because a cap of K with depth D still permits K^D — the same exponential
wearing a smaller number. Subtractive bounds compose across process boundaries with no shared state.

## What a child is given

`planSpawn` emits exactly:

```
pi --print --no-session --no-extensions --no-skills --no-context-files --no-prompt-templates \
   [--skill <path>]… [--append-system-prompt <text|file>] \
   --tools <allowlist> | --no-tools \
   " <task>"
```

Every negative flag is load-bearing and each was added because its absence leaked something:

- `--no-extensions` — ambient extensions cannot widen the child.
- `--no-skills` **unconditionally**, then `--skill` per *granted* skill. `--skill` without `--no-skills`
  would *add* to the discovered set rather than replace it — an allowlist that widens.
- `--no-context-files` — `CLAUDE.md` is model-directing text no capability describes. Opt back in
  explicitly if you want project conventions inherited.
- `--no-prompt-templates` — same class, lower risk.
- **The task is the final argv element, prefixed with one space.** pi dispatches `@file` and `-flag` on the
  *first character* of an argv element, and `@file` is read before any tool exists, so `--tools` cannot stop
  it. The space is applied unconditionally so the guarantee is positional rather than a pattern match
  against pi's current parser.

Each child gets its **own `env` object** — governance variables are stripped from the inherited environment
and re-supplied only by the plan, so a value the plan does not set cannot survive from the parent.

## Approvals

A gated capability requires a human yes before it reaches a child. Scopes: `once`, `session`, and — **only
for `delegate({agent})`** — `always` (30 days, stored outside the workspace).

**What a yes is *about* differs by call form, and that is what decides which scopes are offered.**
`delegate({agent: X})` is approved against **`X` itself**: an operator-authored file the session must hold
`agent:X` to name at all, so the prompt reads *"approve tool:bash for deploy?"* and `always` is available.
`delegate({tools: […]})` is approved against the constant `<delegate>` and is offered only `once` and
`session`, because there the only things naming the child are the task and the tool list — both
model-chosen, and a key the model controls is not a key.

A persisted approval is pinned to **both** the definition's `allowed-tools` *and* its body digest, so it is
void the moment either changes: adding a tool voids it (`type-changed`), and so does rewriting the
instructions while leaving the tools alone (`instructions-changed`). An entry carrying no body pin is
treated as changed rather than assumed unchanged.

Concurrent callers share **one dialog** per `capability@subject`, but only share the *answer* when it was
about more than one spawn. `session`, `always`, a decline and an error answer everyone; **a `once` is
consumed by exactly one caller** and the rest are asked their own question. Without that, one *Allow once*
authorised every concurrent child while the human had seen only the first task.

An approval never crosses a delegation boundary: `once` is dropped on inheritance, and what does cross is
clamped to the child's own grant, so `approved ⊆ grant` holds at every level.

## The ledger

Append-only JSONL at `PI_GRANTS_LEDGER`. One record per governed decision — **including refusals**, which
are the interesting ones.

Ids are hierarchical and derived: a child of `d0` is `d0.1`, its own second child `d0.1.2`. Ancestry reads
from the id alone with no join, and it is reproducible, so two runs of the same fan-out produce a diffable
ledger. `denied` non-empty is the one designated escalation signal.

**Setting `PI_GRANTS_LEDGER` makes the ledger load-bearing:** a write failure fails the delegation closed,
because a child running with granted capabilities and no audit line is the thing the ledger exists to
prevent. Concurrent appends are serialised by a lock file with a short timeout — failing closed beats
hanging — and a lock abandoned by a killed process is broken after 10s.

`/grants ledger` reads it back and reports record count, escalation attempts, and unparseable lines with
line numbers. A corrupt line is **reported, never repaired**: it is the only artifact an investigation has.
Nothing verifies automatically.

**Privacy is a property of this file, and the boundary is exact.** Capability ids, counts and identifiers
only — *never prompts, tool arguments or results.* A spawn that names a definition records a
`definitionDigest` of `{name, source, sha256}` over the body (ADR-0018): an **identifier** for
operator-authored text already committed to a repository, which names a version without reproducing it.
**The task is never recorded**, in any field — it is assembled by the model from the parent's context and
could carry anything the parent could see.

So the ledger answers *"did these four children run the same instructions?"* (compare digests) and *"has
this definition changed since?"* (rehash the file). It does **not** answer *what the instructions said* —
if the file is gone or altered, the digest proves the loss rather than recovering the text — and matching
digests say nothing about whether the child behaved as intended. It identifies text; it does not evaluate
it.

## Executors

Same plan, two places to run it:

- **`runChild`** (default) — a captured child process. Needs nothing installed.
- **`runHerdrPane`** (`PI_GRANTS_HERDR=1`) — a visible, attachable [herdr](https://herdr.dev) pane. We build
  the argv, so the model never touches it. herdr owns the pane lifecycle, so this package needs no child
  registry.

Opt-in, never auto-detected from `herdr` being on `PATH`: where a governed child executes is an operator
decision, not a consequence of what happens to be installed.

herdr specifics, all measured (`docs/probes/g16-herdr`): the grant goes on the **pane** (`agent start` has
no `--env`, but a pane's environment reaches the shell that launches the agent); a multi-line system prompt
is staged to a temp file because `agent start` types argv into a shell and rejects what it cannot encode;
`--print` is incompatible with an interactive agent; a fresh pane is not yet at a shell prompt, so
`agent start` is retried while it comes up; and settling requires a terminal status **and** an advanced
`state_change_seq`, because `agent wait --until idle` matches the state the agent was already in.

## The tripwire

The `tool_call` hook refuses third-party spawn tools (`Agent`, `subagent`, `spawn_agent`) in a governed
session, and records the refusal. Such a spawn would create a descendant this package did not provision,
does not bound, and does not record.

**It is not complete and does not claim to be:** `subagents:rpc:spawn` reaches `manager.spawn()` over the
event bus and never produces a `tool_call`, so a tool-name check cannot see it. It catches the ordinary case
loudly.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PI_GRANTS_GRANT` | unset ⇒ **ungoverned** | Presence switches governance on. An ungoverned session publishes no governance variables at all, so "inactive" cannot quietly govern descendants. |
| `PI_GRANTS_MAX_DEPTH` / `PI_GRANTS_DEPTH` | `2` / `0` | Depth is set by the parent, not by hand. |
| `PI_GRANTS_GATED` | `tool:bash` when governed | `""` gates nothing. Closed under subsumption. |
| `PI_GRANTS_APPROVED` | unset | `capability@subject` pairs, inherited and clamped. |
| `PI_GRANTS_FANOUT` | `8` | Subtree budget. |
| `PI_GRANTS_PARENT_ID` | `d0` | Ledger identity; set by the parent. |
| `PI_GRANTS_LEDGER` | unset ⇒ not recording | Setting it makes it load-bearing. |
| `PI_GRANTS_CHILD_TIMEOUT` | `600` | Seconds. Inherited. |
| `PI_GRANTS_HERDR` / `_WORKSPACE` / `_KEEP_PANE` | unset | herdr executor. |

**Malformed configuration disables spawning rather than falling back**, and says which variable it was — a
bound a typo can switch off is not a bound.

## Verifying it

```bash
cd packages/pi-agent-grants
npm test                  # 250 unit tests — pure, no pi, no network
npm run typecheck          # src + extensions + test + test-integration
npm run test:integration   # 9 tests against a REAL pi process, no model tokens
npm run test:smoke         # pack, install into a scratch project, import and USE every subpath
```

## Known gaps

Stated because a gap nobody wrote down is the one that surprises somebody.

- **`bash` escapes governance.** Out of scope by decision (ADR-0012).
- **`subagents:rpc:spawn` bypasses the tripwire.** Unfixable from here.
- **Nothing verifies the ledger automatically.** Detection exists; a scheduled check does not.
- **Pane cleanup is not leak-proof.** Cleanup runs in a `finally`, which covers thrown errors but not the
  process being killed. There is no reaper.
- **A definition's *instructions* are still ungoverned.** ADR-0017 closed the authorisation half of R-35
  (`agent:<name>` is required to spawn one) and ADR-0018 the audit half as far as it goes (the record
  identifies which body ran). What no capability model reaches: the operator authorises a **file**, and what
  that file says is their responsibility. Nothing reads a body and judges it, and the ledger identifies the
  text without preserving it — if the definition changed, the digest proves the change and cannot recover
  what was lost.
- **A child can never be asked anything.** It runs `--print` with no UI, so a gate it hits has only two
  outcomes: satisfied by an inherited approval, or refused. Persistence helps the human session across
  restarts; below the root, inheritance is the whole mechanism.
- **An `allowed-tools` entry written as `tool:read` becomes `tool:tool:read`.** Only `ext:`, `skill:` and
  `agent:` are passed through as written; everything else is lowercased and prefixed. The catalog then
  refuses it as unknown, so it fails loudly rather than granting anything — but the message names the
  mangled id, not the mistake. Bare names (`Read`, `Grep`) are the documented form.
- **`PI_BUILTIN_TOOLS` is a pinned observation** of pi 0.84.1. Drift misfiles a capability in the catalog;
  it cannot grant one, because `--tools` is the authority.
