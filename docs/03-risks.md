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

## R-28 · A correct pure function reached through a wrong argument list — H×H (FOUND AND FIXED)
Added 2026-08-12 by the architecture-critic pass, **confirmed by execution before being written down**.
`extensions/grants.ts` called `decideSpawn` from the `tool_call` hook **without `extensionTools`**, while the
three other call sites (`/grants` status, the `/grants` ceiling display, the post-approval retry) all passed
it. Because `ceilingFor` returns `[WILDCARD]` when it is `undefined` — fail-closed, and correct in isolation —
and `inheritsExtensions` defaults to **true** for any type file lacking an `extensions:` key, **every ordinary
narrow agent type resolved to `tool:*` on the one path that enforces.**

In a governed session holding an *enumerated* grant — the product's whole selling point — the result was:
the spawn refused; the reason **stating a falsehood about the file** (*"declares no `tools:` allowlist"* about
a file declaring `tools: read, grep`); and the ledger recording `denied: ["tool:*"]`, so `isEscalationAttempt`
— the single security signal ADR-0008 designates — **fired on legitimate traffic**. `shouldSeekApproval`
returns `false` when `denied` is non-empty, so the retry that *did* pass the argument was unreachable.

**Why 226 unit tests could not see it.** `decideSpawn` and `ceilingFor` were correct and well covered;
`test/agent-types-fidelity.test.ts:93` already pinned that an omitted `extensionTools` yields the wildcard.
The defect was **in the argument list, and nothing tested the argument list.** This is the generalisable
lesson: a pure-core/thin-wiring design moves the bugs into the wiring, and `extensions/grants.ts` was the one
file with no unit coverage — which three independent reviewers had already flagged.

**It had also been found and fixed once before, on `/grants` only** (see the comment on
`extensionCapabilities`). Repairing the symptom at the call site that revealed it, rather than the shared
call, is what let it survive on the enforcement path for two releases.

**Mitigation (implemented):** a single `decisionContext()` builder in `extensions/grants.ts` is now the only
place `extensionTools` is spelled, so the omission is *unspellable* rather than merely corrected. Covered by
`test/interceptor-wiring.test.ts`, which loads the real extension against a fake `pi` and drives the
`tool_call` hook directly — the first unit coverage that file has had. Verified by reintroducing the defect:
two of its four tests fail.
**Note 2026-08-13 (where the mitigation lives now, the mitigation itself unchanged):** ADR-0016 deleted the
interceptor, so `decideSpawn`, `decisionContext()` and `test/interceptor-wiring.test.ts` are gone with it;
the surviving builder is `delegationContext()`, and it moved to `extensions/session.ts` when
`extensions/grants.ts` was split (866 → 202 lines). The property is the one that mattered and it still
holds: **one builder, used by both the enforcing path and `/grants`, so a diagnostic that disagrees with
enforcement is not expressible.** The `extensionCapabilities` comment cited above went with the port — the
fact it recorded is in `CLAUDE.md` (`pi.getAllTools()` is available immediately; the first-provider-request
tool array is not). `test/delegate-all-wiring.test.ts` is now the wiring coverage, and
`test/file-size.test.ts` makes "the one file with no unit coverage grew to 866 lines" a test failure rather
than a thing three reviewers have to notice again.
**Trigger:** any second construction of a `DecisionContext` literal outside the builder; any refusal whose
reason names `tool:*` for a type whose file declares an explicit `tools:` list; `isEscalationAttempt` firing
on traffic an operator considers routine.

## R-29 · One "Allow once" authorises N concurrent spawns — H×H (FOUND AND FIXED)
Added 2026-08-12, **confirmed by execution** (10-line probe, no pi, no model). The single-flight approval
queue keys on `capability@subject` (`approval-prompt.ts:174-180`) and the delegate path's subject is the
**constant** `DELEGATE_SUBJECT`. Concurrent callers therefore share one pending promise and receive the *same*
`PromptOutcome`. Measured: four concurrent delegations gating `tool:bash`, one dialog, *Allow once* clicked
once → **four `{scope:"once", kind:"granted"}` outcomes**, and the dialog title showed only the **first**
caller's task. A textbook confused deputy: the human approved seeing task A and authorised A-D unseen.

ADR-0014's decided property — *"`once` stops at the boundary"* — **does not survive concurrency.** The ledger
would show four lines reading `approvalScope: "once"`, which a reviewer reads as "the human said once, four
times."

**Was not a live defect** when found: `delegate` blocks until the child exits, so two delegations could not
overlap. It was a hard precondition for any fan-out work, so it was fixed **before** the feature that would
arm it rather than after.

**Mitigation (implemented 2026-08-12).** The obvious fix — key the single flight on a per-spawn identity —
was **rejected**, because `DELEGATE_SUBJECT` is a constant for a good reason: the only things naming a
delegated child are the task and the tool list, both model-chosen, and *a key the model controls is not a
key* (`approval.ts:24-32`). That reasoning governs **approval identity** and is sound.

The real defect was narrower: **one key was doing two jobs.** De-duplication and authorisation are not the
same question. So the queue still shares one dialog per key, but a joining caller only *keeps* the answer
if it was about more than one spawn — `session`, `always`, a decline, or an error answer everyone; a
**`once` is consumed by exactly one caller** and the rest ask their own question. Verified by reintroducing
the defect: `test/approval-prompt.test.ts`'s R-29 test fails.

**Two pre-existing tests had to be re-targeted rather than updated**, and this is the interesting part:
*"two concurrent requests raise ONE dialog"* asserted `calls === 1` **and** that both callers received
`scope: "once"` — it was **pinning the defect** while appearing to protect de-duplication. Re-answered with
a `session` scope, they still protect the real property; the `once` semantics are now covered separately.

**Still open, and NOT addressed by this fix:** approvals evaluated *after* `execute` returns would use a
torn-down `ctx.ui`, making "is this spawn gated?" depend on queue position. That remains a precondition for
background (as opposed to synchronous) fan-out.
**Trigger:** any ledger file with two `approvalScope: "once"` lines sharing a timestamp and capability; any
approval resolved outside the tool call that requested it.

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

## R-31 · The pi-subagents port has no version pin and no drift tripwire — M×H (RETIRED: THE PORT IS DELETED)
Added 2026-08-12. ADR-0013 ported pi-subagents' tool-resolution rules "rule-for-rule from 0.14.3", and
`packages/pi-agent-grants/package.json` names `@tintinweb/pi-subagents` **nowhere** — not a dependency, peer,
or devDependency. So no version is claimed, `npm ls` cannot see it, and R-22 ("upstream churn") has **no wired
trigger**. Measured 2026-08-12: upstream is **0.15.0**, which adds a `src/nested-tools.ts` nesting-depth
ceiling and `fallbackSubagent` resolution that our port does not model; installed pi is **0.84.1** while every
probe records 0.83.0 and `PI_BUILTIN_TOOLS` is pinned "as of 0.83.0".

**The failure direction is permissive**, which is what makes it a risk rather than a chore: any upstream rule
that *widens* what a child receives makes our ceiling an **undercount**, and `agent-types.ts:143` says
outright that an under-counted ceiling is one that gets **ALLOWED**.
**Mitigation (proposed):** add `@tintinweb/pi-subagents` as a **pinned devDependency**; replace the
transcribed fidelity table in `test/agent-types-fidelity.test.ts` with a differential test importing the real
resolution helpers over ~30 frontmatter fixtures, so `npm update` turns drift into a red test; record a
`subagentsVersionSeen` field in the ledger so an audit can tell which port produced a line.
**Trigger:** any `@tintinweb/pi-subagents` release; any pi release changing the built-in tool list.

> **2026-08-12 (later) — RETIRED, by deletion rather than mitigation.** ADR-0016 removed
> `src/agent-types.ts` and `src/interceptor.ts` entirely: this package no longer re-implements another
> project's tool-resolution rules, so there is nothing left to drift. The proposed mitigation above — pin
> `@tintinweb/pi-subagents` as a devDependency and add a differential fidelity test — was **not built and
> is no longer needed**; the cheaper fix was to stop having the dependency. Recorded rather than deleted
> because the *reasoning* is the reusable part: a copy of someone else's private function, kept in step by
> human vigilance, with a silent permissive failure mode, is a liability whether or not it has drifted yet.
>
> **One half survives and moved:** `PI_BUILTIN_TOOLS` is still a pinned observation of pi itself, now in
> `src/pi-tools.ts`, and its trigger below still stands. It is used for *classification only* — never for
> enforcement, which is `--tools`' job — so drift there misfiles a capability rather than granting one.

> **2026-08-12 — the second trigger FIRED, in the product rather than in a dependency.**
> `docs/probes/g16-herdr` §6: a child launched with `--tools read` under pi **0.84.1** reported a
> **`parallel`** tool, which is absent from `PI_BUILTIN_TOOLS` (`src/agent-types.ts:20`, pinned "as of
> 0.83.0"). Not an enforcement hole — `--no-tools` removes it — but `PI_BUILTIN_TOOLS` is exactly what
> `ceilingFor` subtracts to derive extension tools and what the catalog classifies by, so an unknown
> built-in is **misclassified as an extension capability**. The pinned list needs a tripwire of its own,
> not only the pi-subagents one.

## R-32 · A governed child inherits the operator's skills and context files — M×H (FOUND AND FIXED)
Added 2026-08-12, **measured** (`docs/probes/g16-herdr` §4-5). `planSpawn` (`src/spawn.ts:50`) passes
`--no-extensions` and nothing else. pi has **separate** `--no-skills` / `--skill <path>` and
`--no-context-files` flags, and the comment at that line reasons only about *extension* discovery. So a
child spawned with the narrowest useful grant (`--tools read`) still starts with **every skill the
operator has installed** and with `CLAUDE.md` loaded — observed directly in a governed pane's startup
banner:

```
[Context]  CLAUDE.md
[Skills]   architect, build, debug, decide, git-ops, plan, review, skill-harness
```

**Two distinct problems, and they need different answers.**

1. **`skill:` capabilities enforce nothing.** This was suspected (ADR-0013; `SESSION-LOG` item f) and is
   now measured: a grant of `skill:review` and a grant naming no skill produce the *identical* child. A
   capability namespace that reads as a control and is not one is worse than an absent feature — it
   invites exactly the misplaced confidence R-25 describes. **Either make it real** (`--no-skills` plus
   `--skill` per granted skill) **or delete the namespace.**
2. **Context files are model-directing text that no grant describes.** Inheriting project conventions is
   often *desirable*, so this is not self-evidently a bug — but it must be a **decision**, because
   `CLAUDE.md` can instruct a child in ways no capability records and no ledger line reflects. Under
   ADR-0012's threat model (prompt injection in scope), an untrusted repo's context file reaching a
   governed child is the injection vector, and today it arrives silently.

**Mitigation (implemented 2026-08-12).** `planSpawn` now emits `--no-skills` unconditionally and adds
`--skill <path>` for each granted skill, resolved from the catalog's own `source` via
`skillPathsFromCatalog`. The order is not stylistic: read from pi's resolver
(`dist/core/resource-loader.js:329`), `noSkills` drops *discovered* skills while keeping
explicitly-passed paths, so `--skill` **without** `--no-skills` would ADD to the discovered set rather
than replace it — an allowlist that widens. A granted skill the catalog cannot place is **refused** by
`planDelegation`, not dropped: a grant naming a skill the child never receives is a ledger line that
lies. `--no-context-files` is on by default and `contextFiles: true` opts back in, so inheriting project
conventions stays possible but becomes a decision.

**A third resource class turned up while verifying the fix**, and is now withheld too:
`--no-prompt-templates`. Lower risk (a template expands when a human invokes `/name`; it is not injected
into the system prompt) but withheld for consistency, because under a herdr backend a governed child runs
in an **attachable pane with a human in it**.

**Verified in a real pi process, not only in unit tests** — the same way the defect was found. Before:
`[Context] CLAUDE.md` and `[Skills] architect, build, debug, decide, git-ops, plan, review,
skill-harness`. After: neither block appears.

**Still open:** the ledger records what a child *could do*, never what it was *told* — the skills and
system prompt it received are not in the record. That gap is what makes "what was this child instructed
to do?" unanswerable after the fact, and it is not closed by this fix.
**Trigger:** any grant naming a `skill:` capability that reaches a child without a `--skill` flag; any
pi release adding a resource class that `--no-extensions` does not cover.

## R-33 · `wait --until idle` returns before the work starts — M×H (FOUND AND FIXED)
Added 2026-08-12, **measured** (`docs/probes/g16-herdr` §7). `herdr agent wait <name> --until idle`
called immediately after `herdr agent prompt` matched the agent's **pre-existing** idle state and returned
at once, with `state_change_seq` unchanged — a reply indistinguishable from a completed run.

**Why this is a governance risk and not merely a bug to code around:** the intended fan-out pattern is
spawn N → prompt N → wait N → harvest N → merge. If the wait is satisfied by the state *before* the work,
an orchestrator collects N empty transcripts and **merges them into a confident summary of nothing** —
R-03's lossy-aggregation failure with a new cause. A missing result must never be indistinguishable from
an empty one.
**Mitigation (implemented 2026-08-12).** `runHerdrPane` does not use `agent wait` at all — its contract
cannot express "settled *after* this point". It polls `agent get` and requires **both** a terminal status
**and** `state_change_seq` advanced past the value observed before prompting. Verified by reintroducing the
defect: the R-33 test fails.
**Trigger:** any `runHerdrPane` implementation; any orchestration step that merges N child results.

## R-34 · A ledger whose damage is invisible is not a compensating control — M×H, CLOSED
Added 2026-08-12. ADR-0008 leans on the append-only ledger as its compensating control, and **nothing in
this package had ever read one back.** `appendRecord`'s strict mode catches write *errors*, never
corruption, so a torn line was silently indistinguishable from a spawn that never happened — a gap in the
audit trail that reads as an absence of activity. Two conditions made that more than theoretical: fan-out
turned concurrent appends from impossible into ordinary (a blocking `delegate` had bounded writers to one by
accident), and `PI_GRANTS_LEDGER` propagates to children, so a subtree can have many *processes* appending
to one file. `O_APPEND` is atomic for a single write to a regular file on a POSIX filesystem and promises
nothing on drvfs (`/mnt/c` under WSL2) or NFS — which is where this project runs.

**CLOSED 2026-08-14 (0.12.1).** `verifyLedger` now runs at **session start** whenever `PI_GRANTS_LEDGER` is
set, and a damaged trail announces itself as an error naming the first bad line. Until then the check was
reachable and unrun: `/grants ledger` found a torn line only if an operator thought to look, and a check you
have to know to run is a feature rather than a control — the same distinction this entry was opened on, one
level up. Corruption **only**: the escalation count is a query, and reporting historical attempts at every
start is the fatigue shape R-25 names, which ends with the operator skipping the line that matters. An
intact ledger says nothing, and a test asserts that as well as the alarm.

**Mitigation (implemented).** `verifyLedger` reads the ledger back and reports record count, escalation
attempts, and unparseable lines **with line numbers**; `/grants ledger` exposes it, because a check an
operator cannot run is not a control. Appends are serialised across processes by an exclusive lock file with
a short timeout (failing closed beats hanging) and stale-lock breaking (a process killed while holding it
must not block every future write). A corrupt line is **reported, never repaired** — it is the only artifact
an investigation has.

**Deliberately still open:** nothing *automatically* verifies. Detection exists; a scheduled or startup
check does not, so a corrupt ledger stays unnoticed until someone runs the command. Naming that is the
point — the previous state was worse and undocumented.
**Trigger:** any `/grants ledger` run reporting a non-zero corrupt count; any ledger configured under
`/mnt/` or an NFS mount.

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

## R-39 · Every model was told there are no definitions to spawn — H×H, FIXED
Added **and fixed** 2026-08-13 by an `architecture-critic` red-team pass over ADR-0017/0018/0019. **The one
that shipped.**

`registerDelegationTools` computed `spawnable` — the list in the `agent` parameter's description — at
**registration** time. Registration is synchronous in the extension factory (`extensions/grants.ts`), while
`session.definitions` is populated by the `session_start` hook, which fires afterwards. The map was
therefore always empty, `maySpawnDefinition` filtered nothing, and every model in every governed session
read **`Available: none.`**

So the model did the reasonable thing and used `delegate({tools})`: the path with no operator-authored
instructions, no `agent:` prerequisite, no `definitionDigest` on the record, and — by ADR-0019's own
reasoning — permanently denied `always`. **ADR-0017 and ADR-0019 both bought expressiveness the model was
structurally prevented from using**, and every dialog was a `<delegate>` dialog again. That is precisely the
prompt fatigue ADR-0019 was written to remove, arriving through the front door.

The comment on the deleted line reasoned carefully about grant staleness and never noticed the map was
empty. That is the lesson worth keeping: a careful argument about *when* a value is computed is worthless if
nobody checks what it computes.

**FIXED (0.10.2)** on a measured fact — **pi serialises a tool's schema at request time, not at
registration**, verified by a probe that rewrote a parameter description in `session_start` and saw the new
text arrive in `before_provider_request`'s payload. `registerDelegationTools` now returns
`refreshSpawnable()`, called from both hooks. Written through the *constructed* schema
(`params.properties.agent`) because `Type.Optional` shallow-copies its input. Pinned by two tests, and
verified to fail when the refresh call is removed.

## R-40 · `npm test` rewrote and cleared the developer's real approvals store — H×M/H, FIXED
Added **and fixed** 2026-08-13, same pass. **Confirmed by finding this suite's fixtures in `$HOME`**, not by
reading code: `~/.pi/agent/grants-approvals.json` contained `tool:write@x` with
`cwd: /tmp/grants-approvals-oFhqs6` and a body digest of sixty-four zeroes.

`approvalsPath(_cwd?)` **ignored its argument** — a vestige of the pre-ADR-0014 in-workspace store —
and `test/approval-store.test.ts` passed it a `mkdtemp` directory, reasonably believing the result was
hermetic. One test wrote `{ this is not json` over the real file; another emptied it; a third left
`version: 2` behind, which the loader rejects, so the operator's approvals would have silently granted
nothing even before being overwritten.

**Latent since ADR-0014 and destructive from ADR-0019**: while nothing could write the store, nothing could
lose anything either. `docs/SESSION-LOG.md` had applied exactly this reasoning to the *integration* suite the
same morning ("without the override this suite would read and write the developer's own approvals") and did
not carry it back to the unit suite.

**FIXED (0.10.2):** `approvalsPath()` takes no argument at all, so the mistake is unspellable rather than
merely corrected, and each test gets a hermetic `PI_CODING_AGENT_DIR`. Verified by checksumming the real
file across a full `npm test` run: unchanged.

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

## R-42 · Two concurrent `saveApproval` calls destroyed each other's write — M/H×M, FIXED
Added **and fixed** 2026-08-13, same pass. The atomic-write temp file was named
`${path}.${process.pid}.tmp` — unique per **process**, not per call. So of two concurrent writes, the
second's `wx` failed `EEXIST`, its `catch` unlinked the **first's** in-flight temp, and the first's `rename`
then failed `ENOENT`. **Both returned false and nothing was written**, on a perfectly writable file.

Measured with two *different* keys, so it was never limited to the shared-dialog case the finding described:
any two concurrent writes lost both. `delegate_all` is exactly that shape, so `always` failed precisely in
the fan-out case ADR-0019 argues drives adoption — and both callers reported *"could not persist the
approval — it applies for this session only"*, naming a cause that was not the cause.

**FIXED (0.10.2):** `${path}.${pid}.${randomUUID()}.tmp`, plus a test that runs two concurrent saves and
requires both to report success and at least one to survive.

## R-43 · `/grants revoke --all` revoked every project on the machine — M×M, FIXED
Added **and fixed** 2026-08-13, same pass; the sibling of R-41 and separated from it because the fix is a
different shape. `revokeAll` wrote an empty approvals file, and the store is one file for all projects — so
revoking in one checkout silently revoked every other checkout's approvals too.

An operator running a command that names neither a project nor a scope is answering for the checkout they are
sitting in. There is no interface for *"and everywhere else"*, so it must not be the default reading of the
one that exists. **FIXED:** scoped to its own `cwd`, other projects' entries preserved, and the confirmation
now says *"all persisted approvals for this project"* rather than *"all persisted approvals"* — the message
was accurate about the old behaviour, which is how it went unnoticed.

## R-44 · The model-authored task is written to disk, which the project's own rule forbids — M×M, OPEN
Added 2026-08-13, found independently by **both** reviewers, which is why it is not filed as a nit.

`src/ledger.ts` states the privacy boundary without qualification: *"**The task is not recorded, anywhere,
ever** — it is assembled by the model from the parent's context and can carry anything the parent could see,
so a ledger holding it would be a secrets sink."* ADR-0018 rejected recording it for that reason, and
`docs/SPEC.md` repeats the rule as "in any field".

`extensions/approvals.ts` writes `taskAtApproval: task` into the persisted entry, and `/grants approvals`
prints it back. The field predates ADR-0019 and was unreachable until it, so **0.10.0 armed it hours after
the rule was made explicit** — into a destination the ADR's own criteria rank *worse* than the ledger:
`PI_GRANTS_LEDGER` is opt-in and operator-placed, whereas `~/.pi/agent/grants-approvals.json` is always-on,
outside the repository, shared by every project, and kept for 30 days.

**A second reason to remove it, not found by either reviewer.** Displaying `for: <task>` beside a standing
approval implies a scope the approval does not have: the entry authorises **any** task for that definition
for 30 days. It reads like a constraint and is not one — the legibility failure of R-25 and R-35.

**FIXED 2026-08-14 by ADR-0021** — the field is deleted, not exempted. `ledger.ts`'s "anywhere, ever" stands
unamended and is now true. The write path additionally projects every entry through a **whitelist of declared
fields**, so this closes the class rather than the instance: no future field can reach the store by being
present on a parsed object. The task is still shown in the dialog, where a human needs it and where it is
not at rest.

## R-45 · The body pin exists on one of three approval paths — M×H, OPEN
Added 2026-08-13, same pass.

`resolveApprovals` resolves `inherited` → `session` → `persisted`, and **only the persisted branch passes
through `entryVerdict`**. Session approvals are bare `capability@subject` strings; `inheritApprovals`
publishes them to a child with no digest, no ceiling and no expiry. So ADR-0019's headline property —
*an approval is void once the instructions change* — is enforced on the one path that persists and on
neither of the two that do not.

**Scenario at depth 2.** A human approves `tool:bash@deploy` for body A. The file is then rewritten (a `git
pull`, or any agent in the tree holding `write`). The parent is unaffected — its `definitions` map is a
`session_start` snapshot — but the child it spawns is a **new process**, loads `deploy` from disk as body B,
receives `PI_GRANTS_APPROVED=tool:bash@deploy`, hits the `inherited` branch first, and runs body B with
`bash` under a yes given about body A. The ledger records `approvalSource: "inherited"`, which reads as
correct.

Not an escalation — `bash` was held and `approved ⊆ grant` still holds — but it is the confused deputy
ADR-0010 and ADR-0019 exist to stop, on the paths that skip the check.
**FIXED 2026-08-14 by ADR-0022:** `PI_GRANTS_APPROVED` publishes `capability@subject#sha256`, and the child
verifies the digest against the definition **it** loaded rather than trusting that its parent read the same
file. A republished key carries this session's digest, not the one it received, so a stale pin cannot travel
another hop. Breaking propagation-format change, as ADR-0014's was. An unpinned entry is still honoured —
`<delegate>` has no file to hash and a pre-0.11 parent sends none — but `key#` with nothing after it is
dropped rather than guessed at.

## R-46 · The ledger reports one approval source for a set with several — M×M, OPEN
Added 2026-08-13, same pass. `resolveApprovals` computes a per-capability `sources` map and
`obtainApprovals` throws it away, returning `scope ? "prompt" : sources[approved[0]]`.

Gate `tool:bash` and `tool:write`; let a persisted entry cover `bash` while a human clicks *Allow once* for
`write`. The record reads `approved: ["tool:bash","tool:write"], approvalSource: "prompt"` — **asserting a
human was asked about `tool:bash`, which they were not.** The ledger's whole job is answering *"did a human
authorise this?"*, and here it over-claims. **FIXED 2026-08-14 (0.11.1):** the record carries `approvalSources`, one entry per capability. The scalar
`approvalSource` is **kept and derived** — emitted only when every approved capability shares one source, so
old and new lines can both be trusted, and omitted rather than guessed when they differ. `buildRecord`
derives it instead of accepting it, so no call site can supply a summary that disagrees with the map beside
it.

## R-47 · `PI_GRANTS_GATED=agent:deploy` is a silent no-op — M×M, OPEN
Added 2026-08-13, same pass. `gatedBlocked` is a filter over `requested`, and for a definition spawn
`requested` is the definition's **ceiling** — which never contains `agent:<name>`, because the
authorisation check is a separate, ungated branch. `gatedFromEnv` accepts any string.

So an operator who reads ADR-0017's *"it attenuates like any other capability"* and writes
`PI_GRANTS_GATED=tool:bash,agent:deploy` meaning *"ask me before deploy runs"* gets no dialog, no warning,
and nothing in the ledger marking the gate inert. It **does** work when a definition hands the id down
(`allowed-tools: agent:deploy`), so the flag half-works, which is worse than not working at all. R-25's
shape, in the namespace ADR-0017 just promoted out of exactly that state.
**PARTLY FIXED 2026-08-14 (0.11.1):** a startup warning named the inert entry.
**FULLY FIXED 2026-08-14 (0.12.0) by ADR-0024:** the authorising id is evaluated against the gate, so
naming a definition in `PI_GRANTS_GATED` asks a human before it spawns, through the existing approval path —
`once`/`session`/`always` all apply, and a rewritten body voids a stored yes. `agent:*` in the gate covers
every definition. The id is deliberately **not** added to `requested` or `effective`: it is the parent's
authority to run the definition now, and putting it in `effective` would place it in the *child's* grant and
let the child re-spawn that definition with nobody asked. This also closes the gap ADR-0023 recorded against
itself — `agent:*` finally has its "except".

## R-48 · `/grants` silently truncated its verdict list at 12 — L/M×L/M, FIXED
Added **and fixed** 2026-08-13, same pass. The listing sliced to 12 definitions with no indication that it
had. Map order is discovery order, so the entries dropped are the **global** ones (`~/.pi/agent/skills`) —
the least obvious to lose — and absent was indistinguishable from "no such definition" while the
`catalog … N agent-type` line directly above contradicted the short list. R-38's failure mode with a
different cause. **FIXED:** `… and N more not shown`.

## R-49 · An unlocked read-modify-write can resurrect a revoked approval — L×M, OPEN
Added 2026-08-13, same pass. `approval-store.ts` documents that *"a revoke takes effect immediately —
including one performed from another session while this one is running"*, and the write path is an unlocked
read-modify-write, so: session 1 loads; session 2 revokes; session 1 saves an unrelated approval and
**restores the revoked entry** for the rest of its 30 days, with no error and no warning.

Needs two live sessions and a revoke inside the window, so likelihood is low — but it falsifies a documented
property, and the mitigation already exists in this codebase: the ledger's lock file.

## R-50 · "Void the moment either changes" is really "void at the next session start" — L×L, DOCUMENTATION
Added 2026-08-13, same pass. `session.definitions` is loaded once at `session_start` and never refreshed, so
`snapshotOf` validates persisted entries against a **session-start snapshot** rather than the file. Every
consequence is fail-safe and none is written down: within a long session an edited definition does not void
its approval (consistent, since the child genuinely receives the old body); two concurrent sessions can
legitimately disagree about the same entry; a definition added after start is unknown until restart. The one
that matters for an investigation: SPEC advises rehashing the file to answer *"has this definition changed
since?"*, and a rehash cannot distinguish "changed after the spawn" from "changed before it, in a session
holding a stale copy".

## R-52 · "Any definition, narrow tools" was unexpressible — M×M, FIXED
Added **and fixed** 2026-08-14; found by `product-strategist` in the red-team pass and decided as ADR-0023.
`maySpawnDefinition` accepted exactly `tool:*` or an exact `agent:<name>`, so an operator wanting *"may spawn
any of our review definitions, but may never hand over `write`"* had to either enumerate every definition —
a list that must be kept in sync by hand, where **adding a skill silently makes it unspawnable** — or grant
`tool:*`, which is authority to grant every tool and switches off the governance they wanted. **The
ergonomic option was the least safe one on the menu**, which is R-25's shape.
**FIXED by ADR-0023:** `agent:*` covers any `agent:<name>` and confers no tool authority. It is the only
wildcard rule in `resolve()` and is deliberately not generalised to `<ns>:*`, so a namespace added later does
not silently acquire one. It is inheritable (unlike `tool:*`, R-26) because it grants no tools and every
definition a descendant runs is still clipped to that descendant's own grant.
**Trigger for revisiting:** any incident where a definition nobody authorised ran because a grant said
`agent:*` — the risk Option 2 named, and the reason `agent:*,tool:bash` is documented as a poor combination.

## R-51 · Nothing reads `definitionDigest`, so ADR-0018's questions have no tool — M×L, OPEN
Added 2026-08-13 by the `product-strategist` pass. `verifyLedger` counts records, escalation attempts and
corrupt lines; it never touches `definitionDigest`. Both questions ADR-0018 advertises — *"did these four
children run the same instructions?"* and *"has this definition changed since?"* — require hand-written
`jq`, and the second is not even reproducible with `sha256sum SKILL.md`, because the digest covers the body
alone. Same class as R-34: the data exists and the control does not.
**FIXED 2026-08-14 (0.11.1):** `verifyLedger` groups records by `name`+`sha256`, and `/grants ledger` prints
each version with its spawn count and compares it against disk — `current`, `CHANGED since`, or
`no such definition here` — using the **same `snapshotOf`** that voids an approval, so the listing cannot
disagree with the enforcer about whether a definition changed. Two rows under one name are called out
explicitly, because that is the finding rather than a formatting quirk. Both of ADR-0018's advertised
questions now have a command; whether anyone runs it is that ADR's revisit trigger.

## R-59 · Four documents described a defect that had been fixed four days earlier — L×M, FIXED
Added **and fixed** 2026-08-14. `CLAUDE.md`, the root `README.md` and two places in `docs/SESSION-LOG.md`
all stated that `pi-token-audit`'s headline was *"a character ratio, not a token share"*. That was true when
G10 falsified it on 2026-08-10 and **false a few hours later**: `5c593fb` deleted the token estimate and the
report has since read *"% of request CHARACTERS … not a token measurement"*, with the arithmetic of the
mistake preserved in a comment so it stays legible.

**Two independent reviewers repeated the stale claim, and so did this assistant, three times in one
session** — because it was written in `CLAUDE.md`, which is the first thing anything reads here. That is the
cost of a stale line in an orienting document: it is not one wrong sentence, it is every downstream reader
inheriting it, including the ones brought in specifically to find wrong sentences.

Same shape as R-58 (documents describing behaviour the code no longer has), and worse in one respect: R-58's
contradictions were internal and findable by reading one file, whereas this one was only findable by reading
the *code* that the documents described. **Trigger:** any risk-register entry marked FIXED whose claim still
appears unqualified in `CLAUDE.md`, a README, or the session log.

## R-53 · A fresh approval crossed to the child unpinned, with one scope for the whole set — H×H, FIXED
Added **and fixed** 2026-08-14 by the second red-team pass, over ADR-0020–0023. **The one that shipped**, and
it made ADR-0022 false on exactly the approvals ADR-0022 was written for.

`planWithApprovals` re-plans with the just-approved capabilities, and that object literal carried two
defects:

- **No `bodySha256`.** `inheritApprovals` appended `#<digest>` only when one was supplied, and
  `verifyInherited` **honours an unpinned entry by decision** (`<delegate>` names no file; a pre-0.11 parent
  sends none). So every freshly-approved capability reached the child *exempt from the digest check*. The
  only thing hiding it in the single-capability case was sort order: both `tool:bash@deploy` and
  `tool:bash@deploy#<digest>` were published, `.sort()` put the unpinned one first, and `parseInherited`'s
  last-write-wins let the pinned one survive. **A security pin defended by lexicographic collation is not
  defended.**
- **One scope for the set.** `outcome.scope` was a single variable declared outside the prompt loop and
  overwritten by the last capability answered. Approve `tool:bash` *once* and `tool:write* *for this
  session* and both were re-stamped `session` — reopening ADR-0014's A-S1, the defect whose whole point is
  that a human's most conservative answer must not produce the least conservative outcome.

Confirmed by execution before being written down: the published set survived verification against a
different body.

**FIXED (0.11.2)** in three places, and the third is the one that matters: the literal now takes its digest
from `snapshotOf` and its scope from a per-capability map, `obtainApprovals` returns `scopes` instead of a
scalar — and **`inheritApprovals` now refuses to publish an unpinned entry for any subject other than
`<delegate>`**. Enforcing it at the point of publication makes it structural rather than something two call
sites must each remember, which is what the first fix relied on. A caller that cannot produce a digest
publishes nothing: the fail-closed direction.

## R-54 · `tool:*` did not satisfy non-tool capabilities, so ungoverned sessions were refused — M×M, FIXED
Added **and fixed** 2026-08-14, same pass. **This broke the one rule the package must never break by
accident: governance is opt-in.**

`docs/SPEC.md` has always said `tool:*` "satisfies any capability", and `maySpawnDefinition` has always
honoured it for definition ids. `resolve()` did not: it was exact-match plus subsumption plus (since
ADR-0023) `agent:*`, and `tool:*` appeared nowhere in its coverage check. It worked for tools only because
`deriveOwnGrant` *enumerates* observed tool names beside the wildcard — and an ungoverned session's
non-tool inheritance is empty.

So with **no `PI_GRANTS_GRANT` at all**, spawning a definition whose `allowed-tools` names `agent:worker` or
`skill:review` — the composition ADR-0017 created and ADR-0023's own example uses — was refused with
*"capability escalation blocked"* and recorded as an escalation attempt, in a session that had opted out of
governance. Measured. R-28's shape: two spellings of one rule, and the enforcing one was wrong. ADR-0023
edited this exact function and restated the false claim rather than noticing it.
**FIXED (0.11.2):** `covered()` honours `tool:*` for every capability. The gate still bites underneath it —
holding the wildcard is authority to grant widely, never authority to skip a human (ADR-0011).

## R-55 · `agent:*` could not be handed down at all — M×M, FIXED
Added **and fixed** 2026-08-14, same pass. `unknownCapabilities` runs **before** `resolve`, and the catalog
contains no wildcards — `definitionEntries` emits one id per discovered definition and `PI_BUILTIN_TOOLS`
has no `*`. So `delegate({tools: ["agent:*"]})` and a definition declaring `allowed-tools: agent:*` were
both refused as *"unknown capability … (typo, or an uninstalled package?)"*, from any grant. ADR-0023's
Decision says a parent holding `agent:*` may hand it down; that was live only at the root.
**FIXED (0.11.2):** wildcards are grammar, not catalog entries, and are exempt from the unknown check.
**Left open, recorded here:** because that check short-circuits before `resolve`, requesting a capability
that does not exist yields `denied: []`, so ADR-0008's escalation signal is not raised for a probe that
names something nonexistent. Fail-closed (the spawn is refused) but unrecorded as an attempt.

## R-56 · `/grants ledger` reported a false "CHANGED since" across projects — M×M, FIXED
Added **and fixed** 2026-08-14, same pass — in the R-51 feature shipped hours earlier. The digest listing
compared by **name only** while `verifyLedger` carried `source` all along. `PI_GRANTS_LEDGER` exported once
in a shell profile is shared by every project, so two different `deploy` definitions in two checkouts were
reported as one definition that had changed, complete with the NOTE the code's own comment calls "the
finding, not a formatting quirk". **A diagnostic manufacturing an incident, in the one command ADR-0018
points an investigator at.**
**FIXED (0.11.2):** `source` is compared too; a same-named definition from elsewhere is labelled as such,
and the NOTE fires only for two versions of the same file.

## R-57 · The per-project filename was a 24-bit hash with its mitigation removed — L×M, FIXED
Added **and fixed** 2026-08-14, same pass. `approvalsPath` used `sha256(cwd).slice(0, 6)` — 6 hex, 24 bits.
ADR-0020 deleted the `foreign-cwd` carry-through on the premise that one file means one directory, so
**inside a collision R-41 returns with its mitigation gone**: the second project's save deletes the first's
entries. Accidental collision arrives at a few thousand governed directories; a deliberate one costs ~16.7M
hashes, under a second. Availability only — `entryVerdict` still refuses to honour another `cwd`'s entry —
but "the collision becomes inexpressible" is a stronger claim than 24 bits supports.
**FIXED (0.11.2):** 16 hex, 64 bits.

## R-58 · Four documents described behaviour the code no longer had — M×M, FIXED
Added **and fixed** 2026-08-14 by the `product-strategist` pass. Each was introduced by the two days of
changes that preceded it, and the last one is the one this project's rules single out:

- `README.md` gave the **shared** store path, contradicting its own banner 290 lines above.
- `README.md` carried a live warning about `foreign-cwd` pruning — **behaviour ADR-0020 deleted** —
  presented as a caution about current code.
- `README.md`'s configuration table said `PI_GRANTS_APPROVED` carries `capability@subject` pairs,
  contradicting its own banner at line 17.
- `src/approval-store.ts` still said *"One file for all projects"*, contradicted eight lines later in the
  same comment block. **A register entry may describe what was believed on its date; a source comment
  describing present behaviour may not.**

Also: the README's opening paragraph carried the **unqualified** claim a reviewer forced out of `SPEC.md`
the day before — *"a sub-agent can never confer more than it holds"*, with no tool-surface clause. It is
repaired 100 lines down; the first paragraph is what a package registry shows.
**Trigger for the shape recurring:** any release where a decision changes behaviour and the README banner is
updated without re-reading the section the banner describes.

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
| 2026-08-12 | R-28 | Added and **FIXED same session** — the `tool_call` hook reached a correct `decideSpawn` through a wrong argument list, refusing every narrow inheriting type in an enumerated-grant session and firing the escalation signal on legitimate traffic. Confirmed by execution before being written. Fixed with a single `decisionContext()` builder + `test/interceptor-wiring.test.ts` (first unit coverage of `extensions/grants.ts`) | architecture-critic, verified locally |
| 2026-08-12 | R-29 | Added — one *Allow once* authorises N concurrent spawns (single flight keyed on a constant subject). Confirmed by a 10-line probe. **Latent**, since `delegate` blocks; a hard precondition for fan-out, and it reopens ADR-0014 | architecture-critic, verified locally |
| 2026-08-12 | R-30 | Added — `pi-herdr`'s `herdr_start_agent`/`herdr_delegate` expose **model-controlled `agentArgs` and `env`**, reopening the g1-argv hole and allowing a forged `PI_GRANTS_GRANT`. Not loaded on this machine; same class as ADR-0013 Finding 6 but through a documented parameter | landscape check |
| 2026-08-12 | R-31 | Added — the pi-subagents port has no version pin and no drift tripwire, and has **already drifted** (upstream 0.15.0, pi 0.84.1 vs probes' 0.83.0). Failure direction is permissive, so drift silently widens ceilings | architecture-critic, verified locally |
| 2026-08-12 | R-22 | Cross-referenced R-31 — R-22 named upstream churn as a risk but wired no trigger; R-31 is that gap made concrete, with a proposed differential test as the tripwire | architecture-critic |
| 2026-08-12 | R-29 | **FIXED** — a joining caller keeps a shared answer only when it was about more than one spawn; a `once` is consumed by exactly one. The per-spawn-key fix was rejected on ADR-0014's own reasoning. Two pre-existing tests were found to be **pinning the defect** and were re-targeted | `pi-agent-grants` |
| 2026-08-12 | R-31 | **TRIGGER FIRED** — pi 0.84.1 exposes a `parallel` tool absent from `PI_BUILTIN_TOOLS` (pinned "as of 0.83.0"). Gated correctly, but misclassified as an extension capability by `ceilingFor` and the catalog | `docs/probes/g16-herdr` |
| 2026-08-12 | R-32 | Added — **measured**: a governed child inherits all the operator's skills and `CLAUDE.md`, because `planSpawn` passes `--no-extensions` but not `--no-skills` / `--no-context-files`. Confirms `skill:` capabilities enforce nothing | `docs/probes/g16-herdr` |
| 2026-08-12 | R-31 | **RETIRED by deletion** — ADR-0016 removed the port (`src/agent-types.ts`, `src/interceptor.ts`), so there is no longer another project's resolution logic to keep in step. The proposed devDependency pin and differential test were never built and are no longer needed; `PI_BUILTIN_TOOLS` moved to `src/pi-tools.ts` and keeps its own trigger | ADR-0016 |
| 2026-08-12 | R-32 | **FIXED** — `planSpawn` withholds skills, context files and prompt templates, and passes `--skill` per granted skill; an unresolvable granted skill is refused, not dropped. `skill:` capabilities now enforce something for the first time. Verified in a real pi process, and a third leaking resource class (prompt templates) was found while verifying | `pi-agent-grants` |
| 2026-08-12 | R-33 | Added — **measured**: herdr's `wait --until idle` is satisfied by the pre-existing idle state, so a fan-out harvest can merge N empty results into a confident summary (R-03 with a new cause) | `docs/probes/g16-herdr` |
| 2026-08-12 | R-33 | **FIXED** — `runHerdrPane` polls `agent get` and requires a terminal status *and* an advanced `state_change_seq`; `agent wait` is never used. Building the executor also found four further herdr constraints, written up as an addendum to `docs/probes/g16-herdr` | ADR-0016 |
| 2026-08-12 | ADR-0008 | **AMENDED** — the attenuation invariant gains a **cardinality companion**: a subtree budget (`PI_GRANTS_FANOUT`), propagated like depth, plus a per-call cap. Closes review finding F5, which had no entry of its own because "silence about a bound" is not a risk anyone had written down | ADR-0015 / fan-out |
| 2026-08-12 | R-35 | Added — `agent:` capabilities enforce nothing, so definitions are not individually authorised and a definition's *instructions* are ungoverned. Found by writing `docs/SPEC.md`: stating the guarantee precisely is what exposed the gap between "what a child can do" and "what it is told to do" | doc sync |
| 2026-08-12 | R-34 | Added and **partly fixed** — the ledger had no reader, so corruption was silent; `verifyLedger` + `/grants ledger` make it detectable and concurrent appends are now serialised by a lock | fan-out |
| 2026-08-12 | R-30 | Downgraded in likelihood — the working frame (no third-party pi extensions; speak herdr's CLI directly) means `pi-herdr` is not installed and its model-controlled `agentArgs`/`env` are not in the trust path. **Kept as a live entry**: the hazard returns the moment it is installed, and this frame is not yet recorded in an ADR | `docs/probes/g16-herdr` |
| 2026-08-13 | R-28 | **Dated note** — the mitigation is unchanged but moved: `decideSpawn`/`decisionContext()`/`test/interceptor-wiring.test.ts` went with ADR-0016's port deletion; the surviving builder is `delegationContext()` in `extensions/session.ts` after `extensions/grants.ts` was split 866 → 202 lines. `test/file-size.test.ts` now makes "the one file with no unit coverage grew unreviewable" a test failure | grants.ts split |
| 2026-08-13 | R-36 | Added — `deriveOwnGrant` filters the inherited grant by observed **tool** names, so `skill:` and `agent:` capabilities are silently dropped at the first provider request. Live for `skill:` since R-32; fail-closed but unrecorded, and a hard blocker for ADR-0017. **Measured by execution** while scoping that ADR | ADR-0017 |
| 2026-08-13 | R-35 | Taken up by **ADR-0017 (Proposed)** — `agent:<name>` becomes a real prerequisite (Option A) rather than the namespace being deleted (Option B), in two steps with R-36 fixed first. The audit half (body hash on the ledger record) is deliberately left to a separate ADR | ADR-0017 |
| 2026-08-13 | R-36 | **FIXED** same day (ADR-0017 step 1) — only `tool:`/`ext:` are filtered against an observation; `skill:` and `agent:` pass through. Four tests, including survival across three levels | ADR-0017 |
| 2026-08-13 | R-37 | Added — the `<delegate>` approval subject rests on a premise ADR-0017 falsified, so `always` approvals can never persist on the only spawn path. Fail-closed; the real cost is the prompt fatigue that gets gating switched off (R-25's shape) | ADR-0018 scoping |
| 2026-08-13 | R-35 | **Audit half closed** by ADR-0018 — every definition spawn records a `definitionDigest` (name, source, sha256 of the body). What remains is inherent: the digest identifies text without preserving it, and no capability model judges what a body says. The **task is never recorded**, by decision | ADR-0018 |
| 2026-08-14 | R-34 | **CLOSED** — `verifyLedger` runs at session start, so a damaged audit trail announces itself instead of waiting to be asked about. Corruption only; the escalation count stays a query, because a control that speaks every session is one an operator learns to skip | queued work |
| 2026-08-14 | R-59 | Added and fixed — four documents, `CLAUDE.md` first among them, described `pi-token-audit`'s G10 defect as live four days after `5c593fb` fixed it. Both reviewers and the assistant repeated it from those documents. A stale line in an orienting file is inherited by every reader, including the ones hired to find stale lines | verifying a finding |
| 2026-08-14 | R-53…R-58 | **Second red-team pass**, over ADR-0020–0023 (`architecture-critic` + `product-strategist`). Six entries, all fixed the same session. R-53 is the one that shipped: every freshly-approved capability crossed to the child **unpinned**, so ADR-0022 was false on exactly the approvals it was written for — hidden by sort order. R-54 broke "governance is opt-in". Both confirmed by execution before being written. The pass also cleared the `republishable` laundering fix, `parseInherited`/`verifyInherited`, ADR-0021's deletion, and R-46's derived scalar as sound | red-team pass 2 |
| 2026-08-14 | R-46, R-47, R-51 | **Closed (R-46, R-51) and half-closed (R-47)** — the queued code work from the red-team pass, none of it needing a decision. The ledger no longer claims a human was asked about a capability satisfied from the store; `/grants ledger` reads `definitionDigest` for the first time, so ADR-0018's two advertised questions finally have a command; and an `agent:` id in `PI_GRANTS_GATED` says out loud that it gates nothing. Enforcing that last one is left as a decision | queued work |
| 2026-08-14 | R-41, R-44, R-45, R-52 | **All four closed by decision**, as ADR-0020 (one approval file per project), ADR-0021 (the task is never stored), ADR-0022 (an inherited approval names its instructions) and ADR-0023 (`agent:*`). Each was presented to the user with a worked failure scenario and the options weighed; each ADR records the rejected option and what it would have bought. Two are breaking: the store layout and the propagation format | red-team follow-up |
| 2026-08-14 | R-49 | Narrowed, not closed — ADR-0020 reduces the unlocked read-modify-write race from "any two projects on the machine" to "two sessions in the same directory". The mitigation is unchanged and still unbuilt: the lock the ledger already has | ADR-0020 |
| 2026-08-13 | R-39…R-51 | **Red-team pass over ADR-0017/0018/0019 and the R-38 fix** (`architecture-critic` + `product-strategist`, the first review of any of it). Thirteen entries. Five fixed the same session (R-39 the description that said `Available: none`, R-40 the suite rewriting `$HOME`, R-41's pruning half, R-42 the lost concurrent write, R-43 global revoke, R-48 silent truncation); six open, of which R-41's keyspace, R-44's stored task and R-45's unpinned inheritance need decisions rather than patches. **Both reviewers independently found R-44.** Every finding acted on was reproduced by execution first | red-team pass |
| 2026-08-13 | R-29 | Cross-referenced R-41 — two unit tests were again found *pinning a defect as correct*, this time calling another project's live approval "stale". Third occurrence of that pattern in this repository; worth a standing check when a test's fixture is named after a judgement rather than a state | red-team pass |
| 2026-08-13 | R-38 | Added and **FIXED same session** — `/grants` listed a definition as BLOCK while a real spawn would allow it off a valid persisted approval, because the listing shared the *planner* with enforcement but not the *approval step*. R-28's shape one layer up. Found by the first end-to-end test of the approval store, and confirmed by execution before being written. Fixed with one `planWithApprovals` used by both, `ctx: null` meaning preview | approval-store IT |
| 2026-08-13 | R-37 | **Verified end to end** — an `always` approval was created by a real model answering a real dialog, read back by a *different* process with no prompt (ledger `approvalSource: "persisted"`), and voided by a body edit that re-raised the dialog. ADR-0019's machinery had been implemented and unit-tested but never watched working; it works | approval-store IT |
| 2026-08-13 | R-37 | **Corrected and FIXED** — the entry understated it: `always` was not silently downgraded, it was **never offered**, because `offeredScopes` gated it on a path ADR-0016 had deleted. Nothing since 0.7.0 could write a persisted approval, so ADR-0014's integrity work guarded an unwritable file. ADR-0019 makes the definition the subject and pins the body digest as well as the ceiling | ADR-0019 |
