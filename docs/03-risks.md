# D0 Risk Register

Reviewed at every gate. Each risk carries an **early-warning trigger** — a concrete observable,
not a feeling. architecture-critic owns adversarial review of this list.

**Severity = likelihood × impact (H/M/L).**

---

## R-01 · Cache-invalidation economics negate token savings — H×H
Mount/unmount churn breaks prompt-cache prefixes; "smaller context" can cost more than a large
stable cached one.
**Mitigation:** validate A-02 before design freeze; design mounting to keep a stable prefix
(mount region at the END of context, or per-request `tools`-param strategy per A-03).
**Trigger:** the cost model shows JIT ≥ cached-full-catalog cost at realistic turn counts.
**Update 2026-08-09 — the mitigation text was wrong and is corrected here.** "Mount region at the END
of context" is **not achievable by us** with native tool-calling: the `tools` array sits at the *head*
of the cacheable prefix (tools → system → messages), so any change to it invalidates everything
downstream (critic F1). What *is* achievable is the providers' own escape hatch, which pi already
routes to: Anthropic `defer_loading` + `tool_reference` (GA) and OpenAI `tool_search`/`defer_loading`
(gpt-5.4+) exclude deferred definitions from the prefix and append discovered tools at the load point,
preserving the cache — pi-ai 0.80.7 maps additive `setActiveTools` changes onto this. **Two hard
constraints follow:** changes must be additive (removals never use deferred loading, so eviction
forfeits cache safety), and a tool carrying `promptSnippet`/`promptGuidelines` rebuilds the system
prompt and breaks the prefix even on native models. The quantitative form of this risk is now A-02's
break-even inequality **S > 11.5·c·C**. See R-14/R-15 for what this risk splits into.

## R-02 · Latency stacking degrades UX beyond budget — M×H
Retrieval + mount round-trip + aggregator pass on every delegated turn.
**Mitigation:** Q-HOW-1 budget becomes an acceptance criterion in every D1 spec; measure in the
walking skeleton (D2) before adding layers.
**Trigger:** skeleton p95 added latency > budget.

## R-03 · Aggregator lossiness causes silent wrong decisions — M×H
Compressed sub-agent reports drop the one detail that mattered; failures look like clean summaries.
**Mitigation:** A-04 golden-set eval; aggregator outputs carry structured "omissions/uncertainty"
fields; raw output stays retrievable on demand (pull, not push).
**Trigger:** eval divergence above the agreed threshold; any incident traced to a summary.

## R-04 · Orchestrator becomes a complexity magnet / debugging black box — M×H
A second brain between user and model; three places to look for every bug.
**Mitigation:** observability is a Phase-1 feature, not polish (blueprint §4 agrees): per-turn
trace of {query → retrieval hits → mounts → calls → evictions}; replayable traces.
**Trigger:** the first debugging session that takes > 1 hour because the mount state at failure
time is unknowable.

## R-05 · Eviction thrash / stale-schema calls — M×M
A tool unmounted mid-task then re-mounted repeatedly; or the model calls a tool evicted two turns ago.
**Mitigation:** validate A-06 with traces before building three policies; the D1 state machine
must define behavior for "call to unmounted tool".
**Trigger:** thrash rate (re-mount of the same tool within N turns) above threshold in skeleton traces.

## R-06 · Platform convergence erodes the delta — M×M
Providers keep shipping native dynamic-tool features (tool search, MCP dynamic tool lists,
server-side context management). The custom layer's moat shrinks while it's being built.
**Mitigation:** `04-landscape.md` refreshed by research-scout at every gate; ADR-0001 records what
we deliberately DON'T build.
**Trigger:** a native feature covers a planned MVP capability before D2 ships.
**⚠ TRIGGER FIRED 2026-08-09 — and not only at the provider, at the substrate.** (1) Anthropic's tool
search is **GA** (not beta) with published results: MCP-eval accuracy 49%→74% (Opus 4), 79.5%→88.1%
(Opus 4.5), ~85% fewer tool-definition tokens; OpenAI ships near-parity on gpt-5.4+. (2) **pi itself
ships the O1 design as an official documented recipe**: `docs/extensions.md` has a "Dynamic Tool
Loading" section whose lifecycle is verbatim our Stage B — "Keep loader tools, such as `search_tools`,
active and leave searchable tools inactive… call `pi.setActiveTools([...currentTools,
...matchingTools])`. The change must be additive" — followed by a complete ~90-line worked example,
shipped in 0.80.7 (2026-07-14). **Consequence: the mounting *mechanism* is no longer a thing DTCM
builds.** What remains unclaimed is index/catalog quality, selection policy, and the evidence — see
ADR-0004's amended Stage B and ADR-0001's C1 cell. Counter-balance that keeps a home for the work:
native coverage is **not universal** — Google has no equivalent (open parity request), local models have
none, and support is version-gated (Sonnet 4.5+, gpt-5.4+) — so a policy layer for a multi-provider
agent is still unclaimed ground.

## R-07 · Registry drift: index stale vs. tool definitions — M×M
Tool/skill definitions evolve at their source while the semantic index holds yesterday's
descriptions — a second copy of truth.
**Mitigation:** Q-WHERE-3 names the single source of truth; the D1 registry spec defines reindex
triggers (e.g. content hash on load).
**Trigger:** retrieval returns a tool whose definition no longer matches what was indexed.

## R-08 · Scope creep into a framework rewrite — H×M
The blueprint invites building an "Agentic OS": new stack + new infra + forked agent, all at once.
**Mitigation:** Q-WHAT-2 forces a smallest-MVP definition; ROADMAP gates; ADR-0003 picks ONE
runtime home.
**Trigger:** any D1 spec that requires touching > 2 of {new service, new datastore, new language,
new agent fork}.

## R-09 · Two-stack maintenance burden — M×M
An orchestrator in a different language than the baseline agent doubles CI, types, deploy paths,
and context-switching for a small team.
**Mitigation:** ADR-0002 decides language with A-08 evidence; default posture is "the baseline's
language wins unless a named capability gap says otherwise".
**Trigger:** an ADR-0002 draft landing on a second language without a gap listed in A-08's scan.

## R-10 · Schema-blind Top Agent under-delegates or hallucinates capabilities — M×H
The blueprint makes the Top Agent "completely unaware" of tools, yet it must know delegation is
possible and for what. Zero awareness → missed delegations, invented capabilities, vague
orchestrator queries.
**Mitigation:** Q-WHAT-4 decides the capability-index compromise (names + one-liners — cheap and
cache-stable); test under-delegation explicitly in D2.
**Trigger:** skeleton sessions where the Top Agent answers from priors instead of delegating a
delegable task.

## R-11 · Under-search: the model never calls `search_tools` — M×H
The R-10 failure mode in the shape the Q-WHAT-1 decision actually chose. Stage B's value depends on
the model *choosing* to call a meta-tool when it lacks a capability; instead it may answer from
priors, guess at a tool it cannot see, or claim the task is impossible. Silent by construction: the
trace shows a clean turn with no search call, so the miss looks like a decision.
**Mitigation:** measure it explicitly on the fixed goal set (goals whose completion *requires* an
unmounted tool → % where a search call occurred); keep a compact capability index (names +
one-liners, cache-stable — Q-WHAT-4) rather than zero awareness; make `search_tools`' description
state the obligation, and emit an explicit `no_search_this_turn` marker in the trace so absence is
visible as data.
**Trigger:** any goal in the fixed set completed (or refused) without a search call where the
required tool was unmounted.

## R-12 · Thermometer without a cure — M×M
Stage A ships or completes, Stage B never does: the knee is ambiguous, the gate never trips, or
attention moves on. DTCM's one OSS launch is then a measurement harness, which serves the community
far less than the thesis promised and burns the credibility that a benchmark buys.
**Mitigation:** Stage A's exit is a *decision*, not a report — the baseline report must end in
proceed-to-Stage-B / park (O6) / adjust, with the numeric knee threshold written down **before** the
data is collected so the decision cannot be rationalized after the fact; Stage B's design is small
enough (one extension, one meta-tool, append-only mounts) to remain reachable.
**Trigger:** baseline report exists for > 4 weeks with no recorded Stage-B/park decision.

## R-13 · Benchmark overfit to the author's own catalog — M×M
Q-WHY-1 grounds the baseline on the user's own pi setup while Q-WHO-1 makes the OSS community the
primary user. Numbers from one hand-built catalog can show a large win that no other pi user
reproduces — and a benchmark that does not reproduce is worse than none for adoption.
**Mitigation:** Stage A requires ≥1 catalog that is not the author's own (community/synthetic) and
publishes per-catalog numbers rather than an average; the fixed goal set and catalog manifests ship
with the results so anyone can rerun.
**Trigger:** any published DTCM number derived from a single catalog, or a win margin that differs
by more than a factor of two between catalogs.

## R-14 · Cache economics are provider-conditional — the same design wins and loses — M×H
Added 2026-08-09 (critic N-1, sharpened by scout evidence). Prefix preservation under tool mounting is
**the provider's** feature, not ours, and pi decides how to reach it. Anthropic (Sonnet/Opus/Haiku 4.5+),
OpenAI Responses (gpt-5.4+) and Kimi get native deferred loading and keep the cached prefix; **Google,
local models, and any provider outside that set fall back to sending `Context.tools` normally** and pay
full-prefix invalidation on every mount. So one benchmark number will recommend the right architecture
to some users and the wrong one to others.
**Mitigation:** every cost claim states its provider class; the trace records provider/model id and the
`pi.ai.deferred` flag so each turn is attributable to a regime; Stage B degrades explicitly (and says so)
on non-deferred providers rather than silently costing users money.
**Trigger:** a two-request probe (identical history, one extra tool) reports `cache_creation_input_tokens`
≈ full context rather than the delta on any target provider; or pi-ai's adapters show `cache_control`
placement is internal with no extension hook.

## R-15 · Cache-regime bifurcation: human pacing vs. cache TTL flips the verdict — M×H
Added 2026-08-09 (critic N-2). Provider prompt caches have short TTLs (Anthropic's default ~5 minutes;
pi-ai exposes a separate `cacheWrite1h` bucket for extended TTL). In a human-paced session a 6-minute
pause re-writes the whole cached prefix at ~1.25× base, and that cold-start cost **scales with catalog
size** — so a large stable catalog is expensive exactly where the "just cache the full catalog" argument
was supposed to win. In a rapid-fire agentic loop the cache stays warm and JIT loses by 1.6–2.4×. The
honest conclusion is that JIT wins in the cold-cache/large-catalog regime and loses in the
warm-cache/long-history regime.
**Mitigation:** A-02's cost model must be **parameterized by inter-turn think time**, and no cost claim
ships without its regime stated; the baseline capture records the distribution of inter-turn gaps.
**Trigger:** more than ~25% of baseline inter-turn gaps exceed the provider's cache TTL; or the cost
model yields opposite verdicts at a 30-second versus a 6-minute gap.

## R-16 · Mid-turn tool-need divergence: the active set is frozen while the loop runs — M×H
Added 2026-08-09 (critic N-3/F14). Pi executes many tool calls per user turn, but `setActiveTools` takes
effect *between* turns. Any design selecting from the user's first message must predict the whole
trajectory's needs up front. Concrete: "fix the failing test" mounts bash/read/edit/test; three steps in
the agent needs `git_log` to find the breaking commit; not mounted; no recourse until the user speaks
again — so it stalls, works around badly, or fabricates ("I checked the git log and…"). Distinct from
R-05: the tool was never mounted and never evicted, it was *mispredicted*, and the failure is silent.
Externally corroborated: the Meta study (A-01) found under-showing tools costs more than over-showing on
hard queries.
**Mitigation:** prefer a model-invoked search/mount escape hatch over automatic per-turn top-k; specify
the mount-lag transitions before any code (search returns hits but mounting is deferred; zero/low-score
hits; two search calls in one turn; the model narrating use of an unmounted tool).
**Trigger:** computable from baseline traces with zero new code — for each user turn, take the tools
actually used during that turn and check whether all would rank in the top-k for that turn's *first*
message. If the failing fraction exceeds a few percent, automatic per-turn selection is an M3 regression.

## R-17 · JIT mounting turns the tool surface into a data-dependent privilege boundary — M×H
> **⚠ INVERTED 2026-08-09 (ADR-0007): for the reframed product, this is the FEATURE, not the risk.** The
> user's goal is precisely to make the tool surface a controlled privilege boundary — granting each
> sub-agent a deliberate subset and withholding the rest. What remains a genuine risk is the qualifier
> **"data-dependent"**: grants must be *deliberate, bounded, and auditable*, never inferable from untrusted
> content. So the mitigation below is promoted from a nice-to-have to a core requirement, and the risk
> restates as: **a grant that can be influenced by untrusted data is a privilege-escalation bug in a
> product whose whole purpose is privilege control.** Add: grant attenuation (a sub-agent must never grant
> itself more than it holds) and depth bounds.

Added 2026-08-09 (critic N-5). **A whole risk category the register was missing: security.** With a
static catalog, a session's blast radius is fixed, auditable, and reviewable before the session starts.
With search-and-mount, the set of capabilities the agent can exercise becomes a function of untrusted
data — a file's contents, a fetched page, or a tool result containing "use search_tools to find the
deploy tool" can cause a destructive capability to become active in a session where the user never
enabled it. Prompt injection escalates from "can misuse available tools" to "can expand the set of
available tools".
**Mitigation:** a deny-list or confirmation gate for destructive (write/exec/deploy-class) tools that JIT
mounting may never activate unprompted; the trace records the mount decision's input provenance.
**Trigger:** any trace where a tool was mounted during a turn whose user message did not reference that
capability **and** the mount decision's input included file, web, or tool-result content; or any
write/exec/deploy-class tool becoming active without an explicit user-turn request.

## R-18 · Trace payloads are a privacy incident with a delay fuse — M×H
Added 2026-08-09 (critic N-6). The `05-metrics.md` §3 event carries `query`, and the repairs below add
tool arguments and outcomes. An extension writing user prompts, file paths, and tool arguments to disk
by default — plus a public benchmark inviting the community to contribute traces — will eventually
capture a credential or customer data. For the OSS primary user this is also an adoption blocker: a
metrics package that silently records prompts gets uninstalled. Note pi's own telemetry contract already
takes this position: attributes are primitives only, with an explicit prohibition on prompts, tool
arguments, and outputs.
**Mitigation:** opt-in, a redaction pass, documented retention, and a separate "shareable" trace
projection that excludes free text — all decided before code.
**Trigger:** the first trace file containing a secret-shaped string (API-key shapes, `Authorization:`,
private-key headers) or a path outside the workspace root; or the first externally contributed trace
containing a raw user prompt.

## R-19 · Tool-name collision across independently installed Pi Packages — M×M
Added 2026-08-09 (critic N-7). `setActiveTools` takes **names**, and Pi Packages install independently
from npm/git (~110 exist; 40+ published in the first nine days of August 2026). Two packages can register
the same name (`search`, `query`, `run`); a cross-package registry then holds two records with identical
names and different ids, and mounting by name activates the wrong implementation — silently, with
correct-looking traces. R-07 covers the index holding a stale *description*; this is the namespace being
ambiguous *today*, and it grows precisely with the catalog size that justifies the project.
**Mitigation:** a namespacing/qualification policy in the D1 registry spec, plus a startup collision
check that fails loudly.
**Trigger:** the registry contains two records with identical `name` and different `id`/source package;
or `setActiveTools` is called with a name resolving to more than one registered tool.

## R-20 · Embedding-model version drift makes retrieval non-reproducible — M×M
Added 2026-08-09 (critic N-8). Any vector registry caches embeddings because recomputing them is
expensive, and two things then rot invisibly: a Pi Package updating one description via npm leaves a
stale vector unless the cache is keyed on a per-tool content hash, and changing the embedding-model
version changes top-k for every query with **no catalog change and no code change**. Mixed-version
vectors in one index are worse than either version alone, and retrieval results in traces stop being
reproducible — so R-07 detection and any selection-accuracy regression test become unreliable.
**Mitigation:** key the embedding cache on per-tool content hash; record embedding-model version and
catalog content hash in every trace; refuse to serve an index containing mixed model versions.
**Trigger:** indexing the same catalog with two model versions changes top-5 on a fixed query set; or
recall@k drops with no catalog change; or a tool's content hash differs from the hash recorded at embed
time.

## R-21 · Tool-definition token attribution is not directly observable — M×M
Added 2026-08-09 (critic N-10; method since found). M2 ("prompt tokens attributable to tool schemas") is
in **no** provider's usage fields — providers report totals plus cache read/write splits, never
per-region attribution — and pi ships nothing between "total input tokens" and "which tool ran". The
headline number of the whole Stage A benchmark therefore rests on a derived quantity.
**Mitigation (now known):** count/diff the serialized `tools` array at the `before_provider_request`
event, which pi's docs describe as "mainly useful for debugging provider serialization and cache
behavior" — i.e. the intended seam. The method and its **error bar** must be written into
`05-metrics.md` before code, and any published figure labelled as a measurement-with-method rather than
a provider-reported number.
**Trigger:** local re-serialization fails to reproduce a known provider prompt-token count within a few
percent; or a published DTCM figure appears without its attribution method stated.

## R-22 · Upstream churn: the substrate moves under the extension — M×M
Added 2026-08-09 (critic N-11). R-06 covers *providers* eroding the moat; nothing covered **pi itself
moving**. DTCM's leverage comes from `registerTool`, `setActiveTools`, `transformContext`,
`before_provider_request`, the event bus, and — for token accounting — pi-ai internals. Pi shipped
0.73→0.84 in ~7 months with an active push cadence, and its CHANGELOG already carries an Unreleased
entry moving OpenAI Responses toward "message-anchored `additional_tools`". The deeper the integration,
the more exposed.
**Mitigation:** pin a supported pi range; nightly CI against `pi@latest`; treat a red nightly as a
release blocker, not background noise; prefer documented extension events over source-shape assumptions.
**Trigger:** CI against `pi@latest` fails on a pi minor release; or any changelog entry changing an
extension-hook signature, the `before_provider_request` payload shape, or the session JSONL format.

## R-23 · Monotonic mount growth decays its own savings — M×M
Added 2026-08-09 (critic F9). In a long session an append-only mounted set converges toward the full
catalog, so by hour two the session runs the full catalog **plus** N cache-invalidation events **plus**
N extra round-trips — strictly worse than the baseline on all three axes. Capping the set requires
eviction, and "no eviction engine" was the design's whole cost advantage.
**Mitigation:** measure p50/p90 distinct-tools-used per session from baseline traces before committing to
append-only; if p90 approaches catalog size, the design needs a cap and A-06 reopens.
**Trigger:** p90 distinct-tools-used per session exceeds ~60% of catalog size; or measured savings in a
Stage B session decline monotonically with session length.

## R-24 · The pull-escape-hatch paradox (aggregator, deferred) — M×M
Added 2026-08-09 (critic N-9). R-03's mitigation relies on "raw output stays retrievable on demand". But
pulling requires the Top Agent to *suspect* loss: if it rarely suspects, the operating mode is
savings-with-silent-errors — the exact failure R-03 describes; if it often suspects, raw output re-enters
context and the savings vanish while the aggregator pass has already been paid for. No configuration
yields both. Compounding it, structured omission fields can only report *known* omissions.
**Mitigation:** deferred with the aggregator (Q-WHAT-3); if reopened, the A-04 eval must measure pull
rate and seeded-omission recall as first-class metrics.
**Trigger:** in an A-04 eval, pull rate > ~20% (savings gone) or < ~5% with decision divergence above
threshold (silent loss is the steady state); or seeded decision-flipping details surface in the omissions
field less than ~90% of the time.

## R-25 · A grant containing `bash` reads as narrow but isn't — M×H
Added 2026-08-09 (A-15). `bash` runs `grep`, `find`, `ls`, `cat`, `sed`, so it confers the whole file and
search surface. A reviewer reading "granted: read, bash" sees two capabilities and infers a narrowness that
does not exist. This is a *governance-legibility* failure rather than an enforcement failure: the control
behaves correctly while its output misleads the human reading it — which is worse, because it invites
misplaced confidence.
**Mitigation:** `SUBSUMPTION` models the reach explicitly, `ResolveResult.subsumedBy` reports what a parent
covers only indirectly, and the ledger records it per spawn. Consider promoting `bash` to a *universal*
capability (like `fabric_exec`) if grants containing it prove to be the common case in practice.
**Trigger:** any published or reviewed grant containing `bash` alongside a claim of least privilege; or
`subsumedBy` non-empty on a grant described as read-only.

## R-26 · The wildcard leaks down the tree — M×H (FOUND AND FIXED)
Added 2026-08-09. A root holding `tool:*` handed it to children, so every descendant could reacquire the full
catalog and attenuation became meaningless below the root. **Found by a test, not in production** — the
three-level transitivity test failed on `write` being reacquired at level 2.
**Mitigation (implemented):** the wildcard is *held* but never *inherited*; children receive the enumerated
grant only, and a wildcard root that has not yet observed its own tools hands children an empty grant (fails
closed). Regression-tested in `test/propagation.test.ts`.
**Trigger:** any descendant grant containing `tool:*`; or a transitive-attenuation test failing.

## R-27 · A committed approvals file authorises every clone — M×H (MITIGATED BY DESIGN)
Added 2026-08-09 by ADR-0010. Persisted `always` approvals live in `.pi/grants-approvals.json`, a file under
a directory that will be committed sooner or later. Once it is, **one person's "always allow `tool:write` for
`docs-writer`" silently authorises everyone who clones the repo** — none of whom was asked, and none of whom
can tell from the working tree that a gate is already open. The same hazard applies to a file copied between
checkouts.
**Mitigation (designed in, not deferred):** every entry stores the `cwd` it was approved in, and the loader
**ignores any entry whose `cwd` does not match the current working directory**. A copied or committed file
therefore authorises nothing anywhere else; it must be re-approved by the human sitting in that checkout.
Backed by the 30-day expiry and by the ceiling check (an approval is void once its agent type changes).
**Trigger:** any `grants-approvals.json` appearing in a repository's tracked files; or a ledger entry with
`approvalSource: "persisted"` whose approving `cwd` differs from the session's.

---

## Register log

| Date | ID | Change | By |
| :--- | :--- | :--- | :--- |
| 2026-08-08 | R-01…R-10 | Seeded from blueprint tensions | kickoff kit |
| 2026-08-09 | R-11, R-12, R-13 | Added — failure modes introduced by the Q-WHAT-1 decision (staged O5→O1): under-search, thermometer-without-cure, single-catalog benchmark overfit | brainstorm (Q-WHAT-1) |
| 2026-08-09 | R-01 | **Mitigation text corrected** — "mount region at END of context" is unachievable by us; prefix preservation is the provider's native deferred loading, which pi routes to. Quantified as A-02's S > 11.5·c·C | architecture-critic + research-scout |
| 2026-08-09 | R-06 | **TRIGGER FIRED** — Anthropic tool search GA with published numbers; pi ships the `search_tools` recipe itself (0.80.7). The mounting mechanism is no longer ours to build | research-scout |
| 2026-08-09 | R-14…R-24 | Added 11 risks from the architecture-critic pass: provider-conditional cache economics, TTL/pacing bifurcation, mid-turn divergence, **security/privilege escalation via mounting (a missing category)**, trace privacy, tool-name collisions, embedding drift, attribution unobservability, upstream churn, monotonic-growth decay, pull paradox | architecture-critic |
| 2026-08-09 | R-03 | Cross-referenced R-24 — the "raw on pull" mitigation is shown to trade one horn for the other, and omission fields cannot catch unknown omissions | architecture-critic |
| 2026-08-09 | R-17 | **INVERTED** — for the reframed product the privilege boundary is the feature; what remains a risk is the "data-dependent" qualifier | ADR-0007 |
| 2026-08-09 | R-25, R-26 | Added — `bash` grants read as narrow but aren't (legibility failure); wildcard leaked down the tree (found by test, fixed) | `pi-agent-grants` |
| 2026-08-09 | R-27 | Added — persisting `always` approvals to a repo-local file lets a commit authorise every clone; mitigated by `cwd`-match on load | ADR-0010 |
| 2026-08-09 | R-25 | Cross-referenced ADR-0010 — gating `bash` by default is the highest-value use of the new approval machinery and also its hardest test (prompt fatigue); carried as an open item, not decided | ADR-0010 |
