# ADR-0023: `agent:*` — a wildcard scoped to definitions

**Date:** 2026-08-14
**Status:** Accepted (2026-08-14, by the user, Option 1 over a steelmanned Option 2 — keep lists explicit)
**Driver:** the configuration cliff found by `product-strategist` in the 2026-08-13 red-team pass. Extends
ADR-0017, which created the `agent:` prerequisite; touches ADR-0008's attenuation invariant.

## Context

ADR-0017 made `agent:<name>` a real prerequisite: a session must hold it to spawn that definition. That
closed R-35's authorisation half and is not reopened.

**`maySpawnDefinition` accepts exactly two things**: the tool wildcard `tool:*`, or the exact id
`agent:<name>`. There is nothing in between. So this configuration is **unexpressible**:

> an orchestrator that may spawn any of our review definitions, but may never hand `write` to anything

The only ways to express "any definition" are to enumerate all of them — a list that must be kept in sync by
hand, where **adding a new skill silently makes it unspawnable** — or to grant `tool:*`, which means
*authority to grant every tool* and switches off exactly the governance the operator wanted. The cliff is
therefore not cosmetic: the ergonomic escape hatch is strictly the least safe option on the menu.

**Why `resolve()` has no wildcard rule today, which is the real constraint.** It is exact-match plus
subsumption. A wildcard session works only because `deriveOwnGrant` *enumerates* its observed tool names
alongside `tool:*`. Definitions are not tools, so nothing enumerates them — which is precisely why
`maySpawnDefinition` had to special-case the wildcard, and why `agent:*` cannot simply be "another id".

## Options considered

### Option 1 — add `agent:*` *(chosen)*

A wildcard that satisfies any `agent:<name>` and **nothing else**.

**Buys:** the configuration above becomes writable, and the incentive to reach for `tool:*` disappears.
`agent:*,tool:read,tool:grep,tool:delegate` says what an operator means: *any of our definitions, and these
tools only.* A definition added later is spawnable without editing the grant, which is the whole complaint.
**Costs:** it says *"any body may run with these tools"*, and a body is a loaded procedure the model could
not have composed itself — which is the value ADR-0017 bought. That is a real weakening, chosen knowingly,
and it is bounded: whatever the body says, the child holds only the tools the session granted.

### Option 2 — leave it; keep lists explicit *(steelmanned)*

**The case:** ADR-0017's entire contribution is that *which instructions may run here* becomes an operator
decision. A wildcard hands that decision back. "Adding a skill silently makes it unspawnable" is arguably the
**correct** default — a new definition appearing on disk (from a `git pull`, from another tool's install)
should not become runnable because a grant written months ago said "anything". Under Option 1,
`agent:*,tool:bash` means any file dropped into `~/.pi/agent/skills/` runs with a shell.
**Why it lost:** the alternative on offer today is `tool:*`, which is worse in every respect — it grants the
wildcard *and* every tool. An operator forced to choose between an unmaintainable list and a total grant
picks the total grant, and R-25 is the record of what happens to controls that are annoying. Option 1 makes
the safer configuration the more convenient one, which is the only kind of control that survives contact.

### Option 3 — prefix globs, e.g. `agent:review-*`

**Rejected.** ADR-0016 refused `Bash(git:*)` in `allowed-tools` because a security control implemented by
string-matching is a security control that is wrong at the edges, and every reinterpretation of a pattern is
wrong in some direction. A namespace wildcard is all-or-nothing and needs no matcher; a prefix glob
reintroduces exactly the semantics that decision declined. If per-family authority is ever wanted, the
mechanism should be a declared group, not a pattern.

## Decision

**`agent:*` satisfies any `agent:<name>` and no other capability.** It is honoured in two places, both
explicitly: `maySpawnDefinition`, and `resolve()`'s coverage check so that a definition declaring
`agent:other` in its own `allowed-tools` can be authorised by a parent holding `agent:*`. It confers **no
tool authority** — `toPiToolsAllowlist` filters it out as it does every `agent:` id, so it never reaches
`--tools`. It **attenuates**: a parent holding `agent:*` may hand down `agent:*` or specific ids; a parent
holding specific ids may **not** hand down `agent:*`, because that would be granting more than it holds.
Unlike `tool:*` it **is** inheritable, because the R-26 reason for withholding the tool wildcard — a
descendant reacquiring the full catalog — does not apply: `agent:*` grants no tools, and every definition a
descendant runs is still clipped to that descendant's own tool grant. `tool:*` continues to satisfy
everything, unchanged. For v1 this means `PI_GRANTS_GRANT="agent:*,tool:read,tool:delegate"` is a valid,
meaningfully-governed configuration.

## Consequences

**Positive.** "Any definition, narrow tools" is expressible, and is now the convenient option rather than
the laborious one. A definition added on disk needs no grant edit. The `tool:*` escape hatch loses its
main legitimate use.

**Negative.** An operator writing `agent:*,tool:bash` grants a shell to any `SKILL.md` that appears in either
skill root, including one installed by another tool. That is the weakening Option 2 warned about, it is
recorded here rather than discovered later, and it argues for documenting `agent:*` as appropriate for narrow
tool grants and inappropriate beside `bash`. **Since 2026-08-14 that combination is detected and warned about
at session start**, because a hazard a document declares and nothing observes is R-47's shape.

**Negative, and load-bearing: this decision shipped without its exception.** The moment an operator writes
`agent:*`, the only route back to per-definition control is `PI_GRANTS_GATED=agent:<name>` — which R-47
records as a **silent no-op**, given a warning the same day and no enforcement. So the menu is *enumerate
every definition by hand* or *authorise all of them with no carve-out*. This ADR removed one cliff and left
the operator on the next one, and R-47's enforcement decision is therefore no longer an independent item:
it is what gives `agent:*` its missing "except".

**A premise of ADR-0017 that does not survive here.** That ADR reasons about *an operator-authored file*.
Definitions are discovered from `~/.pi/agent/skills/` as well as the project, and the format is read by 16+
tools — so `agent:*` authorises bodies installed by other software. Clipping to the tool grant bounds what
such a child can *do*; it does not bound what it says back into the parent's context.

**Neutral.** `skill:*` and `ext:*` are **not** added. No demand, and the namespaces differ: skills are
already enumerable from the catalog, and `ext:` ids name third-party tools where enumeration is the point.

**Deliberate non-goals.** No prefix or glob matching. No generalised `<namespace>:*` rule — this is one
explicit case, not a mechanism, so a future namespace does not silently acquire a wildcard.

## Revisit trigger

Either direction is observable. **Toward generalising:** a second namespace needing the same treatment, at
which point the two explicit cases should become one rule. **Toward reversing:** any incident where a
definition nobody authorised ran because a grant said `agent:*` — the exact shape Option 2 predicted, which
would mean the convenience was bought at too high a price and the answer is declared groups.
