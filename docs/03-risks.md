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

## R-30 · A model-controlled argv/env spawn path outside the fence — M×H
Added 2026-08-12. `herdr` (a terminal workspace manager for agent panes) is installed on the author's machine,
and the third-party `@andrewjacop/pi-herdr` exposes `herdr_start_agent` / `herdr_delegate` whose **model-facing
parameters include `agentArgs: string[]` and `env: Record<string,string>`**. That is a model-authored array
landing directly in a CLI argv — the exact hole `neutralisePrompt` exists to close (`docs/probes/g1-argv`) —
plus model control of the channel grants travel on.

**Precise impact, because `deriveOwnGrant` is a real mitigation:** a forged `PI_GRANTS_GRANT=tool:*` does
**not** conjure tools; it is intersected with tools actually observed, and pi's `--tools` remains the
enforcement point. But a pane launched with no `--tools` has pi's full default surface, so the forged grant
resolves to everything, and that agent can delegate onward **looking legitimate** — minting ledger entries
claiming authority it was never granted. Audit-record laundering rather than privilege escalation from
nothing.

**Not a live breach:** `pi-herdr` is not in this machine's `~/.pi/agent/settings.json` packages, so it is not
loaded. **Same class as ADR-0013 Finding 6** (`subagents:rpc:spawn` bypassing `tool_call`), and materially
worse in that the escape is a *documented parameter* rather than an internal path.
**Mitigation (options, undecided — see ADR-0015):** speak herdr's own CLI/socket from this package so
**we** build the argv (`herdr agent start <NAME> --kind pi --pane <ID> -- <planSpawn args>`), which is
strictly safer than intercepting a third-party extension whose model-facing parameters are the hole; and/or
add `herdr_*` spawn tools to the fence.
**Trigger:** `pi-herdr` appearing in any settings `packages` list; any tool schema exposing an argv array or
an env map to a model in a governed session.

## R-35 · A definition's instructions are not governed, only its tools — M×H
Added 2026-08-12, found while writing `docs/SPEC.md` — i.e. by trying to state the guarantee precisely, not
by testing.

`agent:<name>` is produced by the catalog for every definition and *parses* as a capability
(`normaliseCapability`, `ceilingForDefinition`), but **nothing ever checks that a session holds one.** The
only gate on `delegate({agent})` is that the definition's `allowed-tools` fits inside the session's grant.

**So the capability model governs what a child CAN DO and never what it is TOLD to do.** A session granted
`read, bash` may spawn any definition whose ceiling fits — including one whose `SKILL.md` body instructs it
to delete everything it can reach, because that body needs only `bash`. Every grant is honoured and every
ledger line is correct; the instructions were simply never in scope. It also means an operator cannot
express "this session may spawn `review` but not `deploy`", which is an ordinary thing to want.

Sharpened by ADR-0016: definitions are now **spawnable prompts**, so their bodies carry far more weight than
an agent type's frontmatter ever did. The ledger records the grant and not the body, so "what was this child
instructed to do?" is unanswerable after the fact.

**Mitigation (undecided):** make `agent:<name>` a genuine prerequisite for spawning that definition — cheap,
since the catalog already emits the ids and `resolve()` already intersects capability sets — **or** delete
the namespace. A capability that enforces nothing reads as a control, which is R-25's legibility failure in
a new place. Recording the body's hash in the ledger would separately close the audit half.
**Trigger:** any grant naming an `agent:` capability, since it currently has no effect; any operator asking
to restrict which definitions a session may spawn.
**Note 2026-08-13:** taken up by **ADR-0017** (Proposed), which chooses the prerequisite over deleting the
namespace and blocks on R-36 below. The audit half — the ledger records the grant and never the body — is
explicitly *not* in that ADR and still has no owner.

## R-36 · Observation silently drops every non-tool capability from a session's own grant — M×M
Added 2026-08-13 while scoping ADR-0017. **Measured by execution, not by reading the code.**

`deriveOwnGrant` tightens the inherited grant by filtering it against the session's *observed tool names*
(`src/propagation.ts:101–103`), and the filter is `matchesToolName`, which only ever matches `tool:` and
`ext:`. Every other namespace therefore fails the test and is dropped at the first provider request:

```
inherited      : tool:read, skill:review, agent:reviewer, ext:pkg/web_search
before observe : tool:read, skill:review, agent:reviewer, ext:pkg/web_search
after  observe : ext:pkg/web_search, tool:read
```

**This is live for `skill:` today.** R-32 shipped skill grants and a child does receive the skill (it is
passed as `--skill`), but the capability vanishes from its own grant the moment the model is first called
— so the child cannot re-grant it to a grandchild, and `/grants` stops listing something the child holds.
The direction is fail-closed, which is why it is M×M rather than higher, but it is **silent**: nothing
records that a capability was removed, and the delegator that granted it is never told.

**Mitigation (proposed, ADR-0017 step 1):** filter only the namespaces that *are* tools and pass `skill:`
and `agent:` through untouched — an observed tool array says nothing about a namespace that is not tools.
This is a widening, so it ships with the test that pins it.
**Trigger:** a `skill:` capability present in `PI_GRANTS_GRANT` and absent from `/grants` in the same
session; any child unable to re-grant a skill it demonstrably holds.
**Note 2026-08-13: FIXED** the same day by ADR-0017 step 1 — only `tool:` and `ext:` are filtered against
an observation now, pinned by four tests including a three-level survival case. Kept as a live entry
because the *shape* recurs: a matcher written when only one namespace existed, silently excluding the ones
added later.

## R-37 · Delegate approvals are keyed to a subject that ADR-0017 made obsolete — M×L
Added 2026-08-13, surfaced while scoping ADR-0018.

`src/approval.ts:24–33` fixes the delegate-path approval subject to the literal `<delegate>`, on this
reasoning: *"the only things naming a child are the task string and the tool list, both chosen by the model.
A key the model controls is not a key."* That was correct when written. **ADR-0017 falsified it for
`delegate({agent})`**: the definition is operator-authored, and the session must now hold `agent:<name>` to
name it at all, so there IS a human-authored subject — the same one the capability names.

The consequence is not an escalation, which is why this is M×L: `ceilingOf("<delegate>")` is `null`, so an
`always` approval can never be persisted on this path (`saveApproval` is skipped, the scope downgrades to
`session`, and the operator is told). **The cost is prompt fatigue.** ADR-0010's persisted-approval
machinery — including `grantAtApproval`, the confused-deputy check that voids an approval when the thing it
was granted for changes — is dormant on the only spawn path that exists, and an operator asked the same
question every session is an operator who eventually sets `PI_GRANTS_GATED=""`. That is R-25's shape: a
control that is technically present and practically switched off.

**Mitigation (undecided):** make the definition name the approval subject for `delegate({agent})`, leaving
`<delegate>` for the `tools:` form where the premise still holds. ADR-0018's `definitionDigest` gives it the
missing half — a stored approval could then be voided by a body change, which `grantAtApproval` cannot
detect today because `ceilingForDefinition` reads only `allowed-tools`.
**Trigger:** any operator disabling gating; any repeated approval prompt for the same definition across
sessions; a `grants: cannot persist the approval` warning naming `<delegate>`.
**Note 2026-08-13 — the entry above UNDERSTATED it, and the correction is the useful part.** It said
`always` was offered and silently downgraded. It was never *offered*: `offeredScopes` gates `always` on the
path literal `"interceptor"`, and ADR-0016 deleted the only caller that passed it. So no version since
0.7.0 could create a persisted approval at all, and `approval-store.ts`, `entryVerdict`'s ceiling check and
every ADR-0014 integrity property were guarding a file nothing could write. Found by grepping for the call
sites instead of trusting the reading — the same lesson as R-28.
**FIXED by ADR-0019 (0.10.0):** `delegate({agent})` approves against the definition on a `"definition"`
path that offers `always`; the `tools:` form keeps `<delegate>` and keeps being denied it. A persisted
entry pins the ceiling **and** the ADR-0018 body digest, so rewriting instructions voids it
(`instructions-changed`) — strictly stronger than ADR-0010 designed, and an unpinned entry fails closed.

## R-38 · `/grants` reported a definition as blocked while a spawn would allow it — L×M
Added **and fixed** 2026-08-13, found by writing the first end-to-end test of the persisted approval store
(0.10.1). **Measured before it was written down:** an integration test seeded one valid entry, then asked
`/grants` and `/grants approvals` in the same session. The listing said
`BLOCK  bash-user — tool:bash requires explicit approval`; the approvals view, reading the same file
through the same `snapshotOf`, said `1 persisted approval`. A real `delegate({agent: "bash-user"})` would
have spawned, silently, with no human in the loop.

**The cause is R-28's shape, one layer up.** `/grants` deliberately ran the real `planDelegation` "so a
diagnostic that disagrees with enforcement is not expressible" — and that was true of the *planner* and
false of the *path*. Enforcement is plan → gate → approvals → re-plan; the listing was plan alone, and
`planDelegation` knows nothing about approvals by design (it takes them as an argument). Sharing the
function while not sharing the sequence left the two able to disagree again.

Direction of the error was conservative for privilege and **wrong for audit**, which is why an L×M
diagnostic defect was worth fixing rather than noting: the operator most likely to run `/grants` is one
asking *what can this session spawn without asking me?*, and the answer it gave was a confident no. ADR-0019
had just made standing approvals writable for the first time since 0.7.0, so the number of sessions in
which this could mislead went from zero to all of them on the same day.

**FIXED (0.10.1):** the sequence itself is now one function — `planWithApprovals` in
`extensions/run-delegation.ts` — used by the enforcer and by `/grants`. They differ in one argument:
`ctx: null` means *preview*, so stored approvals count exactly as they would for a spawn and no human is
asked. Deliberately **not** expressed as `hasUI: false`, which is a different fact ("nobody is here to ask",
true in every governed child) and would have replaced each gated definition's reason with advice about
interactive sessions. The listing now also names *why* it allows —
`allow  bash-user  tool:bash, tool:read  (tool:bash approved: persisted)` — because an `allow` that
silently depends on a 30-day entry in a file elsewhere is the thing an operator ran the command to find.
**Trigger for the shape recurring:** any second caller of `planDelegation` that is not `planWithApprovals`.

## R-41 · One project's `always` approval deletes another project's — H×M, HALF-FIXED (keyspace needs a decision)
Added 2026-08-13, same pass; **measured, and worse than reported**.

ADR-0014 moved the store to one file for all projects, scoped by each entry's own `cwd`. But `saveApproval`
loaded, dropped every non-matching-`cwd` entry as `foreign-cwd`, and wrote back **only the valid set** — so
approving anything in `/work/web` deleted the approval given in `/work/api`. Not merely ignored: gone from
the file. Two active projects turned `always` into *"always, until I approve something anywhere else"*.
Two unit tests pinned this as correct by calling another project's live approval "stale" — the same
tests-pinning-the-defect pattern R-29 hit.

**FIXED (0.10.2):** writes carry `foreign-cwd` entries through untouched (they are the only verdict
`entryVerdict` can reach without consulting this session's definitions, so they are exactly "another
project's, and not ours to judge") and pruning is limited to entries this session can see are dead.

**FULLY CLOSED 2026-08-14 by ADR-0020** — and by a different route than the mitigation proposed here.
Nesting by `cwd` inside one document was Option 2 and lost: it fixes the collision while leaving every write
touching every project's data, which is where R-41, R-42, R-43 and R-49 all came from. **One file per
project** makes the collision inexpressible instead of handled. The `foreign-cwd` carry-through added in
0.10.2 is deleted with the shared file that required it; `entryVerdict` keeps checking `cwd`, still doing
R-27's original job of refusing an entry copied from elsewhere.

## R-85 · Work lands on `main` by drift rather than by decision — M×M, FIXED IN PART 2026-08-18
Added 2026-08-18. Eleven commits (`b7c0475..26e778f`) reached `main` with no pull request. Not a decision: the
session was still checked out on `main` after PR #5 was squash-merged, and no one looked before the first edit.
Every review this project has run found something — R-78…R-82 came out of one such pass — so the work that
skips the PR is the work with no independent pass over it, and **ADR-0033's two critical governance defects
are in exactly these eleven commits.**

**Why this is a risk entry and not only a rule.** By rule 1 a failure mode lives here, with a trigger. The
first draft of working rule 10 recorded the incident inside the remedy and nowhere else, which leaves a future
session no way to ask whether it recurred.

**FIXED IN PART.** `hooks/pre-commit` refuses a commit on `main`, names the branch and gives the recovery
(rule 8's shape), with `test/branch-guard.test.ts` proving the script refuses — **seven mutations of the hook
fail it**, including deleting it. Three gaps stay, all deliberate and all stated in rule 10 rather than
implied: the hook is wired **per clone** by `git config core.hooksPath hooks` and is inert until then; `main`
has no GitHub branch protection, so a direct `git push` still succeeds; and `pre-commit` never runs for a
clean merge, cherry-pick or revert, so those reach `main` unguarded.

**The fix's own review found the fix repeating the defect it removed.** The first hook refused a **conflicted**
merge on `main` — a clean merge runs `pre-merge-commit` and never reaches it, but a conflicted one finishes
with a literal `git commit` that does — and in that state `git switch -c`, the recovery the hook itself
prints, is rejected by git outright. The only escape git suggests is `git merge --quit`, which discards the
conflict resolution. **That is "a prohibition with no usable recovery" reintroduced in shell, one commit after
being removed from the prose**, and it is this project's most repeated shape: a fix containing the defect it
fixed. Now exempted via `MERGE_HEAD`/`CHERRY_PICK_HEAD`/`REVERT_HEAD`.

**It recurred within the hour, which is the honest part of this entry.** Verifying the hook, `git stash -u`
swept the then-untracked hook aside, so the test commit on `main` succeeded — the guard was absent at the one
moment it was being tested. The commit was empty and unpushed and was undone with `git branch -f main
origin/main`, which is the recovery rule 10 prescribes. **A guard that a routine command can remove is a
guard with a hole**, and the hole closes only when the hook is tracked *and* `core.hooksPath` is set in the
clone — the state this repository is now in.

**Trigger:** `git log --first-parent --oneline 26e778f..origin/main | grep -vE '\(#[0-9]+\)$|Merge pull
request #'` — any output is a commit that reached `main` without a PR. **The first version of this trigger was
useless and a reviewer measured it: unbounded, it flagged 87 of 89 commits, and it also flagged the two real
PR merges**, because GitHub's merge-commit subject puts `#N` in a prefix rather than a `(#N)` suffix. Bounded
at the rule's own start it is silent on today's history and returns exactly 11 over the incident range.

## R-84 · One `session` yes to a model-chosen tool list pre-authorises the whole subtree — M×M, OPEN by decision
Added 2026-08-18, measured. `<delegate>` is a **fixed literal** subject: `inheritApprovals` exempts it from
ADR-0022's body pin (nothing to pin — there is no definition), and `republishable` re-emits it unchanged. So a single
*session*-scoped approval for a gated capability on the `tools:` path crosses every boundary intact.

Measured: a child at depth 1 holding `PI_GRANTS_APPROVED=tool:bash@<delegate>` runs `delegate({tools:["read","bash"]})`
with **zero dialogs**, spawns a grandchild at depth 2, and that grandchild's own `PI_GRANTS_APPROVED` carries the same
entry. Unbounded in depth and breadth, nobody asked again. Controls behave correctly: with no inherited approval the
dialog appears, and a `tool:bash@digger` entry does **not** satisfy a `tools:` request.

**The irony is the point.** `<delegate>` exists because *"a key the model controls is not a key"* (ADR-0019, R-37),
which is why that path is denied `always` and never persisted. Session scope was left as the safe middle — and it is
the one scope that propagates.

**Open by decision, not by oversight.** Three candidate fixes, none free: refuse to inherit `<delegate>` approvals at
all (breaks the legitimate "approve bash once for this subtree" workflow the scope exists for); key them to the
requesting session's id (a new identity concept, and a child cannot verify its parent's); or bound them by depth
(arbitrary). Withholding `tool:bash` from a grant already prevents it entirely, which is the remedy `docs/SPEC.md`
already recommends. **Trigger to revisit:** any report of a descendant holding a gated capability its operator does
not remember approving, or a request to make `<delegate>` approvals persistable.

## R-62 · A killed process orphans one herdr pane per in-flight child — **M**×L, FIXED IN PART
Added **and fixed in part** 2026-08-14. `runHerdrPane` closes its pane in a `finally`, which covers a thrown
error and a timeout and **not the process being killed**, so an interrupted fan-out left a pane per child —
and `docs/probes/g16-herdr` records that an orphaned pane is not trivially closable afterwards. Low severity
throughout: the herdr executor is opt-in and `PI_GRANTS_HERDR` is off by default.

> **RE-RATED 2026-08-17 (L×L → M×L), because ADR-0031 removed the premise the old rating rested on.** "Low
> severity throughout" was justified above by *"the herdr executor is opt-in and `PI_GRANTS_HERDR` is off by
> default"*. **That sentence is now false**: an unset variable means *probe*, so on any machine running herdr
> the pane path is the **default**. An orphaned pane after SIGKILL has gone from a rare opt-in-only outcome to
> the ordinary consequence of killing a session mid-fan-out.
>
> **Likelihood rises; impact does not.** The failure is unchanged — some stale tabs, remedied by
> `herdr tab close <id>` — and nothing about the grant, the ledger or enforcement is affected. What changed is
> how often anyone meets it.
>
> **Neither ADR-0031 nor ADR-0032 fixes it, and both say so.** SIGKILL runs no `exit` handler by design, and
> the refusal below still stands for exactly the reason it always did. ADR-0032 *does* move the ordinary close
> point from the per-call `finally` to `agent_settled` — so panes are now open for **longer** in the normal
> case, which widens the window rather than narrowing it. It also caps concurrent panes at 8
> (`MAX_CHILDREN_PER_CALL`), which bounds how many a kill can orphan; that cap is the one thing here that cuts
> the other way.
>
> **What would change the rating again:** a report of orphaned panes actually accumulating in real use. The
> mitigation on the table is not a signal handler (refused, below) but a startup sweep — closing panes labelled
> by a `pi-daddy` prefix that no live process owns. That has its own hazard, since a label is not proof of
> ownership, and it is not worth designing against a failure nobody has hit yet.

**FIXED IN PART (0.13.0)** — `src/pane-reaper.ts` tracks open panes and closes them on `exit`. The coverage
is stated rather than implied, because the gap is the interesting half:

- **Covered:** normal exit, `process.exit()`, an uncaught exception reaching the default handler.
- **NOT covered:** SIGKILL, and SIGTERM/SIGINT where nothing else in the process has a listener. Node runs
  no `exit` handlers there, by design. `herdr tab close <id>` remains the manual remedy.

**The obvious completion is deliberately refused.** Installing a SIGINT/SIGTERM listener would close the
remaining cases and would *suppress Node's default termination* — a library taking over an application-level
decision it has no standing to make. pi uses SIGINT to interrupt a turn; a handler here that re-raised would
turn *"cancel this delegation"* into *"exit pi"*, on **every** session rather than the opt-in ones. A
governance package quietly changing its host's interrupt semantics is a worse defect than the leak.

Also fixed alongside: `tab create` replying without a pane id returned **before** `cleanup` was defined, so
the one path where herdr half-succeeded was the one that leaked a tab.

## R-50 · "Void the moment either changes" is really "void at the next session start" — L×L, DOCUMENTATION
Added 2026-08-13, same pass. `session.definitions` is loaded once at `session_start` and never refreshed, so
`snapshotOf` validates persisted entries against a **session-start snapshot** rather than the file. Every
consequence is fail-safe and none is written down: within a long session an edited definition does not void
its approval (consistent, since the child genuinely receives the old body); two concurrent sessions can
legitimately disagree about the same entry; a definition added after start is unknown until restart. The one
that matters for an investigation: SPEC advises rehashing the file to answer *"has this definition changed
since?"*, and a rehash cannot distinguish "changed after the spawn" from "changed before it, in a session
holding a stale copy".

## R-74 · A definition copied by `init` does not track the package it came from — L×M, ACCEPTED
Added 2026-08-16 (ADR-0028). `pi-daddy init` copies each declared `SKILL.md` into `.pi/skills/`, so
`npm update principal-pi-skills` changes `node_modules` and leaves the governed copies exactly as they were.
An operator who believes the update reached their sub-agents is wrong, and nothing tells them.

**Accepted rather than fixed, because the alternative is worse.** ADR-0018 pins a spawn to a body digest and
ADR-0022 pins an inherited approval to it: a definition that silently changed under an operator would void
approvals mid-session, make *"has this definition changed since?"* unanswerable, and hand a child rewritten
instructions under a yes given about the old ones. A committed, diffable copy is the property the whole
design rests on. `init --force` is the deliberate re-sync and its usage text says it discards any
`allowed-tools` the operator wrote.
**Trigger:** an operator reporting that a skill upgrade "did not take effect", or `/grants ledger` reporting
`CHANGED since` for a definition nobody edited — the first would mean the copy semantics need saying louder
in `init`'s output, the second would mean something is rewriting `.pi/skills/` behind them.

## R-75 · The startup summary classifies against the grant *before* the tool surface is observed — L×L, DOCUMENTATION
Added 2026-08-16 (ADR-0028). `session_start` runs before the first provider request, so `ownGrant` is still
the **inherited** upper bound; `deriveOwnGrant` narrows it to the observed tool names only when a request is
made. A definition whose ceiling names a tool this session turns out not to have is therefore counted
spawnable at startup and refused afterwards.

It fails in the harmless direction — the line over-reports what is available, it never authorises anything,
and `--tools` remains the enforcement point — and the same caveat already applies to the `holding [...]` line
above it, which `/grants` marks *"(inherited, not yet observed)"*. Recorded because it is the kind of thing
nobody should have to derive from a confused operator: the summary is an **upper bound**, and `/grants` run
after any request is the settled answer.
**Trigger:** anyone treating the startup count as an inventory — a test asserting it equals `/grants`, or a
document quoting it as *"what this session can spawn"* without the qualifier.

## R-86 · A workspace lease is mistaken for filesystem confinement — M×H, OPEN BOUNDARY
Added 2026-08-19 by ADR-0034. A kernel writer lease can ensure that two **pi-daddy-governed** writer
spawns do not start concurrently for one canonical worktree. It cannot stop the operator, an IDE, Git
hooks, another agent runtime, or a child holding `bash` from writing there. Initial-CWD realpath validation
likewise prevents accidental misrouting and nothing after spawn.

**Mitigation:** key leases by canonical root rather than caller ID; say “governed writer coordination” in
API, ledger and docs; keep ADR-0012's bash warning beside the workspace contract. Strong confinement needs
an OS sandbox or constrained broker.
**Trigger:** any claim containing “contained to WRITER_ROOT”, “read-only filesystem”, or “single writer”
without the governed-process qualifier; any write observed from outside the lease holder while the lease is
present.

## R-87 · Crash recovery admits a second writer on a guessed stale timeout — M×H, MITIGATED BY DESIGN
Added 2026-08-19 by ADR-0034. Reusing `withFileLock` for a child lifetime would transfer ownership after
10 seconds based only on mtime. A healthy ten-minute child paused by SIGSTOP, suspend or a debugger would
then overlap its successor.

**Mitigation:** the workspace lease is a kernel `flock` held by a helper process. Recovery occurs only after
the kernel lock is acquirable; active metadata then records that the prior owner died. Unsupported or
ambiguous locking refuses with `WORKSPACE_LEASE_STALE` rather than falling back.
**Trigger:** two holders for one canonical root; any recovery while the prior helper still owns the kernel
lock; any in-memory or mtime-only fallback added to the write path.

## R-88 · Correlation metadata is mistaken for authorization — M×H, MITIGATED BY SEPARATION
Added 2026-08-19 by ADR-0034. Run/task/workspace/context IDs, assurance labels/scopes and external digest
fields may be model- or controller-supplied. If they are compared as proof of identity, a caller can mint
the value that authorizes it.

**Mitigation:** external values live under `correlation`; capability decisions use the existing grant,
ceiling and gate plus internally computed definition/task/request/effective digests. Approval matching may
bind supplied workspace/context values but never treats them as authority by themselves.
**Trigger:** any authorization branch reading `correlation`; a supplied `definition_digest` or `task_digest`
being preferred over the planner's computed digest.

## R-89 · A task digest is a privacy identifier, not anonymization — M×M, ACCEPTED
Added 2026-08-19 by ADR-0034, narrowing ADR-0021. Critical assurance requires exact task identity in an
approval and joinable ledger. Storing SHA-256 avoids task text but a short or predictable task can be guessed
from a dictionary; equality across runs is also visible.

**Mitigation:** never store task text, tool arguments or results; label the digest sensitive/linkable; keep
caller-supplied task digests separate from the trusted computed one. A keyed digest is deferred because it
introduces key distribution and prevents independent recomputation.
**Trigger:** a real task recovered by guessing its digest, or an operator requiring unlinkability between
ledgers.

## R-101 · The lease helper signals a recorded pid with no identity check — L×H, ACCEPTED

Added 2026-08-20, **not fixed.** On parent death the helper SIGTERMs, then SIGKILLs, the pid it was told to
attach — with no `/proc/<pid>` start-time check. In the window where the child exits and the parent dies
before releasing, that pid may have been recycled and the helper signals an unrelated process. Accepted
rather than fixed: the check belongs inside a one-line embedded helper where a bug is harder to see than the
race is to hit, and the blast radius is bounded by the parent's own uid. **Revisit if** the helper grows a
real module, or if anyone observes it killing something it did not start.

## R-118 · The worktree-membership check is defence-in-depth with no test — L×L, ACCEPTED

Added 2026-08-20. Deleting `registeredWorktrees.includes(registered)` from `validateRegisteredWorkspace`
leaves the suite green, and unlike the other four guards audited that day this one resisted every attempt to
construct a case where it is the only check that fires — the `rev-parse --show-toplevel` comparison catches a
non-repository, a path inside a worktree, and a broken gitdir link. Recorded as accepted rather than given a
test that would pass for a different reason. **Revisit if** anyone finds the case, or concludes the check is
genuinely redundant and removes it deliberately.

## R-127 · R-97's regression claim is corrected a SECOND time, not satisfied — L×M, OPEN

Added 2026-08-20. The R-93/R-97/R-98 correction note above says all four previously-absent regressions "now
have tests that fail when the guard is removed." For R-97 that is still false. The mutation that stayed
green was at the **call site** — `infrastructureError ??= error` plus an early throw — and the fix extracted
the logic into `throwFanoutInfrastructure`, which the new tests exercise directly with hand-built arrays.
Nothing drives the `catch` that feeds it, and it is not reachable from the wiring layer: children fail as
*refusals*, which land in `outcomes` normally and never throw.

A test written for it was **deleted rather than weakened until it passed**. So: the extraction is a real
improvement, the pure function is genuinely pinned, and the call site is not. **Correcting a false
regression claim by making another one is the finding here** — recorded in the same file as the correction
it repeats.

## R-129 · The 17-mutation audit has no artifact — L×M, OPEN

Added 2026-08-20. `docs/03-risks.md` and the session log both rest on "a 17-mutation audit", and rule 5 would
normally park a measurement that load-bearing under `docs/probes/`. Nobody can re-run it, and R-127 is what
that costs: a coverage claim derived from an audit no one can reproduce. The second round's mutations are
likewise recorded only in commit messages.

## R-151 · Letting the parent exit makes the pane reaper and the lock helper close the same tab — M×M, OPEN

Added 2026-08-22 by the independent review of the R-146 fix, and it exists **because** that fix works: while
the process could never exit, the on-exit pane sweep never ran, so nothing raced.

A refused writer close throws `HerdrWriterCloseError` **without** `untrackPane` — deliberately, so the pane
"stays the reaper's problem". The retained tab is therefore still in the reaper's map when the process exits,
and `process.once("exit")` runs before the helper's pipes close. So the reaper closes the tab first, and the
helper then spends its whole retry budget closing a tab that is already gone.

```
threw=HerdrWriterCloseError   tabs attached to the lease helper=["w1:t9"]
openPaneCount after the refused close = 1      ← still tracked
  process.once("exit") sweep runs: herdr tab close w1:t9
… helper then burns 10 attempts at 1s          t+0s..t+9s lock=HELD, t+10s lock=FREE
marker: {"reason":"herdr-close-failed", …}     ← asserts a failure that did not happen
```

Three consequences, none of them a capability defect:

- a ~10s window after `pi` has exited in which a successor is told a governed writer is active;
- a marker file asserting a close failure that the reaper had already resolved — and **`readCloseFailure()`
  has no caller anywhere** in `src/`, `extensions/` or `test/`, so the "marker file" step of the advertised
  recovery path is written and never read;
- retention is documented as *"the pane may still be live"*, while the reaper now kills that pane on the way
  out. Both behaviours are defensible; they are not the same behaviour, and the documents describe only one.

**Not fixed here.** The candidates conflict — untrack the pane on retention (contradicting "stays the reaper's
problem"), have the reaper skip lease-attached tabs (leaking panes on the path that most needs the sweep), or
have the helper ask before retrying — and choosing needs the herdr executor's owner rather than a patch inside
a hang fix.

**Trigger:** a `herdr-close-failed` marker for a tab that is already gone; or any second closer of a resource
the lock helper also closes.

## R-137 · Routing attenuates by ID, not by DESTINATION — H×M, OPEN (ADR-0042 decided; implementation deferred)

Added 2026-08-21. **Attempted, defeated four ways, and reverted 2026-08-22.** The attack is measured; the
mechanism that was meant to close it is not in the product.

ADR-0035 attenuated *which id* a descendant may name and left the id→path mapping in a mutable file. A child
holding `workspace:staging` **and `tool:write`** — not `bash`, so squarely inside ADR-0012's scope — can
rewrite the `staging` entry to point at any other Git worktree and route its grandchild there, with a real
exclusive write lease. **Measured** by `docs/probes/g37-registry-tamper`, which drives the real
production path against real worktrees and a real kernel lease: the grandchild started in a root nobody
authorised, while the *control* — the same child naming `prod` directly — was refused
`WORKSPACE_NOT_AUTHORIZED`. So the capability check works and what moved is the thing it names.

(This entry first asserted "measured end to end" with no probe in the repository, which working rule 5 counts
as unmeasured. The probe was written afterwards, and it is the reason that sentence is now true.)

**What was tried, and why it is out.** A content pin: the root records the registry's digest, descendants
inherit it verbatim, a mismatch refuses. A fourth review pass defeated it four ways, all measured:

1. **It never reached a herdr child.** `mergeChildEnv` is on the process branch only; the herdr executor
   passes `plan.env`, which carries neither the pin nor the registry path. A pane child re-minted the pin over
   its own edit and its grandchild took a real write lease on the unauthorised root. The same gap means
   `PI_GRANTS_WORKSPACE_LEASE_DIR` does not cross either, so a pane child's "exclusive" lease excludes nobody.
2. **`PI_GRANTS_WORKSPACE_PIN=` failed open, permanently.** Empty is `!== undefined`, so it was never
   re-minted, and an unparseable pin was silently treated as "not my file". An attacker able to set the
   variable at all preferred emptying it to re-minting.
3. **A registry unreadable at root session start left the whole tree unpinned, silently** — and ENOENT is the
   everyday case, since `pi-daddy init` writes the registry *after* session start.
4. **Its reader bypassed all four guards added for the same file in the same commit**, and reintroduced R-136:
   a bare `readFile` on a FIFO hung session start forever.

**The reverted mechanism is not the finding; the venue is.** A new env var, a new refusal code and a new
inheritance rule are an ADR, not a paragraph in an amendment — ADR-0035 explicitly declined Option 2, and a
different mechanism arriving inside a fix commit got none of the design attention the herdr path needed. It
returns as its own ADR.

**CORRECTION 2026-08-22 (R-144), and it widens this entry.** The paragraph below described the ownership and
mode guard as existing. `e1937cf` had already removed it — the same commit that wrote this entry's scope
decision — so **nothing checks who may write the registry.** This attack therefore does not need `tool:write`
inside a governed child at all: any local process that can write the file, or `rename(2)` into its directory,
repoints an id for every descendant that holds it. Three reviewers found the stale claim independently. The
paragraph is left as written, per rule 2.

**What DOES exist now**, and is narrower than the pin was claimed to be: the registry must be a regular file,
under 1 MiB, owned by this user or root, and not world-writable. That refuses a registry another *user* can
rewrite in place. It cannot touch this entry's attack at all — a governed child runs as the same uid as its
parent, and no file mode distinguishes them — and it does not establish "nobody else may rewrite it" either,
since it inspects the file and never its parent directory, and `rename(2)` needs only directory write
(measured: a 0600 registry in a world-writable non-sticky directory, accepted then atomically replaced).

**Trigger:** any authority whose meaning is stored outside the grant — routing is the first; a future
`check:<id>` or `context:<id>` would be next. Also: an operator reporting a child that started somewhere they
did not authorise.

**Decision 2026-09-03.** ADR-0042 chooses a root-resolved, grant-attenuated inherited destination map over
status quo and a per-child registry. No code changed: the previous attempt was defeated on Herdr propagation,
empty/malformed state, startup ordering and a second unsafe reader. Implementation waits for a positive reversal
of probe g37 and mutations covering those exact paths, so this risk remains OPEN.

## R-138 · Four findings from the PR #10 review pass, deliberately NOT fixed — M×M, OPEN

Added 2026-08-21. Recorded rather than fixed, because each is pre-existing and outside ADR-0035's change.
Listed so the next session does not rediscover them as new.

1. **The herdr pane path has no `mergeChildEnv` equivalent.** The process executor deletes all eight
   `GRANT_ENV_KEYS` before applying `plan.env`; a pane inherits the herdr **daemon's** environment and only
   *adds* `--env`. `ENV_GRANT`/`DEPTH`/`MAX_DEPTH`/`APPROVED` are written unconditionally so they cannot
   leak, but `FANOUT`, `GATED`, `LEDGER` and `PARENT_ID` are conditional — and `PI_GRANTS_FANOUT` *relaxes* a
   bound. A daemon started from a governed shell could leak it into every pane. Reviewer could not
   demonstrate it (their daemon had no `PI_GRANTS_*` set), so this is a code-read, not a measurement.
2. **`/grants init`'s `adoptGrant` does not intersect with `session.inherited`.** A human running the command
   inside a governed child widens that child's own grant past what its parent granted. Not model-reachable —
   it is a command, not a tool — and `plan.grant` never contains a `workspace:` id, so routing cannot be
   gained this way.
3. **`isGated` is exact-match, so a namespace wildcard in `PI_GRANTS_GATED` is weaker than an enumerated id.**
   `workspace:prod` gates both routing there and handing the id to a child; `workspace:*` gates only routing.
   Widening the gate therefore loses a control. Inherited from `agent:*`, which behaves identically. SPEC now
   states the asymmetry rather than the unqualified claim it had.
4. **One dialog confers two authorities.** In the ordinary chained-routing shape the authorising id and the
   requested id are spelled identically, so a single approval covers both and the ledger cannot tell them
   apart. Contained in practice — a routing gate is always bound, so an inherited approval cannot satisfy a
   descendant's gate — but the record is less precise than the mechanism.

**Trigger:** any of these appearing in a *measured* form, or a fifth namespace inheriting the same shape.
Item 3 is the one to fix first if `isGated` is ever touched for another reason.

---

## R-140 · Two session-start readers can block a session forever — H×M, OPEN

Added 2026-08-22 by the fifth review pass, which ran R-136's own stated trigger — *"grep for `readFile`
reached from `loadProjectDefinitions`"* — and got two hits R-136 does not cover. **Both pre-date ADR-0035 and
are outside this PR's scope; they are recorded so the trigger's next reader does not have to rediscover them.**

1. **`src/definitions.ts:227`** — `readFile(<skillroot>/<name>/SKILL.md)`, no file-type check, no bound,
   reached from `loadProjectDefinitions`'s *first* line. Measured with a FIFO at that path: never returns, and
   a `process.exit` watchdog could not fire because the blocked `open(2)` pins a libuv thread.
2. **`src/grant-store.ts:91`** — `readFileSync` of the stored grant, called in the extension **factory**,
   before any hook runs. Synchronous, so it blocks the whole event loop, it runs earlier than `session_start`,
   and its path comes from `PI_CODING_AGENT_DIR` — the same shape of operator-supplied path as the registry.

Against a real `pi`, each produced **zero bytes on stdout** and timed out, which is R-136's exact signature.

**Twelve sibling readers do a bare `readFile` with no guard** (`approval-store`, `lease-record`, `file-lock`,
`grant-store`, `ledger-report`, `definitions`, `skill-packages`, `workspace-lease`, `check-runner`). The
registry reader is now the only hardened one, so this is a class rather than two defects — which is the
argument for fixing it as its own change with one shared guarded reader, not one site at a time.

**Trigger:** already fired twice. The rule to adopt: any `readFile` on an operator-supplied path that is
awaited during extension construction or `session_start` needs a file-type check and a bound, and R-136's
trigger should be run *as part of* any commit that touches session start.

---

## R-141 · Relative child-inherited paths can split workspace state — M×M, PARTIAL (ledger repaired; lease namespace OPEN)

Added 2026-08-22. **Pre-existing composition; a fix was attempted in this PR and reverted as out of scope.**

Three facts compose: a routed child's cwd IS the leased worktree root (`extensions/execute-child.ts`);
`PI_GRANTS_LEDGER` is inherited verbatim and `pi-daddy init` scaffolds a **relative** `.pi/grants.jsonl`; and
a `read` lease takes no kernel lock at all. Measured: two delegating children classified `read` both created
`.pi/` inside one worktree, `git status` showed `?? .pi/`, and a grandchild took a WRITE lease on a root
already held.

**The same shape is live for `PI_GRANTS_WORKSPACE_LEASE_DIR`, and there it breaks exclusion outright.**
`defaultWorkspaceLeaseDir()` returns the env value verbatim and is called in the *delegating* process, so with
a relative value a parent at its own cwd and a routed child at the leased root compute **different lease
namespaces**. Measured: both acquired a write lease on the same canonical root — "mutual exclusion did not
happen" — and the child left its lease files untracked in the worktree.

A separate finding in the same area: **`governedWorkspaceAccess` only ever upgrades read→write**, so
`("write", [])` returns `"write"`. `access` is a model-facing parameter, so a child holding no write tool can
make its grandchild take the exclusive kernel lock on a root — a denial of service against every legitimate
writer, with a ledger line recording `access: "write"` for a child that cannot write.

And a ledger-integrity defect made reachable by the same area: `extensions/workspace-runtime.ts` keeps a
**private copy** of `leaseReleaseLedgerOutcome` that omits the `not-held` arm, so a read lease's release is
recorded `released` — asserting a handover that never happened. `src/workspace-lease.ts` claims "ONE
definition, exported, because two call sites had their own copies", which is false.

**Why not fixed here.** Making a child-inherited path absolute is a change to the ledger and lease plumbing,
not to ADR-0035, and the attempted fix landed mid-review where it immediately produced a false claim about
`tool:delegate`. `tool:delegate` is therefore NOT in `KNOWN_READ_ONLY_TOOLS`, so routing read-only while
delegating still takes a writer lease — unchanged from 0.18.1.

**2026-08-28 dashboard review amendment.** The ledger half is repaired: session start resolves
`PI_GRANTS_LEDGER` once against pi's actual root cwd and every descendant inherits that absolute path. This was
not optional hardening for ADR-0036 — without it, a routed grandchild disappeared from the dashboard's only
execution database under the documented `.pi/grants.jsonl` default. A wiring regression forces the published
environment to be absolute before routing can change cwd. The relative `PI_GRANTS_WORKSPACE_LEASE_DIR`,
write-access overstatement, and private release-outcome mapping above remain open; this entry is therefore only
partly closed.

**Trigger:** any env-supplied path a child inherits and resolves relative to its own cwd. Grep for
`process.env[` reached from a function called in the delegating process.

---

## R-145 · A gated routing attempt takes the destination's exclusive writer lease before the human is asked — M×H, OPEN

Added 2026-08-22 by the sixth pass. **New behaviour created by ADR-0035**, and not a defect in any single
line: two correct decisions compose into it.

`extensions/run-delegation.ts` previews the plan, and enters `prepareDelegationWorkspace` when
`plan.ok || shouldSeekApproval(...)`. `shouldSeekApproval` is true whenever `gatedBlocked` is non-empty and
`denied` empty — precisely the state ADR-0035's new routing gate produces. So the lease is acquired, and only
then is the dialog opened. `src/approval-prompt.ts` documents the default as no timeout: *"waiting forever
denies nothing."*

Measured against real worktrees and a real kernel `flock`, replaying the production ordering: caller holds
`workspace:prod` and `tool:write`, operator sets `PI_GRANTS_GATED=workspace:prod`, the model calls
`delegate(..., workspace: {workspace_id: "prod", access: "read"})`.

```
preview           GATED_UNAPPROVED, gatedBlocked ["workspace:prod"], denied []
lease_acquired    true, access "write", root .../prod
rival writer      REFUSED  WORKSPACE_WRITE_CONFLICT — "already has an active pi-daddy-governed writer"
final             GATED_UNAPPROVED, child_ever_started false
```

So an **unapproved** routing attempt excludes every other governed writer on `prod` for the whole dialog,
emits a `workspace_lease` `acquired`/`write` record for a child that never runs, then releases. Repeatable
once per tool call, and reachable by the model rather than by the operator.

**Why the ordering is not simply wrong.** It is ADR-0034's, and deliberate: the workspace is resolved and
leased *before* any human is asked so that the approval binds to the exact tree the human sees (R-110). What
changed is the subject — ADR-0035 made the routing itself the gated thing, so "resolve then ask" became
"seize the destination, then ask whether you may go there". Reversing it needs a decision about what a bound
approval means, which is an ADR and not a patch, and the gate is the one control an operator has for exactly
the workspace they care most about.

**What it is not:** no capability is conferred, no child starts, and the lease is released. The harm is
availability plus a lease record whose child never existed.

**Trigger:** an operator reporting `WORKSPACE_WRITE_CONFLICT` on a workspace nothing is running in; or a
`workspace_lease acquired` with no subsequent `capability_decision` that started a child.

**Decision 2026-09-03.** ADR-0041 chooses resolve/bind, approve, acquire, then revalidate. The sentence above
that says the default dialog has no timeout is historical and stale: the current default is 120 seconds, while
zero or malformed configuration can still make it unbounded. No code changed in this wave because destination
binding changes the version-1 approval meaning and needs a race probe. A small ledger-only patch was rejected:
normal refusal teardown already attempts a matching release and reports append failure; a truthful `never-ran`
event needs a versioned wire decision.

---

## R-147 · A registry the reader refuses produces no message anywhere — M×H, OPEN

Added 2026-08-22 by the sixth pass. Working rule 8 says prefer failing closed **and** prefer being loud about
it; this fails closed silently.

`registeredWorkspaceIds` catches everything and returns `[]`; `buildCatalog` does the same. Exactly one
extension surfaces a registry refusal, and only once a delegation already names a workspace. So one
malformed id — a space in a name, which R-139's new grammar refuses, and one bad entry refuses the whole file
by design — removes every workspace from `/grants`, from the catalog and from `init`'s `ROUTABLE WORKSPACES`
block, with nothing printed.

```
registry: {"prod": …, "pr od": …}   ← one id with a space
catalog workspace entries : []
registeredWorkspaceIds()  : []
```

The operator's symptom is *"no workspaces registered"*, which is also what a correct empty registry looks
like. **The counter-example in the same codebase is what makes this a rule-8 violation rather than a
judgement call:** a malformed `PI_GRANTS_DEPTH` gets a notify naming the variable. R-139 made the grammar
strict in the same release, so the population of operators who hit this is exactly the ones upgrading.

**Also open, from the same reviewers, and grouped here because both are "two surfaces disagree":**

- `/grants` prints the ids the **registry** lists, not the ids this session may **route to**, so a session
  holding none is told it can route to all of them.
- A `tool:*` or `workspace:*` root can mint, record and propagate `workspace:<id>` for an id no registry
  contains (the catalog exempts the namespace deliberately, since the registry is the authority at point of
  use). Not an escalation today — `resolveWorkspace` refuses — but it is a grant that becomes real the moment
  the operator registers that id, and the ledger asserts routing authority meanwhile.

**Trigger:** an operator reporting a registered workspace missing from `/grants`; or any `catch` around a
governance refusal that returns a default instead of reporting.

---

## R-148 · The herdr executor gives a pane child neither the registry nor the lease directory — MEASURED 2026-08-22, OPEN

Added 2026-08-22. R-138 item 1 recorded this as *"a code-read, not a measurement"* and R-137's first defeat
asserted the lease-directory half without one. **Both halves are now measured**, which is the entry's whole
purpose.

`runHerdrPane` passes only `plan.env` to `tab create --env`; the process executor passes
`mergeChildEnv(process.env, plan.env)`. `plan.env` carries the grant, depth, fan-out, ledger and parent id —
not `PI_GRANTS_WORKSPACE_REGISTRY` and not `PI_GRANTS_WORKSPACE_LEASE_DIR`.

```
herdr `tab create` argv --env: GRANT, DEPTH, MAX_DEPTH, APPROVED   (no registry, no lease dir)
process executor child:        registry = /etc/pi/parent-registry.json, leases = /run/parent-leases
same leaseDir     → second writer REFUSED  WORKSPACE_WRITE_CONFLICT
different leaseDir → second writer ACQUIRED on the SAME root   ← two "exclusive" governed writers
```

Two consequences, and the second is the one ADR-0035 cares about. A pane child's *authority*
(`workspace:staging`) attenuates correctly on `plan.env`; the *meaning* of that id comes from whatever
registry the herdr daemon's environment has — nothing, in which case the capability is silently inert, or a
different file, in which case the id resolves to a root this operator never registered. And two governed
writers can hold "exclusive" leases on one canonical root when the lease directories diverge, which is the
one property the kernel `flock` design exists to provide.

ADR-0035's Context rests on *"`ENV_WORKSPACE_REGISTRY` … inherits into every governed child"*. That is true
of one executor of two, so the chosen Option 1 — *the child receives the full registry and is refused at the
capability check* — has no meaning on the herdr path.

**Still not measured:** the consequence inside a live pane. `herdr` is installed but no daemon was started,
so the argv and the lease-directory behaviour are measured and the pane child's resolution is inferred.

**Trigger:** any governance state that reaches a child through `process.env` rather than `plan.env` — the two
executors diverge there by construction, and this is the second time (R-137 defeat 1 was the first).

**Decision 2026-09-03.** ADR-0040 chooses co-locating the coordination lock under the validated worktree's
`gitCommonDir`, rather than pretending a lease-directory hash or convention makes two directories contend.
The defect remains OPEN: implementation waits for a positive host/container and linked-worktree probe, because
the existing evidence proves split-brain but not that Git metadata is shared and writable in supported layouts.

## R-149 · The registry read deadline is forced by nothing, and its second timeout refusal cannot be reached — M×M, OPEN

Added 2026-08-22 by the sixth pass. Both halves are in `src/workspace.ts`, the reader written to answer
R-79/R-136.

The docstring makes `REGISTRY_READ_TIMEOUT_MS` the answer to *"session start awaits this read"* and says the
in-loop check *"makes the bound as real as it can be in-process"*. **Deleting the whole deadline block leaves
the suite green** (629 tests, 0 failures, measured in an isolated copy). It is not in the mutation catalogue
either, and the catalogue's exclusion list — which exists to name the reader's unforced guards — does not
mention it, so it reads as covered.

The second half is worse in a quieter way: the module still classifies `AbortError`/`TimeoutError` into a
timeout refusal, and **no `AbortSignal` remains anywhere in it** — the signal approach was replaced by
`open(O_NONBLOCK)` plus `fstat` on the descriptor (R-136's fourth pass). So the file carries two timeout
refusals, one untested and one unreachable, in the guard whose whole purpose is that a session start cannot
block.

**Trigger:** any `catch` classifying an error type whose producer has been removed — grep for the producer, not
for the handler.

---

## R-150 · What the catalogue does not cover, including a guard wired on the quieter of two routes — M×M, OPEN

Added 2026-08-22 by the sixth pass, whose fourth reviewer was asked for the **complement** of
`npm run test:mutation` rather than for its contents. That framing is the finding: twenty pinned pairs answer
"do these guards hold", and nothing answered "which guards are missing from the list".

**The one with a behavioural consequence.** Two sites wire the registry into `buildCatalog` — session start,
and the once-per-session rebuild in `before_provider_request`. The integration test names the first; **the
second is forced by nothing, unit or integration.** Measured: revert only the rebuild site and the named
integration test still passes. If it regresses, `session.catalog` loses every workspace entry from the first
model turn onward, so `/grants`'s workspace count and `routable …` line vanish mid-session. Display only — but
it is **R-28's shape, two routes for one rule with the guard on the quieter one**, in a diff that fixes exactly
that shape in `propagation.ts` (R-135). It is also structurally invisible to the catalogue, which runs one
`test/` file per entry and therefore cannot pin an integration-only guard.

**Seven guards this diff adds that nothing forces**, each verified by a single hand-revert in an isolated copy:
the read deadline and the unreachable `timedOut` branch (R-149), the catalog rebuild above, `minLength: 1` on
the routing parameter (redundant with `checkRoutingAuthority`, which *is* forced), the `ENV_APPROVED` clamp,
the post-read grow check (its RSS test was removed for being unreliable, correctly), and `O_NONBLOCK`, which is
forced **only by non-termination** — reverting it wedges the suite past 120s despite the FIFO test's own
5-second timeout, because a pending `open(2)` keeps the process alive. Loud, but only to someone who notices
the suite stopped rather than failed, which is the R-119 lesson about a hang reading as untested.

**Two more properties of the new tests, disclosed rather than filed as defects:** two liveness assertions are
wall-clock bounds (`< 1s`, `< 5s`) and are the only thing separating "refused" from "blocked", so a loaded
runner turns a guarantee into a flake; and the fd-count check can pass with its `finally { close() }` deleted
because Node closes a `FileHandle` on GC, which the docstring already says.

**What this pass found genuinely forced is the larger half, and it is on record**: the whole `workspace:`
namespace across all nine sites, both wildcard clauses, `inheritableGrant` on both routes, all three routing
guards, the gate and its dedupe, the id grammar including `feature/x`, and every `init` path. And the answer to
"was a test weakened to make this branch green" is **no** — the canonical refusal enum was extended and then
made *generated*, with the waiver documented and its factual basis verified: no released tag ever carried the
v2 contract.

**Trigger:** a guard whose only forcing test lives in `test-integration/` — the catalogue cannot see it. And
any second call site of a rule the catalogue pins on the first.

## R-160 · Whole-file dashboard polling eventually becomes its own outage — M×M, OPEN

Added 2026-08-28. The MVP rereads and reprojects the complete JSONL every 250 ms. That is the deliberately
boring choice for the assumed bound (10,000 lines / 10 MiB) and avoids an inode-rotation/resume state machine
before a workload needs one. It is linear CPU and allocation forever, so a months-long shared ledger can make
the observability pane the noisiest process in the workspace.

**Mitigation now:** the renderer is a separate process and never affects enforcement; all interpretation is a
pure replay function, so replacing only the reader is possible. **Revisit at:** a normal ledger above 50 MiB
or projection above 100 ms p95. The replacement tracks inode + byte offset, reconstructs once, and falls back
to full replay on truncation/rotation; it does not create another database.

**Trigger:** either threshold, sustained dashboard CPU above one core, or refresh latency visibly above one
second.

## R-174 · The default project ledger can make repository writability a delegation precondition — M×M, ACCEPTED

Added 2026-09-01 for ADR-0037. After explicit `/grants init`, the default is `<cwd>/.pi/grants.jsonl` and is
load-bearing. A project made read-only after init, a `.pi` permission change, or a ledger path replaced by a
directory therefore refuses delegation that previously ran without recording. The file may also appear
untracked; pi-daddy does not edit `.gitignore` or choose retention.

This is the selected failure direction, not a silent fallback: `/grants` prints the effective path, the append
error refuses the spawn, and `PI_GRANTS_LEDGER` can select another path or `""` can disable it for one run.
Existing v1 stores do not acquire the precondition until init is rerun.

**Revisit trigger:** repeated reports of repository clutter, read-only-project refusals, or demand for a
first-class persistent ledger-only disable command.

## R-177 · An empty working directory was mistaken for containment — H×H, MEASURED / ACCEPTED BOUNDARY

Added 2026-09-04 from retained Wave A v6 principal-qualification evidence. Subject
`wave-a-v6-s02-luna-subject-r1` started in the empty
`measurement/wave-a-v6/packet/work/wave-a-v6-s02-luna-subject-r1`, searched outside it, found
`sources/principal-pi-skills/build/tests/fixtures/C1/notes.ts`, and changed `// teh balance` to
`// the balance` through an absolute-path `edit` call. The JSONL records the search, before-content, exact
edit and successful diff (`805f9d2b…`). The contaminated file remains the checkout's sole tracked change,
with mtime `2026-09-03T00:14:16.077715026Z`: inside the terminal receipt's
`00:14:01.203Z`–`00:14:22.107Z` run window and within milliseconds of the JSONL tool result. Wave A v7's
first prepare then refused `qualification product checkout must be clean` (`WAVE_A_V7_FINAL.json`,
`60e92abd…`). Full paths, hashes and read-only re-verification are in
`docs/probes/g38-cwd-is-not-containment`.

**What it proves:** an unsandboxed child can write outside its initial working directory, and one model did so
without being told where the target lived. **What it does not prove:** no pi-daddy governance rule failed.
The child used tools it held; the product has never claimed path confinement. SPEC's `WRITER_ROOT` paragraph
now links this occurrence beside the existing `bash` escape boundary (`docs/probes/g5-bash-escape`).

**Accepted boundary:** CWD and `WRITER_ROOT` remain intent/routing inputs, not a filesystem sandbox. Actual
containment requires an OS sandbox or constrained broker. **Trigger:** any claim that an empty CWD, validated
workspace or governed-writer lease confines the child's filesystem reach.

## R-179 · The first advisor rides an alpha endpoint and a model released three days ago — M×M, OPEN

**Recorded 2026-09-21 (ADR-0076).** Jev is reached through OpenRouter's `POST /api/alpha/decisions`, an
endpoint OpenRouter itself marks alpha, for a model (`typesafe/jev-1.13`) released 2026-09-18. Public
accuracy evidence is one 50-request routing sample and one vendor benchmark; nobody has published
calibration for "is this tool result relevant to that code task". **Mitigation by design:** advisors are
default off, every call has a two-second timeout and degrades to "no advice", the adapter is one file behind
one interface, and `pruned` handoff cannot become a default until `docs/probes/jev-handoff/` measures
precision and recall on the operator's own sessions. **Trigger:** the endpoint changes shape or is withdrawn,
or the probe shows recall below what a reviewer needs; either reopens whether the advisor ships on by default
anywhere.

## R-180 · The load-bearing `allowed-tools` field is experimental in the standard — L×H, OPEN

**Recorded 2026-09-21.** The Agent Skills specification still marks `allowed-tools` "Experimental. Support
for this field may vary", and the reference implementation (Claude Code) documents that it does not restrict
tools. pi-daddy is the only surveyed harness that treats the field as structural (ADR-0016). A rename or
semantic change upstream would leave every definition's ceiling undeclared, which this package already
handles by refusing to spawn (ADR-0028's "undeclared ceiling never becomes unrestricted"). **Trigger:** a
specification release that renames, deprecates or redefines the field; the response is a reader that accepts
both names for one release and an ADR, not a silent fallback.

---

Entries marked FIXED, RETIRED or CLOSED were moved verbatim to `archive/03-risks-resolved.md` on 2026-09-21.
A risk number cited anywhere resolves in one of the two files.
