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
still open while the dialog is up, so the answer always arrives before the spawn. In background mode the
call returns first. So: **what happens to an approval a human resolves after the tool call that needed it
has already returned?**

If the answer is "the child spawns when the human answers", then whether a child receives `tool:write`
depends on **when the operator got to the dialog** — that is, on queue position. Two identical delegations
issued a second apart could resolve differently. That is not a worse user experience; it is a governed
capability set that depends on timing, which contradicts the one invariant this package exists to hold
(ADR-0008: the effective set is a function of the grant, the ceiling and the gate — of nothing else).

## Decision

**A background delegation whose gates are unresolved when its tool call returns is REFUSED.** It is
recorded like any other gate refusal: `gatedBlocked` non-empty, **no** `approvalSource`, `blocked: true`.
An approval that arrives later does not retroactively start anything.

This is the existing ledger vocabulary, not a new one. `gatedBlocked` with no source already means *"nobody
was there to ask"* (`src/ledger.ts`), which is exactly this situation — the operator was not there **yet**,
and "yet" is not a distinction the governance layer should be able to observe.

**The remedy is pre-approval, and it is the operator's, not the model's.** Work meant to run in the
background is work whose capabilities should be settled in advance: an `always`-scoped approval, or a
`PI_GRANTS_GATED` that does not gate what the background job needs. That is a decision a human makes once,
deliberately, rather than one they make under time pressure with a queue behind it — which is R-25's fatigue
argument pointing the same way for once.

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

**When it is built, the rule above is testable before any of the concurrency is**: a background delegation
requesting a gated capability with no standing approval must produce a refusal record with `gatedBlocked`
non-empty and no `approvalSource`, and must produce it *at return time* rather than whenever the dialog is
eventually dismissed.

**`docs/SPEC.md`'s five properties stay true** for everything that exists today. This ADR does not weaken
them; it says what the sixth would have to look like.

## Revisit trigger

A concrete workload that a blocking `delegate_all` of eight cannot serve — a long-running watch, a job
outliving its turn — **together with** a named owner for the four properties background mode gives up. Both
halves, because ADR-0015 was reopened once on the first half alone and could not be closed.

Separately: if anyone proposes letting a late approval start a queued child after all, that is this decision
being reversed, and it needs its own ADR rather than a patch.
