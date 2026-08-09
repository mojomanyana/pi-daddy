# ADR-0007: Reframe — the product is capability governance for a multi-level agent system, not token optimisation

**Date:** 2026-08-09
**Status:** Accepted (user correction, 2026-08-09)
**Reframes:** ADR-0004, ADR-0005, ADR-0006 — not by reversing their findings, but by replacing the
success criterion those findings were measured against.
**Driver:** direct user statement of intent (2026-08-09) · Q-WHY-1 (re-answered) · Q-WHAT-1 (re-answered)
· Q-WHAT-4 · R-17 · A-09

## Context — what the user actually wants, in their own framing

> "I would have a large set of tools and sub agents and i want to build top level orchestrating agent for
> them that can give them some skills and tools but some not. It is to narrow control of sub-agents and
> sub session executions and steer overall process on multilevel agent system as expected."

The requirement is **per-sub-agent capability provisioning under orchestrator control**:

1. A large catalog of tools **and sub-agents/skills**.
2. A **top-level orchestrating agent** that grants each sub-agent a *subset* — deliberately withholding
   the rest.
3. The purpose is **narrowing control** — bounding what a sub-agent can attempt — and **steering the
   overall process** across multiple levels of delegation.

This is an **access-control and process-control** problem. Token economy is a *consequence* of narrow
grants, not the objective.

## How the project drifted, recorded so the pattern is visible

`docs/00-blueprint.md` §1 justifies the whole architecture on context bloat ("consumes excessive tokens,
dilutes the model's focus… fails to scale to hundreds of tools"). Discovery adopted that justification as
the goal: `05-metrics.md` made **M1 net cost per task** the headline metric, Q-HOW-2 asked "what saving
makes this worth it", and Q-KILL-1's kill condition was economic. Gate 0 then correctly answered the
question it was given — *does JIT mounting save money on a coding agent?* — and returned no. **The
measurement was sound; the success criterion was wrong.**

The blueprint's *architecture* (Module A Top Agent, Module B Orchestrator doing routing + provisioning +
aggregation, Module D lifecycle) was always a control architecture. It was reduced during discovery to
"a component that selects top-k tools", which is a misreading of Module B.

Two signals were present and misfiled:
- **Q-WHAT-4** ("how does the Top Agent know what it CAN delegate?") was treated as prompt-engineering
  detail. It is actually the central question: the orchestrator's view of the capability space is what it
  governs.
- **R-17** was recorded as a risk — "JIT mounting turns the tool surface into a data-dependent privilege
  boundary." For this product **the privilege boundary is the feature.** The risk framing inverts to a
  requirement: grants must be *deliberate, bounded, and auditable* rather than data-dependent.

## Decision

**The product is a capability-governance and orchestration layer for pi's multi-agent execution, and it is
judged on control correctness, not on token savings.**

Working shape (to be specified, not assumed):

- **Capability registry** — the catalog of tools, skills, and sub-agent types that exist in the system.
  (This is the blueprint's Module C, but its purpose is *enumerating what can be granted*, not semantic
  retrieval.)
- **Grants / profiles** — named capability sets attachable to a sub-agent or sub-session ("researcher:
  read, grep, web_search"; "writer: read, write, edit"; "nothing destructive without approval").
- **Provisioning at spawn** — the orchestrator instantiates each sub-session with exactly its granted
  subset, and the sub-agent cannot see or call the rest.
- **Steering** — the orchestrator can inject, redirect, halt, or gate a running sub-session.
- **Audit trail** — what was granted to whom, what was called, what was refused, at what depth.
- **Multi-level bounds** — recursion depth, per-branch budgets, and grant inheritance/attenuation rules
  (a sub-agent must not be able to grant itself more than it was given).

## What survives from the previous work, and what does not

**Survives, and is directly load-bearing:**
- **`pi --tools <allowlist>` / `--exclude-tools` / `--no-tools` / `--no-builtin-tools`** (found 2026-08-09
  while checking A-13) is no longer merely "the boring control arm that beats retrieval" — it is
  **plausibly the provisioning mechanism itself** for child-process sub-agents. Combined with
  `createAgentSession()` for in-process sub-agents, per-sub-agent tool scoping may be largely expressible
  with existing pi primitives.
- **A-12 / `pi-token-audit`'s instrumentation** generalises into the audit trail. The measurement work
  becomes the observability layer for governance.
- **R-17** inverts from risk to requirement (deliberate, bounded, auditable grants).
- **A-09** (sub-agent isolation) returns to relevance — it was deferred as "no named hazard"; under a
  governance framing the hazard *is* named: privilege leakage across delegation boundaries.
- All pi substrate facts: mutable per-turn tools, event bus, extension seams, no MCP, session tree.
- The **72%-of-prompt finding** supports the design as a side benefit: sub-agents run short sessions, the
  regime where narrow grants cut the most context.

**Does not survive as a success criterion:**
- **M1 net cost per task** as the headline metric, and **Q-HOW-2**'s cost target as a gate.
- **Q-KILL-1's economic kill path** as the initiative's kill condition — Gate 0's verdict is retained as a
  true statement about token economics on a long-session coding agent, and demoted from decisive.
- **A-02's break-even inequality** as a go/no-go. It stays as useful cost intuition.
- **A-01 / A-05 / A-13's retrieval framing** — semantic tool *retrieval* was always the weakest reading of
  Module C. Governance needs a registry that enumerates and authorises, which may need no retrieval at all.

## Consequences

**Positive**
- The project is now aimed at what the user asked for, and the success criteria become testable in a way
  cost never was for them: does a sub-agent ever hold a capability it was not granted? Can the orchestrator
  halt a runaway branch? Is every grant attributable?
- Much prior work is reusable — substrate knowledge, instrumentation, and the `--tools` mechanism.
- The most dangerous failure mode is already characterised (R-17), and the register now treats it as a
  requirement with a deny-list/approval design rather than as an unmitigated hazard.

**Negative**
- The metrics plan (`05-metrics.md`) is substantially mis-aimed and needs new M-targets built around
  control correctness, not cost. B1–B10 keep their value as context, not as gates.
- **The landscape research was aimed at the wrong shelf.** The scout surveyed tool-retrieval prior art; the
  relevant shelf is sub-agent orchestration and capability scoping — where the ecosystem is *already
  crowded*: ~8 pi subagent packages exist, and **`pi-fabric` 0.40.3 already advertises "child agents,
  councils, recursion depth + shared cost budgets"**, which overlaps the multi-level bounds above. A fresh
  scout pass on *that* shelf is now the highest-value research, and build-vs-adopt (ADR-0001) must be
  re-run against it.
- Gate G0's criteria are partly obsolete; the gate needs restating around the new criterion rather than
  re-running as written.

**Deliberate non-goals (unchanged, and now for better reasons)**
Semantic/vector tool retrieval, eviction policy engines, containerised vector/KV services,
message-injection mounting, a standalone network service, a second language. None of these serve capability
governance.

## Build-vs-adopt, run on the RIGHT shelf (2026-08-09) — ~70% already runs on the user's machine

`@tintinweb/pi-subagents@0.14.3` is **already installed in this user's pi** (`~/.pi/agent/settings.json`),
and their session history shows it in active use (`Agent` ×18, `get_subagent_result` ×6). They already have
custom agent types at `~/.pi/agent/agents/{debug,plan,review}.md`. Read against the requirement:

| Requirement | Status in the installed package |
| :--- | :--- |
| Spawn sub-agents in isolated sessions | ✅ `Agent` tool; foreground/background; `resume`; `inherit_context`; `isolation: worktree` |
| **Per-sub-agent tool provisioning** | ✅ **but static** — `tools:` frontmatter allowlist in `.pi/agents/<name>.md`, supporting built-in names, `*`/`all`, `none`, and **`ext:<extension>/<tool>` selectors**; plus `disallowed_tools:` denylist |
| Skills provisioning | ✅ coarse — `skills:` and `extensions:` toggles; `isolated: true` forces both off and drops `ext:` selectors |
| **Steer the process mid-run** | ✅ `steer_subagent` — injects a message, interrupting after the current tool execution |
| Model governance | ✅ model pinning per type + opt-in enforcement against pi's `enabledModels` allowlist |
| Audit substrate | ◐ per-subagent JSONL transcripts (`output_transcript`), but no grant ledger |
| Programmatic orchestration | ✅ cross-extension RPC over the event bus (`subagents:rpc:spawn` / `:stop`) |

**The genuine delta — what the requirement needs and this does not provide:**

1. **Dynamic, per-invocation grants.** The `Agent` tool's parameters are `prompt`, `description`,
   `subagent_type`, `model`, `thinking`, `max_turns`, `run_in_background`, `resume`, `isolated`,
   `isolation`, `inherit_context` — **there is no `tools` / `allowed_tools` / `disallowed_tools`
   parameter.** Capability sets are fixed per agent *type*, authored in files. The user's phrasing — a top
   orchestrator "that can give them some skills and tools but some not" — implies the orchestrator decides
   per delegation. Note `isolated: boolean` *is* a call-time capability reduction, so the precedent for
   call-time scoping exists; widening it to a tool subset is a small, natural extension.
2. **Multi-level attenuation and depth bounds.** No recursion depth control and no grant attenuation (a
   sub-agent must never be able to grant a sub-sub-agent more than it holds). Today `isolated: true`
   incidentally prevents nesting by dropping extension tools — accidental, not designed. "Multilevel agent
   system" is an explicit requirement, so this is a real gap. Compare `pi-fabric` 0.40.3, which advertises
   "child agents, councils, recursion depth + shared cost budgets".
3. **A grant ledger.** Transcripts record what happened, not *what was authorised and what was refused*,
   across the delegation tree.
4. **A capability registry** — an enumeration of what *can* be granted across a large tool/skill/agent set,
   which is what makes governance authorable at scale.

**Strategic consequence:** the cheapest credible path is **not a new package**. It is (a) a small upstream
contribution to `pi-subagents` adding call-time tool/skill scoping to the `Agent` tool, plus (b) a thin
governance layer for depth bounds, attenuation, and the grant ledger. Q-WHO-1 chose the OSS community, and
the strategist already noted that an upstream-acknowledged change is the highest-adoption channel available.
This also means **ADR-0001's build-vs-leverage answer is "leverage heavily"** on this shelf, and the answer
is much stronger here than it was for tool retrieval.

## Revisit trigger

- If an existing package (`pi-fabric`, `pi-subagents`, `pi-crew`, `@quintinshaw/pi-dynamic-workflows`)
  already provides per-sub-agent capability scoping with an audit trail and depth/budget bounds, then this
  becomes a contribution or a thin composition layer rather than a build — decide via a fresh ADR-0001 pass.
- If sub-agents turn out to be exclusively in-process, the `pi --tools` provisioning route is unavailable
  and the mechanism question reopens.
- If grants are never revoked mid-session in practice, the lifecycle/eviction machinery stays cut for good.
