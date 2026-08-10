# ADR-0011: Universal capabilities are treated three different ways across the two spawn paths

**Date:** 2026-08-10
**Status:** Accepted — Option 3, 2026-08-10. **Implemented 2026-08-10** (`e8b0fef`), 155 tests passing.

**One thing was implemented beyond the decision as written, and deliberately.** The wildcard branch of
`decideSpawn` returned `allow` *before* the gated check ran, so an operator who set `PI_GRANTS_GATED`
without `PI_GRANTS_GRANT` got a gate that silently did nothing. Two independent reviews found this
separately (`docs/reviews/2026-08-10-aggregated-findings.md`, A-S2 / B-C5). It is fixed here because it
lives in the same early return this ADR restructures, and because leaving it would have made the decision
incoherent — removing the cosmetic stripping without touching the early return would have left that branch
allowing spawns *with* universal capabilities, the opposite of what was decided.
**Driver:** Residual R3 from the final whole-branch review of the gated-capability-approval feature
(`.superpowers/sdd/2026-08-09-gated-capability-approval/progress.md`). Extends **ADR-0008** (monotonic
attenuation) and interacts with **ADR-0010** (approval semantics). Touches risk **R-25**.

## Context

`UNIVERSAL_CAPABILITIES` (`src/resolve.ts:25`) names capabilities that transitively confer the whole
catalog. `ext:pi-fabric/fabric_exec` is on that list **on measured evidence**: a child granted `tools: []`
plus `recursive: true` still reached `pi.write` and `pi.bash` and spawned a grandchild that wrote to disk
(`docs/probes/pi-fabric-eval`, probes 2, 4, 7, 8).

`resolve()` reports them in `ResolveResult.universal` (`src/resolve.ts:131`), and `assertNarrowing()`
(`:143`) throws if any survive, on the stated grounds that *"a universal capability in an 'attenuated'
grant is not a narrow grant with one extra item — it is full authority wearing a narrow grant's
clothing."*

**The two spawn paths do not agree about what to do with that report.** Traced in the current code:

| Situation | Behaviour | Site |
| :--- | :--- | :--- |
| **Interceptor**, delegator holds `tool:*` | Universal capabilities are **stripped from `effective`** and the spawn is **allowed** | `src/interceptor.ts:85-92` |
| **Interceptor**, delegator holds an enumerated grant | A surviving universal capability is **passed through in `effective`** and the spawn is **allowed** — `assertNarrowing` is never called on this path at all | `src/interceptor.ts:136` |
| **Delegate** | `assertNarrowing` is called and the delegation is **refused** | `src/delegate.ts:118-122` |

Three behaviours for one concept: silently dropped, silently passed, loudly refused.

**A second-order consequence, which is how this was found.** `planDelegation` checks `gatedBlocked`
(`src/delegate.ts:115`) *before* `assertNarrowing` (`:119`), and `shouldSeekApproval`
(`src/approval.ts:67-71`) gates only on `denied`. So a delegation that will ultimately be refused by
`assertNarrowing` still raises an approval dialog first. If the human answers *"Allow for this session"*,
that yes is recorded and republished to children for a delegation that never happens — the same harm class
as the finding that introduced `shouldSeekApproval` in the first place.

**One fact that constrains every option, and is easy to get wrong.** On the interceptor path,
`Decision.effective` is a **record, not a provisioning instruction**. `@tintinweb/pi-subagents`' `Agent`
tool has no `tools` parameter (`src/interceptor.ts:4-11`), so the child receives whatever its agent type
declares regardless of what `effective` says. Stripping universal capabilities from `effective` at
`src/interceptor.ts:85` therefore changes the ledger entry and nothing else — **the child still gets
`fabric_exec`.** The only real lever on that path is allow/block.

**Assumption load:** none unvalidated. Every claim above is either measured (the `fabric_exec` escalation)
or read directly from current code.

## Options considered

### Option 1 — Symmetric refusal: block a spawn whose effective set retains a universal capability

Call `assertNarrowing` (or an equivalent check) on the interceptor path too, and refuse.

- **Buys:** one rule for one concept. Closes the case where a governed session hands a child the whole
  catalog through an agent type that declares `fabric_exec` — the case where the guarantee this package
  sells is most obviously false. Makes the stripping at `:85` unnecessary rather than cosmetic.
- **Costs:** refuses spawns pi itself would permit, including for a delegator that legitimately holds
  `fabric_exec` and knowingly wants a child to have it. There is currently no override on that path
  (`assertNarrowing`'s `allowUniversal` flag is not plumbed through `decideSpawn`).
- **Forecloses:** nothing permanently; an `allowUniversal` escape hatch could be added later.

### Option 2 — Fix only the approval ordering

Extend `shouldSeekApproval` to also require `result.universal.length === 0`, so no human is asked about a
delegation `assertNarrowing` will refuse. Leave the interceptor's pass-through alone.

- **Buys:** removes the banked-yes harm with a two-line change to a pure, tested function.
- **Costs:** leaves the substantive disagreement intact — the interceptor still hands children universal
  capabilities while `delegate` refuses them. Fixes the symptom that was noticed, not the condition.
- **Forecloses:** nothing.

### Option 3 — Both: symmetric refusal *and* gate the prompt

Option 1 plus Option 2.

- **Buys:** the disagreement is resolved and the approval flow stops asking about doomed spawns. After it,
  `universal` means the same thing everywhere: a grant containing one is not a narrow grant, and no path
  issues one.
- **Costs:** the largest behaviour change. Some spawns that succeed today begin to fail, which is a
  breaking change for anyone relying on the current interceptor behaviour — though it is hard to argue that
  reliance was ever sound.
- **Forecloses:** nothing.

### Option 4 — Record the asymmetry as intentional and change nothing

Argue that the paths *should* differ: `delegate` **provisions** and therefore owns what the child receives,
whereas the interceptor only **permits or refuses someone else's spawn** and cannot narrow it, so applying a
narrowing assertion there is a category error.

- **Buys:** no code change; the honest observation that the two paths have genuinely different powers.
- **Costs:** leaves a documented hole. The package's README states the guarantee as *"a sub-agent can never
  confer more than it holds"*; on the interceptor path a session holding `fabric_exec` confers everything,
  which is technically consistent with that sentence and completely against its spirit. Also leaves the
  banked-yes harm in place.
- **Forecloses:** nothing, but each release that ships it makes the asymmetry more load-bearing.

## Decision

**Option 3 — both fixes.** Taken 2026-08-10.

1. **The interceptor refuses a spawn whose effective set retains a universal capability**, as `delegate`
   already does. One rule for one concept: no path issues a grant containing one.
2. **`shouldSeekApproval` additionally requires `result.universal.length === 0`**, so no human is asked to
   approve a delegation `assertNarrowing` will refuse, and no `session`-scoped yes is banked for a spawn
   that never happens.
3. **The stripping at `src/interceptor.ts:85` is removed.** It edits the ledger's `effective` and nothing
   else — the child still receives `fabric_exec` — so it implies a narrowing the path cannot perform.
   Removing it makes the record honest: the ledger will show what the child actually got.

For v1 this means a delegator that legitimately holds `fabric_exec` and knowingly wants a child to have it
**cannot** spawn that child through the interceptor. `assertNarrowing`'s `allowUniversal` flag exists but
is deliberately not plumbed through `decideSpawn` yet; the first real need for that override is the
evidence that it should be added, not speculation now.

**This is a breaking change.** Spawns that succeed today will begin to fail — specifically, any agent type
declaring a universal capability, spawned by a session that holds one. That reliance was never sound: the
package's guarantee is that a sub-agent cannot receive more than a narrow grant, and such a spawn hands it
the entire catalog.

**Implementation note:** this is the first change to `src/interceptor.ts` since the package shipped. That
file was treated as hard-protected throughout the gated-capability-approval work, and the design's central
claim — that neither it nor `src/resolve.ts` was modified — held for the whole of that feature. Taking this
decision ends that for `interceptor.ts` deliberately and with a recorded reason. **`src/resolve.ts` remains
untouched**, and this ADR does not authorise changing it: every change here is at a call site of `resolve`,
not inside it.

## Consequences

**While unresolved:**

- A governed session holding `fabric_exec` can spawn an agent type declaring it via the interceptor and the
  child receives the full catalog. Attenuation holds *formally* — the child got nothing the parent lacked —
  while failing in substance, because the parent's own grant was already universal.
- A human can be asked to approve a delegation that `assertNarrowing` then refuses, and a `session`-scoped
  yes from that dialog persists for later delegations that do proceed.
- `assertNarrowing` has exactly one caller in the package (`src/delegate.ts:119`), which reads as an
  oversight rather than a decision, and invites someone to "fix" it in either direction without knowing
  this trade-off exists.

**Whichever option is taken, one thing should change regardless:** the stripping at
`src/interceptor.ts:85` should either become meaningful or be removed. It currently implies a narrowing the
path cannot perform, and a line that looks like enforcement but only edits an audit record is worse than no
line at all.

**Deliberate non-goal:** re-opening whether `bash` should join `UNIVERSAL_CAPABILITIES`. It functionally
subsumes the file and search tools (R-25, `SUBSUMPTION` in `src/resolve.ts:43`) and the argument for
promoting it is real, but it is a separate decision with a much larger blast radius, and conflating the two
would stall both.

## Revisit trigger

Any of:

- A ledger entry showing a spawn allowed with a non-empty `universal` set — evidence the interceptor
  pass-through is being exercised in practice rather than in theory.
- An approval recorded (`approvalSource: "prompt"`) for a delegation whose plan was then refused by
  `assertNarrowing` — the banked-yes harm actually occurring.
- `pi-subagents` gaining a `tools` parameter on its `Agent` tool. That is already tracked as the change
  which would turn the interceptor from enforce-only into provisioning, and it would make Option 1 strictly
  better by giving that path a way to narrow rather than only to refuse.
- Any second caller of `assertNarrowing` being added, which would mean this decision was taken implicitly
  by whoever added it.
