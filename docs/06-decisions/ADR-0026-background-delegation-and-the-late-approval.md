# ADR-0026: background delegation, and what a late approval does

**Date:** 2026-08-14
**Status:** Accepted (2026-08-14, by the user — Option A, refuse the spawn)
**Driver:** known-open item 3, open since ADR-0015. That ADR **declined to decide** background delegation
and said why; this one answers the single question that was blocking it, so the feature is now specifiable.

## Context

`docs/SPEC.md` states the current position as a positive design claim, not an omission:

> There is deliberately **no background mode, no result-by-id and no child registry.** Because the turn
> still owns the children: the parent cannot exit first, the tool-call signal stays live, the timeout
> outlives every child, results are returned rather than stored, and no ids dangle across a compaction.

Every one of those five properties is a consequence of blocking. Background delegation gives up all five at
once, which is why ADR-0015 declined to trade them for an unmeasured convenience.

**But the reason it stayed undecidable is narrower than that, and it is a control-correctness question
rather than a UX one.** A gated capability is resolved by asking a human. In blocking mode the tool call is
still open while the dialog is up, so an answer given *within the dialog's lifetime* arrives before the
spawn. In background mode the call returns first. So: **what happens to an approval a human resolves after
the tool call that needed it has already returned?**

If the answer is "the child spawns when the human answers", then whether a child receives `tool:write`
depends on **when the operator got to the dialog** — that is, on queue position. Two identical delegations
issued a second apart could resolve differently. That is not a worse user experience; it is a governed
capability set that depends on timing.

**Corrected 2026-08-14, and the correction matters.** An earlier draft rejected Option B by citing ADR-0008
as *"the effective set is a function of the grant, the ceiling and the gate — of nothing else"*. **ADR-0008
says no such thing.** It states `G_child = ( R ∩ G_parent ∩ ceiling ) \ D_gated` and a monotonic shrinking
property; a child queued and started five minutes later satisfies that formula exactly, and `\ D_gated`
names human approval as the intended escape hatch without saying when it arrives. The invariant was
restated in a stronger form and Option B was then rejected for violating the restatement. **The rejection
stands on the four-properties argument below, which is sound on its own** — this ADR does not get to borrow
ADR-0008's authority for a property ADR-0008 never claimed.

The honest form of the argument is narrower and still sufficient: *this package should not add a NEW way for
timing to decide a capability set*, and the four properties below are given up regardless.

**Also honest about what already happens.** The blocking path is not the clean baseline the draft implied.
`PI_GRANTS_APPROVAL_TIMEOUT` (default 120s) already turns a late human answer into a refusal with
`gatedBlocked` and no source — precisely the record prescribed here — and under `delegate_all` which
concurrent child reaches the dialog first is decided by filesystem completion order. So "late is refused"
is not a new rule this ADR invents; it is the rule the synchronous path already follows, which is the
strongest available argument *for* Option A and was being forfeited.

## Decision

**A background delegation whose gates are unresolved when its tool call returns is REFUSED.** It is
recorded like any other gate refusal: `gatedBlocked` non-empty, **no** `approvalSource`, `blocked: true`.
An approval that arrives later does not retroactively start anything.

This is the existing ledger vocabulary, not a new one. `gatedBlocked` with no source already means *"nobody
was there to ask"* (`src/ledger.ts`), which is exactly this situation — the operator was not there **yet**,
and "yet" is not a distinction the governance layer should be able to observe.

**The remedy is pre-approval, and it is the operator's, not the model's.** Work meant to run in the
background is work whose capabilities should be settled in advance: an `always`-scoped approval, or a
`PI_GRANTS_GATED` that does not gate what the background job needs.

**With one exception that has to be stated, because it is half the tool surface.** `offeredScopes` returns
`always` only for `path === "definition"`, so `delegate({tools: [...]})` can never hold a persisted
approval — decided in ADR-0019 and not reopened here. For that form the first remedy is **structurally
unreachable**, leaving only `PI_GRANTS_GATED`, which is not pre-approval at all but switching the control
off for the whole session. For the default gate that reduces to `PI_GRANTS_GATED=""`, verbatim the outcome
R-25 exists to prevent. So the consequence below is **stronger for the `tools:` form than for definitions**:
not "only useful for ungated capability sets" but "no pre-approval route exists short of disabling the
gate". A background mode that is useful only for `agent:` spawns may be the right shape; this ADR does not
decide that, and whoever builds it must.

Where the remedy *does* exist, it is the right shape: a decision a human makes once, deliberately, rather
than one they make under time pressure with a queue behind it — R-25's fatigue argument pointing the same
way for once.

**Consequence, stated plainly: background delegation is only useful for ungated capability sets.** That is a
real limitation and it is the correct one. It also makes the feature much smaller than it looked, because
the hard part was never the concurrency.

## Options considered

**A. Refuse the spawn — CHOSEN.** Gating stays a pure function of grant, ceiling and gate. Costs: a
background job needing a gated capability fails until an operator pre-approves it. Refusal is loud, recorded
and has an obvious remedy, which is the failure mode this project prefers.

**B. Queue the spawn and start it when the human answers.** Maximum capability and the intuitive reading of
"background". Rejected: it makes the effective set depend on queue position, and it strands the four other
properties that blocking provides — no live turn owns the child, so there is no abort signal, no parent
timeout, and results have nowhere to be returned to. Each of those wants its own mechanism (a registry, a
result store, ids that survive compaction), and ADR-0015's whole point is that none of them is free.

**C. Forbid gates in background mode** — a call requesting anything gated silently runs synchronously.
Rejected: the same call shape would behave differently depending on `PI_GRANTS_GATED`, so an operator
tightening the gate list would silently change the execution model of code they did not touch. Surprising in
the direction that matters, and a strictly worse version of A: A refuses out loud where C reroutes quietly.

**D. Decline background delegation permanently.** Still defensible, and the answer above makes it
unnecessary — the blocking question is answered, so the feature can be specified whenever a concrete
workload asks for it.

## Consequences

**Not implemented by this ADR, deliberately.** What was missing was a decision, not code, and no workload
has yet appeared that a blocking fan-out of eight cannot serve. This records the rule so that whoever builds
it does not have to re-litigate the one question that stopped it twice.

**It does not make the feature small, and an earlier draft claimed it did.** `docs/SPEC.md` names **five**
properties that follow from blocking — the parent cannot exit first, the tool-call signal stays live, the
timeout outlives every child, results are returned rather than stored, and no ids dangle across a
compaction. Answering the gate question removes **none** of them; it removes one blocker to specifying the
work. Two more that the five do not name: there is exactly **one** `appendRecord` per delegation and it
fires *before* the spawn, so no completion record exists — in blocking mode the return value carries the
outcome, and in background mode neither the result nor the audit trail has anywhere to go.

**When it is built, the rule above is testable before any of the concurrency is**: a background delegation
requesting a gated capability with no standing approval must produce a refusal record with `gatedBlocked`
non-empty and no `approvalSource`, and must produce it *at return time* rather than whenever the dialog is
eventually dismissed.

**`docs/SPEC.md`'s five properties stay true** for everything that exists today. This ADR does not weaken
them; it says what the sixth would have to look like.

## Revisit trigger

**Rewritten 2026-08-14, because the first version could not fire** — the defect ADR-0020's trigger was
amended for on the same day, in mirror image. It read: *"a concrete workload that a blocking `delegate_all`
of eight cannot serve, together with a named owner for the four properties."* Nothing anywhere records that
a workload was attempted and could not be served; the two examples given are categories the design
**forbids**, so nobody writes them and the evidence can never accumulate. A trigger whose evidence is
suppressed by the decision it guards fires on nothing. ("The four" was also undefined — there are five.)

The replacement, either half sufficient, both denominated in something observable:

- **A delegation refused for depth or per-call width, three times in one session**, visible in the ledger
  today as repeated `blocked` records naming the bound. That is a workload pushing against the shape
  blocking imposes, and it accumulates whether or not anyone wants a background mode.
- **A `delegate_all` that times out at `PI_GRANTS_CHILD_TIMEOUT` with more than half its children
  incomplete** — the case where "the turn owns the children" stops being free.

Neither requires a volunteer to appear first. If a background mode is proposed with no such evidence, the
question to ask is which of the five properties the proposer intends to own, and ADR-0015's answer stands
until they name them.

Separately: if anyone proposes letting a late approval start a queued child after all, that is this decision
being reversed, and it needs its own ADR rather than a patch.
