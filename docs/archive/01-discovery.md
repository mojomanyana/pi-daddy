# D0 Discovery — Question Bank

**How to use:** `/kickoff` walks these questions with you and records answers here. A question is
DONE only when its Answer field is filled and any spawned assumptions/ADRs are linked. Criticality
★★★ questions block gate G0; ★★ should be answered; ★ may be consciously deferred at the gate.

**Status legend:** OPEN · ANSWERED · DEFERRED (with reason)

---

## BASELINE — the substrate this builds on

### Q-BASE-1 ★★★ What exactly is the "Pi Dev Agent" the blueprint forks?
**Context:** The blueprint names it without a reference. Pin it down: which repository/project,
which version, what license (fork legality/obligations), and is a fork even the intent — or is
"fork" shorthand for "build something in its spirit"?
**Answer:** Mario Zechner's **pi coding agent** (user-confirmed 2026-08-09). Canonical repo:
**github.com/earendil-works/pi** (created as `badlogic/pi-mono`, since transferred; old URL
redirects). Latest release **v0.84.1** (2026-08-07); very active (push 2026-08-08, ~85.6k stars).
License: **MIT** (Copyright 2025 Mario Zechner) — legally unencumbered for any integration depth.
npm scope: `@earendil-works/*` (`@mariozechner/*` deprecated at 0.73.1).
**Fork intent: NOT a literal fork** — user chose *build on pi as a dependency*. Scout confirms pi
is designed for this: three integration depths exist — (a) pi extension (`pi.registerTool()` +
`pi.setActiveTools()` + event hooks), (b) SDK consumer (`createAgentSession()`, `defineTool()`,
per docs/sdk.md), (c) hard fork. Upstream velocity (0.73→0.84 in ~7 months) makes (c) costliest.
→ Feeds ADR-0001/0003. Evidence: research-scout report 2026-08-09 (sources: repo LICENSE, README,
docs/sdk.md, docs/extensions.md, npm registry).
**Status:** ANSWERED

### Q-BASE-2 ★★★ What is the baseline's language, stack, and agent-loop shape?
**Context:** The blueprint's directive 4 proposes Python + LangGraph/LlamaIndex + FastAPI. If the
fork target is written in something else, that's a day-one contradiction → feeds ADR-0002.
**Answer with:** language, runtime, how it defines/passes tools today, how its loop is extended.
**Answer:** **TypeScript on Node.js (engines ≥22.19.0)** — a day-one contradiction with the
blueprint's Python/LangGraph/FastAPI directive (→ ADR-0002). Monorepo packages, lockstep v0.84.1:
`@earendil-works/pi-agent-core` (agent loop), `pi-ai` (LLM abstraction, 25+ providers), `pi-coding-agent`
(CLI), plus tui/client/protocol/server/telemetry/evals. Tool schemas use TypeBox. Tools are
`AgentTool` objects (name, description, TypeBox parameters, async execute) passed via
`agent.state.tools` — **explicitly mutable between turns** — and sent to providers as native
tool-calling params (per-provider adaptation handled inside pi-ai). Loop extension seams:
`transformContext()` (prune/compact before each LLM call), `convertToLlm()` (filter what the model
sees), `steer()`/`followUp()` (mid-run injection), `shouldStopAfterTurn`, plus a full event bus
(`agent.subscribe()`: turn/tool-execution/message events). Extensions can intercept
`before_provider_request`/`after_provider_response`, block `tool_call`, modify `tool_result`.
Evidence: research-scout 2026-08-09 (packages/agent + packages/ai READMEs, docs/extensions.md).
**Status:** ANSWERED

### Q-BASE-3 ★★ What does the baseline already do about tool management and context?
**Context:** Whatever it already ships (tool registration, per-request tool lists, context
compaction) is the floor the Orchestrator must beat — and the seam it must integrate through.
→ Feeds A-10 (maps-without-rewrite).
**Answer:** Pi already ships the **mechanism** for JIT mounting, but not the **policy**:
- Runtime tool registration: extensions call `pi.registerTool()` at load **or mid-session**;
  `pi.setActiveTools(names)` adds/removes tools between turns without `/reload`.
- Built-ins are minimal by design: read/write/edit/bash default (grep/find/ls available); system
  prompt <1k tokens.
- **No MCP, deliberately** — README: build CLI tools with READMEs (Agent Skills standard) or add
  MCP via an extension. Zechner's stated rationale is exactly DTCM's thesis: MCP servers "dump
  their entire tool descriptions into your context... 7–9% of your context window gone."
- Context compaction: automatic on overflow (recover+retry) or proactive near limit; manual
  `/compact`; lossy, full history preserved. Sessions: JSONL tree (branching) in
  `~/.pi/agent/sessions/`.
- Distribution: "Pi Packages" (extensions/skills/prompts/themes) installable via npm/git.
**Implication:** DTCM's floor is high — the differentiated surface is the *orchestration layer*
(registry, relevance selection, eviction lifecycle), not mounting mechanics. UNKNOWN (needs probe
or source read): whether `setActiveTools` selection survives session resume/compaction.
Evidence: research-scout 2026-08-09 (coding-agent README, docs/extensions.md, Zechner blog 2025-11-30).
**Status:** ANSWERED

---

## WHY — is the problem real, measured, and worth it?

### Q-WHY-1 ★★★ What concrete pain do YOU have today that this fixes?
**Context:** The blueprint asserts context bloat generically ("excessive tokens, diluted focus,
fails to scale to hundreds of tools"). Ground it: which agent do you run today whose tool/skill
count, token bill, or wrong-tool rate actually hurts? If the honest answer is "none yet — this is
anticipatory", say so; it changes the MVP from "fix" to "prove".
**⚠ RE-ANSWERED 2026-08-09 — the original answer below recorded the wrong pain (see ADR-0007).**
**The actual pain, in the user's words:** *"I would have a large set of tools and sub agents and i want to
build top level orchestrating agent for them that can give them some skills and tools but some not. It is
to narrow control of sub-agents and sub session executions and steer overall process on multilevel agent
system as expected."*
So the pain is **loss of control over a multi-level agent system**, not token cost: there is no way to
provision a sub-agent with a deliberate *subset* of capabilities, to bound what it can attempt, or to steer
and halt delegated execution across levels. Token bloat is a *symptom the blueprint led with*, and
discovery mistook it for the disease — which sent the entire measurement programme after M1 (net cost) and
produced a Gate 0 verdict that answered a question the user never asked. Narrow grants do reduce context
(and the 72%-of-prompt finding says substantially, since sub-agents run short sessions), but that is a
side effect, not the goal.
**Consequences:** success criteria move from cost to **control correctness** (no ungranted capability ever
held; every grant attributable; runaway branches haltable). R-17 inverts from risk to requirement. A-09
(sub-agent isolation) returns to relevance with a named hazard: privilege leakage across delegation
boundaries. `pi --tools` becomes a candidate *mechanism* rather than a competing alternative.

**Original answer, retained for the audit trail (mis-scoped):** All four pain categories claimed (user, 2026-08-09): (1) daily-agent context bloat
(tool/skill definitions burning tokens), (2) observed wrong-tool / diluted-focus failures as tool
count grows, (3) an in-flight many-tool product agent whose roadmap won't hold under all-tools,
(4) anticipatory catalog growth. **None quantified yet.** Grounding instance chosen for the
baseline measurement (05-metrics §1): **the user's own pi setup** — a pi coding-agent instance
with a real tool catalog (to be stood up / instrumented as the baseline workload). This aligns the
measured pain with the substrate DTCM builds on and makes the baseline capture the next concrete
work item. Caveat recorded: breadth-without-numbers means the MVP still carries a "prove it"
burden — A-01/A-02 probes remain the evidence, not this answer.
→ Feeds Q-WHO-2 (first integration = the same pi setup is the natural candidate) and the
05-metrics §1 baseline plan.
**Status:** ANSWERED

### Q-WHY-2 ★★★ At what tool count does the naive approach actually break?
**Context:** Find the knee of the curve for the models you'll use — with evidence (published
tool-selection studies via research-scout, plus your own probe per A-01), not intuition.
**Answer:** **Partially answered from literature 2026-08-09 (research-scout); the band that matters for
us is genuinely unmeasured, so Stage A closes it.**

*What published evidence establishes:* the measured degradation elbow is **40–60 tools**, not 10–30.
Routing F1 fell 58.2→42.1 (GPT-5.4), 63.7→40.6 (GPT-5.1) and 66.3→45.9 (Claude Sonnet 4.5) as a catalog
grew 51→584 tools (arXiv:2606.17519, 2026-06-17), and that study decomposes the loss into a ~16pp
*retrieval* gap and a **~10pp confusion gap that no retrieval layer can recover** (the oracle ceiling
itself falls 79%→68.8%) — a hard ceiling on what DTCM can win, now recorded against M3. Vendor guidance
sits lower and carries no published eval: Anthropic says selection "degrades once you exceed 30–50
available tools" and recommends tool search at ≥10 tools or >10k tokens of definitions; OpenAI suggests
"fewer than 20 functions" as a soft cap.

*The critical gap:* **nobody has published measurements in the 10–40 tool band — precisely where a
realistic pi catalog sits.** So this question cannot be closed from literature, and our probe is a novel
contribution rather than a re-run. Two binding consequences: the sweep must reach **≥100 tools** to enter
the regime where any published effect exists, and it needs a **real-catalog arm** beside the synthetic one
(synthetic distractors separate more easily, so a padded-only curve reads optimistic).

*A second knee that matters more than the accuracy one:* the **economic** break-even from A-02 —
**S > 11.5·c·C** — implies roughly **≥110 tools (~27k tokens of definitions)** before mounting pays at all
at c≈0.15, rising linearly with session length. So there are two thresholds, and the cost one may bind
first: below ~110 tools the intervention loses money even if accuracy degradation is real.

*Counter-evidence worth carrying:* more tools is not monotonically worse and fewer is not monotonically
better — a Meta study (arXiv:2605.24660) found adaptive shortlist depth ~7.4 matched fixed-K=50 coverage
on BFCL's 370 tools, but that always-showing 5 tools *hurt* (Sonnet 4.6: 93.1% adaptive vs 87.1% fixed-5;
76.8% vs 60.9% on medium-difficulty queries). Under-showing costs more than over-showing on hard queries
→ R-16.
**Status:** PARTIALLY ANSWERED (literature: elbow 40–60, ceiling ~10pp, our band unmeasured; the number
for *our* models and catalog comes from Stage A's B7 — still blocking G0)

### Q-WHY-3 ★★ What is the cost of doing nothing for 6 months?
**Context:** If the realistic tool count stays below the Q-WHY-2 knee, the initiative may be
premature — park it with a re-trigger instead of building early.
**Answer:** _
**Status:** OPEN

### Q-WHY-4 ★★ Which do we optimize first: token cost, accuracy, or latency?
**Context:** JIT mounting trades latency (retrieval + extra hops) for tokens. Pick the primary,
bound the others (Q-HOW-1/2).
**Answer:** **Derived from the Q-WHAT-1 decision / ADR-0004.** Primary = **token cost** (M1 net,
cache-aware), with **accuracy as a hard floor rather than an optimization target** (M3 must not
regress — it is listed as an anti-metric, not a dial) and **latency as a bounded tolerance**
(Stage B's design accepts one extra round-trip; the p50/p95 numbers that bound it are Q-HOW-1, still
OPEN). Stated as one sentence: *token savings without an M3 regression is the whole claim.*
Note the ordering is a consequence of the chosen user, not a preference — the OSS pi community's
resonant complaint is context spend, and cost is the only one of the three that Stage A can measure
credibly before any code ships.
**Status:** ANSWERED (derived)

---

## WHAT — what exactly is the product?

### Q-WHAT-1 ★★★ Which of the blueprint's three deltas is the core?
**Context:** Relative to what platforms already ship (see `04-landscape.md`), the blueprint's
differentiated parts are: (a) JIT mount/unmount with **configurable eviction policies**,
(b) the **aggregator layer** (sub-agent output compression), (c) the **hybrid registry**
(semantic + exact tag/bundle). Rank them; the MVP is the top one done well.
**⚠ RE-ANSWERED 2026-08-09 (ADR-0007): none of the blueprint's three deltas as I framed them is the core.**
The core is **Module B read properly** — the Orchestrator as a *capability-provisioning and process-control*
layer over a multi-level agent system. Discovery reduced Module B to "a component that selects top-k tools",
which is a misreading. The real deltas, re-ranked against the corrected goal:
1. **Per-sub-agent capability provisioning** — grant a sub-session a deliberate subset of tools/skills and
   withhold the rest. Candidate mechanisms already in pi: `pi --tools/--exclude-tools` for child processes,
   `createAgentSession()` with a scoped tool list in-process.
2. **Steering and bounds across levels** — halt, redirect, gate; recursion depth and per-branch budgets;
   grant attenuation (a sub-agent must never grant itself more than it holds).
3. **Capability registry** — enumerate what *can* be granted (Module C for authorisation, not for semantic
   retrieval).
4. **Audit trail** — who was granted what, called what, was refused what, at what depth. `pi-token-audit`'s
   instrumentation generalises here.
The aggregator (b) stays cut. Semantic retrieval — the thing the previous answer ranked first — is
**demoted to optional**: governance needs enumeration and authorisation, and may need no retrieval at all.
**Blocking research:** the landscape pass surveyed tool-retrieval prior art, which was the wrong shelf.
~8 pi subagent packages exist and **`pi-fabric` already advertises "child agents, councils, recursion depth
+ shared cost budgets"** — overlapping deltas 1 and 2. Build-vs-adopt (ADR-0001) must be re-run against
that shelf before any build.

**Original answer, retained for the audit trail (mis-scoped):** **Ranked: (c) hybrid registry / tool selection FIRST, (a) eviction lifecycle second,
(b) aggregator last** — but the operative answer is that the core delta is *neither of the three
as stated*: it is **evidence + selection, staged**. Decided by user 2026-08-09 after `/brainstorm`
(frame broadened at user request to allow answers outside the blueprint's three deltas).

**Brainstorm frame:** "What is the CORE of DTCM's MVP — the one thing built/done well first?",
constrained by: pi already ships mounting *mechanics* (Q-BASE-3), primary user = OSS pi community
(Q-WHO-1), M3 task-success floor is non-negotiable, A-01/A-02 CRITICAL-unvalidated, B1–B7
uncaptured, anti-metrics = debuggability + dev-loop simplicity.

**Option set stressed (6):** O1 leverage-first `search_tools` meta-tool (model-driven, monotonic
append-only mounts) · O2 minimal-custom embedded registry + automatic per-turn top-k · O3
blueprint-literal Orchestrator (Docker Qdrant/Redis, message-injection, aggregator, 3 eviction
modes) · O4 aggregator-core · O5 contrarian observability/benchmark-first · O6 contrarian park.

**product-strategist ranking (0–10):** O5 8 · O1 7 · O2 4 · O6 2.5 · O4 2.5 · O3 1.
Decisive points: O5 is mandated by the project's own rule ("no target without a baseline") and its
trace event is *already* a committed D1 contract deliverable, so measuring is not a detour — B7
doubles as the A-01 probe. O2 walks into R-01 (the register's only H×H) with A-02 unvalidated:
per-turn churn can cost users MORE than naive all-tools — a cure that is a poison — and O1 tests
the same retrieval thesis with strictly less machinery. O3 trips R-08's trigger verbatim (new
service + new datastore + possible second language), welds four unvalidated assumptions into one
unfalsifiable artifact, and is adoption-zero for OSS pi users (nobody installs Qdrant + Redis for
a coding-agent extension). O6 invokes Q-KILL-1's condition without running the probe, and its
"platform covers it" premise is false on this substrate today (pi has no MCP, no native tool
search) — O6 is properly the ELSE-branch of O5's data, not a peer option. O4 is blocked on an
unconfirmed pi delegation seam and targets the wrong pain for this user.

**DECISION (user, 2026-08-09): the staged O5→O1 combo** — the seventh option the strategist
identified as strictly dominating either alone. Sequence:
- **Stage A (measure):** trace/benchmark instrumentation → capture B1–B7 on the user's own pi
  setup **plus at least one catalog that is not the author's own**, run the B7 curve (= A-01
  probe), run the A-02 cache-aware cost model, and ride along a micro-probe on `setActiveTools`
  persistence across session resume/compaction (hours; gates Stage B feasibility → new A-11).
- **Stage B (cure, gated on Stage A showing a knee):** ship O1's `search_tools` extension sharing
  the *same* trace schema, with before/after benchmark numbers in the README.
The thermometer becomes the cure's proof: this answers O5's "thermometer-not-cure" kill point and
O1's "claims without evidence" kill point in one motion, and satisfies Q-WHO-3's benchmark
requirement as a side effect. If B7 is flat at 3× catalog and A-02 shows cached-full-catalog
dominance, the O6 park executes with recorded re-triggers instead.

**PHASE-GATE NOTE (`.claude/rules/phase-gates.md`):** Stage A's *measurement* code is D0-legal as
a probe under `docs/probes/` (measurement-only, per `05-metrics.md` §1). Stage A's *shippable*
OSS benchmark extension and all of Stage B are production code → **G1-gated**. The staged combo
therefore maps onto the existing gate path with no bypass: the D0 probe work is exactly what
unblocks G0 (baseline report + A-01/A-02 evidence + the three ADRs), and the installable artifacts
land after G1. No waiver needed.

**Evidence that would flip the ranking:** (1) flat B7 curve at 3× realistic catalog **plus** A-02
showing cached-full-catalog cost dominance → O6 park with re-triggers; (2) a measured knee below
the community's realistic B1 **with** cache-positive economics → accelerate straight to Stage B
(O1), and to O2's automatic selection only if O1's extra round-trip proves to be the binding
constraint; (3) A-11 busting (mount state lost on resume/compaction) → Stage B's reliability claim
is void until a persistence shim exists.

**AMENDMENT 2026-08-09 (architecture-critic + 2× research-scout, folded in after the decision):** the
*sequence* survived adversarial review and was strengthened; **Stage B's content was rewritten.** Five
findings, recorded in full in ADR-0004's "Amendments at acceptance":
1. **"Append-only mounting is cache-friendly" was false as I first recorded it.** The `tools` array sits
   at the *head* of the cacheable prefix, so any mutation invalidates everything downstream. What rescues
   the design is the providers' **native deferred loading**, which pi already routes to — and that is
   **provider-conditional** (absent on Google and local models) → R-14. Removals never use deferred
   loading, which independently vindicates cutting the eviction engine.
2. **pi ships the `search_tools` recipe itself** (documented ~90-line example, 0.80.7) → R-06's trigger
   fired at the substrate. Stage B is no longer "build the mechanism" but "supply the catalog, the
   selection policy, and the evidence". No ecosystem package among ~110 does the catalog-retrieval slice.
3. **A control arm was missing and may dominate Stage B** → new **A-13**: static profiles (c = 0, best
   cache profile of anything on the table) and capability-index-plus-explicit-mount (~94% token cut,
   no index, no retrieval hop). The retrieval branch's delta is currently unjustified.
4. **A-12 came back YES** (cache-aware usage ships across 25+ providers) but **the §3 trace schema cannot
   diagnose R-01** and must be repaired before code (schema v2, `05-metrics.md` §3a); build on the event
   bus, not telemetry spans.
5. **Literature puts the elbow at 40–60 tools with a ~10pp irreducible ceiling**, leaves our 10–40 band
   unmeasured, and shows under-showing hurts more than over-showing.

**Spawned:** ADR-0004 (MVP cutline — **Accepted 2026-08-09**, with Stage B amended) · A-11, A-12, **A-13**
(new assumptions) · R-11, R-12, R-13, **R-14…R-24** (11 further risks from the critic, including R-17, a
security category the register had entirely missed) · R-01's mitigation corrected · R-06 trigger fired
(new risks) · answers Q-WHAT-2 and Q-WHAT-3 below · constrains ADR-0001 to the leverage-first
hybrid posture · distribution note: Zechner publicly holds DTCM's own thesis (the 7–9% MCP
context critique), so an extension acknowledged upstream is the highest-adoption channel available.
**Status:** ANSWERED

### Q-WHAT-2 ★★★ What is the smallest MVP that proves the thesis?
**Context:** Candidate shape: retrieval-based tool selection (top-k instead of all-tools) inside
the baseline agent, measured against the `05-metrics.md` baseline — no new services, no eviction
engine, no aggregator. Prove token savings without hurting task success, then expand.
**Answer:** Follows directly from the Q-WHAT-1 decision (staged O5→O1). The MVP is **two stages,
not one**, and the candidate shape in this question's Context is Stage B — deliberately *second*:

**Stage A — the thermometer (D0-legal probe work, no shippable code).** Instrument an unmodified pi
session via its event bus; emit the `05-metrics.md` §3 trace event; fill B1–B7 on (i) the user's own
pi catalog and (ii) ≥1 non-author catalog; run the B7 scaling curve at 10/50/200 as the A-01 probe;
run the A-02 cache-aware cost model; micro-probe A-11 (`setActiveTools` persistence across resume /
compaction). Deliverable: `docs/gate-reports/baseline-YYYY-MM-DD.md` + the fixed goal set (which
becomes the regression suite). **This is the whole of the near-term MVP work and it is what G0 needs.**

**Stage B — the cure (post-G1, gated on Stage A showing a knee).** One pi extension exposing a
single always-mounted `search_tools(query)` meta-tool over an index of the tool catalog; hits are
mounted via `pi.setActiveTools()`; **mounts are monotonic/append-only within a session — no eviction
engine** — corrected 2026-08-09: not because append-only alone preserves the prefix (it does not; the
`tools` array is at the *head* of the cacheable prefix), but because **non-additive changes never use the
providers' native deferred loading**, so any unmount forfeits cache safety outright. Emits the same trace event as
Stage A, so before/after numbers are produced by identical instrumentation. Ships as an
npm/git-installable Pi Package, TS-only, zero containers, zero new API keys, with reproducible
benchmark numbers in the README.

**Thesis proven when:** M3 (task success) holds at or above baseline on the fixed goal set **and**
M1 net cost per task improves after cache accounting, on ≥2 catalogs, with every turn explainable
from its trace alone. Token savings without an M3 regression is the whole claim; anything else is
scope.
**Status:** ANSWERED

### Q-WHAT-3 ★★ What is explicitly OUT of scope for v1?
**Context:** The blueprint names Docker infra, isolated sub-agent execution, an aggregator LLM,
three eviction modes, bundles, and observability. Cutting is a decision, not an accident — list the cuts.
**Answer:** **Derived from the Q-WHAT-1/Q-WHAT-2 decision** (staged O5→O1) rather than answered
independently — recorded here so the cuts are explicit and auditable; amend if any is contested.
Everything below is a deliberate non-goal for v1, each with the trigger that would reopen it:

| Cut from v1 | Why | Reopen trigger |
| :--- | :--- | :--- |
| **Aggregator LLM / sub-agent output compression** (blueprint §4, C3) | Wrong pain for the OSS pi user; A-04 CRITICAL-unvalidated; R-03 silent-failure hazard; needs a golden-set harness before any user value; pi delegation seam unconfirmed | A-04 validated **and** a measured case where delegation output, not tool definitions, dominates token spend |
| **Eviction policy engine** (TURN_BASED / AUTONOMOUS / TIMEOUT, C4) | A-06 unvalidated, and now leaning BUSTED: **no shipping production design does per-turn eviction**, and **non-additive tool changes never use native deferred loading** — so the substrate actively penalizes unmounting. Stage B's append-only mounting needs no eviction | Measured session traces where append-only mounting exhausts the window or thrashes (M5) — see R-23: p90 distinct-tools-used approaching catalog size reopens this |
| **Containerized Qdrant/Chroma + Redis** (blueprint §3.1) | Adoption-zero for a one-command Pi Package; violates Q-HOW-3 and the dev-loop-simplicity anti-metric | Embedded/keyword index fails recall or latency at measured catalog scale (A-07 evidence) |
| **Message-injection mounting** (blueprint §3.2) | A-03 evidence already deprecates it on this substrate — pi's `agent.state.tools` is mutable per turn and `pi-ai` adapts to native tool-calling across 25+ providers; injection also churns history = worst cache behavior | A provider where per-request tool mutation is impossible |
| **Automatic per-turn top-k selection** (O2) | Walks into R-01 with A-02 unvalidated; opaque selection risks the M3 floor and the debuggability anti-metric; O1 tests the same thesis with less machinery | O1's extra round-trip measured as the binding constraint, **with** A-02 cache-positive |
| **Contextual tool bundles** (blueprint §4) | Optimization on top of a selection layer that does not exist yet | Retrieval eval (A-05) shows correlated-tool misses that bundles fix |
| **Sub-agent OS/container isolation** (blueprint §4, A-09) | No named hazard for an MVP whose tools are the user's own; infrastructure before thesis | A specific isolation hazard named in the A-09 failure-mode analysis |
| **Standalone middleware service + auth/deploy** (ADR-0003 opt. 2) | Network boundary before the thesis is proven (R-08); wrong shape for a Pi Package | A second real consumer appears |
| **A second language / Python stack** (blueprint directive 4) | Baseline is TS/Node (Q-BASE-2); a second stack forfeits exactly the seams DTCM needs (R-09) | A-08 capability scan names a gap with no viable TS implementation |
| **Dashboards / observability UI** (C5 presentation layer) | Stage A needs the *trace event*, not a UI; "observability layer" is R-08 in miniature | Post-G1, if trace consumers outgrow reading JSONL |

**Kept in v1 deliberately:** the §3 trace event (it is the product in Stage A and the proof in
Stage B), the fixed goal set as a regression suite, and a keyword/exact-match index only as far as
`search_tools` needs it.
**Status:** ANSWERED (derived)

### Q-WHAT-4 ★★ How does the Top Agent know what it CAN delegate?
**Context:** The blueprint says the Top Agent is "completely unaware of tool schemas" yet must
decide when to delegate. Zero awareness risks under-delegation and capability hallucination
(risk R-10). Does it get a compact capability index (names + one-liners), or nothing?
**Answer:** _ — **partially constrained, deliberately still OPEN.** ADR-0004's Stage B gives the
model *one* always-mounted `search_tools` tool, which is strictly more than "nothing" but is not a
capability index. The undecided part is whether to ALSO mount a compact names+one-liners index
(cheap, cache-stable) so the model knows what *kinds* of capability exist before searching. This is
now the mitigation question for **R-11 (under-search)**, which is the R-10 failure mode in the shape
actually chosen — so it must be decided before Stage B ships, and it is measurable on the fixed goal
set (goals requiring an unmounted tool → % where a search call occurred, with and without the index).
**Escalated 2026-08-09 (architecture-critic):** this question is no longer just a mitigation detail — the
capability index is now a **candidate replacement for the whole selection layer** (A-13). Names plus
one-line descriptions cost ~15 tokens/tool, so ~3k tokens covers 200 tools against ~50k for full schemas
(a 94% cut) — and it sits in the **stable cached prefix**, so it costs nothing in cache churn. Paired with
one `mount_tools(names[])` tool it answers this question, mitigates R-10 and R-11, and **deletes the index,
R-07, R-20, and the retrieval round-trip**. The critic's framing: a model that already reads and reasons
may not need BM25 to pick from a 200-line list, so retrieval must *justify* itself against this.
Measurable directly: recall@5 for (a) BM25 over descriptions, (b) embeddings, (c) the model choosing from a
names+one-liner list, on one fixed ≥30-query set.
**Status:** OPEN — now a Stage A measurement (A-13's control arm), not merely a Stage B design choice

---

## WHO — who is this for? (chosen at handoff: UNDECIDED — validate here)

### Q-WHO-1 ★★★ Who is the primary user for the next 90 days?
**Options to weigh:** (a) you/Cosmic Buildings internal tooling, (b) open-source community
project, (c) future commercial product. Each changes success metrics, docs burden, and API
stability needs. Pick ONE primary; the others become explicit non-goals for now.
**Answer:** **(b) Open-source community** (user, 2026-08-09). Primary user for the next 90 days =
other pi users adopting DTCM. Explicit non-goals until re-trigger: Cosmic Buildings internal
tooling as a success criterion (it may still be a testbed), and commercial validation.
Consequences accepted with this choice:
- Success metric shifts from "my setup improved" to "adoptable by pi users" — distribution via
  the Pi Packages channel (npm/git) becomes a first-class requirement.
- Q-WHO-3 (adoption requirements: benchmarks vs. naive + vs. platform-native, integration docs,
  API stability posture) is now LIVE, no longer deferrable.
- Pushes ADR-0003 toward installable shapes (pi extension / library) over a standalone service.
- Tension noted: baseline workload is still the user's own pi setup (Q-WHY-1) — fine for
  measurement, but MVP acceptance must not overfit to one person's catalog.
**Status:** ANSWERED

### Q-WHO-2 ★★ Whose workflow gets the first integration?
**Context:** "A dev agent used for coding" and "an automation agent running many tools" feel the
pain differently (session length, tool correlation, eviction fit). Name the first real workflow —
it defines the first API contract in Phase D1.
**Answer:** _
**Status:** OPEN

### Q-WHO-3 ★ If OSS/commercial later, what would adoption require?
**Context:** Benchmarks vs. native platform features, integration docs, API stability guarantees.
Answer only if Q-WHO-1 ≠ internal.
**Answer:** _
**Status:** OPEN

---

## WHERE — where does it live and run?

### Q-WHERE-1 ★★★ Runtime home: inside the forked agent, a standalone service, or a library?
**Context:** Three shapes with very different costs:
(a) module inside the forked agent (fastest feedback, couples to one agent),
(b) standalone middleware service (blueprint's shape — agent-agnostic, but ships a network
boundary + auth + deploy story before the thesis is proven),
(c) a library/package the agent imports (no network hop, per-language lock-in).
→ Decide in ADR-0003.
**Answer:** **Derived from Q-WHO-1 + the Q-WHAT-1 decision (ADR-0004): a pi extension, distributed
as an npm/git-installable Pi Package** — in-process, no network boundary, no auth, no deploy story.
This is closest to ADR-0003's Option 1 but *without* the fork: DTCM composes through pi's documented
extension seams (`registerTool` / `setActiveTools` / event bus) rather than living inside a modified
agent core (Q-BASE-1: build-on-as-dependency, not a fork). Option 2 (standalone service) is cut for
v1 — adoption-zero for this user and R-08 bait. ADR-0003's Option 4 spirit is retained: the trace
event schema *is* the extraction seam, so a service can be carved out later if a second consumer
appears, at near-zero cost today.
Consequence for Stage A: the measurement harness is also an extension (event-bus subscriber), which
means the instrumentation path and the product path are the same integration surface — one seam to
keep working against pi's upstream velocity (0.73→0.84 in ~7 months).
Residual open: ADR-0003 stays **Proposed** until Q-WHO-2 (first integration workflow) is answered and
A-10's one-page module mapping is reviewed — this answer fixes the *shape*, not the ADR's acceptance.
**Status:** ANSWERED (derived — ADR-0003 acceptance still pending Q-WHO-2 + A-10)

### Q-WHERE-2 ★★★ Registry storage: embedded/in-process or containerized services?
**Context:** The blueprint mandates Qdrant/Chroma + Redis in Docker. For a single-developer MVP,
embedded options (e.g. sqlite-vec, LanceDB, or in-process embeddings over tool definition files)
may deliver the same recall with zero infrastructure. Every always-on container raises the
dev-loop cost (Q-HOW-3). → Feeds ADR-0002; validate via A-07.
**Answer:** **Embedded — and more precisely, no index dependency at all until measurement earns one**
(research-scout 2026-08-09; recorded in full in A-07 and ADR-0002). Nothing in this design needs Docker,
so the blueprint's containerized Qdrant/Redis has no infrastructure justification at MVP scale. But the
finding that actually decides the shape is that **every embedded TS option is pre-1.0** — sqlite-vec is
0.1.10-alpha.4 with breaking storage-format changes promised before 1.0, LanceDB 0.33.0 ships prebuilt
native binaries (the "npm install fails on my machine" adoption-death class), and SQLite's own Vec1 is
announced but unreleased. For a package whose success metric is installability (Q-WHO-1), that is a real
tax.
**Decided shape:** a **swappable index interface with a zero-dependency in-memory brute-force cosine
baseline**. A few hundred tools is trivially brute-forceable — ANN is unnecessary at our scale — so
sqlite-vec / LanceDB / Vec1 stay as later backends behind the interface, adopted only if A-05 shows
brute-force insufficient. Local embeddings are viable when needed (`transformers.js` ONNX MiniLM, 384-dim,
~23MB, 256-token cap — fine for tool descriptions).
**Residual open, deliberately:** index *type* is unresolved and the evidence conflicts — BM25 was the
weakest retriever at 584 tools (32.8% F1 vs 52.5% embeddings) yet Anthropic's GA implementation ships
regex and BM25. Index choice is scale-dependent, so it is a Stage A measurement, not a decision here.
And per A-13 the honest baseline is *no index at all*.
**Status:** ANSWERED (embedded, no containers, interface-first; index type deferred to measurement)

### Q-WHERE-3 ★★ Where do tool definitions live as source of truth?
**Context:** Files in the repo (index rebuilt from them), a database, or the vector store itself?
Two copies of truth invite drift (risk R-07) — name the single source and the reindex trigger.
**Answer:** _
**Status:** OPEN

---

## WHEN — sequencing and horizon

### Q-WHEN-1 ★★ What outcome must be true at 30 / 60 / 90 days?
**Suggested shape:** 30d = baseline measured + G0 passed; 60d = D1 specs done + walking skeleton
measured; 90d = MVP integrated behind a flag with metrics vs. baseline.
**Answer:** _
**Status:** OPEN

### Q-WHEN-2 ★ What else competes for the same time, and who wins?
**Context:** Name the opportunity cost explicitly — an initiative that never states what it
displaces tends to displace everything a little.
**Answer:** _
**Status:** OPEN

---

## HOW MUCH — budgets (these become acceptance criteria in every D1 spec)

### Q-HOW-1 ★★★ Latency budget: how much added delay per delegated turn is acceptable?
**Context:** JIT flow adds retrieval + mount round-trip (+ an aggregator pass later). Set p50/p95
numbers now so specs inherit them.
**Answer:** _
**Status:** OPEN

### Q-HOW-2 ★★★ Token/cost target: what saving makes this worth it?
**Context:** Must be **cache-aware** — see A-02. A naive "smaller prompt" claim can lose money
once prompt-cache reuse is accounted for. State the target as net cost per task at N=50/200 tools.
**Answer:** _
**Status:** OPEN

### Q-HOW-3 ★★ Infra budget: are new always-on containers acceptable for local dev?
**Context:** Ties to Q-WHERE-2. Decide what "one command to run everything" means for this project.
**Answer:** _
**Status:** OPEN

---

## KILL — what would stop this?

### Q-KILL-1 ★★★ What evidence would make us NOT build it?
**Candidates:** native platform features (provider tool search / MCP dynamic tool lists) cover
≥90% of the need at the realistic tool count; or the A-01 probe shows no measurable degradation
at 3× the expected catalog size.
**Answer:** _ — **the kill evidence is now a pre-committed decision rule, not a judgement call:**
`05-metrics.md` §2a. Three corrections from the 2026-08-09 evidence pass:

1. **A cheaper kill test now precedes the accuracy one.** §2a's "Gate 0" is a spreadsheet: A-02's
   break-even **S > 11.5·c·C** evaluated with measured B1/B3. If the realistic catalog is far below
   ~110 tools, selection-based mounting is **cost-negative regardless of any accuracy finding** — this
   kills or spares the initiative before the B7 sweep runs, at zero cost.
2. **The second candidate above is now half-true and must be restated.** "Native platform features cover
   the need" *does* apply through pi after all — pi-ai routes additive tool changes onto Anthropic's GA
   `defer_loading`/`tool_reference` and OpenAI's gpt-5.4+ `tool_search`, and **pi documents the
   `search_tools` recipe itself**. But coverage is **not universal**: Google has no equivalent, local
   models none, and support is version-gated. So the honest kill condition is narrower than "the platform
   covers it" — it is *"the platform covers it for the providers our users actually use"*, which is a
   measurable question about the user population, not a yes/no about the API.
3. **A third kill path opened (A-13).** If the boring control arms — static profiles, or a capability
   index plus explicit mount — match retrieval within tolerance on the fixed query set, the
   registry-and-selection branch dies on its own merits even if both the accuracy knee and the economics
   are favourable. This is the cheapest of the three tests and should run alongside Gate 0.

Thresholds must be filled before Stage A's probes run, per R-12.

**⚠ THE ECONOMIC KILL PATH FIRED 2026-08-09** — on measured data, at zero cost, from session history
that already existed. `docs/gate-reports/baseline-2026-08-09.md`: catalog ≈ 20 tools, per-request
context p50 ≈ 50k tokens, prompt cache read:write = 114:1 (91.1% of prompt tokens served from cache).
Savable definition tokens are 2,250–6,000 against a requirement of ~28,700 at the most generous churn
rate — **JIT mounting loses by 5×–102×, with no parameter combination in which it pays.** One mount
event costs 4.2× the entire median session. The boring alternative (A-13) also won outright: p90
distinct tools per session is **4**, and four tools are 98.1% of all calls, so pi's default core set
already is the right static profile for this workload.
**But this is one catalog, and it is the author's own — exactly R-13.** So the kill is conclusive for
*this* setup and silent about Q-WHO-1's actual primary user. The remaining question is therefore about
**target, not technology** — see `baseline-2026-08-09.md` §6 for the three branches (park / measure other
catalogs / re-baseline on the many-tool product agent).
**Status:** ANSWERED for the measured catalog (economic kill fired); the *initiative-level* verdict awaits
the target decision

### Q-KILL-2 ★★ Post-MVP kill criteria?
**Candidates:** < X% net cost saving, > Y ms p95 added latency, task success rate drops > Z points
vs. baseline. Fill X/Y/Z from the Q-HOW answers at G0.
**Answer:** _
**Status:** OPEN

---

## Answered-question log

| Date | Question | Answered by | Spawned |
| :--- | :--- | :--- | :--- |
| 2026-08-09 | Q-BASE-1 | user (identity, fork-intent) + research-scout (repo/license/version) | ADR-0001 input; ADR-0003 option space |
| 2026-08-09 | Q-BASE-2 | research-scout | ADR-0002 conflict noted (TS vs. blueprint's Python); A-08 evidence |
| 2026-08-09 | Q-BASE-3 | research-scout | A-10 evidence; new unknown: setActiveTools vs. session resume |
| 2026-08-09 | Q-WHY-1 | user (all four pains; baseline grounding = own pi setup) | 05-metrics §1 target workload; Q-WHO-2 candidate |
| 2026-08-09 | Q-WHO-1 | user (OSS community primary) | Q-WHO-3 now live; ADR-0003 pushed toward extension/library; Pi Packages distribution requirement |
| 2026-08-09 | Q-WHAT-1 | user decision (staged O5→O1) after `/brainstorm` + product-strategist stress-test | ADR-0004; A-11, A-12; R-11, R-12, R-13; constrains ADR-0001 |
| 2026-08-09 | Q-WHAT-2 | derived from Q-WHAT-1 decision | Stage A = D0 probe work (unblocks G0); Stage B = post-G1 |
| 2026-08-09 | Q-WHAT-3 | derived from Q-WHAT-1/2 decision | 10 explicit v1 cuts, each with a reopen trigger |
| 2026-08-09 | Q-WHY-4 | derived from Q-WHAT-1 decision | primary = token cost; M3 = floor not dial; latency bounded (Q-HOW-1 still open) |
| 2026-08-09 | Q-WHERE-1 | derived from Q-WHO-1 + Q-WHAT-1 decision | runtime home = pi extension / Pi Package; ADR-0003 shape fixed, acceptance still pending Q-WHO-2 + A-10 |
| 2026-08-09 | Q-WHY-2 | research-scout (literature) — PARTIAL | elbow 40–60 tools; ~10pp irreducible ceiling → M3 upper bound; our 10–40 band unmeasured → probe must reach ≥100 |
| 2026-08-09 | Q-WHERE-2 | research-scout (A-07 evidence) | embedded, no containers, swappable interface + brute-force cosine baseline; index type deferred to measurement |
| 2026-08-09 | Q-WHAT-1 | AMENDED by architecture-critic + research-scout | Stage B rewritten (ride pi's loader pattern); A-13 control arm added; R-14…R-24; ADR-0004 Accepted |
| 2026-08-09 | Q-KILL-1 | **baseline probe on 82 real sessions** — economic kill path FIRED | A-02 BUSTED for this catalog; A-12 VALIDATED; A-13 control arm wins; target decision now the open question |
