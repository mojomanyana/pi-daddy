# ADR-0013: The interceptor's model of a child does not match what `pi-subagents` builds

**Date:** 2026-08-10
**Status:** **Accepted 2026-08-10 — govern `pi-subagents` properly (Option 1), which the evidence then
showed requires an upstream change.** Option 4 pursued in parallel; the local half is a faithful port.
**Driver:** Review group **G2** (findings B-C2, B-C3, B-C4, B-C11, A-C2, A-S9). Undermines part of
`propagation.ts`'s race-freedom argument and therefore the **R-26** fix it records.

## Context

The interceptor decides whether a spawn is permissible by computing a **ceiling** from an agent type's
frontmatter and comparing it to the delegator's grant. Six findings say that computation describes
something other than the child `@tintinweb/pi-subagents` actually constructs.

### 1. Children are in-process — the reviews disagreed, and this was settled by reading the source

`child_process` appears in exactly one file of `@tintinweb/pi-subagents@0.14.3` (`worktree.ts`, for git).
Children on the interceptor path are `AgentSession` objects built **in the same Node process**.

Review A's security reviewer concluded no propagation race was constructible; Review B said the opposite.
**Both were partly right**, which is why they diverged: `delegate` genuinely spawns a subprocess and gets
its own `env` object, so A's analysis holds *there*. The interceptor path has **no process boundary**, so
`publishChildEnv`'s writes to `process.env` are global to every sibling and descendant.

This is the single most consequential item: `propagation.ts` documents at length why publishing only
parent-level facts makes concurrent spawning safe. That argument assumes a boundary which exists on one
path only.

### 2. The ceiling omits most of what a child receives

`tools:` frontmatter is an allowlist for **tools**. Extensions and skills load independently of it, so the
computed ceiling is not the child's authority. Related, and confirmed separately:

- **`skill:` and `agent:` capabilities enforce nothing** (A-S8). Skills are injected into the system
  prompt, not passed as tools, so `--tools` cannot gate them, and `spawn.ts` passes neither `--no-skills`
  nor `--no-context-files`. **Nothing anywhere reads an `agent:` capability.** They are labels.
- **The interceptor governs three hardcoded tool names** (A-S9) — `Agent`, `subagent`, `spawn_agent`. Any
  other spawn-capable tool is invisible to it, including `fabric_exec`.

### 3. The frontmatter parser disagrees with pi's own YAML parser

`agent-types.ts` is deliberately "not a YAML parser". A block-list `tools:` reads as **absent** here —
therefore the wildcard ceiling — while pi reads `["read","grep"]`. Found by Review A only, and verified.

With a wildcard delegator the spawn is **allowed** and the ledger records `effective: ["tool:*"]` while
the child is actually restricted to two tools. **The audit record is wrong in the permissive direction**,
which is the direction that matters.

### 4. Identity is keyed differently at each end (TOCTOU)

Grants caches definitions at `session_start` and trusts the frontmatter `name`. `pi-subagents` keys by
**filename** and reloads before execution. A definition validated as safe can be replaced before the spawn
it authorised.

### 5. Scheduled `Agent` calls have no `tool_call` at all

Approved once at creation; later executions run through the scheduler, so the interceptor never sees them.

**Assumption load:** none unvalidated — all six are read from source or measured. **A-16** (`--tools`
hard-enforces) is unaffected and remains the enforcement point; this ADR is about *what the interceptor
believes it is enforcing on*.

## Options considered

### Option 1 — Resolve the authoritative config from the same snapshot the spawner uses

Stop parsing frontmatter independently. Read the child's real, resolved configuration immediately before
execution, from `pi-subagents`' own loader, and decide on that.

- **Buys:** closes 3 and 4 at the root and shrinks 2, because the ceiling would come from the same source
  of truth rather than a reimplementation of it. Removes a whole class of "our parser disagrees" bugs.
- **Costs:** couples this package to `pi-subagents` internals, which are not a published API and can
  change without notice — the coupling this package was designed to avoid.
- **Forecloses:** nothing, but makes upgrades of that package a compatibility risk.

### Option 2 — Replace env propagation with per-session state

Keep a session-keyed map inside the extension instead of writing to `process.env`, so in-process siblings
cannot read each other's values.

- **Buys:** closes 1 properly on the interceptor path and makes `propagation.ts`'s claim true rather than
  conditional.
- **Costs:** needs a reliable session identity for in-process children — which finding 4 says the package
  does not currently have. **So Option 2 depends on Option 1**, or on some other stable identity.
- **Forecloses:** nothing.

### Option 3 — Narrow the claim: govern `delegate`, downgrade the interceptor to advisory

State that provisioning-grade governance is `delegate` only. Keep the interceptor as a best-effort guard
that blocks obvious escalation and records what it saw, explicitly not a security boundary.

- **Buys:** honesty at zero engineering cost, and it matches the evidence: `delegate` owns the whole
  pipeline (it builds argv, sets `--tools`, owns the env, spawns the process), while the interceptor
  inspects someone else's construction through a keyhole. Findings 1–5 are all consequences of that.
- **Costs:** abandons governing `pi-subagents` agent types, which is the integration most users already
  have. The package becomes useful only to those who adopt `delegate`.
- **Forecloses:** nothing — the interceptor can be re-promoted if `pi-subagents` gains a `tools`
  parameter, which is separately tracked as the change that would make it a provisioning path.

### Option 4 — Upstream a `tools` parameter on `pi-subagents`' `Agent` tool, and wait

Already recorded as an open decision elsewhere: it is the change that turns the interceptor from
enforce-only into provisioning.

- **Buys:** would make Options 1 and 2 largely unnecessary, because the parent would state the child's
  tools rather than inferring them.
- **Costs:** not in this project's control, and the six findings stay live meanwhile.
- **Forecloses:** nothing.

## Decision

**Option 1 — govern `pi-subagents` properly — taken 2026-08-10, with Option 4 in parallel.**

Option 3 (downgrade the interceptor to advisory) was recommended above and was **not** taken. The evidence
that decided it: `Agent` has been called **25 times across 85 sessions, most recently the same day**, while
`delegate` has been called **zero times outside probes**. The interceptor governs the mechanism actually in
use; `delegate` governs one that is not. Downgrading the claim on the path that carries the real traffic
would have been honest about the wrong thing.

### A goal this decision does not meet, recorded plainly

The stated aim was *"fresh context and a new process for sub-tasks"*. Those are separable, and
`pi-subagents` provides only the first:

| | Fresh context | New OS process |
| :--- | :--- | :--- |
| `pi-subagents` `Agent` | yes — a new in-process `AgentSession` | **no** |
| this package's `delegate` | yes | **yes** — a real `spawn("pi", …)` |

**No amount of work on the interceptor will produce process isolation**, because pi-subagents creates
in-process `AgentRecord`s by construction. This decision was taken with that understood. `delegate` remains
available and is the only path that provides it.

### What the evidence changed about Option 1's cost

The option above described the cost as "couples to `pi-subagents` internals". **That understated it.**
Measured against 0.14.3 (`docs/probes/g13-subagents-coupling`):

- **The live registry cannot be read by importing it.** pi loads `./src/index.ts` and the registry is
  module-level state in the same process, so an `import()` of that path ought to hit Node's module cache.
  It returns a **different instance**: `getAvailableTypes()` gave `[]` in a session where pi-subagents was
  demonstrably loaded.
- **`getToolNamesForType` is unusable as an authority lookup.** Unknown names fall back to
  `general-purpose`, whose `builtinToolNames` is omitted and therefore means *all available tools*. Every
  type queried returned the full builtin list. **A layer trusting it would grant everything to a typo** —
  the same permissive-direction failure as finding 3.
- **The supported RPC cannot answer the question.** `ping` / `spawn` / `stop` only, at
  `PROTOCOL_VERSION = 2`. No config query.
- **Nothing accepts a tool override.** `SpawnOptions` has no `tools` field, so neither the `Agent` tool nor
  the RPC can narrow a child. **Refuse or allow remains the ceiling on any local fix.**

### Finding 6, new, found while establishing the above

**`subagents:rpc:spawn` bypasses the interceptor entirely.** It travels the event bus to `manager.spawn()`
and never produces a `tool_call`, so this package's hook — its whole enforcement point on that path — never
observes it. Any other loaded extension can spawn an ungoverned sub-agent.

This is broader than finding A-S9. Adding names to `SPAWN_TOOLS` cannot catch it, because there is no tool
call to catch.

### So the decision has two halves

1. **Upstream (Option 4), now the critical path.** A `tools` parameter on `Agent` and `SpawnOptions`, or an
   RPC method reporting a type's resolved config. Drafted as
   `docs/proposals/pi-subagents-tools-parameter.md`, **for the user to file under their own name** — it is
   their project relationship, not this package's.
2. **Locally, meanwhile: a faithful port of the resolution rules.** Replace the naive frontmatter reader
   with `pi-subagents`' actual logic — `DEFAULT_AGENTS`, `loadCustomAgents`, and the `general-purpose`
   fallback — so ceilings and ledger entries stop being wrong. It still cannot provision, and it must be
   kept in step with upstream releases; that maintenance burden is accepted knowingly, because the
   alternative is a ledger that is wrong in the permissive direction.

Two things are fixed regardless, because they are wrong under every option:

1. **Stop advertising `skill:` and `agent:` as enforceable.** Nothing reads `agent:`, and `--tools` cannot
   gate a skill. Either pass `--no-skills`/`--no-context-files` and make `skill:` mean something, or
   remove the namespaces. A capability that enforces nothing is worse than an absent one, because it reads
   as a control.
2. **Record the parser disagreement in the ledger.** While a hand-rolled parser survives, a type whose
   `tools:` key it cannot read should be recorded as unread rather than as a wildcard ceiling — the
   audit record must not be more permissive than reality.

## Consequences

**If the recommendation is taken:**

- The README's interceptor section becomes "best-effort guard and audit", not "the security property".
- `docs/specs/2026-08-09-capability-governance-design.md` needs its interceptor sections revisited.
- The upstream proposal stops being a nice-to-have and becomes the path back to a governed
  `pi-subagents`.

**While unresolved:**

- `propagation.ts`'s race-freedom argument, and the **R-26** fix, hold only on the `delegate` path. The
  documentation states them unconditionally.
- A ledger entry for an interceptor spawn can be more permissive than what the child received.
- Scheduled agent executions are ungoverned entirely.

## Revisit trigger

- `pi-subagents` gains a `tools` parameter → Option 4 lands, most of this dissolves.
- `pi-subagents` publishes a stable loader API → Option 1's main cost disappears.
- pi gaining a `tool_call`-equivalent hook for scheduled executions → finding 5 becomes fixable.
