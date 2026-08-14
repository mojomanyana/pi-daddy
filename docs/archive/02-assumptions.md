# D0 Assumptions Register

Every load-bearing claim behind the blueprint, made explicit and falsifiable. `/validate <ID>`
runs the validation method and updates the row. **CRITICAL assumptions block gate G0 unless
VALIDATED or consciously ACCEPTED-UNVALIDATED with a recorded reason.**

**Status:** UNVALIDATED · IN-PROGRESS · VALIDATED · BUSTED · ACCEPTED-UNVALIDATED

---

## A-01 — All-tools-in-context degrades quality as the catalog grows · CRITICAL
**Claim:** Loading every tool definition into context measurably hurts tool-selection accuracy
(not just cost) at scales this project will realistically hit.
**Source:** Blueprint §1.
**Validation:** Probe in `docs/probes/A-01/`: fixed goal set, tool catalogs of 10 / 50 / 200
(pad with generated distractor tools), measure correct-tool selection rate + tokens per call on
the models you actually plan to use. Also: research-scout pulls published tool-count vs. accuracy
studies for current models.
**Evidence:** 2026-08-09 (research-scout, published literature — **half-supported, and the half that
matters for us is the unmeasured one**):
- **The measured elbow is 40–60 tools, not 10–30.** arXiv:2606.17519 (2026-06-17) measured routing F1
  falling 58.2→42.1 (GPT-5.4), 63.7→40.6 (GPT-5.1), 66.3→45.9 (Claude Sonnet 4.5) as the catalog grew
  51→584 tools, locating "the elbow at 40–60 agents".
- **A hard ceiling on any selection layer.** That study decomposes the loss into a ~16pp *retrieval*
  gap (recoverable by better selection) and a **~10pp confusion gap that retrieval cannot fix** — the
  oracle ceiling itself drops 79%→68.8%. So even perfect retrieval leaves ~10pp on the table; this is
  an upper bound DTCM must state before building (now recorded in `05-metrics.md`).
- **Vendor guidance, unbacked:** Anthropic's docs assert selection "degrades once you exceed 30–50
  available tools" and recommend tool search at ≥10 tools or >10k tokens of definitions, but publish
  no eval. OpenAI suggests "fewer than 20 functions" as a soft cap.
- **Counter-evidence that under-showing is worse than over-showing:** arXiv:2605.24660 (Meta,
  2026-05-23) found adaptive shortlist depth ~7.4 tools matched fixed-K=50 coverage on BFCL (370
  tools), but that always-showing only 5 tools *hurt* — Sonnet 4.6 scored 93.1% adaptive vs 87.1%
  fixed-5 (76.8% vs 60.9% on medium-difficulty queries; 16.7% found where fixed-5 found nothing on
  ToolBench's 3,251 tools). Aggressive top-k is a measured hazard, not a theoretical one → R-16.
- Weaker transfer: RAG-MCP (arXiv:2505.03275) >90% success below ~30 candidates, precision collapse
  beyond ~100 — but on qwen-max, not a frontier model. LongFuncEval (arXiv:2505.10570) 7.6–85.6%
  drops from 8K→120K tool-context tokens, hugely model-family dependent.
- **The token half is separately supported:** arXiv:2604.21816 (2026-04-23) reports per-turn tool
  tokens cut 95% (47.3k→2.4k) in a simulated 120-tool environment — but it is a simulation and does
  **not** measure selection accuracy vs. tool count.

**Consequences for the probe (binding):** (a) the 10–40 tool band where pi's realistic catalog sits is
**genuinely unmeasured in public literature** — which makes our probe a novel contribution rather than
a re-run, and means A-01 cannot be VALIDATED from literature; (b) the sweep must pad to **≥100 tools**
to enter the regime where any published effect exists; (c) Q-KILL-1's condition is genuinely live —
3× a ~15-tool catalog is ~45, which is *at* the measured elbow, not past it; (d) synthetic distractor
padding is easier to separate than real overlapping catalogs, so our curve will read optimistic
unless a real-catalog arm is included (critic F33).
**Status:** UNVALIDATED (literature supports the cost half only; our band is unmeasured — probe required)

## A-02 — JIT mounting yields NET cost savings after prompt-cache effects · CRITICAL
**Claim:** Mount/unmount churn still saves money once provider prompt caching is priced in.
**Why doubtful:** A stable full catalog is a cacheable prefix (cheap reads). Churning mounted
schemas invalidates cache suffixes; savings can invert. Local models (no cache pricing) and hosted
providers (cache pricing) behave differently.
**Validation:** Cache-aware cost model (spreadsheet or calc script in `docs/probes/A-02/`):
full-catalog-cached vs. JIT-churned across turn counts, catalog sizes, and provider pricing.
**Evidence:** 2026-08-09 — **the model now has a closed form, and a provider-conditional answer.**

**(1) The break-even inequality (architecture-critic).** Let S = tool tokens saved by mounting,
c = fraction of turns on which the active set changes, C = JIT context size (tools+system+history) at
the average turn. At Sonnet-class pricing ($3.00 input / $3.75 5-min cache write / $0.30 cache read
per MTok), warm-cache steady state gives baseline = (C+S)·0.30 and JIT = c·C·3.75 + (1−c)·C·0.30, so
**JIT wins iff S > 11.5 · c · C.** Worked cases (tool def ≈ 250 tok, system 1k, history +1.5k/turn,
20-turn task): N=200 tools, c=0.40 → JIT $0.554 vs cached-full $0.558 (a coin flip that JIT loses
asymptotically, since its penalty is linear in turns while the baseline's big write is one-time);
**N=60, c=0.40 → JIT costs 2.4× MORE**; N=200, c=0.15 → JIT wins 1.9×; **N=60, c=0.15 → JIT still
loses 25%.** Design rule: at c=0.15 with a 15k-token history you need **≳110 tools (~27k tokens of
definitions)** before mounting pays at all, and that threshold rises linearly with session length.
**This makes B1 (catalog size) a kill test computable on a spreadsheet: if the realistic pi catalog
is under ~100 tools, selection-based mounting is cost-negative before a line is written.**

**(2) The prefix-position question, answered — and it inverts twice (research-scout).** The critic's
strongest attack was that the `tools` array sits at the **head** of the cacheable prefix (tools →
system → messages), so *any* change invalidates everything downstream, making "append-only is
cache-friendly" false. That is correct **for the fallback path** — and wrong for the native path,
because providers built exactly this escape hatch and **pi already routes to it**:
- **Anthropic (GA, not beta):** `defer_loading: true` excludes a tool's definition from the prefix;
  discovered tools are appended inline as expanded `tool_reference` blocks, so per Anthropic's docs
  "the prefix is untouched, so prompt caching is preserved". Supported Sonnet/Opus/Haiku 4.5 and
  later. `defer_loading` + `cache_control` on the same tool is a 400.
- **OpenAI (gpt-5.4+):** `tool_search` + `defer_loading` in the Responses API, tools loaded at the
  **end** of the context window specifically so the cache is preserved.
- **pi-ai 0.80.7 (2026-07-14):** "cache-friendly dynamic tool loading. `ToolResultMessage.addedToolNames`
  marks where tools from `Context.tools` became available; Anthropic and OpenAI Responses use native
  deferred loading" — 0.80.9 added Kimi. **Other providers fall back to sending `Context.tools`
  normally**, i.e. full-prefix invalidation.
- Google has **no equivalent** (open parity feature request, googleapis/python-genai #2185). MCP adds
  nothing — spec rev 2026-07-28 still has only `tools/list` + `list_changed`, no search/ranking.
- Constraints that bite: changes must be **additive** (removals never use deferred loading, so
  eviction forfeits the cache-safe path entirely), and activating a tool carrying `promptSnippet`/
  `promptGuidelines` **rebuilds the system prompt** and invalidates the prefix even on native models —
  so lazily loaded tools should rely on their `description` only.

**Net:** R-01's mitigation is real but **not ours** — it is the provider's, reached through pi, and it
exists only on Anthropic / OpenAI-Responses / Kimi. On Google and local models the critic's F1 holds
in full. The same design therefore has **opposite economics on different providers** → R-14. Also
unmodelled: cache TTL vs. human pacing (Anthropic default ~5 min) flips the verdict between
interactive and rapid-fire sessions → R-15; the cost model must be parameterized by inter-turn think
time and every claim must state its regime.
**(3) MEASURED 2026-08-09 — the inequality was evaluated against the user's real pi history and it
fails by an order of magnitude.** `docs/probes/baseline/session_stats.py` over 82 real sessions
(1,956 tool calls, $76.12 of spend): catalog ≈ **20 tools**, per-request context **p50 49,964 tokens**,
prompt cache **read:write = 114:1** (91.1% of prompt tokens served from cache). Savable tool-definition
tokens are 2,250–6,000 depending on per-tool cost — against a requirement of ~28,700 at the most
generous churn rate (c=0.05). **JIT mounting loses by 5×–102× across every bracket; there is no cell in
which it pays.** In dollars: one mount event costs $0.187 at p50 context — **4.2× the entire median
session's cost of $0.044**. Full detail and caveats: `docs/gate-reports/baseline-2026-08-09.md`.
**Root cause matches the critic's F4 exactly: the project was aiming at the smaller term.** Tool
definitions are 4.5–12% of a request; they are cheap to keep (cache) and expensive to change (prefix
head). History is the big term, sits at the tail, and is cheap to attack.
**Status:** **BUSTED for the measured catalog** (~20 tools, ~50k context). The inequality itself is
VALIDATED as a model and needs only other catalogs' inputs — so the assumption stays listed rather than
closed, because Q-WHO-1's primary user is the OSS community, not this one setup (R-13).

## A-03 — Message-injection mounting is technically viable for target providers · CRITICAL
**Claim:** Blueprint §3.2 (inject schemas as chat/system messages, not the API `tools` parameter)
works with native tool-calling on the providers you'll target.
**Why doubtful:** Native tool_use requires schemas in the request's `tools` param; text-injected
schemas mean hand-parsing pseudo-calls and losing provider-side validation. Mutating the
per-request `tools` array may achieve the same JIT goal with far less machinery.
**Validation:** Design-level spike: for each target provider, enumerate how (a) message-injection
and (b) per-request `tools` mutation behave w.r.t. native tool calls, validation, and caching.
→ Feeds a D1 ADR on mounting mechanics.
**Evidence:** 2026-08-09 (research-scout, Q-BASE-2/3): the baseline makes option (b) trivial —
pi's `agent.state.tools` is explicitly mutable between turns, `pi.setActiveTools()` changes the
active set mid-session, and `pi-ai` adapts the tool list to native tool-calling per provider
(25+). Message-injection (blueprint §3.2) is therefore likely unnecessary machinery on this
substrate; the spike should now compare (b)'s caching behavior across providers rather than
rescue (a). Remaining before status change: cache-interaction enumeration (ties to A-02).
**Evidence (2026-08-09, research-scout — this closes the assumption as BUSTED-in-favour-of-(b)):**
Message-injection is not merely unnecessary machinery, it is **obsolete**. Both major providers ship
append-at-end, cache-preserving *native* deferral (Anthropic `defer_loading` + `tool_reference`, GA;
OpenAI `tool_search`/`defer_loading` on gpt-5.4+), and pi-ai already routes additive `setActiveTools`
changes onto it (0.80.7, 2026-07-14). Text-injected schemas would forfeit provider-side argument
validation, constrained decoding, and parallel tool calls — and would require hand-parsing pseudo-calls
for every one of the 25+ providers pi-ai already adapts (critic F20). The blueprint's §3.2 injection
strategy is additionally **self-contradictory with its own §3.3 eviction table**: unmounting an
injected schema means either deleting a message from mid-history (invalidating the prefix *and* risking
orphaned `tool_use`/`tool_result` pairs, which providers reject) or leaving it and appending a
retraction (monotonic context growth — paying for the schema *and* its withdrawal). TURN_BASED eviction
maximizes whichever horn you pick; the blueprint never notices (critic F19).
**Status:** BUSTED as stated (message-injection) → **the per-request `tools`-param path (option b) is
the decided mechanism**, via pi's additive `setActiveTools` + native deferred loading. Cache behavior
now tracked in A-02 and R-14, not here.

## A-04 — An aggregator LLM preserves action-critical fidelity · CRITICAL
**Claim:** Compressing sub-agent output through a lightweight LLM keeps everything the Top Agent
needs to act correctly.
**Why doubtful:** Lossy compression is a silent failure mode (risk R-03) — errors look like clean
summaries.
**Validation:** Golden-set eval: N sub-agent raw outputs → aggregate → have the Top-Agent-role
model make the downstream decision from (raw) vs. (aggregate); diff the decisions. Define the
acceptable divergence threshold before running. **Amended 2026-08-09 (critic F26): the eval must
deliberately seed buried decision-flipping details** — a skipped unparsed file, a non-zero exit code, a
truncated list, a permissions error — and count how many surface in the omissions field. Below ~90%
invalidates the mitigation as written. Also measure the **pull rate** (see below).
**Evidence:** 2026-08-09 — descoped from the MVP (ADR-0004 / Q-WHAT-3) but two findings are worth
recording now, because they change what a future D3 attempt must prove:
- **The R-03 mitigation is unsound as written (critic F26).** Structured "omissions/uncertainty" fields
  can only report *known* omissions; the decision-flipping detail is characteristically one the
  aggregator never registered as salient. Worked example: a sub-agent reports "found 12 call sites, all
  under src/legacy, safe to remove" and silently drops that one `.tsx` file failed to parse and was
  skipped. The omissions field is empty *precisely because* the aggregator does not know what it does
  not know; the trace shows a clean, confident summary and the build breaks.
- **The pull-escape-hatch paradox (critic F27 → R-24).** "Raw retrievable on demand" only helps when the
  Top Agent *suspects* loss. Rarely suspects → savings with silent errors; often suspects → the raw
  output re-enters context and the savings evaporate *on top of* an already-paid aggregator pass. There
  is no configuration yielding both.
- **Delegation seam (research-scout):** pi core ships **no** subagent/task/delegate tool — only
  bash/edit/edit-diff/find/grep/ls/read/write — and the README states the philosophy: users build
  "features like sub-agents and plan mode via extensions rather than core inclusion". What pi does
  provide is a *usage-accounting contract*, not a spawn API: "If a tool makes nested LLM calls, return
  their combined `Usage` as `usage`." The ecosystem has filled the slot ~8× over (pi-subagents 0.44.0,
  @gotgenes/pi-subagents 19.2.1, @narumitw/pi-subagents, @tintinweb/pi-subagents, pi-crew,
  pi-background-tasks, @quintinshaw/pi-dynamic-workflows, pi-fabric). So A-04 is not *blocked* — it is
  **dependent and crowded**, and its only defensible delta is the compression contract itself, not
  delegation. This also makes A-09 cheaper to defer: in-process nested sessions are demonstrably normal
  in this ecosystem.
**Status:** UNVALIDATED — **consciously ACCEPTED-UNVALIDATED for v1** (aggregator cut per ADR-0004;
reopen trigger recorded in Q-WHAT-3)

## A-05 — Hybrid retrieval (semantic + exact tags) beats either alone at our scale
**Claim:** The two-layer registry (vector + KV) is necessary, not just elegant.
**Validation:** Retrieval eval over a realistic tool catalog: recall@k for semantic-only vs.
tag-only vs. hybrid, on a query set drawn from real task phrasings. **Amended 2026-08-09: add two
control arms — brute-force cosine (no vector store) and "the model picks from a names+one-liner list"
(A-13) — before adopting any index dependency.**
**Evidence:** 2026-08-09 (research-scout): **index choice is scale-dependent and the evidence
conflicts, so it must be measured rather than assumed.** At 584 tools, BM25 was the *weakest*
retriever (32.8% F1 vs. 52.5% for text-embedding-3-large and 48.7% for ToolRet-e5, arXiv:2606.17519) —
yet Anthropic's GA tool search deliberately ships **regex and BM25**, not embeddings
(`tool_search_tool_regex_20251119`, `tool_search_tool_bm25_20251119`), and pi's own example uses simple
keyword matching while noting the implementation "could use BM25, embeddings, a remote catalog, or
project-specific routing". Embedding shortlisting at k=20 recovered +10.0–11.3pp F1 on synthetic
584-tool sets and +9.8–16.5pp on 1,435 human-annotated production utterances. At our scale a few
hundred tools is trivially brute-forceable — ANN is not needed — so the cheapest defensible shape is a
swappable index interface with a zero-dependency in-memory cosine baseline.
**Status:** UNVALIDATED

## A-06 — Configurable eviction policies matter in practice
**Claim:** Real sessions need TURN_BASED / AUTONOMOUS / TIMEOUT modes; a single default is insufficient.
**Validation:** Trace real or synthetic sessions under one naive policy first; measure re-mount
thrash and stale-mount rates. If one policy covers ~95% of sessions, the policy engine moves to a
later phase.
**Evidence:** 2026-08-09 — **external evidence now cuts against this assumption from two directions.**
(1) research-scout: *every* shipping production design is additive and monotonic — Anthropic deferred
loading, OpenAI tool search, VS Code Copilot "virtual tools" (auto-grouping past a threshold, driven by
a hard 128-tool-per-request cap) — and **none does per-turn eviction**. (2) The provider mechanics make
eviction actively expensive: non-additive changes (removals or replacement) **never** use deferred
loading, so any unmount forfeits the cache-preserving path and invalidates the prefix. Eviction is
therefore not merely unproven, it is the one operation the substrate penalizes.
**Counter-consideration to keep honest (critic F9):** monotonic growth means a long session converges
toward the full catalog, so savings decay to zero exactly where they matter most — by hour two you run
the full catalog *plus* N cache events *plus* N extra round-trips. Capping the mounted set requires
eviction, which reopens this assumption. The measurable question is therefore not "do we need three
policies" but "does p90 distinct-tools-used per session approach catalog size?" — computable from
baseline traces with no new code.
**Status:** UNVALIDATED (leaning BUSTED for the *policy engine*; the cap-vs-growth question is live)

## A-07 — An embedded registry can match containerized Qdrant/Redis at MVP scale · CRITICAL
**Claim:** Embedded/in-process vector + KV (e.g. sqlite-vec, LanceDB, in-memory embeddings over
tool definition files) meets recall and latency needs without Docker infrastructure — or, if not,
the containers are worth their dev-loop cost.
**Source of tension:** Blueprint §3.1 mandates containerized services; Q-HOW-3 questions the cost.
**Validation:** Spike in `docs/probes/A-07/`: index a realistic catalog both ways; measure recall,
latency, and setup friction. → Feeds ADR-0002.
**Evidence:** 2026-08-09 (research-scout) — **favorable to "no Docker", but every embedded option is
pre-1.0, which matters for an OSS deliverable.**
- `sqlite-vec` is **0.1.10-alpha.4**, author warns of breaking SQL-API and storage-format changes until
  1.0; a third-party Node-only hardening fork exists (`@photostructure/sqlite-vec` v1.1.1).
- `@lancedb/lancedb` **0.33.0** is the most production-shaped (prebuilt binaries for Linux x64/arm64
  glibc+musl, macOS Intel/ARM, Windows x64/arm64; ~425 dependents; used by Continue.dev) — still 0.x and
  adds a native-binary install step.
- **SQLite upstream now has its own vector extension, Vec1** (v0.7, single-file loadable C extension,
  IVFADC+OPQ, SIMD for x86/ARM/WASM) — but **announced, not released** ("There is still no vec1
  release", Dan Kennedy, SQLite forum 2026-03-30). Reason to keep the index layer swappable, not a
  dependency today.
- Bindings substrate is fine on pi's floor: `node:sqlite` is Stability 1.2 RC, and
  `loadExtension()`/`allowExtension` landed in v22.13.0 — available on pi's Node ≥22.19 (note
  `allowExtension` defaults to false).
- Local embeddings in TS are real and cheap: `transformers.js` runs ONNX `all-MiniLM-L6-v2` (384-dim,
  ~23MB) — degrades past ~128 tokens and caps at 256, which is fine for tool descriptions;
  `fastembed-js` is archived, maintained path is `@mastra/fastembed`; model2vec is Python-first with
  only community ONNX exports.
**Conclusion for ADR-0002:** the blueprint's containerized Qdrant/Redis has **no infrastructure
justification at MVP scale** — nothing here needs Docker. But 0.x/alpha/unreleased dependencies are a
real supply-chain and churn risk for a package aimed at installability (Q-WHO-1), and the critic's F8
notes a native prebuilt binary is exactly the "npm install fails on my machine" class of adoption death.
**Cheapest defensible shape: a swappable index interface with a zero-dependency in-memory brute-force
cosine baseline** — a few hundred tools is trivially brute-forceable, ANN is unnecessary at our scale —
with sqlite-vec / LanceDB / Vec1 as later backends. A-05 should be tested against brute-force cosine
before any vector-store dependency is adopted.
**Status:** UNVALIDATED (embedded viability strongly indicated; our own micro-probe still needed, since
no 2026 head-to-head recall/latency benchmark of these three at 100–1,000 items was found)

## A-08 — The baseline agent's existing language/stack suffices · CRITICAL
**Claim:** The Orchestrator, registry, and lifecycle can be built in whatever the forked baseline
is written in — no second language (Python/LangGraph per blueprint directive 4) required.
**Validation:** After Q-BASE-2 is answered: capability scan mapping each blueprint capability →
the library/pattern available in the baseline's ecosystem → genuine gaps. → Feeds ADR-0002.
**Evidence:** 2026-08-09: Q-BASE-2 answered — baseline is **TypeScript/Node ≥22.19**, directly
contradicting blueprint directive 4 (Python/LangGraph/FastAPI). Pi already provides the agent
loop, provider abstraction, tool mutation seams, and event bus in TS; a second language would
forfeit exactly those seams. Capability scan (blueprint capability → TS library/pattern → gaps)
still to run — main open cells: embedded vector search (sqlite-vec/LanceDB have TS bindings) and
eval tooling.
**Status:** IN-PROGRESS

## A-09 — Sub-agent isolation (separate execution environments) is required for v1
**Claim:** Blueprint §4 mandates isolated environments for sub-agents from the start.
**Why doubtful:** For an MVP whose sub-agents are your own code, context isolation (separate
conversations) may be enough; OS/container isolation adds infrastructure before the thesis is proven.
**Validation:** Failure-mode analysis: what concretely goes wrong with in-process sub-agents for
the chosen MVP (Q-WHAT-2)? Defer OS-level isolation unless a specific hazard is named.
**Evidence:** _
**Status:** UNVALIDATED

## A-10 — The blueprint maps onto the baseline agent without a rewrite
**Claim:** Top Agent ≈ the baseline's main loop; Orchestrator ≈ an interceptable seam in that
loop; Registry ≈ its tool table + a new index. The fork is an extension, not a reconstruction.
**Validation:** After Q-BASE-1/2/3: one-page module-boundary mapping (blueprint module → baseline
module → new/changed responsibility). architecture-critic reviews it.
**Evidence:** 2026-08-09: Q-BASE-1/2/3 answered; prima facie the mapping is favorable — Top Agent
≈ pi's `Agent` loop; Orchestrator ≈ extension using `setActiveTools`/`transformContext`/
`before_provider_request`; Registry ≈ new component feeding `registerTool`. Pi ships mounting
*mechanics*; DTCM adds *policy*. The one-page mapping + architecture-critic review still to do.
Open hole to check: does `setActiveTools` state survive session resume/compaction? — **promoted
2026-08-09 to its own row, A-11**, because the Q-WHAT-1 decision (staged O5→O1) makes it a Stage B
feasibility gate rather than a footnote.
**Status:** IN-PROGRESS

## A-11 — Mount state survives session resume and compaction · CRITICAL
**Claim:** A tool set selected via `pi.setActiveTools()` / registered via `pi.registerTool()`
mid-session persists across (a) session resume from the JSONL tree and (b) automatic or manual
context compaction — or, if it does not, a shim can restore it deterministically from the trace.
**Why it matters now:** Stage B of the Q-WHAT-1 decision mounts tools progressively within a
session. If the mounted set silently resets on resume/compaction, the model retains tool-call
history for tools it can no longer call → stale-call failures (M6, R-05) and a reliability claim
DTCM cannot make. Promoted from the A-10 open hole.
**Why doubtful:** pi's compaction is lossy-by-design over history, and sessions are a persisted
JSONL tree; extension-held runtime state is a different lifetime from session state.
**Validation:** Micro-probe in `docs/probes/A-11/` (hours, not days — rides along with Stage A):
register + activate a distinctive tool subset, then (1) `/compact` and inspect the active set and
the next provider request's `tools` param, (2) end and resume the session, inspect again. Read
pi's session/compaction source to confirm the mechanism rather than inferring from behavior alone.
**Evidence (2026-08-09, research-scout — the docs and the source disagree, and the official example
would make it fail regardless):**
- **The docs say NO:** `docs/extensions.md` states plainly that "Active tool changes do not
  automatically persist across session boundaries" and instructs extensions to reconstruct state in
  `session_start` (fired when a session is started, loaded, *or reloaded*).
- **The harness source says the mechanism EXISTS:** `packages/agent/src/harness/session/types.ts`
  defines `ActiveToolsEntry extends EntryBase { type: "active_tools_change"; activeToolNames: string[] }`
  as a persisted session entry appended via `SessionStorage.appendEntry()`, and
  `packages/agent/src/harness/reducer.ts` replays it — `case "active_tools_change": configuration =
  { ...configuration, activeToolNames: [...entry.activeToolNames] }`. The deferred-load anchor is also
  persisted: `packages/ai/src/types.ts` gives `ToolResultMessage.addedToolNames?: string[]` ("names from
  `Context.tools` that became available after this result"), written by `agent-loop.ts`.
- **A documentation contradiction to be aware of:** the coding-agent's own `docs/session-format.md`
  enumerates ten entry types with **no** `ActiveToolsEntry`, and prints a `ToolResultMessage` schema
  **without** `addedToolNames`. The doc lags the code, or the CLI's format genuinely differs from the
  harness's. Either way `session-format.md` cannot be cited for A-11.
- **The self-inflicted failure mode — the most actionable finding here:** pi's own official
  `search_tools` example calls `pi.setActiveTools([...initialTools, "search_tools"])` **inside
  `session_start`**, which would *clobber* whatever the reducer replayed. An extension that copies the
  documented pattern verbatim resets the mounted set on every resume — A-11 fails by our own hand, not
  by pi's design. **Binding design note for Stage B: never blindly `setActiveTools` in `session_start`;
  reconcile with the replayed set.**
- **Compaction remains genuinely unresolved (not merely uncertain):** `docs/compaction.md` documents
  thresholds (`reserveTokens` 16384, `keepRecentTokens` 20000) and that "tool results are truncated to
  2000 characters during serialization", but says nothing about tool state. Whether a summarized-away
  loader tool result takes its `addedToolNames` anchor — and the native `tool_reference` position —
  with it is unverified, and if it does, the next request falls back to sending the full tool list,
  which is precisely the R-01 cache tell. No test covers it: `test/agent-session-dynamic-tools.test.ts`
  has four cases, none referencing resume, reload, switchSession, compact, or cache.
- Registered tools themselves are process-lifetime objects from extension load, so `registerTool`
  survives resume only because extensions re-run.

**Probe now shrinks from "discover the mechanism" to "confirm two cells":** (a) activate a distinctive
subset, grep the live session JSONL for `active_tools_change` to settle the doc-vs-source contradiction,
then resume and compare both `getActiveTools()` **and** the next `before_provider_request` payload's
`tools` array; (b) `/compact` and re-check, watching specifically for a fallback to sending the full
active list.
**Status:** IN-PROGRESS (mechanism to survive resume exists in source and is replayed; end-to-end CLI
behavior unconfirmed; **compaction interaction unresolved**)

## A-12 — Pi's event bus exposes the token accounting the trace event needs · CRITICAL
**Claim:** Pi's event bus / telemetry surfaces per-turn provider usage — prompt, completion,
**cached_read and cache_write** — at a granularity that lets tokens be attributed to tool
definitions, without patching pi.
**Why it matters now:** the entire Stage A thermometer (B2, B3, B6, and the A-02 cache model) rests
on it. If cache fields are not exposed, "net cost after cache effects" cannot be measured on this
substrate, and the M1 metric is unmeasurable rather than merely unmet.
**Why doubtful:** cached-token fields are provider-specific and often dropped by abstraction layers;
pi-ai normalizes across 25+ providers, and normalization is exactly where such fields get lost.
**Validation:** Read `packages/telemetry` + the pi-ai usage types; subscribe to the event bus in a
`docs/probes/A-12/` probe and dump one real turn's usage object per target provider. Fallback if
absent: compare measured prompt-token counts with and without the catalog attached (B2 method) and
record cache accounting as a known blind spot in the baseline report.
**Evidence (2026-08-09, research-scout — YES on the critical clause):** pi-ai's normalized `Usage`
type keeps the cache fields end-to-end across all 25+ providers:
`{ input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost:{input, output,
cacheRead, cacheWrite, total} }` — including a **separate `cacheWrite1h` bucket for extended-TTL
caching**. These reach the extension event bus via `message_end` (carries `usage`) and the
`pi.ai.request` telemetry span (`pi.ai.usage.input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_write_tokens`, `reasoning_tokens`, `total_tokens`, `cost`). Version dates: 0.81.0 (2026-07-21)
persisted tool/compaction/branch-summary usage in session totals; 0.84.0 (2026-08-06) added
vendor-neutral telemetry contracts. **So B2/B3/B6/M1 and the A-02 cost model are measurable without
patching pi.**

Three consequential caveats:
1. **Build Stage A on the event bus, not on telemetry spans.** `packages/telemetry` ships only
   `NOOP_TELEMETRY_CONTEXT` and `InMemoryTelemetryContext` — no production exporter — and no documented
   way to install a `TelemetryContext` into the **CLI** (the only telemetry env var, `PI_TELEMETRY`,
   governs install/update telemetry and provider attribution headers, not the span pipeline). This is
   why all 6+ existing community observability packages attach as event-bus subscribers instead. The
   event bus exposes 33 events including `turn_start`, `turn_end`, `context` ("before each LLM call"),
   `before_provider_request` (the assembled payload, replaceable — docs call it "mainly useful for
   debugging provider serialization and cache behavior"), `after_provider_response`, `message_end`,
   and `tool_result`.
2. **Tool-definition attribution does NOT ship** — there is no field anywhere between "total input
   tokens" and "which tool ran": no per-region attribution, no active-tool count, no catalog size.
   This confirms the critic's F7/N-10 and **fixes M2's method**: count/diff the serialized `tools`
   array at `before_provider_request` rather than reading any provider usage field. That method must
   carry a stated error bar (see R-21).
3. **A free R-01 observable exists:** the span attribute **`pi.ai.deferred` (boolean)** gives a
   native-deferred hit/miss signal per request — exactly the missing `cache_miss_cause` signal the
   critic demanded, at least for the deferred/not-deferred axis. Also `pi.ai.stream.time_to_first_chunk_ms`
   supplies the prefill/TTFT split (critic F6 item 6), and `pi.tool.*` attributes (`name`, `call_id`,
   `replay`, `recovery`, `is_error`) supply tool-call outcomes for M6.
4. **Privacy constraint, inherited:** pi-telemetry's contract permits primitives only and explicitly
   prohibits prompts, tool arguments, and outputs in attributes. Any DTCM trace that carries `query`
   must therefore be opt-in and redacting by design → R-18.
**Confirmed end-to-end 2026-08-09 (probe, not inference):** the usage object is persisted **directly in
the session JSONL** — e.g. `{"input":2607,"output":103,"cacheRead":0,"cacheWrite":0,"totalTokens":2710,
"cost":{"input":0.00453618,...,"total":0.00489462}}` — across 1,783 message entries in the user's real
history. So cache-aware cost measurement requires **no instrumentation at all** for retrospective work;
the event bus is only needed for live per-turn attribution.
**Status:** **VALIDATED** (end-to-end, from real session data). Residual: *tool-definition* attribution
is still our work, not pi's (method + error bar in `05-metrics.md` §3b).

## A-13 — Retrieval-based selection beats the boring alternatives · CRITICAL
**Claim:** Retrieval/search-driven tool selection (a `search_tools` index) delivers materially better
outcomes than the two designs that need no index at all:
(i) **static profiles** — named tool bundles chosen at session start (`pi --profile git`, or a `/tools`
command) driving `setActiveTools` once; and
(ii) **capability index + explicit mount** — names plus one-line descriptions in the *stable cached
prefix* (~15 tokens/tool ⇒ ~3k tokens for 200 tools versus ~50k for full schemas, a 94% reduction),
plus a single `mount_tools(names[])` tool.
**Source of tension:** architecture-critic F41 — nobody has costed the 80% design, so the entire delta
of the retrieval branch is currently unjustified. Static profiles have the **best cache profile of any
option on the table** (c = 0, stable prefix from turn 1, and a *smaller* prefix than the cached full
catalog); the capability index simultaneously answers Q-WHAT-4, mitigates R-10/R-11, and deletes the
index and therefore all of R-07 and the retrieval hop. The model already reads and reasons — it may not
need BM25 to pick from a 200-line list.
**Why doubtful in the other direction (stated fairly):** static profiles fail the exploratory session
where the user genuinely does not know what they will need, and require someone to author and maintain
bundles — but they fail **loudly** (tool missing → user types `/tools`) rather than silently, which the
debuggability anti-metric prefers.
**Validation:** Make the boring designs the **control arm** in the A-01/A-05 probes rather than an
afterthought. Measure recall@5 for (a) BM25 over descriptions, (b) embeddings, (c) the model choosing
from a names+one-liner list, on one fixed ≥30-query set. Also, from baseline traces: count sessions
whose tool usage spans more than one plausible profile — if most stay inside one bundle, profiles
capture the bulk of the value at ~2% of the cost. Separately (20 min): grep pi's config schema and docs
for an existing tool enable/disable/allowlist, which may already ship design (i) (critic F42).
**Weak external evidence already in hand:** every shipping production design found by the scout is
additive/monotonic — Anthropic deferred loading, OpenAI tool search, VS Code "virtual tools" — and
**none does per-turn eviction or re-selection**; and the Meta study (A-01) shows aggressive top-k
*hurts*. Both cut toward the boring end of the spectrum.
**Evidence:** 2026-08-09 (baseline probe) — **strongly supported on the measured workload: the boring
alternative already won.** Across 81 sessions, distinct tools used per session is p50 **3**, p90 **4**,
max 10, from a catalog of ~20; and four tools (bash, read, write, edit) account for **98.1% of all 1,956
tool calls**. **pi's default core tool set already is the correct static profile for this workload** —
there is no selection problem at this scale, only a selection *cost*. Neither a retrieval index nor a
capability index could beat "leave ~20 tools mounted and let the cache serve them" when 91.1% of prompt
tokens are already cache reads. Not yet tested: recall@5 across BM25 / embeddings / brute-force cosine /
names-list on a fixed query set (needed only if a larger catalog re-opens the economics), and the grep for
an existing pi tool allowlist.
**Update 2026-08-09 (critic F42 confirmed — pi already ships design (i)):** `pi --help` documents
**`--tools <list>` (allowlist), `--exclude-tools <list>` (denylist), `--no-tools`, and
`--no-builtin-tools`**, all applying to built-in, extension, and custom tools alike. **Static tool
profiles therefore already exist in the substrate at the CLI level** — no build required. Any selection
layer must beat `pi --tools read,edit,bash`, which has zero moving parts and a stable cached prefix from
turn one. This strengthens A-13 considerably: the 80% design is not merely cheap, it is already shipped.
**Status:** UNVALIDATED as a general claim, but **the control arm dominates on the measured catalog** —
which is why Stage B's shape is now moot pending the target-catalog decision (see
`docs/gate-reports/baseline-2026-08-09.md` §6)

## A-14 — Deferred tool definitions are not billed as prompt tokens · CRITICAL (economics only)
**Claim:** On native deferred loading (Anthropic 4.5+, OpenAI Responses gpt-5.4+, Kimi), a tool marked
`defer_loading: true` costs no prompt tokens until it is discovered.
**Why it matters:** it is the load-bearing assumption behind ADR-0006's "JIT native" cost column. Anthropic
still requires every definition in the request's `tools` array; the docs say deferred ones are "excluded from
the system-prompt prefix", which is a statement about *caching*, not explicitly about *billing*. The vendor's
"~85% token reduction" claim implies they are not billed.
**Validation:** ~1 hour, ~$1 — two API calls with identical history, one with definitions deferred and one
without; read the `usage` fields. **Not run.** Deprioritised when the project reframed from token economics to
capability governance (ADR-0007), where this claim is no longer load-bearing.
**Evidence:** _
**Status:** UNVALIDATED — **consciously deferred** (no longer on the critical path; would only matter if the
cost thesis is revived)

## A-15 — `bash` functionally subsumes the file and search tools · CRITICAL
**Claim:** A session holding `tool:bash` can already do everything `grep`, `find`, `ls`, `read`, `write`,
`edit` do — so a grant containing `bash` is **not** a narrow grant, whatever its list says.
**Why it matters:** without modelling this, governance produces both false positives and a false sense of
safety. False positive: pi's *default* surface is only `read`, `bash`, `edit`, `write` (A-16), so an agent
type declaring `tools: read, grep, find, ls` looks like an escalation from any normal parent despite being
strictly weaker. False safety: a reviewer reading "grant: read, bash" sees two capabilities and infers
narrowness that does not exist.
**Validation:** VALIDATED by inspection and encoded as `SUBSUMPTION` in `packages/pi-daddy/src/resolve.ts`,
with `ResolveResult.subsumedBy` reporting what a parent covers only indirectly. Tested (`resolve.test.ts`).
**Open question deliberately left open:** whether `bash` should be promoted to a *universal* capability
alongside `fabric_exec`. It is not literally universal — a bash-only child still cannot spawn agents — but for
file operations it is total. Currently modelled as subsuming rather than universal, and flagged.
**Status:** VALIDATED (and mitigated)

## A-16 — pi's `--tools` / `--no-tools` hard-enforce against extension tools · CRITICAL
**Claim:** pi core's allowlist flags cannot be circumvented by an extension re-registering or re-activating
its own tool, so they are a trustworthy enforcement point for capability grants.
**Why it matters:** the entire `pi-daddy` design rests on it. If extensions could re-add tools past the
allowlist, enforcement would have to live inside each descendant session — which is what the original spec
assumed, and what dragged in the grant-propagation problem and the `isolated`-disables-governance hole.
**Evidence (2026-08-09, measured — `docs/probes/pi-fabric-eval` probes 9–11):**
`pi --tools read -e npm:pi-fabric` → the model **cannot** call `fabric_exec` (`NO_FABRIC_TOOL`);
`pi --no-tools -e npm:pi-fabric` → likewise blocked; no flag → `fabric_exec` works. An explicitly `-e`-loaded
extension therefore cannot re-add its tool past the allowlist. Independently confirmed end to end: a child
spawned with a `["tool:read"]` grant reported `NO_WRITE_TOOL` and created no file.
**Related measured fact:** pi's **default** tool surface is only `read`, `bash`, `edit`, `write` — `grep`,
`find`, and `ls` exist but are not exposed by default.
**Status:** VALIDATED

---

## Register log

| Date | ID | Change | By |
| :--- | :--- | :--- | :--- |
| 2026-08-08 | A-01…A-10 | Seeded from the blueprint's load-bearing claims | kickoff kit |
| 2026-08-09 | A-03, A-08, A-10 | → IN-PROGRESS with research-scout evidence from Q-BASE-1/2/3 (pi = TS/Node, mutable per-turn tools, extension seams) | kickoff |
| 2026-08-09 | A-11 | Added CRITICAL — mount state vs. session resume/compaction; promoted out of A-10's open hole because it gates Stage B of the Q-WHAT-1 decision | brainstorm (Q-WHAT-1) |
| 2026-08-09 | A-12 | Added CRITICAL — pi event bus must expose cached_read/cache_write usage or Stage A cannot measure net cost (M1) | brainstorm (Q-WHAT-1) |
| 2026-08-09 | A-03 | → **BUSTED as stated**: message-injection is obsolete; native deferred loading (Anthropic GA / OpenAI gpt-5.4+ / Kimi) already routed by pi-ai 0.80.7. Decided mechanism = additive `setActiveTools` | research-scout |
| 2026-08-09 | A-12 | → **VALIDATED** (doc/source): pi-ai `Usage` keeps cacheRead/cacheWrite/cacheWrite1h across 25+ providers; caveats — use the event bus not spans, tool-def attribution is ours, `pi.ai.deferred` is a free R-01 observable | research-scout |
| 2026-08-09 | A-11 | → IN-PROGRESS: harness source persists+replays `active_tools_change`, but docs say state does not persist and pi's own `search_tools` example would clobber it in `session_start`; compaction interaction unresolved | research-scout |
| 2026-08-09 | A-01 | Evidence added: measured elbow 40–60 tools; **~10pp non-recoverable confusion gap caps any selection layer**; our 10–40 band unmeasured in literature; probe must pad ≥100 | research-scout |
| 2026-08-09 | A-02 | Evidence added: break-even **S > 11.5·c·C** (B1 becomes a spreadsheet kill test, ~110 tools needed); prefix-position resolved as provider-conditional → R-14, R-15 | architecture-critic + research-scout |
| 2026-08-09 | A-05, A-07 | Evidence added: BM25 weakest at 584 tools yet Anthropic ships regex/BM25; all embedded TS vector stores pre-1.0; brute-force cosine is the control arm; no Docker justified | research-scout |
| 2026-08-09 | A-06 | Leaning BUSTED for the policy engine: no shipping production design does per-turn eviction, and non-additive changes forfeit the cache-safe path | research-scout + critic |
| 2026-08-09 | A-04 | → ACCEPTED-UNVALIDATED for v1; R-03 mitigation shown unsound as written; pi has no core subagent seam but ~8 ecosystem packages do | critic + research-scout |
| 2026-08-09 | A-13 | Added CRITICAL — the boring alternatives (static profiles; capability index + explicit mount) must be beaten; they are the control arm, and one of them may already ship in pi | architecture-critic (F41/F42) |
| 2026-08-09 | A-02 | → **BUSTED for the measured catalog** — baseline probe on 82 real sessions: ~20 tools, p50 context ~50k, cache read:write 114:1 ⇒ JIT loses 5×–102×; one mount = 4.2× a median session's cost | `docs/probes/baseline/` |
| 2026-08-09 | A-12 | → **VALIDATED end-to-end** — usage with cacheRead/cacheWrite/cost is persisted in session JSONL; retrospective cost measurement needs no instrumentation | `docs/probes/baseline/` |
| 2026-08-09 | A-13 | Control arm **dominates on the measured workload**: p90 = 4 distinct tools/session from ~20; four tools = 98.1% of calls; pi's default set already is the right profile | `docs/probes/baseline/` |
| 2026-08-09 | A-14 | Added, then **consciously deferred** — deferred-token billing stopped being load-bearing when ADR-0007 reframed away from cost | ADR-0006/0007 |
| 2026-08-09 | A-15 | Added **VALIDATED** — `bash` subsumes the file/search tools, so a grant containing it is not narrow; encoded as `SUBSUMPTION` + `subsumedBy` | `pi-daddy` |
| 2026-08-09 | A-16 | Added **VALIDATED** — pi's `--tools`/`--no-tools` hard-enforce against extension tools (probes 9–11); pi's default surface is only read/bash/edit/write | `docs/probes/pi-fabric-eval` |
