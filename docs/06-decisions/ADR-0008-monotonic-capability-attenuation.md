# ADR-0008: Capabilities attenuate monotonically down the delegation tree

**Date:** 2026-08-09
**Status:** Accepted (design invariant, from user answers 2026-08-09)
**Driver:** ADR-0007 (reframe) · user chose **dynamic grants** + **genuinely multi-level** nesting ·
R-17 (privilege boundary) · A-09 (sub-agent isolation)

## Context

The user chose the most demanding combination available:

- **Dynamic grants** — the orchestrating agent decides a sub-agent's capability set per delegation, rather
  than selecting from statically-authored agent types.
- **Genuinely multi-level** — sub-agents spawn their own sub-agents, to arbitrary or bounded depth.

Taken naively together, these are a privilege-escalation hole, and it is the exact hazard R-17 names. If a
grant is whatever an LLM asks for, then a level-2 agent can grant a level-3 agent capabilities that level 2
was never given — and because the requesting party is a language model reading task text, the grant becomes
influenceable by untrusted content (a file, a web page, a tool result). In a product whose entire purpose is
*narrowing* control, a grant path that can widen it is not a rough edge; it is the defect.

The naive fixes are both bad. A policy engine that adjudicates every grant is the complexity magnet R-04
warns about and puts an LLM's judgement on the security path. Forbidding dynamic grants gives up what the
user actually asked for.

## Decision

**A capability set may only ever shrink as it passes down the delegation tree. Escalation is impossible by
construction, not by policy.**

Let `G_X` be the effective grant held by agent `X`, and `R` the capability set requested for a child:

```
G_child  =  ( R  ∩  G_parent  ∩  ceiling(child_type) )  \  D_gated
```

- **`∩ G_parent` is the invariant.** No agent can confer what it does not hold. The root orchestrator holds
  the full catalog, so *from the orchestrator's seat the grant is genuinely free* — which is what the user
  asked for — while every level below can only subtract.
- **`∩ ceiling(child_type)`** preserves the existing `.pi/agents/<name>.md` frontmatter as a declarative
  maximum, so the files the user already authors stay authoritative and auditable.
- **`\ D_gated`** is a hard deny-set of destructive capabilities (write/exec/deploy-class) that may never
  enter *any* grant without explicit human approval, regardless of who asks. This is the backstop for the
  case the intersection cannot catch: the root orchestrator itself being manipulated.

**Depth control falls out of the same rule at no extra cost: the spawn tool is itself a capability.** If
`Agent` ∉ `G_child`, that child cannot delegate at all. A parent that wants a leaf worker simply withholds
it. A numeric `max_depth` remains as a cheap backstop against accidental deep recursion, but the primary
mechanism is the same intersection that governs everything else — one rule, not two.

**Every grant decision is recorded, and the interesting field is what was refused:**

```
{ parent_id, child_id, depth, requested: R, parent_grant: G_parent,
  effective: G_child, denied: R \ G_parent, gated: R ∩ D_gated, ts }
```

`denied` is the security signal. An agent repeatedly requesting capabilities it does not hold is the
escalation-attempt tell, and it is invisible without this record.

## Options considered

### Option 1 — Monotonic attenuation by intersection **(CHOSEN)**
One rule, enforced structurally, no LLM on the security path, depth control for free, and the orchestrator
still grants freely. Costs: the root's grant must be bounded by configuration, and `D_gated` needs an
approval path.

### Option 2 — Policy engine adjudicating each grant
A rules layer deciding whether a requested grant is permissible. **Rejected:** it is R-04's complexity magnet,
it needs its own language and its own tests, and it puts judgement where an invariant will do. Attenuation
gets ~all of the safety for ~none of the machinery.

### Option 3 — Static grants only (agent types, no dynamic narrowing)
**Rejected by the user**, and it declines the requirement rather than meeting it. Retained as the trivial
special case: authoring a type with a fixed `tools:` list is just pre-committing `R`.

### Option 4 — Trust the orchestrator; no enforcement
**Rejected.** It works right up until untrusted content reaches a grant decision, and then it fails silently
and totally. It also makes the audit trail meaningless, since a grant nobody checked proves nothing.

## Consequences

**Positive**
- R-17 changes from an open hazard to a closed invariant; the "data-dependent" qualifier is neutralised
  because data can only ever cause *narrower* grants, never wider.
- Depth bounds, attenuation, and leaf-worker enforcement are one mechanism instead of three.
- Existing `.pi/agents/*.md` files keep working unchanged, as ceilings.
- The ledger's `denied` field gives a concrete, monitorable escalation-attempt signal — the kind of trigger
  the risk register asks for everywhere else.
- Testable as a pure function: `resolve(R, G_parent, ceiling, D_gated)` needs no agent, no model, and no
  network to test exhaustively.

**Negative**
- The root grant becomes a security-critical configuration value; getting it wrong hands out everything.
  It must be explicit, not defaulted to "all".
- `D_gated` needs a human approval path, which is UI surface and the one place a human is in the loop.
- Attenuation can surprise an author: a child type whose ceiling exceeds its parent's grant silently gets
  less than its file says. The ledger's `effective` vs `requested` diff must be easy to read, or this
  becomes a confusing-failure class.
- Skills and spawnable agent types must be modelled as capabilities too, or governance has holes where the
  user explicitly asked for coverage ("some skills and tools but some not").

## Revisit trigger

- A legitimate workflow needs a child to hold something its parent does not (e.g. deliberate
  privilege *elevation* for a trusted specialist). That breaks the invariant and needs an explicit,
  human-approved elevation path — a new ADR, not a quiet exception.
- The ledger shows `denied` is always empty across real runs → the intersection is never binding, and the
  simpler static model (Option 3) would have sufficed.
- `D_gated` approval prompts become frequent enough that users click through them, at which point the
  backstop is theatre and needs redesign.
