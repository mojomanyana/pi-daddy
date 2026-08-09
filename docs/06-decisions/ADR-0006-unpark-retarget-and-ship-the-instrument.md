# ADR-0006: Unpark — re-target to many-tool/small-context, and ship the instrument first

**Date:** 2026-08-09
**Status:** Accepted (user decision, 2026-08-09)
**Supersedes:** ADR-0005 (park the initiative). ADR-0005 was correct about what it measured and wrong to
generalise from it — see Context.
**Driver:** a modelling error in ADR-0005 found on re-examination · Q-WHO-1 (OSS community) · A-02
(re-opened) · A-12 (VALIDATED) · A-13 · R-13 · R-14

## Context

ADR-0005 parked the initiative on the finding that JIT tool mounting loses by 5×–102× on the measured
catalog. **That figure was computed on the cache-invalidating fallback path only, and generalising from
it was an error.** Re-running the model with the history term held fixed at the measured `H ≈ 45,000`
tokens, and separating the two mounting paths pi actually uses:

| Tools | Definitions as share of context | Full-cached | JIT fallback | JIT **native deferred** |
| ---: | ---: | ---: | ---: | ---: |
| 20 | 10% | $0.4725 | $0.7562 | **$0.4371** |
| 60 | 25% | $0.5670 | $0.7562 | **$0.4371** |
| 110 | 38% | $0.6851 | $0.7562 | **$0.4371** |
| 200 | 53% | $0.8978 | $0.7562 | **$0.4371** |
| 400 | 69% | $1.3702 | $0.7562 | **$0.4371** |

On the **native deferred-loading** path — which pi already routes additive `setActiveTools` changes onto
for Anthropic 4.5+, OpenAI Responses gpt-5.4+, and Kimi — the full-prefix cache-write penalty collapses.
At the measured 20-tool catalog the result is a wash (1.08× is inside modelling error and **no win is
claimed**), but it becomes materially positive from roughly 60 tools and reaches ~2× at 200.

**The decisive correction is about which variable governs, and it is not tool count.** It is
**definitions as a share of context**, `S/(H+S)`. A coding agent reads files, so `H` is enormous and
definitions are ~10% — structurally the worst case for this thesis. A small-context automation or
integration agent inverts it (`H ≈ 6,000`, 8 turns):

| Tools | Share of context | Full-cached | JIT native | |
| ---: | ---: | ---: | ---: | :--- |
| 20 | 45% | $0.0644 | **$0.0424** | wins 1.5× |
| 60 | 71% | $0.1229 | **$0.0424** | wins 2.9× |
| 200 | 89% | $0.3276 | **$0.0424** | wins 7.7× |

The blueprint talks about "hundreds of tools", which describes an integration agent, not a coding agent.
**We tested the thesis in the one environment guaranteed to defeat it.** pi was plausibly the wrong
substrate rather than the thesis a wrong idea.

**One unverified fact remains load-bearing and is honestly flagged as such:** the `JIT native` column
assumes deferred tool definitions are **not billed as prompt tokens**. Anthropic still requires every
definition in the request's `tools` array with `defer_loading: true`, and the docs say deferred ones are
"excluded from the system-prompt prefix" — a statement about *caching*, not explicitly about *billing*.
The vendor's own "~85% token reduction" claim implies they are not billed, but this ADR does not rest a
revival on an inference. It is a ~1-hour, ~$1 two-call probe (**A-14**), and it was offered first; the
user chose to proceed on the re-target and the instrument instead, so **A-14 is scheduled, not skipped**.

## Options considered

Four were weighed with the user (2026-08-09): **A** run the deferred-billing probe first · **B** ship the
measurement tool as a pi package · **C** re-target to a many-tool/small-context agent · **D** build the
selection layer anyway with gates waived.

**A** was recommended (highest information per unit effort, and it settles the crux) but not chosen now.
**D** was declined — sensibly, since it means building what measurement calls a wash on this catalog.

## Decision

**Unpark, on two tracks, in this order: B then C.**

**Track B — ship the instrument (immediate).** Build and ship a pi package that answers "where did my
tokens and money go?", including the one number pi does not expose: **prompt tokens attributable to tool
definitions**. It rests on zero unvalidated assumptions — A-12 is VALIDATED end-to-end, since usage with
`cacheRead`/`cacheWrite`/`cost` is persisted directly in session JSONL — and the scout confirmed a real
gap: every framework prior art publishes patterns, none publishes numbers. Roughly 80% of it already
exists as `docs/probes/baseline/session_stats.py`.

**Track C — re-target (needs one input only).** Judge the initiative against a many-tool, small-context
agent rather than against a coding agent, and re-run Gate 0 with **that** agent's real catalog. Blocked
on one fact only the user holds: which agent, and its tool inventory. Not a roadmap — an inventory.

**Why the two tracks reinforce rather than compete:** Track B *is* the measuring device Track C needs. A
tool other pi users can run against their own history is simultaneously the answer to R-13 (our
conclusions rest on one catalog, the author's own) and the cheapest possible route to the population data
that decides whether the selection layer is worth building for anyone.

## Phase-gate waiver — recorded, not slipped

`.claude/rules/phase-gates.md` §2 forbids production code before **G1**, and G1 is not merely unpassed —
**G0 returned NO-GO**. Track B is production code. Per rule 3 ("the gates serve the user; the user
outranks the gates"), this is recorded as an explicit bypass:

> **WAIVED — G0 and G1, scoped to Track B only.** Authorised by the user 2026-08-09 by selecting option
> B ("Ship the measurement tool as a pi package") after being shown that it required a waiver.
> **User's reason, as recorded:** the park was unsatisfying and a lower-friction path that ships something
> is preferred; the measurement tool was chosen specifically because it carries **zero unvalidated
> assumptions**, so the usual reason for the gate (don't build on unproven claims) does not apply to it.
> **Scope of the waiver:** the measurement/observability package only. It does **not** extend to the
> Orchestrator, the registry, the selection layer, eviction, or the aggregator — all of those remain
> gated and remain cut per Q-WHAT-3.

Also mirrored in `gate-reports/G0-2026-08-09.md`, which is amended rather than rewritten.

## Consequences

**Positive**
- Something ships, to the user Q-WHO-1 actually named, in days rather than never.
- The instrument makes every downstream question cheaper: Gate 0 becomes rerunnable by anyone, on any
  catalog, at zero cost — which is the only honest route past R-13.
- The correction is itself a durable finding: **`S/(H+S)`, not tool count, is the governing ratio.** That
  is more useful than the original thesis and more useful than the park.
- No unvalidated assumption is being built on; the risky part of the blueprint stays gated.

**Negative**
- The park lasted hours, which is a real signal that ADR-0005 generalised too fast from one measurement
  path. Recorded plainly so the pattern is visible rather than tidied away.
- Track C is blocked on user input and will stall silently if that inventory never arrives.
- Building before G0 passes means the register's remaining criticals (A-01, A-07, A-08, A-11, A-13, A-14)
  are still open while code exists — acceptable only because the waiver's scope excludes everything those
  assumptions bear on.
- ~10 pi context-management and 6+ observability packages already exist, so Track B must differentiate on
  the tool-definition attribution number rather than on tracing (R-06's crowding applies here too).

**Deliberate non-goals (unchanged)** — Orchestrator, hybrid registry, aggregator, eviction policy engine,
containerised vector/KV services, message-injection mounting, bundles, sub-agent isolation, standalone
service, second language.

## Revisit trigger

- **A-14 resolves against us** (deferred definitions *are* billed as prompt tokens) → the native-path
  column collapses, ADR-0005's park reasoning is restored for both paths, and Track C should stop.
- **Track C's inventory arrives below ~60 tools, or above 60 but with a large `H`** → re-park Track C,
  keep Track B.
- **Track B fails to differentiate** — an existing package already publishes tool-definition token
  attribution → drop Track B and contribute upstream instead.
- R-13's inverse: if community catalogs measured by Track B cluster near 20 tools, the whole
  selection-layer branch is dead for the population, not just for us.
