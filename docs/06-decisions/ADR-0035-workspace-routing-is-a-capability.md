# ADR-0035: workspace routing is a capability, and therefore attenuates

**Date:** 2026-08-20
**Status:** Accepted (2026-08-20)
**Driver:** The ADR-0034 second amendment's *"does NOT resolve"* list — workspace routing is the one
governance dimension that does not attenuate. Constrained by ADR-0008 (the attenuation invariant and its
cardinality companion), ADR-0012 (the product claim is the tool surface), ADR-0017 and ADR-0024 (a
pi-daddy-enforced namespace, and gating one), and R-26 (the same defect, one namespace over).

## Context

ADR-0034 gave delegation an operator-registered workspace: a child can be routed to a named Git worktree,
which becomes its validated initial CWD and the key for the governed-writer lease. Shipped in 0.18.0.

**Which workspace a descendant may select does not attenuate.** Three facts compose into it:

1. `ENV_WORKSPACE_REGISTRY` is **not** in `GRANT_ENV_KEYS` (`src/propagation.ts`), so it survives
   `mergeChildEnv` and inherits into every governed child. That list's own comment defines its membership
   test — *"capability state that must ATTENUATE downward, not an operator preference that should
   inherit"* — and workspace routing was filed on the wrong side of it.
2. `workspace_id` is a **model-facing tool parameter** on `delegate`, `delegate_all` and `delegate_chain`.
3. `prepareDelegationWorkspace` validates the id against the registry and **never checks whether the caller
   was authorised for it**. Verified: no `ownGrant` reference exists on that path.

So an operator who registers `{staging, prod}`, grants a root `tool:write, tool:delegate`, and routes a
child to `staging` has a child that can route **its** grandchild to `prod` — with a real lease, a real
validated CWD, and a ledger line naming `prod`. Depth attenuates. Fan-out budget attenuates. The grant
attenuates. The gated set attenuates. Approvals attenuate. The initial working directory does not.

**This is R-26 in a different namespace.** There, a root holding `tool:*` handed it to children and
"attenuation became meaningless below the root" — found by a three-level transitivity test, not in
production. The fix was that the wildcard is *held* but never *inherited*. The shape recurring in a
dimension added five ADRs later is the argument for making routing use the same machinery rather than a
parallel one.

**What is NOT wrong.** The lease itself is sound: keyed on canonical root, so aliases contend
(`docs/probes/g35-flock-fd-inheritance`, R-99). The registry is operator-owned and a child cannot invent an
entry. This ADR is only about *which registered entry a descendant may choose*.

**MEASURED 2026-08-20 — `docs/probes/g36-workspace-attenuation`.** This paragraph previously recorded the
sequence as derived from reading three files, with a transitivity probe named as the one blocking input.
That probe now exists and **confirms the escalation**: a child routed to `staging`, holding nothing that
names `prod`, planned a grandchild for `prod` with **no refusal** (`grandchild_refusal_code: null`),
resolved it, took an exclusive **write** lease, and would start there (`grandchild_cwd_marker: "prod"`).

The control is what makes it evidence rather than a demonstration: through the *same* child environment the
grant narrowed from `read,write,delegate` to `read` and depth advanced 0 → 1. Two dimensions attenuate and
one does not, in one code path, in one run. `PI_GRANTS_WORKSPACE_REGISTRY` is confirmed absent from
`GRANT_ENV_KEYS`, and the child can enumerate both registered ids.

It drives the real production path with no model and no spawned `pi`, so it re-runs free. **Read its "what
this does not establish" section before quoting it** — it does not show that a model would choose the
escalation, and it observes no real process boundary.

## Options considered

### Option 1 — a `workspace:<id>` capability namespace (CHOSEN)

Routing becomes a capability like any other: `workspace:staging` in a grant means "may route a child here".
`resolve()` already intersects requested against parent grant against ceiling, so attenuation is inherited
from machinery that four ADRs already depend on rather than written again.

`normaliseCapability` gains a fifth prefix beside `tool:`, `skill:`, `agent:`, `ext:`. `workspace:*` follows
`AGENT_WILDCARD`'s precedent and R-26's rule — **held but never inherited**, so a wildcard root hands
children the enumerated set.

**Buys:** attenuation for free and transitively; `PI_GRANTS_GATED=workspace:prod` asks a human before any
descendant routes there, through the existing approval path, which is exactly what ADR-0024 did for
`agent:<name>`; the ledger records the routing decision as a capability decision with no new event type;
`/grants` previews it with no new surface.

**Costs, and the strongest objection to it.** ADR-0012 narrowed the product claim to *the tool surface,
enforced structurally by pi's own `--tools`*. A `workspace:` capability is **not** enforced by `--tools` —
it is enforced by pi-daddy in the parent, before spawn. That is a weaker enforcement class, and pretending
otherwise would be the over-claim this project keeps catching itself in.

The answer is that the precedent already exists and is load-bearing: `agent:<name>` is also enforced by
pi-daddy rather than by `--tools` (ADR-0017), and ADR-0024 gated it. So the namespace would be the *second*
member of an existing category, not a new category — but SPEC must say which capabilities are
`--tools`-enforced and which are pi-daddy-enforced, because it does not distinguish them today and this
would make the distinction matter twice.

**Forecloses:** per-delegation workspace grants that are not expressible as a capability id — anything
pattern-shaped (`workspace:team-*`) would hit exactly the problem `allowed-tools` patterns already hit
(`CEILING_PATTERNS_UNRESOLVED`), so ids stay literal.

### Option 2 — strip the registry and re-supply a narrowed one per child

Add `ENV_WORKSPACE_REGISTRY` to `GRANT_ENV_KEYS` and have the spawn plan write each child a registry
containing only the entries it may use.

**Steelmanned, because it is the more conservative design and nearly won.** It needs no new namespace, no
change to `normaliseCapability`, and no new enforcement-class question — it uses the mechanism
`GRANT_ENV_KEYS` was built for, and the comment there arguably already prescribes it. It also narrows what
a child can even *see*, which is a real defence-in-depth gain that Option 1 does not provide: under Option 1
the child still receives the full registry and is refused at the capability check.

**Costs:** the narrowed registry is a *file* the parent must write per child, so it needs a temp path, a
lifetime, and cleanup — three things this codebase has repeatedly got wrong (R-71 orphaned panes, R-102 the
unreleasable lock, R-105 leaked lease holders). It gives no gate: an operator cannot say "ask me before
anything routes to prod", because there is no capability to name in `PI_GRANTS_GATED`. And it splits
governance across two mechanisms — capabilities for everything else, a filtered file for this — so a reader
must know both to answer "what may this child do?".

**What would settle it:** if a measured case exists where a child must not even *learn* that `prod` is
registered, Option 2's visibility narrowing is decisive and Option 1 is insufficient alone. No such case is
recorded. The two compose, and Option 1 first is the cheaper order.

### Option 3 — an explicit per-delegation allowlist argument

The parent passes `allowedWorkspaces: [...]` when spawning; the child's runtime enforces it.

**Buys:** no capability grammar, no registry rewriting. **Costs:** it is a third propagation channel beside
the grant and the environment, with its own attenuation rule to write, test and get wrong — and ADR-0016's
whole point was that the grant is *an argument rather than a veto*, which this re-splits. Rejected: it
solves the same problem the grant already solves, in a place nothing else looks.

### Option 4 — record it as a deliberate non-goal

Say that workspace routing is a convenience, not a control, and that an operator who cares must not register
two workspaces of differing sensitivity in one session.

**Steelmanned honestly, because it is coherent.** ADR-0034 already declines path confinement, so a child
holding `bash` can write to `prod` whatever the routing says (ADR-0012, measured in
`docs/probes/g5-bash-escape`). If containment is already the OS's job, a routing control is arguably
theatre — and this project's worst failures have been controls that *looked* like enforcement.

**Why it is rejected anyway.** The two are not equivalent to an operator reading the ledger. Under
ADR-0012's escape, the ungoverned descendant produces **no ledger line at all** — its absence is the signal.
Under this gap, the child produces a *complete, correct-looking* capability decision naming `prod`, which
reads as authorised routing because every other dimension in that record genuinely is. The failure is not
"a control is weaker than it looks"; it is "the record asserts an authorisation nobody granted". And unlike
the `bash` escape, this one is cheap to close with machinery that already exists.

## Decision

**Adopt Option 1: a `workspace:<id>` capability namespace, resolved and attenuated by the existing
`resolve()` path, with `workspace:*` held but never inherited.**

For v1 this means:

- Routing a child to workspace `W` requires `workspace:W` in the caller's **effective** grant. A caller
  without it is refused with a new stable code, `WORKSPACE_NOT_AUTHORIZED`, naming the id and what the
  session does hold — the shape `DEFINITION_NOT_AUTHORIZED` already uses.
- The refusal is recorded as a capability decision with `denied: ["workspace:W"]`, so an escalation attempt
  is visible to `isEscalationAttempt` and to `/grants ledger` with no new event type.
- `PI_GRANTS_GATED=workspace:prod` asks a human before any descendant routes there (ADR-0024's mechanism,
  unchanged).
- **This is a breaking change, and deliberately so.** Every existing operator grant lacks `workspace:`
  capabilities, so every workspace-routed delegation begins refusing until the grant is updated. Failing
  *open* for compatibility — permitting routing when no `workspace:` capability appears anywhere — would
  reproduce the defect and make the fix opt-in, which is the one thing an attenuation fix must not be. It
  lands in **0.19.0** with a refusal that names the missing capability, and `pi-daddy init` scaffolds the
  registered ids so the common path is a one-line grant edit.

**Access level is explicitly out of scope for this ADR.** Whether a child gets a read or a write lease
continues to be derived from its requested tools (`governedWorkspaceAccess`), not from the capability id.
A `workspace:prod:write` grammar is a second decision and would make this ADR an "and" twice.

## Consequences

**Positive**

- Workspace routing attenuates transitively, by the same code path as every other capability, and the
  three-level transitivity test that found R-26 extends to cover it.
- An operator can gate a workspace, which is not possible today at all.
- A routing escalation is an ordinary escalation in the ledger, countable by existing tooling.

**Negative**

- Breaking for every operator using workspaces, with no silent migration.
- The registry still inherits in full, so a child can enumerate workspace ids it may not use. Option 2
  remains available as defence-in-depth and is deliberately **not** taken now.
- A second `--tools`-unenforced capability class, which SPEC must now distinguish explicitly rather than
  leaving to a reader's assumption.

**Deliberate non-goals**

- Path confinement, and any claim that this prevents a child holding `bash` from writing to another
  worktree. ADR-0012 stands and `docs/probes/g5-bash-escape` measures it.
- Read/write granularity in the capability id.
- Pattern or prefix matching over workspace ids.
- Narrowing what the child can *see* in the registry (Option 2).

## Revisit trigger

- ~~**The blocking input:** a transitivity probe demonstrating the multi-level escalation.~~ **Satisfied
  2026-08-20** by `docs/probes/g36-workspace-attenuation`. What a reviewer should still weigh before
  acceptance: it observes no real process boundary and no model, so "the mechanism permits this" is
  measured while "an agent would do it" is not.
- **When the fix lands:** the probe gains a case showing the refusal, and its control should show the
  asymmetry disappearing. A probe that only ever measures the defect stops being evidence once the defect
  is gone.
- Any grant containing `workspace:*` observed on a descendant — R-26's trigger, in the new namespace.
- An operator registering workspaces of differing sensitivity and reporting that the capability edit is
  onerous enough that they widen to `workspace:*` — that is R-25's fatigue shape, and it would mean the
  scaffolding in `init` is not doing its job.
- A measured need for a child not to *learn* a workspace exists: adopt Option 2 alongside this.

---

## Accepted 2026-08-20 — and what implementing it changed

Acceptance was a second step, per this project's own ADR discipline: the blocking input was satisfied by
`docs/probes/g36-workspace-attenuation` first, and the decision was walked through before the status moved.

**Implemented as decided**, with one thing the code taught that the decision did not anticipate:

- `normaliseCapability` gained the fifth prefix; `WORKSPACE_WILDCARD` was added to `resolve()`'s `covered()`
  as a deliberate edit — which is exactly what that function's own comment asks for, since there is no
  generalised `<ns>:*` rule and a namespace must not acquire a wildcard by existing.
- `mayRouteToWorkspace` mirrors `maySpawnDefinition`, and the refusal mirrors `DEFINITION_NOT_AUTHORIZED`:
  recorded in `denied`, so `isEscalationAttempt` and every audit query see a routing escalation as an
  escalation.
- **`workspace:*` is held but never inherited** (`childEnv` strips it), for R-26's reason. `agent:*` is
  deliberately left inheritable — ADR-0023 decided that, and definitions are ceilings rather than roots.
  The asymmetry between the two namespace wildcards is now intentional and written down in `propagation.ts`.
- **`tool:*` still satisfies a workspace capability.** Governance is opt-in, so an ungoverned session must
  keep routing anywhere. Refusing it there would be R-28's shape — the enforcing code disagreeing with the
  documented rule — which is precisely how `resolve()` broke at 0.11.2.
- A `workspace:` id cannot reach pi's `--tools`: `toPiToolsAllowlist` filters to `tool:`/`ext:`. Verified by
  test, because a leak would make pi refuse an unknown tool name and the failure would look unrelated.

**What implementation revealed.** The decision said "routing requires `workspace:W` in the caller's
effective grant" as though that were one rule. It is two, and both are needed:

1. the **caller's** authority to route a child — checked against `ctx.ownGrant`, which is the new guard;
2. the **child's** authority to route further — which it only has if the parent put `workspace:W` in the
   child's requested set, because the child's grant is its `effective`.

So a parent must deliberately pass routing authority down, and it attenuates by the same mechanism as
everything else. That is the behaviour the ADR wanted, arrived at by two paths rather than one, and the
Decision above understated it.

**The migration is real and was measured on this repository's own suite:** four test fixtures that routed to
a workspace began refusing until granted `workspace:w1`, which is exactly the one-line edit an operator
faces. Two other fixtures were touched by mistake first and reverted — a reminder that "grant it everywhere
the string appears" is the wrong migration; grant it where routing actually happens.

**Still true, and unchanged by this ADR:** everything in the non-goals above. In particular this does not
confine paths, and a child holding `bash` can still write to any worktree (ADR-0012,
`docs/probes/g5-bash-escape`). The probe's own limits also stand — it observes no model and no real process
boundary.
