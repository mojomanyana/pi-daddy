# ADR-0017: `agent:<name>` authorises a definition, or the namespace goes

**Date:** 2026-08-13
**Status:** Accepted (2026-08-13, by the user, Option A over the steelmanned Option B)
**Driver:** R-35 — `agent:` capabilities are produced by the catalog, parse as capabilities, and are
**never checked**. Also R-25 (a control that reads as a control but enforces nothing). Constrained by
ADR-0008 (attenuation), ADR-0016 (definitions are spawnable prompts, and absent means *nothing*), and
ADR-0012 (`bash` is out of scope). Measured input from this session, recorded below as R-36.

## Context

**What is true today.** `delegate({agent: "deploy"})` is gated on exactly one thing: the definition's
`allowed-tools` must fit inside the session's grant (`planDelegation`, `src/delegate.ts:169–206`). The
catalog emits `agent:<name>` for every definition (`src/catalog.ts:107`), `normaliseCapability` accepts the
prefix (`src/delegate.ts:31`), and `ceilingForDefinition` accepts `agent:` entries inside a `SKILL.md`'s
`allowed-tools` (`src/definitions.ts:154`). **No code path anywhere asks whether the session holds one.**

So the guarantee is precisely: *governance covers what a child CAN DO, never what it is TOLD to do.* A
session granted `read, bash, delegate` may spawn any definition whose ceiling fits — including one whose
body says to delete everything it can reach, because that body needs only `bash`. Every grant is honoured;
every ledger line is correct; the instructions were never in scope. And an operator cannot express *"this
session may spawn `review` but not `deploy`"*, which is an ordinary thing to want.

ADR-0016 sharpened this rather than causing it: a definition is now a **spawnable prompt**, so its body
carries far more weight than an agent type's frontmatter ever did.

**Two facts measured while scoping this ADR, both load-bearing:**

1. **R-36 (new) — observation silently drops every non-tool capability.** `deriveOwnGrant` filters the
   inherited grant by *observed tool names* (`src/propagation.ts:101–103`), so a session that inherits
   `tool:read, skill:review, agent:reviewer` holds only `tool:read` from its first provider request
   onward. Verified by execution, not by reading:

   ```
   inherited      : tool:read, skill:review, agent:reviewer, ext:pkg/web_search
   before observe : tool:read, skill:review, agent:reviewer, ext:pkg/web_search
   after  observe : ext:pkg/web_search, tool:read
   ```

   This is **already live for `skill:`** — R-32 shipped skill grants, and a child cannot re-grant a skill
   it holds, because the capability disappears from its own grant the moment the model is first called.
   It fails closed and is therefore not urgent, but it is silent, and `/grants` stops listing a capability
   the child genuinely received. **It also makes Option A unimplementable until fixed**: an `agent:`
   prerequisite that evaporates at the first provider request would make every non-root session unable to
   spawn definitions.

2. **`resolve()` has no wildcard rule.** `parent.has(c)` is exact-match plus subsumption; a wildcard
   session works only because `deriveOwnGrant` *enumerates* observed tools alongside `tool:*`
   (`src/propagation.ts:95–100`). Definitions are not tools, so nothing enumerates them — any prerequisite
   check must special-case `WILDCARD` explicitly, or an **ungoverned** session would stop being able to
   spawn, breaking "governance is opt-in".

**What no option here achieves.** None of these govern *instructions*. A capability model can say *which
operator-authored definition may be spawned*; it cannot read a body and judge it. The audit half — the
ledger records the grant, never the body, so *"what was this child told to do?"* is unanswerable after the
fact — is a **separate decision** (a body hash on the ledger record) and is deliberately not decided here.

## Options considered

### Option A — `agent:<name>` becomes a real prerequisite

Spawning definition `X` requires the session to hold `agent:X` (or `tool:*`). Cost: **a breaking change**
(0.8.0) — every enumerated grant that spawns definitions today must add `agent:` ids, or it becomes a leaf
for definition spawns while `tools:`-style delegation is untouched. Requires R-36 fixed first. Buys: the
operator's sentence *"may spawn `review`, not `deploy`"* becomes expressible; `agent:` attenuates downward
like every other capability, so a definition's own `allowed-tools` declares which definitions **it** may
spawn in turn — and `ceilingForDefinition` already parses exactly that, which is evidence the design
anticipated this. Forecloses nothing; it is strictly more expressive.

Mechanically small: one check in `planDelegation`, the catalog already emits the ids, `resolve()` already
intersects capability sets, and `toPiToolsAllowlist` already filters `agent:` out of `--tools`
(`src/resolve.ts:183`), so the id rides in `PI_GRANTS_GRANT` and never reaches pi's parser.

### Option B — delete the namespace

Drop `definitionEntries` from the catalog and the `agent:` prefix from `normaliseCapability` and
`ceilingForDefinition`. Cost: *which definition may be spawned* becomes permanently inexpressible; the
answer to "can I restrict this session to `review`?" becomes "no, restrict its tools instead", which is a
different and weaker sentence. Buys: the smallest honest system — nothing that reads as a control fails to
be one — with no migration and no breaking change. **Steelman:** the tool surface really is the enforced
boundary (`--tools` is what pi honours); an `agent:` id is governance this package implements *itself*, in
the parent, and a child holding `bash` escapes it exactly as ADR-0012 already concedes. Adding a control
whose enforcement lives entirely in the spawner, when the product's whole claim rests on pi's own
allowlist, arguably widens the gap between what the product enforces and what it appears to enforce.

**Why it is still rejected:** the escape hatch argument proves too much — it would retire the depth bound,
the ledger and the fan-out budget too, none of which `--tools` enforces either. And "which definitions may
run here" is the one question ADR-0016 made *more* important by turning definitions into prompts.

### Option C — opt-in restriction: an `agent:` id in the grant restricts, its absence permits all

No breaking change; operators who want the restriction get it by naming ids. **Rejected on a recorded
lesson:** a capability whose *absence* means "everything" is precisely the inversion ADR-0016 removed from
pi-subagents' format, where an absent `tools:` meant the full default toolset and made an undeclared
definition the most powerful kind. It also cannot be reasoned about locally — whether `agent:review`
restricts anything depends on whether some *other* `agent:` id appears in the same grant.

## Decision

**Option A, in two steps, with R-36 fixed first.**

1. **Fix R-36** as its own change: `deriveOwnGrant` filters only capabilities that *are* tools (`tool:`
   and `ext:`) and passes `skill:` and `agent:` through untouched, because an observed tool array says
   nothing about a namespace that is not tools. Fail-closed today, so this is a widening — it must ship
   with the test that pins it and a note that `skill:` grants below the root were being silently dropped.
2. **Then make `agent:<name>` a prerequisite** in `planDelegation`, with `tool:*` satisfying any of them so
   an ungoverned session is unaffected. For v1 this means a **0.8.0 breaking change**: an enumerated grant
   must name each definition it may spawn, the refusal names the missing `agent:` id and the definition's
   file, and `/grants` lists definitions the session may actually spawn rather than all of them.

## Consequences

**Positive.** *"This session may spawn `review` but not `deploy`"* becomes expressible and enforced by the
same intersection every other capability goes through. `agent:` stops being decoration (R-25). Definition
authority attenuates down the tree with no new mechanism. R-36 is fixed on the way, which independently
repairs `skill:` grants below the root.

**Negative.** A breaking change for every enumerated grant in existence, including the user's
`principal-pi-skills` wiring; the error is loud and names the fix, but it is still a break. It also adds a
control **this package enforces in the parent**, not one `--tools` enforces — the product must keep saying
that plainly, exactly as ADR-0012 does about `bash`.

**Neutral / deliberate non-goals.** The *content* of a definition remains ungoverned: the operator
authorises a file, and what that file says is their responsibility. Recording the body's hash in the
ledger is left to a separate ADR. Nothing here changes `bash` (ADR-0012) or the `subagents:rpc:spawn`
blind spot (ADR-0013 Finding 6).

## Revisit trigger

R-35's own trigger, inverted: **any grant naming an `agent:` capability that still has no effect** means
step 2 has not shipped and the namespace is back to reading as a control it is not. Additionally: any
operator asking to restrict *which* definitions a session may spawn (evidence the expressiveness is
wanted), and any report of a `skill:` grant vanishing below the root (R-36 unfixed).
