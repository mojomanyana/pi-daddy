# Design — Capability governance for pi's multi-level sub-agents

> ## ⛔ SUPERSEDED AS A BUILD PLAN, same day — see ADR-0009
>
> **`pi-fabric` 0.40.3 already implements essentially all of this**, more maturely, with stricter security
> defaults: per-child `tools:` allowlists passed dynamically in code, `agents.maxDepth` (`0` disables
> spawning), **non-inherited** write/execute/network approvals, `agents.budgetUsd` as a shared append-only
> ledger across the recursion tree, risk classes × approval policies with Allow-once/Allow-session scopes,
> serialized approval prompts, fail-closed on dismissal or restart, and enforcement via **the same Pi
> `tool_call` preflight this spec proposed**.
>
> **This document is now reference, not a build plan.** Its remaining value: an independent statement of
> requirements to evaluate Fabric against, and the N1–N6 acceptance criteria. Do not implement §4's phases
> without first running ADR-0009 Option 4 (empirical evaluation).
>
> **§3.4's blocking unknown is also resolved — and the hole was real.** `extensions:` in `pi-subagents`
> accepts an explicit list (`extensions: [mcp]`), so an agent type could load `pi-subagents` (gaining the
> `Agent` spawn tool) while *not* loading a governance extension — enforcement silently absent. Findings:
> 1. **`isolated: true` is safe**, because it drops *all* extension tools including `Agent`, making the child
>    structurally a leaf that needs no governance.
> 2. **Selective `extensions:` lists are the actual hole.** Closable by a static registry rule, checkable by
>    reading the `.pi/agents/*.md` files before any spawn: *any agent type that can hold the spawn capability
>    MUST also load the governance extension; types that exclude governance may not hold `Agent`.*
> 3. **Defence in depth exists**, documented by pi-subagents' own author: exclusion "is **not a sandbox**…
>    a factory that subscribes directly to the shared `pi.events` bus stays live." So a governance factory
>    attaching to the shared bus keeps *observation* (and detect-and-kill via `subagents:rpc:stop`) even when
>    its bound `pi.on` hooks are suppressed. Bound hooks — and therefore `tool_call` blocking — do **not**
>    survive exclusion, so blocking alone was never sufficient.

**MVP cutline in one sentence:** *A pi extension that makes every sub-agent spawn pass through a grant
resolver which can only narrow capabilities, records what was requested and refused, and bounds delegation
depth — with dynamic per-call grants landing via a small upstream change to `pi-subagents`.*

**Gate status, stated plainly:** this is a D1-shaped artifact produced while G0 reads NO-GO. That verdict was
scored against cost metrics which ADR-0007 retired, so G0's criteria are obsolete rather than unmet — the
gate needs *restating* for the control-correctness criterion, not re-running as written. This document is
design, not code; the existing production-code waiver covers only `pi-token-audit`. **Building any of
Phase 1 below needs the waiver extended or G0 restated.**

---

## 1. What exists, so we build only the delta

Verified 2026-08-09 against the installed `@tintinweb/pi-subagents@0.14.3` and pi 0.83.0.

| Already shipped | Delta to build |
| :--- | :--- |
| `Agent` spawn (fg/bg, `resume`, `inherit_context`, `isolation: worktree`, schedules, event-bus RPC) | — |
| Static per-type provisioning: `tools:` allowlist (built-ins, `*`, `none`, `ext:<extension>/<tool>`), `disallowed_tools:`, `extensions:`, `skills:`, `isolated:` | **Dynamic per-call grants** (no `tools` param on the `Agent` call today) |
| `steer_subagent` mid-run injection | — |
| Per-subagent JSONL transcripts | **Grant ledger** (authorised/refused, not just what happened) |
| Model pinning + `enabledModels` enforcement | — |
| — | **Depth bounds + monotonic attenuation** (nothing today) |
| — | **Capability registry** (enumerate what *can* be granted) |

## 2. Capability model

Per **ADR-0008**, the whole security story is one equation:

```
G_child = ( R ∩ G_parent ∩ ceiling(child_type) ) \ D_gated
```

A **capability** is a stable string in one of four namespaces, so that skills and delegation are governed by
the same machinery as tools — the user asked for "skills and tools", and delegation must be grantable for
depth control to fall out:

| Namespace | Example | Source of truth |
| :--- | :--- | :--- |
| `tool:` | `tool:read`, `tool:bash` | pi built-ins |
| `ext:` | `ext:pi-web-access/web_search` | extension registrations (reuses pi-subagents' existing selector syntax) |
| `skill:` | `skill:code-review` | skill discovery dirs |
| `agent:` | `agent:researcher` | `.pi/agents/*.md` + built-in types |

`agent:*` being a capability is what gives depth control for free: withhold `tool:Agent` (or the specific
`agent:` types) and the child is a leaf. Numeric `max_depth` stays only as a cheap backstop.

## 3. Components

### 3.1 Registry — `enumerate(): Capability[]`
Reads pi's live tool table, extension registrations, skill dirs, and agent-type files into one list with
`{ id, namespace, source, destructive?: boolean }`. Purpose is **authorisation, not retrieval** — no
embeddings, no index, no ranking (ADR-0007 retired that framing). A flat list is the right data structure at
any catalog size a human authors policy for.

### 3.2 Resolver — a pure function, and the whole security surface
```
resolve(requested, parentGrant, typeCeiling, gatedSet) -> { effective, denied, gated }
```
No I/O, no model, no network. **This is the only place escalation can be introduced, so it is the only place
that needs exhaustive testing** — and being pure, it can have it. Total test space is small enough to
enumerate: empty sets, `*`/`all`/`none` expansions, unknown ids, namespace mixing, and the ordering property
that matters (intersection is associative, so parent-then-ceiling equals ceiling-then-parent).

### 3.3 Enforcement — `tool_call` interceptor (**works today, no upstream dependency**)
pi lets an extension block a tool call:
```ts
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "Agent") return;
  const verdict = resolve(requestedFrom(event.input), grantOfThisSession, ceilingOf(event.input.subagent_type), GATED);
  if (verdict.violates) return { block: true, reason: `capability escalation: ${verdict.denied.join(", ")}` };
});
```
**Phase 1 can therefore enforce before any upstream change lands.** The limitation is expressive, not
architectural: with no `tools` parameter on the `Agent` call, the orchestrator cannot *state* a narrower
grant, so Phase 1 enforces (a) the child type's ceiling against the parent's grant, (b) depth, and (c) the
gated deny-set — blocking non-compliant spawns rather than silently narrowing them. That is already the
security property; Phase 2 adds the ergonomics.

### 3.4 Grant propagation — the part with a real unknown
A child session must learn its inherited grant, and it must not learn it from the prompt (model-visible and
model-editable). pi's session format has a **`custom` entry type** (confirmed present — 20 such entries exist
in the user's own history), and `session_start` fires on start/load/resume with the documented instruction to
"reconstruct state from session". So:

> **At spawn, write `G_child` as a `custom` session entry; the governance extension in the child reads it at
> `session_start` and holds it as that session's grant.**

Model-authored text cannot forge a session entry, which makes this materially safer than prompt-passing.

**Two unknowns to probe before committing (both cheap):**
1. Does `pi-subagents` give an extension a hook to write a `custom` entry into the *child's* session at spawn
   time? If not, fall back to an env var on child-process spawns, or to the `subagents:rpc:spawn` event-bus
   path it already exposes.
2. **`isolated: true` drops extension tools — which would drop the governance extension itself in the child.**
   A governed child therefore probably cannot be `isolated`, or governance must live somewhere `isolated`
   cannot switch off. **This is the sharpest known hole in the design** and it needs settling before Phase 1
   is built, because "the safety layer is disabled by the isolation flag" is precisely backwards.

### 3.5 Ledger
One append-only JSONL record per spawn:
```
{ ts, parent_id, child_id, depth, subagent_type, requested, parent_grant, effective, denied, gated, blocked }
```
`denied` is the escalation-attempt signal. Reuses `pi-token-audit`'s writer discipline: async, bounded,
non-throwing, opt-in, and **counts and capability ids only — never prompts, arguments, or results**.

## 4. Phasing

**Phase 1 — enforcement (no upstream dependency).** Registry + resolver + `tool_call` interceptor + ledger +
depth bounds. Deliverable: a spawn that would exceed its parent's grant is blocked and recorded. Settle §3.4's
two unknowns first.

**Phase 2 — dynamic grants (upstream to `pi-subagents`).** Add `allowed_tools?: string[]` /
`disallowed_tools?: string[]` to the `Agent` tool's parameters, resolved as
`ceiling ∩ parent_grant ∩ requested`. The package already carries the machinery (`toolNames`, `allowlist`,
`activeTools`, `setActiveTools` appear throughout its `src/`), and `isolated: boolean` is an existing
precedent for call-time capability reduction — so this is a small, idiomatic addition rather than a redesign.
Upstream is also the highest-adoption channel for the OSS target (Q-WHO-1).

**Phase 3 — budgets.** Per-branch token/cost ceilings decremented up the tree, using pi's documented nested-usage
contract ("if a tool makes nested LLM calls, return their combined `Usage` as `usage`"). Read `pi-fabric`
0.40.3 first — it advertises "recursion depth + shared cost budgets" and may make this adopt-not-build.

## 5. Acceptance criteria (control correctness, replacing the retired cost metrics)

| # | Criterion | Method |
| :--- | :--- | :--- |
| N1 | No agent ever holds a capability outside its parent's grant | Exhaustive resolver unit tests + integration: attempt escalation at depths 2 and 3, assert block + ledger entry |
| N2 | Every spawn is attributable | Ledger has one record per spawn, with `requested`/`effective`/`denied` populated |
| N3 | Depth is bounded | A chain that would exceed `max_depth`, and one where `tool:Agent` is withheld, both fail closed |
| N4 | Gated capabilities never auto-grant | `D_gated` member requested at any depth ⇒ blocked pending explicit approval |
| N5 | Governance cannot be switched off from inside | §3.4 unknown 2 resolved: `isolated` (or any child-settable flag) must not disable enforcement |
| N6 | Failure is closed, not open | Resolver error, missing grant entry, or unreadable ledger ⇒ spawn blocked, never permitted-by-default |

N5 and N6 are the two that decide whether this is a security control or a suggestion.

## 6. Explicitly out of scope

Semantic/vector tool retrieval · eviction policy engines · containerised vector/KV services ·
message-injection mounting · a standalone network service · a second language · a policy DSL (ADR-0008
Option 2, rejected — the invariant replaces it) · sub-agent OS/container isolation beyond pi's existing
`isolation: worktree`.

## 7. Open questions

1. **§3.4 unknown 2 (`isolated` vs governance) — blocking.** Settle before building.
2. Root grant configuration: explicit list, or "everything minus `D_gated`"? ADR-0008 warns it must not
   default to all.
3. Does `pi-fabric` already implement Phase 3 (and possibly parts of Phase 1)? A read of it could shrink this
   design materially — **highest-value research remaining.**
4. Human approval UX for `D_gated`: `ctx.ui.confirm` exists, but background/scheduled agents have no
   interactive user, so gated capabilities in background spawns need a defined answer (deny, or queue).
5. Do skills need per-skill granularity, or is pi-subagents' existing on/off `skills:` toggle enough?
