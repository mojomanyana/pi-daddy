# ADR-0004: MVP Cutline — measure first, then a single tool-search extension

**Date:** 2026-08-09
**Status:** **Superseded by ADR-0005 (2026-08-09).** Accepted the same day, then superseded hours later
by its own Stage A output — **which is the ADR working, not failing.** Stage A's pre-committed Gate 0 ran
against real session history and disqualified the thesis for the target catalog by 5×–102×, so Stage B is
cancelled and the initiative is parked. Everything below stands as the reasoning that produced that test;
the *sequence* (measure → then selection) is precisely what made the falsification cheap.
Prior status line, for the record: Accepted 2026-08-09 — the sequence survived adversarial review, and
Stage B's content was materially revised at acceptance by the architecture-critic and research-scout
evidence (see "Amendments at acceptance").
**Driver:** Q-WHAT-1, Q-WHAT-2, Q-WHAT-3 (all ANSWERED 2026-08-09) · Q-WHO-1 (OSS community) ·
Q-WHY-1 (pain claimed, unquantified) · assumptions A-01, A-02, A-11, A-12 · risks R-01, R-08,
R-11, R-12, R-13

## Context

The blueprint prescribes an "Agentic OS": dual-layer Top Agent / Orchestrator, hybrid registry in
Docker (Qdrant/Chroma + Redis), message-injection mounting, an aggregator LLM, and three eviction
modes. Discovery has since established facts that change what the *first* thing to build is:

- **The substrate already ships the mounting mechanics** (Q-BASE-3): pi registers tools at load or
  mid-session, `pi.setActiveTools()` changes the active set between turns, `agent.state.tools` is
  mutable, and `pi-ai` adapts the tool list to native tool-calling across 25+ providers. DTCM's
  differentiated surface is **policy**, not mechanics. Pi deliberately ships no MCP, and its author
  publicly holds DTCM's own thesis (MCP servers costing 7–9% of the context window).
- **The primary user is the OSS pi community** (Q-WHO-1), so the artifact must be a one-command
  installable Pi Package — TS-only, zero containers, zero new API keys — and, per Q-WHO-3, must
  ship *with* reproducible benchmark numbers.
- **The pain is claimed but unquantified** (Q-WHY-1): all four pain categories asserted, none
  measured. B1–B7 are uncaptured and `05-metrics.md` forbids targets without a baseline.
- **Two CRITICAL assumptions are UNVALIDATED and they point in opposite directions:** A-01 (does an
  all-tools catalog actually degrade selection?) and A-02 (do JIT savings survive prompt-cache
  economics?). R-01 — cache-invalidation negating savings — is the register's only H×H risk.

An ADR built on UNVALIDATED criticals must say so out loud: **it does.** That is precisely why this
decision sequences measurement ahead of the cure instead of choosing between them.

A `/brainstorm` on 2026-08-09 stressed six options with the product-strategist subagent (frame
broadened at the user's request to admit answers outside the blueprint's three deltas). Scores:
O5 observability-first 8 · O1 tool-search extension 7 · O2 automatic per-turn top-k 4 · O6 park 2.5 ·
O4 aggregator-core 2.5 · O3 blueprint-literal 1.

## Options considered

### Option 1 — O1 alone: ship the `search_tools` extension now
A single always-mounted meta-tool over a keyword index; hits mounted via `setActiveTools`;
append-only mounts. **Buys:** the proven industry pattern (Anthropic tool search) on the one
substrate that lacks it; one TS file; zero infra; graceful worst case (+1 round-trip, not a missing
tool). **Costs:** its accuracy pitch rests on UNVALIDATED A-01 and its token pitch on uncaptured
B2 — shipping first means claims without evidence, failing the very benchmark bar Q-WHO-3 sets for
adoption. **Forecloses:** nothing structurally, but spends the community's first impression on an
unproven claim.

### Option 2 — O5 alone: ship the benchmark/trace layer and stop there
**Buys:** obeys the project's own measurement rule; the `05-metrics.md` §3 trace event is already a
committed D1 deliverable and R-04's mitigation depends on it; B7 doubles as the A-01 probe; cannot
violate the M3 floor or the anti-metrics. **Costs:** a thermometer is not a cure — if the numbers
show pain and nothing fixable follows, DTCM's one OSS launch is a dashboard (now R-12).

### Option 3 — O2: automatic per-turn top-k selection over an embedded vector registry
**Buys:** the blueprint's registry delta, minus containers; no reliance on the model choosing to
search. **Costs:** walks straight into R-01 with A-02 unvalidated — per-turn churn can cost users
*more* than a stable cached full catalog, i.e. shipping a cure that is a poison; adds an embedding
dependency and index-build friction (an adoption tax); opaque auto-selection risks the M3 floor and
the debuggability anti-metric. **Steelmanned:** if A-02 comes back cache-positive *and* O1's extra
round-trip proves to be the binding latency constraint, this is the right endpoint — which is why
it is deferred with a named trigger rather than rejected outright.

### Option 4 — O3: the blueprint literally
**Buys:** no re-architecture if the true destination is the full Agentic OS. **Costs:** trips
R-08's trigger verbatim (new service + new datastore + possible second language), stacks R-04/R-09
and R-01's worst variant (message-injection churns history), and is adoption-zero for the chosen
user — nobody installs Qdrant + Redis for a coding-agent extension (violates Q-HOW-3 outright). It
welds four unvalidated assumptions into one artifact that cannot be falsified by parts, and so
cannot be killed at Q-KILL-2.

### Option 5 — O4: aggregator-core
**Buys:** the one blueprint delta nothing else addresses. **Costs:** blocked on an unconfirmed pi
delegation seam; A-04 UNVALIDATED with R-03 (silent wrong decisions) as its native failure mode;
longest time-to-first-value; and it targets delegation-output bloat when this user's community
resonates with tool-definition bloat.

### Option 6 — O6: park the initiative
**Buys:** zero cost, maximal optionality, takes R-06 (platform convergence) seriously. **Costs:**
invokes Q-KILL-1's condition ("A-01 busts at 3× catalog") *without having run the probe* — deciding
on unmeasured evidence, just cheaply; and its "the platform covers it" premise is false on this
substrate today (pi has no MCP and no native tool search). Properly the **else-branch** of Option 2's
data, not a peer option.

### Option 7 (CHOSEN) — staged O5 → O1: the thermometer becomes the cure's proof
Neither alone; sequenced, with the same trace schema serving both stages.

## Decision

**DTCM's MVP is staged: measure first (Stage A), then ship exactly one tool-search extension
(Stage B), gated on the measurement showing a knee.** The core delta is neither the aggregator nor
the eviction engine — it is *evidence plus selection*, in that order.

**Stage A — the thermometer.** *(Scope revised at acceptance — see amendments 4–5 and `ROADMAP.md`'s
ordered work list.)* Repair the trace event to **schema v2 before writing code** (`05-metrics.md` §3a),
then instrument an unmodified pi session through its **event bus** — not telemetry spans, since pi ships
no production exporter and no documented CLI hook for a `TelemetryContext`. Fill **B1–B10** on the user's
own pi catalog **and at least one catalog that is not the author's own**, reported per-catalog. Run the
B7 scaling curve **to ≥100 tools with a real-catalog arm and the A-13 control arms** as the A-01 probe;
run the A-02 cost model **parameterized by inter-turn think time and reported per provider class**; and
ride along a micro-probe for A-11 (`setActiveTools` persistence across resume and compaction — the
compaction half is the genuinely unresolved one). **Order the cheap kill tests first:** the A-02
break-even spreadsheet and the 20-minute grep for an existing pi tool-allowlist can spare the whole
campaign. A-12 is already answered — pi-ai's `Usage` preserves `cacheRead`/`cacheWrite`/`cacheWrite1h`
across 25+ providers — so net cost is measurable without patching pi; what is *not* provided, and is
therefore our work, is tool-definition token attribution (method and error bar in §3b). Deliverable:
`docs/gate-reports/baseline-YYYY-MM-DD.md` plus the fixed goal set, which becomes the regression suite.
**The numeric thresholds that would justify Stage B are written down before the data is collected.**

**Stage B — the cure.** *(Revised at acceptance — see amendments 1–3.)* Ride **pi's own documented
loader-tool pattern** rather than reinventing it: an always-active loader tool that calls
`pi.setActiveTools([...currentTools, ...matching])` **additively**, which pi-ai maps onto provider-native
deferred loading where available. Mounts stay **monotonic and append-only** — not because that alone
preserves the prefix (it does not; see amendment 1) but because *non-additive changes forfeit the
cache-preserving path entirely*, which is a stronger reason. **No eviction engine.** DTCM's actual
contribution is the three things pi leaves empty: the **catalog** (source of truth + reindex trigger),
the **selection policy** (index choice measured, not assumed — and it must beat A-13's control arms), and
the **evidence** (the same trace event as Stage A, so before/after numbers come from identical
instrumentation). Two binding design notes: **never blindly `setActiveTools` in `session_start`** —
reconcile with the replayed active set, or A-11 fails by our own hand, which is exactly what pi's own
example would do if copied verbatim; and on non-deferred providers Stage B must degrade **explicitly and
say so** rather than silently costing users money (R-14). Distributed as an npm/git-installable Pi
Package with reproducible per-catalog, per-provider-class benchmark numbers in the README.

**Stage B's shape is deliberately left open in one respect:** whether the selection mechanism is a search
index at all, or A-13's cheaper capability-index-plus-explicit-mount, is decided by Stage A's control-arm
data — not here. What is decided is that *something* in this family ships second, and that it must beat
the boring alternatives on measured numbers before it earns its complexity.

**For v1 this means:** no aggregator, no eviction policy engine, no containers, no message-injection
mounting, no automatic per-turn top-k, no bundles, no sub-agent isolation, no standalone service, no
second language, no dashboard — each cut recorded with a reopen trigger in Q-WHAT-3.

**Phase-gate mapping (no bypass, no waiver).** Stage A's measurement code is D0-legal as probes
under `docs/probes/` per `.claude/rules/phase-gates.md` §2 and `05-metrics.md` §1. Stage A's
*shippable* OSS artifact and all of Stage B are production code and therefore **G1-gated**. The
staged plan is not a way around the gates: the D0 probe work is exactly what G0 requires (baseline
report, A-01/A-02 evidence, the three seeded ADRs), and the installable package lands after G1.

## Consequences

**Positive**
- The first shippable artifact carries its own proof; Q-WHO-3's benchmark requirement is satisfied
  as a by-product rather than as extra work.
- Both O5's "thermometer, no cure" and O1's "claims, no evidence" kill points are answered by the
  sequencing itself.
- Kill stays cheap and honest: if the B7 curve is flat at 3× catalog and A-02 shows cached-full-catalog
  dominance, the O6 park executes on *measured* grounds with recorded re-triggers — Q-KILL-1
  answered with data instead of intuition.
- Append-only mounting removes eviction, thrash (M5), and most stale-call (M6) surface from v1 by
  design rather than by policy.
- One trace schema serves baseline, benchmark, and debugging — R-04's mitigation ships first, not last.
- Provides ADR-0001/0002/0003 the evidence they are each explicitly blocked on.

**Negative**
- Time-to-first-cure is longer than shipping O1 immediately; the community sees measurement before
  capability (mitigated by R-12's forcing function: Stage A must end in a decision, not a report).
- ~~Stage A depends on A-12~~ — **resolved favourably**: A-12 is VALIDATED at doc/source level, so
  net-cost measurement is possible without patching pi. Residual: one live turn dump per provider.
- Stage B introduces R-11 (the model may never invoke the loader), a failure mode that is silent by
  construction and must be measured explicitly on the fixed goal set.
- Two catalogs, not one, is real extra Stage-A work — accepted deliberately as R-13's mitigation.
- **Stage A's scope grew at acceptance**: schema v2 must be designed before code, and B8–B10 (inter-turn
  gaps, distinct-tools-per-session, mid-turn divergence) plus the A-13 control arms were added. The
  compensating discovery is that most of it is computable from baseline traces with no new code.
- **The economic case may not survive contact with B1.** A-02's break-even (S > 11.5·c·C) implies
  ~110 tools before mounting pays at c≈0.15. If the realistic pi catalog is well under that, Stage B is
  cost-negative and the honest outcome is the park — which is a real possibility this ADR now names
  rather than a hedge.
- **A security category opened that the project had not considered** (R-17): JIT mounting makes the
  privilege surface data-dependent, so prompt injection escalates from misusing available tools to
  *expanding* which tools are available. Stage B cannot ship without a destructive-tool gate.

**Neutral / deliberate non-goals**
- The aggregator (C3) and the eviction policy engine (C4) are not rejected as ideas, only cut from
  v1 with named reopen triggers; A-04 and A-06 stay UNVALIDATED and that is now an accepted state
  rather than a gap.
- O2 remains the plausible endpoint of this path, deferred behind a specific trigger.

## Amendments at acceptance (2026-08-09) — read before the Decision

The architecture-critic and two research-scout passes completed after the decision was made. They
**confirmed the sequence and rewrote Stage B.** Five changes, in order of consequence:

**1. "Append-only mounting keeps a stable cacheable prefix" — as originally written, this was wrong,
and it is now right for a different reason.** The critic established that the `tools` array sits at the
**head** of the cacheable prefix (tools → system → messages), so *any* mutation invalidates everything
downstream; append-only buys fewer invalidation events, not cheaper ones. What rescues the design is not
our append-only discipline but **the providers' native deferred loading, which pi already routes to**:
Anthropic `defer_loading` + `tool_reference` (GA) and OpenAI `tool_search`/`defer_loading` (gpt-5.4+)
exclude deferred definitions from the prefix and append discovered tools at the load point, preserving
the cache; pi-ai 0.80.7 (2026-07-14) maps additive `setActiveTools` changes onto exactly that. **This is
provider-conditional** — Google, local models, and anything outside {Anthropic 4.5+, OpenAI Responses
gpt-5.4+, Kimi} fall back to full-prefix invalidation (→ R-14). Two constraints inherit: changes must be
additive (**removals never use deferred loading**, so eviction forfeits cache safety — which independently
vindicates cutting the eviction engine), and a tool carrying `promptSnippet`/`promptGuidelines` rebuilds
the system prompt and breaks the prefix even on native models.

**2. The mounting mechanism is no longer ours to build — pi ships it as a documented recipe.** `pi`'s
`docs/extensions.md` contains a "Dynamic Tool Loading" section whose lifecycle is *verbatim* Stage B —
"Keep loader tools, such as `search_tools`, active and leave searchable tools inactive… call
`pi.setActiveTools([...currentTools, ...matchingTools])`. The change must be additive" — followed by a
complete ~90-line worked example, shipped in 0.80.7. **R-06's trigger has fired, at the substrate rather
than the provider.** Stage B is therefore *not* "build a `search_tools` extension"; it is "supply the
catalog, the index/selection policy, and the evidence, riding pi's loader pattern". Across ~110
`pi-package`-tagged npm packages the scout found **no** package doing retrieval over a *tool catalog*
driving `setActiveTools` (nearest: `monotykamary/pi-lazy-extensions`, a self-described experiment that
lazy-loads whole *extensions*) — so the slice is unclaimed, but it is a much thinner slice than assumed.

**3. A control arm was missing from the ballot, and it may dominate Stage B (→ new A-13).** The critic's
O0: (i) **static profiles** — bundles chosen at session start driving one `setActiveTools` call — have
c = 0 and thus the *best* cache profile of any option, better than the cached full catalog because the
prefix is also smaller, in ~50 lines of TS; (ii) **capability index + explicit mount** — names plus
one-liners in the stable prefix (~15 tok/tool ⇒ ~3k for 200 tools vs ~50k, a 94% cut) plus one
`mount_tools(names[])` tool — answers Q-WHAT-4, mitigates R-10/R-11, and deletes the index, R-07, and the
retrieval hop entirely. Nobody has costed the 80% design, so **the delta of the retrieval branch is
currently unjustified.** Stage A must run these as control arms, and a 20-minute grep of pi's config
schema may show design (i) already ships.

**4. The Stage A instrument needs repair before code, and Stage A is cheaper than assumed.** A-12 came
back **YES**: pi-ai's normalized `Usage` preserves `cacheRead`/`cacheWrite`/`cacheWrite1h` across all 25+
providers and reaches the event bus, so net-cost measurement is possible without patching pi. But the
`05-metrics.md` §3 trace event **cannot diagnose R-01** as specified — it lacks `active_tools_after`,
`cache_miss_cause`, session/branch id, model/provider id, catalog hash, tool-call outcomes, and a
prefill/TTFT split. Schema v2 (now in `05-metrics.md` §3a) fixes this *before* any code, since trace
schemas cannot be changed once users have data. Two free gifts: **`pi.ai.deferred`** gives a
native-deferred hit/miss signal — the cache observable R-01 needed — and `pi.tool.*` attributes supply
M6's tool-call outcomes. One correction of approach: build on the **event bus, not telemetry spans**
(pi ships no production exporter and no documented CLI hook for a `TelemetryContext`; all 6+ community
observability packages use events). And M2 must be measured by diffing the serialized `tools` array at
`before_provider_request`, with a stated error bar (→ R-21).

**5. The literature does not settle A-01 for our catalog size — which is the opportunity.** The measured
elbow is **40–60 tools** (routing F1 66.3%→45.9% on Sonnet 4.5 as catalogs grew 51→584), with a **~10pp
confusion gap that no retrieval layer can recover** — a hard ceiling now recorded against M3. Anthropic's
"30–50 tools" guidance has no published eval; OpenAI suggests <20. **The 10–40 band where pi's realistic
catalog sits is unmeasured in public literature**, so our probe is a novel contribution rather than a
re-run — and Q-KILL-1 is genuinely live, since 3× a ~15-tool catalog is ~45, *at* the elbow rather than
past it. Counter-evidence worth heeding: a Meta study found **under-showing tools costs more than
over-showing** on hard queries, which is direct support for R-16 and against aggressive top-k.

**What did not change:** the sequence. Every one of these findings makes measuring first *more*
obviously correct — three of the five are facts that would have been discovered only after building the
wrong thing.

## Revisit trigger

- **R-12's trigger** — baseline report older than 4 weeks with no recorded Stage-B/park decision.
- A flat B7 curve at 3× realistic catalog **plus** A-02 cached-full-catalog dominance → reopen as
  the O6 park.
- A-11 busting → Stage B's reliability claim is void until a persistence shim exists.
- ~~**R-06's trigger** — pi shipping native tool search before Stage B~~ — **already fired at acceptance.**
  Disposition: absorbed rather than reopened — Stage B was rewritten to ride pi's loader pattern instead of
  reimplementing it. Reopens again only if pi (or a Pi Package) ships the *catalog + selection policy*
  slice, which the 2026-08-09 scout pass found unclaimed across ~110 packages.
- **A-13 busting** — if the capability-index or static-profile control arm matches retrieval within the
  stated tolerance on the fixed query set, Stage B collapses into the boring design and the
  registry-and-selection branch becomes D3+ material.
- **B1 below the break-even** — if the measured catalog is far under ~110 tools, reopen as the park.
- O1's extra round-trip measured as the binding latency constraint against the Q-HOW-1 budget, with
  A-02 cache-positive → reopen toward O2's automatic selection.
