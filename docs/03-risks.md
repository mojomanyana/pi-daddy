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
`packages/pi-daddy/package.json` names `@tintinweb/pi-subagents` **nowhere** — not a dependency, peer,
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

## R-44 · The model-authored task is written to disk, which the project's own rule forbids — M×M, FIXED
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

## R-45 · The body pin exists on one of three approval paths — M×H, FIXED
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

## R-46 · The ledger reports one approval source for a set with several — M×M, FIXED
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

## R-47 · `PI_GRANTS_GATED=agent:deploy` is a silent no-op — M×M, FIXED
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
**AND THE PARTIAL FIX OUTLIVED THE FULL ONE ACROSS EIGHT PUBLISHED VERSIONS — see R-134, added 2026-08-21.** The 0.11.1
warning above stayed in the session banner through 0.18.1, telling operators that the 0.12.0 gate does
nothing and to withhold the capability instead, with an integration test requiring it to. Removed there.
The lesson for this register: when an entry records two fixes, the second one's commit is also the moment to
delete the first one's mitigation — nothing here prompts for that, and nothing did.

## R-48 · `/grants` silently truncated its verdict list at 12 — L/M×L/M, FIXED
Added **and fixed** 2026-08-13, same pass. The listing sliced to 12 definitions with no indication that it
had. Map order is discovery order, so the entries dropped are the **global** ones (`~/.pi/agent/skills`) —
the least obvious to lose — and absent was indistinguishable from "no such definition" while the
`catalog … N agent-type` line directly above contradicted the short list. R-38's failure mode with a
different cause. **FIXED:** `… and N more not shown`.

## R-49 · An unlocked read-modify-write can resurrect a revoked approval — L×M, FIXED
Added 2026-08-13, same pass. `approval-store.ts` documents that *"a revoke takes effect immediately —
including one performed from another session while this one is running"*, and the write path is an unlocked
read-modify-write, so: session 1 loads; session 2 revokes; session 1 saves an unrelated approval and
**restores the revoked entry** for the rest of its 30 days, with no error and no warning.

Needs two live sessions and a revoke inside the window, so likelihood is low — but it falsifies a documented
property, and the mitigation already exists in this codebase: the ledger's lock file.

**FIXED 2026-08-14 (0.13.0).** The park said *"do not harden a layer whose fate item 1 decides"*, and that
reasoning weakened once the fix turned out to be **reuse rather than hardening**: the lock moved to
`src/file-lock.ts` and both writers use it, so this cost no new mechanism and leaves nothing extra to delete
if ADR-0020 ever chooses Option 3.

Two decisions inside it, both the opposite of the ledger's and both following from what the file *is*:

- **Writes lock; reads do not.** A read that loses a race sees the previous state, which is exactly what
  "read on demand" already promises. Locking reads would buy nothing and slow every gate check.
- **A lock this cannot take does not fail the work.** The ledger is a security control — no audit line, no
  spawn. This store is a convenience cache and the human already said yes, so a timeout downgrades to
  session scope and warns. Failing a delegation closed because a *cache* was busy would be failing closed on
  the wrong thing.

The test is the property, not the plumbing: two writes are issued concurrently and the assertion —
`{b, c}` — is **satisfiable only under a lock**, since unlocked leaves either the revoked entry resurrected
or the concurrent save lost. Mutation-checked; removing the lock fails that test alone. Found on the way in:
the lock lives beside the file, so its directory has to exist *before* the lock is taken, and on a
first-ever approval it did not — every write failed on the lock and reported "busy". The existing round-trip
tests caught it within a minute.

## R-61 · A failed revoke was reported as "no such approval" — L×H, FIXED
Added **and fixed** 2026-08-14, found while fixing R-49. `revokeApproval` returned a boolean for three
facts, so `/grants revoke <key>` printed **"grants: no persisted approval named X"** whenever the *write*
failed — while the approval was still in effect and still satisfying gates.

Low likelihood, high impact, and the impact is the direction that matters: an operator revoking an approval
is performing a security action, and they were told the thing they were revoking did not exist. Reassuring
and wrong beats alarming and wrong every time, which is why this outranks its own probability. Same family
as R-46 (a record asserting a human was asked when they were not) — the failure is the *claim*, not the
mechanism.

**FIXED (0.13.0), breaking:** `RevokeOutcome` is `"revoked" | "absent" | "failed" | "busy"`.

**The first fix contained a smaller copy of the defect it fixed** — the third time that has happened here
(R-38's preview, ADR-0022's republish path), and the first time it was caught by the operator reviewing the
fix rather than by a later pass. It shipped as three states, and a **lock timeout happens before the load**,
so `failed` was returned for a key nobody had looked for while asserting *"It is still in effect"*. False for
a name that never existed. It errs alarming rather than reassuring — the opposite of R-61 proper — which
ranks it low and is not a reason to keep it.

`busy` now says only what was checked: another session holds the file, **nothing was changed**, and this
says nothing about whether the approval exists. `LockTimeoutError` earns its own type precisely so the two
can be told apart: "someone else is writing" is transient, while "the lock could not be created at all"
(EROFS, a directory replaced by a file) will never succeed, and telling an operator to retry that one wastes
their time on a certainty.

**Trigger:** any boolean return in this package that a caller renders as a sentence. Swept at fix time —
`report.ok`, `plan.ok`, `revokeAll` and `saveApproval` were all checked and all have two values for two
facts.

## R-63 · The ADR-0020 tally overstated the persistence layer twentyfold — M×H, FIXED
Added **and fixed** 2026-08-14, **found by the operator reviewing the previous day's work**, and the most
useful finding of the four because it was wrong in the direction that decides an ADR.

`/grants ledger`'s new tally counted `persisted` **records** and reported each as a prompt avoided.
Precedence is `inherited → session → persisted → prompt`, and **`session` approvals live in memory and owe
the persistence layer nothing**. So a session spawning `deploy` twenty times under one persisted entry
writes twenty `persisted` records — while deleting the store would raise **one** prompt and satisfy the
other nineteen from the session cache. The cost of deletion was reported as 20 when it is 1.

That is the same bias `unattributed` exists to prevent, arrived at from the other side: the report excluded
pre-0.11.1 records precisely so it would not inflate `prompt`, and then inflated `persisted` twentyfold by a
different route. **Excluding one known bias is not the same as being unbiased**, and this is what that
sentence costs when it goes unexamined. A second, opposite bias was in it too: one human decision fanning out
to eight children writes eight `inherited` records, inflating the denominator.

**FIXED (0.13.0)** by reporting **two** numbers and labelling them. Records stay, as an upper bound and named
as one; distinct `capability@subject` pairs are printed beside them as the closer estimate, since deleting
the layer costs at most one prompt per pair per session. The exact figure needs a session id the ledger does
not carry, and adding one is refused for now — a schema change to the file whose privacy boundary is spelled
out in three documents, for a question asked once.

**Trigger:** any count in this package presented as an answer rather than a bound. The tell is a sentence of
the form *"each of these is an X"* about records that were not counted per X.

## R-83 · An approval for one subject satisfied another on the PLAIN delegate path — H×M, FIXED 2026-08-18
Added **and fixed** 2026-08-18. `planDelegation` matched `ctx.approved` by bare capability **name**, ignoring the
subject. The fix (0.17.0) was made for `delegate_chain` and its commit message claimed it was *"a no-op on the
pre-existing paths, because they already filtered"*. **That claim was false, and a reviewer measured why.**

`planWithApprovals`' re-plan feeds the planner `[...republishable(session), ...outcome.approved]`, and
`republishable` carries **every subject the session knows, unfiltered**. So the second of the two callers never
pre-filtered.

**Measured, with no chain involved.** Session gating `tool:bash` and `tool:write`, holding an inherited
`tool:write@shaper`, spawning definition `digger` whose ceiling is `Read, Bash, Write`. The operator is asked twice
and **says yes to `tool:bash` while dismissing `tool:write`**:

- with the filter: refused, nothing spawned.
- without it: `SPAWNED`, child argv `--tools bash,read,write`.

**A capability the human explicitly declined for this definition was granted anyway**, satisfied by a yes given for a
*different* definition — with `blocked:false` and `humanDenied:true` on the same ledger line. That is ADR-0014's A-S6
falsified on the ordinary path, and it shipped in 0.16.0.

**Why this entry exists even though the code is fixed.** The record attributed the defect solely to
`delegate_chain` and described the planner change as behaviour-preserving elsewhere. A future reader could
"simplify" the filter back out on that basis. Rule 2 and rule 5 both require the falsification to be written down.
**One test of 498 catches it** — `test/propagation.test.ts`'s A-S6 case — which is thin for a property this load
bearing, and is the honest reason this is rated M rather than L on likelihood of recurrence.

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

## R-51 · Nothing reads `definitionDigest`, so ADR-0018's questions have no tool — M×L, FIXED
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

## R-60 · A ledger that could not be READ silenced session start entirely — M×M, FIXED
Added **and fixed** 2026-08-14, one session after R-34 added the control it defeats. Found by asking the
session log's fourth question — *where else does the R-34 shape appear?* — and **confirmed by execution
before being written down**: a governed session with `PI_GRANTS_LEDGER` naming a directory emitted **zero**
notifications. Not the corruption alarm, and not the `grants: depth 0/2, holding [...]` line that is the one
sign governance is on at all. A control run under the same harness with an ordinary path emitted it.

`verifyLedger` **rethrows** every read error that is not `ENOENT`. That is right for `/grants ledger`, where
an operator asked a direct question. It is wrong at session start, where the call sat inside
`session_start`'s blanket `try { … } catch { /* never throw into the agent loop */ }` — an **empty** catch.
So the throw cancelled every remaining control with no trace.

Three things make this worse than its blast radius suggests:

- **It is R-34's own shape, one level down.** R-34 was *"a check an operator has to know to run is not a
  control"*. R-60 is *a control that does not run on the one input class it exists to detect* — and a trail
  nothing can read is more damaged than a trail with a torn line, not less.
- **The write path already got this right.** `appendRecord` is called with `strict: true`, so the *first
  spawn* against an unreadable ledger refuses loudly. Only the startup check was silent. An asymmetry like
  that is the tell.
- **An empty catch makes every future control silently optional.** Anything added to `session_start` after a
  throwing line inherits the same fault without anyone writing a new bug.

**FIXED (unreleased):** the `verifyLedger` call carries its own `catch`, which reports the path, the errno
and what to do (`PI_GRANTS_LEDGER names a writable FILE`) as an `error`, and the hook continues. The outer
catch is now **loud** rather than empty — it names the failure and says explicitly that later checks did not
run and that the grant itself is unaffected, because enforcement is `--tools` at spawn time and does not
depend on this hook. One integration test against real pi, asserting both halves: the new alarm fires, **and**
the `holding [...]` line still arrives, which is what pins the discarded-controls defect rather than just the
message. Mutation-checked: restoring the rethrow fails that test and nothing else.

**What this does not establish.** The loud outer catch has **no direct test**. Every loader inside the hook
(`loadDefinitions`, `buildCatalog`, both `existsSync` probes) already swallows its own filesystem errors, so
after this fix there is no reachable input that throws past it — which is the reason it is defence in depth
and the reason it cannot be driven from outside. **Trigger:** any new `await` added to `session_start`
whose callee rethrows; it belongs in its own `catch`, not in the blanket one.

## R-72 · Five risk headlines said OPEN for defects their own bodies recorded as FIXED — L×M, FIXED
Added **and fixed** 2026-08-14. R-44, R-45, R-46, R-47 and R-51 each carried `OPEN` in the `## R-nn ·`
headline while the body beneath it said **FIXED**, with a date and a version — and in R-47's case
*"FULLY FIXED … by ADR-0024"*.

**This is R-59's shape, in the register R-59 lives in**, and it is the second time this project has shipped
a stale status line into the document a reader orients from. R-59's trigger was written for exactly this
case and did not fire, because it names `CLAUDE.md`, READMEs and the session log — the places the *previous*
instance was found — and not the risk register itself. A trigger derived from where the last one turned up
finds the last one again.

The failure mode is specific and cheap: a headline is what a reader skims and what a `grep '^## R'` returns,
so five closed defects looked live to anyone scanning, and `docs/SESSION-LOG.md`'s claim that "R-34…R-62 are
ALL CLOSED" contradicted the register it summarised.

**FIXED:** all five headlines corrected. **Trigger, generalised past its origin this time:** any `## R-nn`
headline whose body contains `FIXED` or `CLOSED`. That is mechanical — a five-line script over this file —
and it is the form the check should have taken from the start, rather than a list of the filenames where a
human last happened to notice.

## R-70 · A ledger of nothing but declines reported no declines — L×M, FIXED
Added **and fixed** 2026-08-14, red-team pass. `humanDenied` was rendered **inside** the
`attributed > 0 || unattributed > 0` guard, so a ledger with no approvals printed nothing about the
declines in it.

That is the worst possible ledger to be quiet about. A session where the operator said no to everything is
simultaneously the strongest evidence the gate is doing its job and the most alarming shape an audit can
take — and it was the one shape `/grants ledger` had nothing to say about. The number arguing hardest for
this package's own gating was invisible in exactly the file arguing hardest.

**FIXED:** declines are reported on their own line, before the approvals block, with **records and distinct
pairs**. The pair count is there for R-63's reason one field over: R-29 shares a decline across every
concurrent caller, so one click of *Deny* under an eight-wide fan-out writes eight `humanDenied` records,
and calling that "eight times a human declined" is the per-record bias R-63 removed from `persisted` — left
in place on the only number that flatters this package's own control.

## R-69 · Four causes of an unsatisfied gate produced one indistinguishable record — M×M, FIXED
Added **and fixed** 2026-08-14, raised by `architecture-critic` against ADR-0026. `PromptOutcomeKind` has
five members and the ledger record kept **one bit** of it (`humanDenied`, from `declined`), so `no-ui`,
`dismissed` and `error` produced *identical* records — `gatedBlocked` non-empty, no `approvalSource`,
`blocked: true` — separated only by free-text `reason` written for a human at the call site.

Given a failed run, *"was there an operator who timed out, or was there nobody to ask?"* was not answerable
from any field, and **the two want opposite fixes**: a dismissal wants a longer
`PI_GRANTS_APPROVAL_TIMEOUT` or a queue; `no-ui` wants an operator pre-approving; `error` is a defect. The
discriminant was already computed at the call site and thrown away — R-51's shape, in the record rather
than in a reader.

It lands on ADR-0026 specifically because that decision is expressed **entirely in ledger vocabulary** and
asks a future reader to believe the ledger when it says *"nobody was there to ask"*. It could not say that.

**FIXED:** `gateOutcome` carries the kind, written only when a gate went unsatisfied — a field present on
every record is not a signal, and an approved spawn already says so through `approvalSources`. **Privacy is
unchanged**: a fixed five-member enum, nothing model-authored.

## R-71 · Two herdr panes could be orphaned with nothing tracking them — L×L, FIXED
Added **and fixed** 2026-08-14, red-team pass, both confirmed by execution against the injected exec.

- **A `tab create` reply carrying `pane_id` but no `tab_id`** ran to completion and returned `code: 0` with
  the tab closed by nobody — `cleanup`'s close is guarded by `tabId` and `trackPane` had never been called.
  Defensive only (real herdr 0.7.5 always returns both), but a silent permanent leak rather than a loud
  failure.
- **The early return had an untracked window** one herdr round-trip wide: a tab existed from the moment the
  reply was parsed, and nothing would have reaped it if the process died there. The *normal* path had no
  such window and the *error* path did — backwards, since the error path is the one more likely to be taken
  while something is already going wrong. `trackPane` now runs before the pane-id check.

Also: the early return removed the staged prompt directory unconditionally, throwing away with `keepPane`
what `cleanup` deliberately keeps — on the one path where there is no agent in the pane to ask instead.

## R-67 · The file lock let two writers into `work()` at once — M×H, FIXED
Added **and fixed** 2026-08-14 by the red-team pass. **The most serious finding of the four**, and the only
one that broke an invariant rather than a claim. Reproduced across **real OS processes with no clock
manipulation** — 120 trials × 16 processes on a deliberately oversubscribed box gave two trials with
overlapping holders, and the overlap persisted for the rest of each trial rather than self-correcting.

The lock came from the ledger and predates its extraction; R-49 gave it a second caller, which is what made
it worth attacking.

**One root cause, two breaks:** `rm(lockPath)` deletes whatever is at the path *now*, not the lock this
process created.

- **The stale break is two awaits.** `stat` decides the lock is old; `rm` deletes whatever is there when it
  runs. A process descheduled between them destroys a **live** lock another waiter created in the gap, and
  its own create then succeeds. Two holders.
- **The `finally` was unconditional, and this one is far wider** — its window is the whole of `work()`. A
  holder whose lock had been broken out from under it still freed the **new** owner's lock on the way out.
  The next arrival then walked in beside that owner having raced nothing and observed nothing wrong, which
  is how one lost race became a chain.

The docstring asserted the opposite in so many words: *"whichever wins the subsequent exclusive create
proceeds, which is correct because only one can."* True of the create, false of the delete — which is
exactly what made it convincing.

**FIXED (unreleased):** every lock carries a unique token, and `removeIfOurs` re-reads it before any delete,
so a process can only ever remove a file it can prove is its own. Read-then-delete is still two operations,
so the window is narrowed rather than closed — from "the whole of `work()`" to "between a read and an
unlink" — and the *systematic* break is gone. Three tests; mutation-checked, and the first version of the
fix had **no** failing test until the mutation showed it, which is rule 7 catching the author.

**Also fixed, found in the same pass:** a throw from `handle.writeFile` (ENOSPC, EDQUOT, EFBIG) jumped to
the rethrow with the lock file **already created**, leaving an orphan and leaking the descriptor to GC. An
orphan blocks every writer for a full `STALE_LOCK_MS`, and with the ledger's `strict: true` that fails
delegations closed for ten seconds at a time while being re-created on every retry.

**Also corrected — a claim, not code:** `STALE_LOCK_MS` never checks whether the owner is alive, so *any*
10s stall hands the lock on: `SIGSTOP`, laptop suspend, swap thrash, a debugger breakpoint, a long GC pause.
The trigger originally hypothesised — a slow `work()` — is **cleared by measurement**: one ledger append is
0.11ms on ext4 and 20.5ms on drvfs, a 10,000-entry `saveApproval` is 30ms / 97ms, and 16-way contention
raises *waiters'* time rather than the holder's (max hold 49ms). Two orders of magnitude of headroom against
normal operation, and no guard at all against abnormal suspension. Both halves are now in the docstring.

**Trigger:** any `rm`, `unlink` or `rename` in this package that targets a path another process may own,
without first proving ownership.

## R-68 · `busy` keyed on the error type instead of on what had been read — L×M, FIXED
Added **and fixed** 2026-08-14, same pass. R-61's fourth outcome exists because *"a lock timeout happens
before the load, so nothing was ever looked at"* — and then it was implemented as `error instanceof
LockTimeoutError`, which is a different question.

`EMFILE` — the classic transient, and one a fan-out of children plus herdr panes produces — also fails
before the load, took the `failed` branch, and so asserted the approval *"is still in effect"* about an
entry nobody had looked for while blaming a path that is perfectly writable. R-61's own defect, one error
code to the left, inside R-61's own fix.

**FIXED:** the discriminant is now whether `work()` was entered at all, so every pre-load failure reports
`busy` whatever its cause — and the `busy` message names **no** cause, because at that point none has been
established. Verified by execution with a store directory replaced by a file.

**Consequence worth stating:** `failed` may now be unreachable on the revoke path, since anything stopping
the write also stops the lock beside it. It is kept as defence in depth and **deliberately not asserted by
a test**, rather than asserted with a fixture that proves something else — which is precisely the mistake
R-64 recorded.

## R-66 · Eight ledger lines claimed a human was prompted; one human was — M×H, FIXED
Added **and fixed** 2026-08-14 by the red-team pass over that same day's work. **Confirmed by execution
before being acted on**: one dialog, eight `granted/session` outcomes.

R-29's single-flight queue **shares** any non-`once` outcome across concurrent callers, and that is correct
— *Allow for this session* authorises the capability for the session, not for one child. What was wrong is
the RECORD. `obtainApprovals` then stamped `sources[capability] = "prompt"` unconditionally, so a fan-out of
eight under one click wrote **eight lines each asserting a human was asked**, with the human having seen
exactly one child's task.

`src/ledger.ts` names this exact direction "the worst available failure", and **R-46 is the same defect one
level down** — a scalar claiming a human was asked about a capability they were never asked about. R-46 was
fixed across the capability SET; the concurrency case survived it.

**FIXED (unreleased):** `PromptOutcome` carries `joined`, set only on the shared-outcome path, and a rider
records `session` — which is the honest answer, since it was satisfied by the session approval that answer
created. Two tests, and the second is the one that keeps R-29 intact: a `once` outcome is **never** marked
joined, because nobody may ride a single-spawn approval. Mutation-checked.

**Trigger:** any field the ledger derives from a shared or cached result rather than from what this
particular caller did.

## R-65 · The pane reaper was disabled by the one failure it was built for — L×M, FIXED
Added **and fixed** 2026-08-14, red-team pass, both halves confirmed by execution.

**The reaper could not see a refused close.** `defaultExec` **resolves** with `{code: 1}` on failure and
never rejects, so `cleanup`'s `.catch(() => undefined)` was dead code and the reply was never parsed: a
herdr that REFUSED to close a pane looked identical to one that closed it, and the pane was untracked. The
single failure mode the reaper exists for was the one that removed the pane from its registry. Now the
reply is parsed and only a genuine close untracks.

**The exit sweep could hang the process for 80 seconds, silently.** Eight panes × two calls × a 5s
per-command timeout, with `stdio: "ignore"`, against a hung herdr. Worse, `timeout` is **not a bound**:
`spawnSync` sends `SIGTERM` and then waits for the child to die, so a process ignoring `SIGTERM` runs to
completion — measured at **59.8s for a 3s timeout**. Now `killSignal: "SIGKILL"`, 2s per call, and a **6s
budget across the whole sweep**. A pane left open is the right degradation; a shell that will not exit is
not.

**What this does not establish.** The reaper still does not cover SIGKILL or an unlistened SIGTERM (R-62),
and a pane skipped because the budget ran out is not retried — there is no later sweep. Both are stated in
`src/pane-reaper.ts` rather than implied.

## R-64 · Three malformed source maps corrupted the ADR-0020 tally — M×M, FIXED
Added **and fixed** 2026-08-14, red-team pass, every case reproduced by execution. All three arrive from a
torn, hand-edited or foreign line — **the input class `verifyLedger` exists for**, so "this package never
writes that" is not a defence.

- **`source in bySource` walks the prototype.** A source of `"toString"` passed the check,
  `bySource.toString += 1` wrote a *string* into a counter, the renderer's `Object.values(...).reduce` then
  concatenated instead of summing, `attributed > 0` was false, and **the entire measurement disappeared from
  the report** — while the same line was counted as both valid and corrupt, marking an intact ledger
  damaged. `Object.hasOwn` now.
- **`{}` beside a non-empty `approved` was counted nowhere**, silently shrinking the sample — falsifying the
  promise made by the very field (`unattributed`) added to keep the sample visible.
- **An array passed `typeof === "object"`** and was tallied with numeric indices as capability names,
  inflating `persisted`, which is R-63's direction.

**Also: the pair key claimed to match `approvalKey` and did not.** The approval subject is `DELEGATE_SUBJECT`
(`<delegate>`); the ledger writes `spec.agent ?? "delegate"`, the bare word. `DELEGATE_SUBJECT`'s angle
brackets exist precisely so it "can never collide with a real type", and the ledger dropped them. Mapped in
`verifyLedger` so old files read correctly, with the residual limit stated: a definition genuinely named
`delegate` is indistinguishable from the `tools:` form in that field.

**The test encoded the wrong belief**, which is why it survived: it hand-wrote a record with **no**
`agentType` — a shape production has never written — and asserted the mapping from that. It passed while
proving nothing about the real record. Deleted, and replaced with one driven by the shape
`run-delegation.ts` actually writes. **Trigger:** any test whose fixture is hand-written rather than
produced the way the code under test produces it.

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

## R-73 · `npx pi-daddy init` printed nothing and exited 0 — L×H, FIXED
Added **and fixed** 2026-08-16, during B2. The CLI guards its entry point with *"only run when invoked
directly"*, spelled `import.meta.url === pathToFileURL(process.argv[1]).href`. **npm installs a bin as a
symlink**, so `process.argv[1]` is `node_modules/.bin/pi-daddy` while `import.meta.url` is the file it points
at, and the comparison was false for every installed copy. `main()` never ran.

The failure mode is the reason this is `×H` rather than a footnote: **a scaffolding command that does nothing
is indistinguishable from one that found nothing to do.** Exit code 0, no output, no error — an operator
would reasonably conclude their project had no skill packages and go looking in the wrong place.

**Found by the smoke test, not by reasoning or review.** This is B-I12's shape exactly (the `exports` map
that worked in the tree and threw for every consumer), which is why `scripts/smoke-installed.mjs` exists, and
it has now caught the same class of defect twice.

**Corrected 2026-08-17.** This entry originally said *"every in-repo test passed: they import `main` and call
it, which is precisely the path the guard is written to exclude"*. **False** — `grep -rn 'from "../src/cli'
test/ test-integration/` matched nothing: `src/cli.ts` had **no tests at all**, which is both the truthful
account and the stronger one for this entry's own argument. Found by a reviewer re-executing the claim. The
CLI now has tests, and they immediately caught a second defect in the same file (R-79's argv half).
**FIXED:** `realpathSync(process.argv[1])` before comparing, wrapped in a `catch` that declines to run rather
than throwing. The smoke test now runs the installed bin end to end and asserts on its output and the files
it writes.
**Trigger for the shape recurring:** any new package entry point — a `bin`, an `exports` subpath, an
`imports` alias — that no test exercises through an *installed* copy.

## R-75 · `init` found nothing when you installed the way pi tells you to — M×H, FIXED
Added **and fixed** 2026-08-17. Found by running the documented setup in a **clean environment** rather than
by reading it — every previous test of `init` used `npm install` into the project, which is the layout the
documents described and not the one pi produces.

```
pi install npm:principal-pi-skills
  → $PI_CODING_AGENT_DIR/npm/node_modules/principal-pi-skills
  → the project gets NO node_modules at all

pi-daddy init
  → "no installed package under <cwd>/node_modules declares skills.
     npm install principal-pi-skills"
```

**It told an operator to install a package they had just installed.** `discoverSkillPackages` searched only
`<cwd>/node_modules`, and `pi install` — the pi-native path, and the **only** one that registers a package
so pi will auto-load its extension — does not put it there.

**FIXED:** both roots are searched, project first, so a copy pinned in a repository outranks the
machine-wide one and a name in both yields one package rather than two. `init`'s remedy message now names
every root it looked in and offers `pi install` first.

**It also falsified three of this project's own documents**, which had all said `npm install pi-daddy`. That
instruction appeared to work only because the developer's `~/.pi/agent/settings.json` already listed
`npm:pi-daddy` from an earlier session — the classic shape of a claim verified on a machine that had been
prepared without anyone noticing.

**Widening discovery immediately broke six unit tests**, because they then read the developer's real
`~/.pi/agent/npm`. That is R-40's lesson a second time — a test that reads real user state is not a test —
and each now gets an isolated `PI_CODING_AGENT_DIR`, the same fix the approval store already carries.
**Trigger:** any discovery that reads a path outside a test's own temp directory.

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

## R-76 · `init`'s generated grant is as wide as its widest skill — M×M, FIXED (ADR-0029)
Added 2026-08-16 (ADR-0028). The grant `init` writes is the **union** of every copied definition's declared
ceiling, so one skill declaring `Bash` puts `tool:bash` in the operator's session grant. An operator who
sources `.pi/grants.env` without reading it has a session that may hand a shell to a child — and `bash`
subsumes governance entirely (ADR-0012).

**SUPERSEDED 2026-08-17 by ADR-0029: the wide capabilities are no longer live.** A reviewer priced the
mitigation below and found it was one-third of what it claimed — `DEFAULT_GATED` is **only `tool:bash`**, so
`tool:write` and `tool:edit` reached a child with no dialog at all, and the ADR's own consequence sentence
("the edit step disappears and `init` grants all seven `agent:` ids for the operator to delete down")
described a source-and-go workflow that would never perform the edit the mitigation assumed. `init` now emits
`bash`, `write`, `edit` and the universal capabilities **commented**, with the definitions that need them
named. The original reasoning is kept below because the correction is the instructive part.

**Mitigated three ways rather than avoided**, because the alternative — `init` choosing a subset — is the one
thing ADR-0028 forbids. `tool:bash` is **gated by default**, so a human is asked before any child receives
it; every capability in the file is annotated with the definition it came from, so the wide one is nameable
at a glance; and the file exists precisely to be edited before it is sourced, which is the difference between
this and a runtime default.
**Trigger:** a `.pi/grants.env` found committed with capabilities no definition in that project declares, or
any report of a session holding `tool:bash` whose operator did not know it did.

## R-77 · A skill's DIRECTORY NAME could write a capability into the operator's grant — M×H, FIXED
Added **and fixed** 2026-08-16, during B2, by asking what the generated file interpolates. A definition's
identity is its directory name (`nameFromPath`), and `pi-daddy init` writes that name into three places at
once: `agent:<name>` inside a **comma-separated** `PI_GRANTS_GRANT`, a `.pi/grants.env` the operator
**sources**, and the path the copy is written to.

**Reproduced against the real CLI.** An installed package with a skill directory named `a,tool:bash`
produced:

```
export PI_GRANTS_GRANT="agent:a,tool:bash,tool:delegate,tool:read"
```

**`tool:bash` in an operator's grant, declared by no definition and chosen by nobody** — in the one file
this feature exists to make reviewable, and in the capability this project gates by default because it
subsumes governance entirely (ADR-0012). A quote character reaches a file that is `source`d; a name of `..`
would write outside `.pi/skills/`.

The reach is bounded and worth stating exactly: it needs a package the operator chose to install, it changes
what `init` *proposes* rather than what any session enforces, and the file is meant to be read before it is
sourced. It is `×H` because the whole claim of `init` is that the grant is what the definitions declare, and
this is a way for it not to be.
**FIXED:** `isSafeName` — a whitelist, `[A-Za-z0-9][A-Za-z0-9._-]*`, applied at discovery. A refused skill is
**named on stderr** with the rule, and counted on the summary line so `0 skill(s)` cannot read as "this
package ships none". Verified by mutation: deleting the check fails exactly that test.
**Trigger for the shape recurring:** any new file this package *generates* whose content includes a string
taken from a third party — a definition name, a package name, a path — in a format where a separator or a
quote means something.


## R-78 · A skill's `allowed-tools` VALUE could execute code from the generated grant file — H×H, FIXED
Added **and fixed** 2026-08-17, by an independent reviewer attacking the grant file one day after R-77 was
closed. R-77 whitelisted the definition **name**; the declared **capability id** travels to the identical
interpolation site and was unchecked. `ceilingForDefinition` passes `ext:`, `skill:` and `agent:` entries
through **as written** — correct for the enforcement path, where the catalog refuses what it does not know —
so a package declaring

```yaml
allowed-tools: Read,ext:x";touch /tmp/pwned;PI_GRANTS_GRANT="
```

produced

```
export PI_GRANTS_GRANT="agent:review,ext:x";touch /tmp/pwned;PI_GRANTS_GRANT=",tool:delegate,tool:read"
```

**Reproduced end to end**: `source .pi/grants.env` — the command `init` itself prints — executed the payload,
**silently, exit 0**, leaving `PI_GRANTS_GRANT` set to a plausible value. Backticks work identically; `$(…)`
happens to be caught because an entry containing `(` is routed to the pattern branch, which closes one vector
of several by accident.

**Why this is `×H` rather than "an npm package can already run code at install time".** The payload lands in
a file this workflow tells the operator to **review and commit**. It travels in version control and
re-executes on every teammate who sources it, long after the package is gone — and it survives
`npm install --ignore-scripts`, the posture that would otherwise contain a hostile package.

**And R-77's own trigger names this case**: *"any new file this package generates whose content includes a
string taken from a third party, in a format where a separator or a quote means something."* It was written
about the name and not applied to the value sitting beside it, one line away.
**FIXED:** `isSafeCapability` at discovery (a whitelist per namespace, mirroring `isSafeName`); `tool:*` and
`agent:*` from a *package* declaration are refused separately and loudly, because "you tried to grant
yourself everything" is a different fact from "that is not a name"; and `assertGrantIsWritable` refuses to
write the file at all if anything outside `[A-Za-z0-9:@,._/-]` reaches the assembled grant — a backstop that
does not depend on the enumeration above being complete, since this is the second time the enumeration was
incomplete.
**Trigger:** any third string reaching a generated artefact — a description, a path, a package name — and any
new generated file at all.

## R-79 · `init` overwrote an operator's file, wrote through symlinks, and never checked argv[0] — H×M, FIXED
Added **and fixed** 2026-08-17. Four defects in one scaffolder, all found by reviewers, all reproduced here
before being acted on.

**(a) `readFile` as a presence probe conflates *unreadable* with *absent*.** An operator's `SKILL.md` with
restrictive permissions was reported `wrote`, and their narrowed `allowed-tools: Read` was replaced by the
package's wider `Read, Grep` — **without `--force`**. That falsifies this package's own documented rule
(`docs/SPEC.md`: *"The target file exists → **Kept**"*) in the direction that **widens**. A FIFO at a target
path hung the probe forever, with no timeout anywhere on the path.

**(b) `writeFile` follows symlinks.** A *dangling* symlink at a target path failed the probe, so `init` took
the "absent, so write it" branch and created the file at the link's destination, **outside the project**,
while printing an in-project path. With `--force` it destroyed the link's target. This is **B-I6**, which
`approval-store.ts` fixed for the approval store under ADR-0014 and documents in a comment reading *"never
through a symlink"* — a new writer in the same package reintroducing a defect the package records as closed.

**(c) `--force` silently regenerated `.pi/grants.env`.** The reviewed artifact. An operator who had deleted
`agent:build` and added `PI_GRANTS_LEDGER` would have had both restored to generated defaults by the command
ADR-0028 prescribes as the re-sync for R-74 — whose usage text mentions only `allowed-tools`.

**(d) The unknown-option check exempted `argv[0]`.** `rest.filter((a, i) => … && i !== dirIndex + 1)` with
`--dir` absent makes `dirIndex` `-1`, so the exemption became `i !== 0`. `pi-daddy init --Force` was accepted
as a valid no-op run — exit 0, every file kept — which is indistinguishable from a deliberate second run and
is *precisely* what that line's own comment says it prevents. `src/cli.ts` had **no tests**, which is how
both this and R-73 shipped from one file.
**FIXED:** one `open(path, "wx")` closes (a) and (b) — `O_CREAT|O_EXCL` fails on anything at the path
including a dangling symlink, so there is no probe and no probe-to-write race; `--force` unlinks first, so it
replaces a link rather than writing through it, and never touches `grants.env`; and `parseArgs` is now a pure
exported function with tests.
**Trigger:** any writer in this package that is not `open(…, "wx")` or the approval store's atomic
`wx`+`rename`, and any argv handling that is not `parseArgs`.

## R-80 · The package-containment check was lexical, so a symlink walked past it — M×M, FIXED
Added **and fixed** 2026-08-17. `readSkill` compared `resolve(packageDir, entry)` against `packageDir`, and
`resolve()` normalises `..` while knowing nothing about symlinks. Measured: a `pi.skills` entry pointing at a
symlink inside the package copied a definition from **outside** it into `.pi/skills/`, and that definition's
`allowed-tools: Bash, Write` landed in the operator's grant. Nothing in the output prints `sourcePath`, so
the operator could not tell the copy did not come from the package on the `found` line.

**Same lesson as `cli.ts`'s `realpathSync`, one day later and one file away** — R-73 was fixed by resolving a
symlink before comparing, and this check was written afterwards without it.
**FIXED:** both sides are `realpath`ed before the prefix test.
**Trigger:** any path comparison in this package that is not preceded by `realpath`.

## R-81 · The startup line blamed the operator's FILES for a session-level refusal — M×M, FIXED
Added **and fixed** 2026-08-17. `summariseSpawnable` re-derived a cause from two fields of `plan.result` and
discarded `plan.reason`. `planDelegation` has **six** refusals that leave both fields empty, so all six fell
into the "their files are written wrong" bucket. Measured in a real pi session:

```
grants: 0 of 3 definitions spawnable
  withheld: docs-writer, fabric-agent, undeclared — cannot be spawned as their files are written …
    BLOCK  docs-writer — delegation is disabled (maxDepth 0)
```

Two lines apart, in one screen, from one code path. **This is R-28's shape inside the fix for R-28's shape**,
and the module header claiming *"classified by the real planner, never by a second reading of the rules"* was
false: the classification **was** the second reading. It sent an operator to edit three well-formed
`SKILL.md` files when the fix was one environment variable — and the most likely way to reach it is a
malformed `PI_GRANTS_MAX_DEPTH`, where the extension warns "spawning is disabled" and then blames the files
two lines later.

**Worse, and separately:** the line ignored `mayDelegate`. A governed session whose grant omits
`tool:delegate` has **no `delegate` tool at all** (S-5) — verified with a probe extension calling
`pi.getAllTools()` — and was told `1 of 3 definitions spawnable`. The one configuration where nothing can
ever be spawned is the one the line got wrong, and it is the exact question ADR-0028 says the line exists to
answer.
**FIXED:** session-level facts (`mayDelegate`, depth bounds) are answered **before** any planning, in one
sentence naming the environment; everything the two designated signals do not explain now prints the
planner's own `reason` verbatim.
**Trigger:** any new refusal in `planDelegation` — check whether it sets `denied` or `gatedBlocked`, or the
bucket silently grows again.

## R-82 · The withheld list printed the UNION of missing capabilities across definitions — L×M, FIXED
Added **and fixed** 2026-08-17. `renderSpawnableSummary` grouped withheld definitions by reason and rendered
one deduped `missing` list for the whole group, so a definition missing only `agent:undeclared` was reported
as also needing `agent:fabric-agent`. With nine or more members both halves truncated independently, giving
`def-0 … and 1 more — need tool:t0 … and 1 more`. **The line's stated purpose is naming the fix**, and the
fix it named was wrong per definition. `docs/SPEC.md`'s and ADR-0028's own worked examples were instances.
**FIXED:** rendered per definition — `architect (needs agent:architect); build (needs agent:build)`.
**Trigger:** any aggregate rendered against a list of names rather than beside each one.

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

## R-90 · A load-bearing ledger failure strands a live writer lease — M×H, FIXED
Added and fixed 2026-08-19 while testing ADR-0034's cleanup claim. Workspace setup acquired the kernel lock
and then wrote the `workspace_lease` event. If that append failed, the catch path tried to record another
event and rethrew, but the acquired lease was scoped inside the `try` and never released. The OS would
recover it when the parent exited; a still-live pi session could not start another governed writer.

**FIXED:** setup retains the lease across the error boundary and releases it before any best-effort refusal
record. Child execution now also encloses executor invocation and terminal lifecycle writes in the release
`finally`, not only the successful-return branch. A regression test makes the acquired-event append fail,
then acquires the same canonical-root lease in the same process.
**Trigger:** any operation inserted between lease acquisition and the `finally`, especially a load-bearing
ledger append; any cleanup whose resource handle is declared inside the `try` that can fail after acquisition.

## R-91…R-95 · Independent review found five assurance bypasses — H×H, FIXED
Added and fixed 2026-08-19 before release. Three independent reviews found:

- **R-91:** single-flight keyed only `capability@subject`, so concurrent exact-bound tasks could share one
  session/always answer and each waiter stamped its own task binding onto it. The binding digest is now part
  of the queue identity; different exact scopes raise different dialogs.
- **R-92:** model-facing `access:"read"` could suppress a writer lease even for `write`/`edit`/`bash`.
  Coordination access is now conservatively derived from trusted requested capabilities; caller `write` may
  tighten and caller `read` cannot loosen.
- **R-93:** parent SIGKILL released the helper's lock while the actual process/herdr agent survived. The lease
  helper now owns crash cleanup for an attached PID/tab and releases only afterwards; token-checked metadata
  prevents a stale lease object overwriting a successor.
- **R-94:** check receipts promoted caller-supplied head/tree into top-level “exact” identity. Head and the
  temporary-index candidate tree are now computed under the lease, checked against any supplied value, and
  recomputed after the check; workspace change yields no receipt. Executable bytes are copied privately and
  hashed before spawn, so later configured-path replacement does not change what runs or invalidate the receipt.
- **R-95:** a grandchild retaining stdout/stderr could keep `runChild` pending after the governed PID was
  killed. Settlement now drains briefly after PID exit and does not wait forever for inherited pipes. This
  does not kill arbitrary detached descendants or claim containment.

**Trigger:** removing the binding digest from prompt queue identity; consulting declared access without the
grant; releasing before attached-resource cleanup; copying correlation identity into a receipt; waiting only
for pipe `close` after process `exit`.

## R-96…R-97 · The first review fixes had aggregate-path copies of the defects — H×H, FIXED
Added and fixed 2026-08-20 in the required re-review. **R-96:** chain upfront approvals were tracked only by
subject, so one tools-only step could be attributed approvals intended for another and consume every `once`
for `<delegate>`; when a later gate declined, earlier session/persisted answers remained active but vanished
from the ledger. Approvals now retain intended step+capability for attribution/consumption and every banked
answer is recorded even when no step runs. **R-97:** single delegate still wrapped the upstream critical token,
fan-out could return while siblings were running if one infrastructure path threw, and mixed failures could
borrow one child's refusal code. The exact token now fails unchanged on all three tools; fan-out catches and
awaits every sibling before rethrowing infrastructure failure; aggregate codes require every failure to carry
the same code. Partial results include per-child refusals.

The same pass made v2 validation require its join/identity fields, attached named checks to crash cleanup,
closed settled writer panes before lease release, executed privately staged executable bytes rather than a
racy pathname, and destroys inherited output pipes after bounded drain.
**Trigger:** any aggregate path that reconstructs approval/refusal/lifecycle semantics beside the single-child
path; any writer resource that can stay live after its lease event says released.

## R-98 · Final review found evidence/lease races after the happy-path fixes — H×H, FIXED
Added and fixed 2026-08-20. A herdr writer tab-close refusal still returned normally on two paths, so the
caller released its lease around a live promptable pane. A named check could lose its helper while a blocked
receipt append was in progress and still emit evidence. Fan-out preferred an infrastructure exception over a
sibling's exact critical-block token. Versioned ledger lines could omit the event discriminator and be read
as legacy. All now fail closed: failed writer close throws and retains the helper/lease; checks finish and
release the measured candidate lease before writing a receipt and emit none on lease loss; the critical token
wins after every sibling settles; any line carrying `ledgerVersion` must satisfy v2 discrimination/fields.
**Trigger:** a receipt written before its resource's terminal ownership fact; a cleanup failure converted to
normal return; “legacy” selected from field absence without first rejecting a present version marker.

**Amended 2026-08-20 (six-reviewer pass), and the amendment is a correction to this entry, R-93 and
R-97.** Rule 2: the note is added, the original text above is left alone. All three said or implied that
each fix carries a regression. A mutation audit — 17 mutations, each applied to production code on a
confirmed-green baseline and restored — showed **four of those claimed regressions do not exist**:

- **R-93's second half** ("token-checked metadata prevents a stale lease object overwriting a
  successor"). Changing `if (current?.token === token)` to `if (true)` left the suite green. The test
  named for it killed the recorded pid FIRST, so `release()` short-circuited on a dead holder and the
  token comparison was never reached. R-93's first half was genuinely pinned.
- **R-97's "awaits every sibling before rethrowing".** Replacing `infrastructureError ??= error` with
  `throw error` — so `Promise.all` rejects early and abandons live siblings — left the suite green.
- **R-98's "retains the helper/lease".** The throw was tested; the retention, which is the actual safety
  property, was not. `retainWriterLease = false` left the suite green.
- **R-98's "the critical token wins after every sibling settles".** Swapping the two throws so an
  infrastructure error wins left the suite green; no test constructed a fan-out with both.

R-90, R-91, R-92, R-94, R-95, R-96 and R-98's other two halves were each mutation-verified as genuinely
pinned. All four gaps above now have tests that fail when the guard is removed. **A claimed regression
nobody re-derived is indistinguishable from an absent one**, which is why this correction is here rather
than in a commit message.

---

## R-99 · `flock`'s command inherits the lock fd, so teardown released nothing — H×H, FIXED

Added and fixed 2026-08-20. **Measured, and it settled a disagreement between two reviewers who both said
they had measured it** — one reported an orphan keeping the lock, the other reported `FD_CLOEXEC` making it
a stray-process leak only. `docs/probes/g35-flock-fd-inheritance` shows the exec'd command holds an fd on
the lock file, survives SIGKILL of the wrapper, and keeps the lock (`exit 73` on reacquisition) until it
dies; `-o/--close` exists precisely because inheriting is the default, and pi-daddy does not pass it.

Two teardown paths SIGKILLed only the wrapper. On the readiness-timeout path the helper's pid is usually
still unknown, so killing the recorded pid is not a fix either. **Consequence:** a stranded lock, reported
to every later acquisition as `WORKSPACE_WRITE_CONFLICT` — the one message an operator would use to conclude
another agent is writing. Separately, `release()` **threw** from a path every caller runs in a `finally`, so
a dead helper turned a COMPLETED child into an exception with no output: the model could not tell "the work
never happened" from "the work happened and we lost the receipt", which is R-03's rule.

Fixed: the holder gets its own process group and teardown kills the group (which also stops a stray terminal
signal from releasing a live writer's lock); `release()` returns `released | released-unrecorded | lost` and
never throws; `executePlannedChild` reports a teardown failure alongside its result instead of in place of
it. **Trigger:** any cleanup path that can throw, or that kills a wrapper rather than the process holding
the resource.

## R-100 · `recovered` lied in both directions — M×H, FIXED

Added and fixed 2026-08-20. ADR-0034 sells "crash recovery is an observed kernel-lock fact rather than an
age guess". Two ways the observation was of something that never happened: an **unreadable** predecessor
record read as `recovered: false`, silently downgrading "the previous writer may have died mid-write" to the
reassuring answer; and a swallowed release write left `state: "active"`, so the next owner recorded a crash
after a clean handover. Absent and unreadable are now different facts, `recovered` has a third state
(`"unknown"`), and "recorded" means this owner actually wrote its own handover — `released-unrecorded`
otherwise. **Trigger:** a best-effort write whose failure changes what a later reader concludes.

## R-101 · The lease helper signals a recorded pid with no identity check — L×H, ACCEPTED

Added 2026-08-20, **not fixed.** On parent death the helper SIGTERMs, then SIGKILLs, the pid it was told to
attach — with no `/proc/<pid>` start-time check. In the window where the child exits and the parent dies
before releasing, that pid may have been recycled and the helper signals an unrelated process. Accepted
rather than fixed: the check belongs inside a one-line embedded helper where a bug is harder to see than the
race is to hit, and the blast radius is bounded by the parent's own uid. **Revisit if** the helper grows a
real module, or if anyone observes it killing something it did not start.

## R-102 · The herdr close loop retried forever while holding the lock — M×H, FIXED

Added and fixed 2026-08-20. `herdr tab close` was retried at 1s intervals with no cap, no deadline and no
give-up, while holding the kernel lock — so a pane closed by hand, a downed daemon, a missing binary or a
mid-run herdr upgrade stranded that worktree **permanently**, with no lease command in `/grants` and no
recovery short of finding an anonymous `flock`/`node -e` pid. ADR-0034 licenses "stops the attached process
or herdr tab before releasing"; it does not license never releasing. Now bounded, and it releases anyway
with a marker file naming the tab: **an unreleasable lock is worse than a recorded failure to close.**

## R-103…R-105 · The ledger had no words for what the lease actually did — M×H, FIXED

Added and fixed 2026-08-20. `WorkspaceLeaseOutcome` was `acquired | refused | released | timeout |
recovered`, so three different facts were all recorded as `released` or `acquired`:

- **R-103:** a lease **lost** under a live governed writer was recorded as `released, reason: cancelled` —
  byte-identical to an operator pressing stop. A count of lost leases is exactly the number an operator
  auditing this feature needs, and it was unrepresentable. `lost` added, plus `CHILD_*` refusal codes so the
  two are distinguishable to an external controller as well as to a reader.
- **R-104:** a deliberately **retained** lease (herdr tab would not close) wrote no terminal event at all,
  so the successor's `recovered: true` blamed a crash on a known-good path. `retained` added.
- **R-105:** a **read** lease, which takes no kernel lock, was recorded as `acquired` — overstating how many
  exclusions the kernel performed. `uncontended` added, and `verifyLedger` counts them separately.

**Trigger:** any outcome union where two materially different facts share a member.

## R-106 · A child could mint the upstream controller's verdict — M×H, FIXED

Added and fixed 2026-08-20. `isCriticalAssuranceBlock` matched on `!ok` plus the child's own captured stdout
starting with `BLOCKED_CRITICAL_ASSURANCE`, and the caller then threw that text, **discarding** the
governance-authored reason and the structured refusal. So a timeout, a cancellation, a lost writer lease or a
truncated answer could all be reported to the parent as a clean upstream veto — and under ADR-0012's threat
model the child's output can carry content it merely read from a repository. The token is now honoured only
when the child otherwise exited cleanly non-zero: a process killed mid-sentence has not been assessed by
anybody's gate. ADR-0034's pass-through requirement is unchanged.

## R-107…R-109 · Refusals an external controller could not identify — M×M, FIXED

Added and fixed 2026-08-20. ADR-0034 promises "stable refusal codes accompany, rather than replace, existing
human diagnostics". Three groups had none. **R-107:** no execution-phase failure carried a code, so a lost
lease, a timeout, a cancellation, a missing `setpriv` (a *documented platform requirement*) and an ordinary
non-zero exit were indistinguishable free text. **R-108:** the catch that recorded an executor failure used
a strict ledger append, so its own failure replaced the error it was recording — including
`HerdrWriterCloseError`, whose meaning is "a lease is retained". **R-109:** five planner paths returned a
reason with no code, among them the `assertNarrowing` violation — ADR-0011's invariant, the hardest rule this
package enforces, and the one refusal a controller switching on `error.code` would misclassify as an
internal error. All coded now, and `test/refusals.test.ts` is length-checked against the whole union because
it previously enumerated eleven of eighteen members.

## R-110 · A bound approval could be spent outside the workspace it named — H×H, FIXED

Added and fixed 2026-08-20. `buildApprovalBinding` read `workspace_id` and `context_id` straight out of
**caller-supplied** `correlation` into what the comment one line above calls the trusted,
internally-computed scope. Worked sequence, all in one session: approve a delegation carrying a real
`workspace` spec — registry-resolved, realpathed, leased, human asked — then re-issue the byte-identical
task with `correlation.workspace_id` set and **no** `workspace` field. No registry lookup, no lease, the
parent's own cwd, every digest matching, and the persisted approval is spent; the ledger names a workspace
the child never entered. The guard that would have caught it can only fire when there is a spec to disagree
with.

No capability escalation — the grant is unchanged — but the "exact workspace scope" property advertised in
ADR-0034, `docs/SPEC.md` and the package README was false for the two components that came from the caller.
The binding now takes trusted values only and does not accept a `CorrelationMetadata` at all; scope follows
the routing spec. `context_id` is still included and is documented as a caller-declared label that narrows
only. **Trigger:** any field that crosses from a "non-authoritative" structure into one documented as
trusted.

## R-111 · Correlation was a model-writable text channel into the append-only ledger — H×H, FIXED

Added and fixed 2026-08-20. `src/ledger.ts` states the invariant in its own header — capability ids, counts
and identifiers only, never prompts, tool arguments or results — and ADR-0034 repeats that the ledger must
never carry task text. But `correlation` is a **model-facing tool parameter** on all three delegation tools,
`assurance_scope` was declared `Type.Any()`, and `normaliseCorrelation` checked only "is a JSON object, under
32 KB": no key whitelist, no per-field bound, undeclared keys surviving the round trip. A model could write
32 KB of arbitrary text into every v2 event through it, and disabling the cap entirely left the suite green.
Now a whitelist of the pinned schema 1.0 field set, each string bounded at 512 characters,
`assurance_scope` at 4 KB, sequence numbers required finite. An undeclared key is refused **by name**: if
upstream adds a field, an actionable break beats a silent secrets sink.

## R-112 · The correlation bound threw past every recorder — M×M, FIXED

Added and fixed 2026-08-20. `normaliseCorrelation` threw a bare `Error` from outside every try in
`planDelegation`, so an oversized correlation produced a governed refusal with **no code and no ledger line
at all** — the ledger file was never even created. This is the G6/B-I3 class that `src/delegate.ts`'s own
comment says it exists to close, reopened by a new pre-`resolve()` throw site. Caught and recorded now.

## R-113 · A refused delegation still banked the human's approval — H×H, FIXED

Added and fixed 2026-08-20. `extensions/run-delegation.ts` states the rule — "a refused operation must not
leave authority behind" — and moved the executor check above the gate to honour it. The **adjacent path kept
the defect**: the load-bearing ledger append runs after the gate, and its failure denies the delegation, so
an operator clicks *Always*, a 30-day project-wide entry reaches disk, `PI_GRANTS_APPROVED` is republished to
children, and the spawn never happens. A lock timeout under fan-out is a documented condition, so no
adversary is required. The gate now records what it banked and the refusal takes it back, saying so out loud
if the store was busy and an entry still stands. **This is the third occurrence of one defect shape** (the
executor path, then the chain path as R-96, now here), which is the argument for fixing shapes rather than
sites.

## R-114…R-115 · A failed check left evidence of a clean run — M×H, FIXED

Added and fixed 2026-08-20. **R-114:** `CHECK_IDENTITY_MISMATCH` — "the workspace changed while the check
ran", the strongest evidence-integrity signal the feature has — wrote no ledger record at all, while the
`finally` wrote `released, reason: completed`. The trail for a check whose workspace was mutated mid-run read
like a clean run with no receipt. **R-115:** those `finally`/`catch` ledger appends were strict, so an append
failure replaced the refusal it was recording. Every throw out of `runNamedCheck` is now ledgered as a lease
refusal, and both records are best-effort-but-loud.

## R-116…R-117 · Fan-out discarded what it caught — M×H, FIXED

Added and fixed 2026-08-20. **R-116:** `infrastructureError ??= error` kept the first sibling's error and
dropped every other with no log anywhere — and one of the droppable ones is `HerdrWriterCloseError`, a
*resource-retention notice* rather than a per-child failure, so nobody was told a lease was held with no
owner until the process exited. Each swallowed child also reported the same contentless
`"delegation infrastructure failed"` with no code. **R-117:** the critical-assurance token was checked first
and threw past the infrastructure error entirely. The token still wins — it is the answer the caller is
waiting for — but the infrastructure failure rides along in an `AggregateError`. Mixed refusal codes now
survive a total failure in `details`, under an aggregate code that is deliberately not any child's.

## R-118 · The worktree-membership check is defence-in-depth with no test — L×L, ACCEPTED

Added 2026-08-20. Deleting `registeredWorktrees.includes(registered)` from `validateRegisteredWorkspace`
leaves the suite green, and unlike the other four guards audited that day this one resisted every attempt to
construct a case where it is the only check that fires — the `rev-parse --show-toplevel` comparison catches a
non-repository, a path inside a worktree, and a broken gitdir link. Recorded as accepted rather than given a
test that would pass for a different reason. **Revisit if** anyone finds the case, or concludes the check is
genuinely redundant and removes it deliberately.

## R-119…R-126 · The FIXES claimed properties the code did not have — H×H, FIXED

Added and fixed 2026-08-20, by six independent reviewers over the *fix commits* for R-99…R-118. The
capability invariant held a third time; every entry below is the runtime half, and they share one cause
worth naming above the list: **the claim was written before the code satisfied it.** That is R-93/R-97/R-98's
shape — an asserted property with nothing forcing it — now committed on both sides of a review.

- **R-119 (critical):** the terminal `child_lifecycle` append was still `strict: true`, while its own
  docstring, `docs/SPEC.md`, the ADR-0034 amendment and R-99's entry all four said terminal observations are
  best-effort. A contended ledger lock still discarded a completed child's output — and every sibling's under
  `delegate_all`. Only the comment had changed.
- **R-120 (critical):** the `onFailure` mechanism added *to prevent silent appends* was satisfied nowhere —
  two empty callbacks, one of them guarding the R-114 evidence record, three lines under a comment saying
  "loud". A third fed an array nothing read on the throw path.
- **R-121 (critical):** `unbankApprovals` was gated on `ledgerDenied`, missing three other post-gate
  refusals — most reachably a human declining the SECOND of two gated capabilities, which needs no fault at
  all. And it revoked by `capability@subject` with no ownership check, so a joined gate or a
  legacy-then-bound sequence let one refused delegation destroy an approval a live sibling was running under.
  `"absent"` from `revokeApproval` also counted as revoked, though `loadApprovals` excludes stale-but-present
  entries that later revive.
- **R-122:** R-106's fix over-corrected — `truncated` in the guard rejected a genuine 1 MB veto, breaking
  the pass-through ADR-0034 pins in the fix meant to protect it. And deleting all four non-text guards left
  580/580 green: the marquee fix, undefended. `childFailureOutcome`'s `text: ""` was likewise the only thing
  making the laundering path unreachable, and nothing held it.
- **R-123:** R-102's marker file had no reader anywhere — an unreleasable lock traded for a silent one.
- **R-124:** R-104 was fixed in the release event's wording only. A retained lease never wrote
  `state: "released"`, so the successor still reported `recovered: true` — the blame `retained` exists to
  remove.
- **R-125:** the check runner's `releaseReason` stayed `"completed"` through every throw, so a refused
  check's LAST lease event still read as a clean run and `verifyLedger` still counted a clean release.
  R-114's fix put a line beside the misleading one instead of correcting it. Separately, the refusal path
  released the workspace through an unguarded `strict: true` append, on the path where the ledger is already
  known unwritable.
- **R-126:** `LeaseReleaseOutcome` conflated three facts under `released-unrecorded` — the alarm (nobody
  recorded the handover), the healthy case (a successor already owns the record), and a read lease that never
  locked. It is five members now, and `release()` is memoized so a second call cannot invent a handover.

**A test that hung the runner, fixed.** With a lease guard mutated, `test/workspace.test.ts` printed its
failure and hung past 900 seconds: the failing test never reached its `release()`, so a live `flock` kept
node's event loop alive. On CI that turns a one-line assertion failure into a job timeout with no summary —
and it is how an auditor gets a false "untested" reading from a suite that did catch the defect. Measured
after an `after()` reaper: 900+s → 4s clean failure, no orphans.

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

## R-128 · Five review agents and an editor shared one working tree — M×L, PROCESS, FIXED BY SEQUENCING

Added 2026-08-20. Reviewers were authorised to mutate production code and restore it. One reasonably read a
dirty tree as its own mess and ran `git checkout -- .` twice, discarding four in-flight fixes and producing a
phantom `commit (amend)` in the reflog that took a while to explain. The agents behaved correctly; the
sequencing was wrong. **Either give each reviewer its own `git worktree`, or do not edit while a review is
running.** Also measured: two concurrent `npm test` runs fail each other, while the docs advertise the suite
as "fast, pure, no pi, no network" — worth knowing before it goes in a matrix build.

## R-129 · The 17-mutation audit has no artifact — L×M, OPEN

Added 2026-08-20. `docs/03-risks.md` and the session log both rest on "a 17-mutation audit", and rule 5 would
normally park a measurement that load-bearing under `docs/probes/`. Nobody can re-run it, and R-127 is what
that costs: a coverage claim derived from an audit no one can reproduce. The second round's mutations are
likewise recorded only in commit messages.

## R-130 · Two findings the second review could not close, closed on re-verification — L×M, FIXED

Added and fixed 2026-08-20. The mutation auditor re-ran against the fixed HEAD and reported five of its
seven findings closed. Two it could not speak to, both now settled:

- **The clean-release handshake was unpinned.** `{release:true}` is the only thing distinguishing "the owner
  handed the lease back" from "the owner died" — on stdin close the helper signals the attached process
  unless told the release was deliberate. Deleting that one write left **586/586 green**. So after a normal
  handover the helper would SIGTERM whatever held the attached pid, which under pid reuse (R-101, accepted)
  is an unrelated process. The auditor could not re-test it because `workspace-lease.ts` had been rewritten
  under it; re-derived here, and now pinned by a test that fails when the write is removed.
- **A test of mine claimed more than the wiring supports.** "correlation alone cannot put a workspace or
  context into the binding" is true of the workspace and false of the context: both extensions pass
  `boundContextId: spec.correlation?.context_id` **by design**, because `context_id` can only narrow a
  binding and a mismatch fails closed. Rescoped to the planner, with the extension-layer behaviour stated in
  the docstring — and with the residual named: nothing pins the trusted-source property at the extension
  layer, which is where R-110 actually happened.

**The auditor also corrected one of its own recommendations, which is worth recording.** It had listed
`truncated` among the guards to pin on `isCriticalAssuranceBlock`; the fix deliberately removed it, because
the executor keeps the HEAD of the output and the token matches at byte 0, so a genuine veto with a long
rationale is still genuine. Implementing that recommendation literally would have introduced the bug the
fix exists to prevent. **A reviewer's recommendation deserves the same re-derivation as a reviewer's
finding.**

**And a fair hit on a commit message.** `a882595` is labelled `docs:` and also edits five production files.
They are comment-only changes with no behaviour, but rule 10 lets a docs-only change merge on the author's
own read, so mislabelling one is not free. The label was wrong; the diff is what it is.

## R-131 · Workspace routing does not attenuate — H×H, FIXED (shipped broken in 0.18.0)

Added 2026-08-20, and **live on npm as of 0.18.0**. `ENV_WORKSPACE_REGISTRY` is not in `GRANT_ENV_KEYS`, so
it inherits into every governed child; `workspace_id` is a model-facing parameter on all three delegation
tools; and `prepareDelegationWorkspace` validates the id against the registry while checking nothing about
whether the caller was authorised for it. A child routed to `staging` can therefore route its grandchild to
`prod`, with a real lease, a validated CWD, and a ledger line naming `prod`.

**This is R-26 one namespace over** — a wildcard that leaked down the tree until attenuation was meaningless
below the root, found there by a three-level transitivity test. Depth, fan-out, grant, gated and approvals
all attenuate; the initial working directory does not.

**Why it is worse than ADR-0012's `bash` escape, which is accepted.** That escape produces **no ledger line
at all**, and the absence is the signal. This produces a complete, correct-looking capability decision
naming `prod` — which reads as authorised routing, because every other dimension in that record genuinely
is. The failure is not "a control is weaker than it looks"; it is "the record asserts an authorisation
nobody granted".

**MEASURED 2026-08-20 — `docs/probes/g36-workspace-attenuation`.** No longer inferred: the escalation
reproduces against real Git worktrees and a real kernel lease, driving the production propagation path. The
grandchild planned with **no refusal**, resolved `prod`, took an exclusive **write** lease, and would start
there. The probe's control is the load-bearing half — the grant and depth attenuated through the *same*
child environment, so this is an asymmetry rather than "everything inherits".

**FIXED 2026-08-20 by ADR-0035 (Accepted), landing in 0.19.0.** Routing is now a `workspace:<id>`
capability: the caller must hold it, the refusal is `WORKSPACE_NOT_AUTHORIZED` recorded in `denied` so an
escalation counts as one, `workspace:*` is held but never inherited (R-26's rule), and `tool:*` still
satisfies it because governance is opt-in. The probe now measures both sides — the original mechanism and
the refusal — so it keeps being evidence after the defect is gone.

**Breaking, deliberately.** Every grant that routes must add the capability; failing open for compatibility
would have made an attenuation fix opt-in. Measured on this repository's own suite: four fixtures began
refusing until granted, which is the one-line edit an operator faces.

**What is still not shown:** that a model would choose the escalation, and that it crosses a real process
boundary. The probe's own "does not establish" section says so.

**SUPERSEDED 2026-08-22 (sixth pass):** the paragraph below was written before ADR-0035 shipped the gate it
says does not exist. `PI_GRANTS_GATED=workspace:prod` now asks a human before any descendant routes there —
verified by execution — so the interim guidance is no longer the mitigation. Read R-145 before relying on it:
the destination's writer lease is taken *before* the question is asked. Left as written, per rule 2.

**Interim guidance for an operator:** do not register workspaces of differing sensitivity in one session.
There is no capability to gate today, so `PI_GRANTS_GATED` cannot help.

**Trigger:** any descendant `workspace_lease` event whose `root` is not the root its parent was routed to;
or a workspace transitivity test failing once one exists.

## R-132 · A capability id containing a comma mints authority the root never held — H×H, FIXED

Added and fixed 2026-08-20. **Present in published 0.18.0**, verified against `origin/main` before the fix
was written. Predates ADR-0035 and is unrelated to it.

`PI_GRANTS_GRANT` is comma-separated and `parseList` splits it. A capability id containing a comma was
admitted by a wildcard's **prefix** rule — `"agent:x,tool:bash"` starts with `agent:`, so `agent:*` covered
it — written verbatim into the child's grant, and split by the child into two capabilities. Measured:

```
ownGrant: ["agent:*", "tool:read", "tool:delegate"]     ← root never holds tool:bash
tools:    ["read", "delegate", "agent:x,tool:bash"]
→ denied: []
→ child grant parses as ["agent:x", "tool:bash", "tool:delegate", "tool:read"]
```

The child holds a real `tool:bash`. `denied` is empty, so `isEscalationAttempt` sees nothing and the ledger
line reads as an ordinary authorised delegation. **Minting authority with a clean audit record** is the
precise harm this package exists to prevent, and it is worse than R-131's shape because no configuration
mistake is required — only a wildcard, which is a documented supported root grant (R-26 is written about
exactly it).

`tool:*` is affected identically, since it covers every namespace.

**The codebase predicted this channel and guarded a different one.** `grant-env.ts` refuses to *write* a
grants file containing characters outside a capability id, and says why: *"the third channel — whatever it
turns out to be — should cost a refusal rather than an injection. A guard that depends on my enumeration
being complete is not a guard."* Propagation was that third channel and had no backstop.

**Fixed with two guards, both mutation-verified.** `covered()` refuses to grant a malformed id, so it lands
in `denied` and is recorded as the escalation attempt it is rather than throwing. And both grant writers
refuse to emit one, loudly — unreachable by construction, which is the point of a backstop.

Deliberately a blocklist of structurally dangerous characters (comma, CR, LF, NUL, surrounding whitespace)
rather than the full grammar whitelist `isSafeCapability` applies at the generation boundary. This is the
enforcement path and must keep accepting whatever ids operators already have; a security patch to a
released version should not invent a new way to refuse a legitimate setup. Verified: `ext:@scope/pkg/tool`,
`skill:my-skill`, `agent:my_agent` and both wildcards are unaffected.

**Trigger:** any capability id in a grant, a ledger record or a refusal containing a character outside
`[A-Za-z0-9:@._/*-]`; or a child grant whose parsed length exceeds its parent's.

## R-146 · A retained writer lease stopped its own process from exiting — H×M, FIXED

Added and fixed 2026-08-22, found by the sixth review pass over PR #10 and **re-derived by execution here
before being acted on** (working rule 5). **Present in published 0.18.0 and 0.18.1**, and unrelated to
ADR-0035 — which is why it is fixed from `main` rather than inside that PR.

`acquireWorkspaceLease` spawns the `flock` holder with `stdio: ["pipe","pipe","pipe"]` and never `unref`s it,
so the parent's references keep node's event loop alive. Every ordinary path ends the helper's stdin, which is
how the lock goes back. `markRetained` deliberately does not — *"the pane may still be live"* — and nothing
else dropped the references, so on that path the process could never exit.

```
mode=release   acquired write · release -> released · EXIT event, code 0 · exit=0
mode=retain    acquired write · main() returning                         · exit=124 (timed out)
```

Reached in production from the herdr executor when `tab close` fails: `HerdrWriterCloseError` →
`markRetained("herdr-close-failed")`. **R-102 accepted stranding the worktree; nothing recorded that it also
stranded the process.** Two comments also promised the strand lasted *"until process exit"*, which was the one
thing that could not happen.

**Which hosts it wedged — corrected by the independent review, and the correction narrows this entry.** The
first version of it said the compounding hit every pane, citing `src/cli.ts` as a host that "sets
`process.exitCode` and relies on a natural exit". `src/cli.ts` has one subcommand, `init`, and can neither hold
a lease nor open a pane; the claim came from a reviewer's report and **was repeated here without being
checked**, which is the specific trap this register keeps recording. Re-derived against pi 0.84.2:
`process.exit()` ignores pending handles *and* runs `exit` handlers, so only a host that lets the loop drain is
affected — pi's **print** mode (`dist/main.js`: `process.exitCode = exitCode; return;`) and any library
consumer, i.e. exactly ADR-0034's external controllers. Interactive and rpc mode call `process.exit()`
(`dist/modes/interactive/interactive-mode.js:3148`), so there the process still left and the on-exit pane sweep
still ran. The hang is real; "it also broke the pane reaper for everyone" was not.

**A bound on retries is not a bound on time, and this half was found by the review of the fix.** The helper's
`herdr tab close` ran through `execFile` with **no `timeout`**, so a herdr that accepts the close and never
answers never calls back: `--left` never decrements, `giveUp()` never runs, no marker is written, and the lock
is held **forever** — R-102's explicitly rejected outcome. It had been masked by the defect above, because
while the parent could not exit, EOF never arrived and an operator saw a hung `pi` instead of a silent strand.
**So the first version of this fix removed the only symptom of an unreleasable lock.** Measured with a `herdr`
that sleeps: before, parent `exit=0` in 82ms and `LOCK=HELD` with no marker indefinitely; after,
`LOCK=FREE — released as advertised` with the marker written. Each attempt now carries a wall-clock timeout
(`herdrCloseTimeoutMs`, default 15s), and `test/workspace.test.ts` forces it with a fake `herdr` that sleeps.

**Fixed by unref, not by closing**, in `markRetained` only. The lock must outlive the call, so the parent drops
its references and leaves the helper running; when the parent does exit, the helper sees EOF and runs the path
it was written for — bounded `herdr tab close` attempts, a marker file, then release anyway. That is R-102's
decision, and it is why letting the parent go is safe rather than a leak: **the successor can still acquire**,
which the regression asserts as its second property.

**Deliberately narrowed to the retain path.** At spawn, `unref` would also remove an accidental guarantee —
that a process cannot exit while a lease is still ACTIVE. Whether to keep that is a separate question and not
this fix.

**The regression, and what breaks it** (rule 7): removing the `unref` block makes the child never exit and the
first assertion fails on a bounded deadline — verified by reverting it. Bounded on purpose: R-119 was a lease
test that wedged the runner past 900s, which is how a suite that CAUGHT a defect reads as untested.

**A second review pass over the fix found four more things, two of them behavioural.** The pattern this
project keeps recording held again: the fixes needed the same adversarial read as the defect.

- **Retention was not terminal, and this fix is what made it read as terminal.** `markRetained` settled
  nothing, so a later `release()` ran the whole clean handshake. Measured: it returned `released`, overwrote
  `retained:herdr-close-failed` with `completed`, and sent `{release:true}` so the helper exited `clean` and
  never attempted the close — the pane retention exists to protect, abandoned silently, with the ledger
  asserting a clean handover for a lease kept *because* a pane would not close. No in-tree caller does it;
  `WorkspaceLease` is a public export and `try { … } finally { await lease.release() }` is the obvious shape
  for exactly the external controllers this fix is for. `release()` now answers `retained` — which required
  `"retained"` to become a real member of `LeaseReleaseOutcome` rather than the `| "retained"` bolted onto two
  signatures, and that is *why* it could not say so before.
- **`herdrCloseTimeoutMs: 0` silently restored the unbounded hang.** Node's `execFile` treats `timeout: 0` as
  *no* timeout — measured: the callback for a 3s sleep arrived at 3004ms with no error — so a controller
  passing `0` for "no limit" got the defect back with no message. Negatives behave the same. Both bounds are
  now refused, loudly, naming the parameter (rule 8).
- **The marker could not tell a refused close from one that never answered**; the timeout path now writes
  `herdr-close-timeout`. Worth little today, because `readCloseFailure()` still has **no caller** anywhere —
  see R-151.
- **The first test was not hermetic and leaked processes.** It inherited the 15s default while its successor
  loop waited 5s, so its outcome depended on whether a real `herdr` was installed — it is, here. And the fake
  `herdr` was `sh -c 'sleep 300'`, which `execFile`'s SIGKILL does not reach past the shell: three runs left
  three orphans owned by init, and a mutation sweep running the suite once per entry accumulates dozens. Both
  fixed with one `stubHerdr` helper using `exec`.

**And the orphan fix took a guard's teeth out, which the catalogue then caught.** Replacing the fake herdr's
`sleep 300` with `exec sleep 5` stopped the orphaning *and* meant that without the wall-clock bound the close
now succeeded after 5s — inside the successor loop's ~5s window, so the test passed with the guard reverted.
A cleanup fix that quietly converts a guard into decoration is rule 7's concern arriving from the least
suspicious direction: 30s restores the teeth, and `exec` keeps the signal reaching the sleep. **Found by the
catalogue on its first run over these entries**, which is the argument for the catalogue in one line.

**And my own new test hung the runner rather than failing — R-119, in the commit that cites R-119.** With the
validation guard reverted, the acquisition *succeeds*, and the lease was untracked, so a live `flock` held the
event loop open past the deadline. Routed through `trackedLease` so the `after()` reaper releases it: the
mutation now fails in 1.1s with a named assertion. **A test that proves a refusal must still clean up the
success it did not expect.**

**One line of the fix was itself unforced, which the review caught.** The block unref'ed `stdin` as well, and
a line-by-line reversion showed the suite stayed green without it — R-122's shape inside the fix. Removed
rather than pinned, since `holder.unref()` plus the two output streams are each load-bearing (verified by
reverting them separately). The helper's docstring also justified its optional calls by citing a
`stdio: "ignore"` caller that does not exist; corrected.

**Two debts, stated rather than left implicit — and both PAID on 2026-08-22, when PR #10 merged `main`.** The
catalogue lives on that branch and not on `main`, so these guards reached `main` with named regressions and no
entries. All four are now pinned there (the two below plus terminal retention and the refused bound), and the
helper-source entry targets **`src/lease-helper.ts`**, not the path written below: the same merge hit the
400-line ceiling and moved the helper out. The entries as first written, kept because the debt is the record:

```js
{ name: "lease: a retained lease detains its process", file: "src/workspace-lease.ts",
  test: "test/workspace.test.ts", find: "      holder.unref();", replace: "",
  expect: "retained lease releases its process" },
{ name: "lease: a hung herdr close is unbounded in time", file: "src/workspace-lease.ts",
  test: "test/workspace.test.ts",
  find: "{timeout:Number(process.env.PI_DADDY_LEASE_CLOSE_TIMEOUT_MS||15000),killSignal:\"SIGKILL\"},",
  replace: "", expect: "hangs on close does not strand the lock forever" }
```

**The OPEN copy PR #10 carried was deleted when that branch merged `main`, 2026-08-22.** It was authored the
same day, and this is the promise it made kept. Keeping both would have left `grep '^## R-146'` returning a
headline that says OPEN for a defect fixed and merged — **R-72's exact shape**, which this register has a
mechanical guard about. Nothing was lost: the deleted copy's own content was the discovery recorded above, plus
two things now false — the retracted `src/cli.ts` scope claim, and "deliberately not fixed in this PR, with the
candidates named", which named `holder.unref()` at spawn and the stdin sentinel. The narrower fix was taken and
the reason the spawn-wide one was rejected is above.

**Trigger:** any `pi` session that stops responding to exit after a herdr `tab close` failure; a
`retained:herdr-close-failed` release reason in the ledger; or any long-lived child spawned with pipes that a
non-release path leaves referenced.

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

## R-152 · `markRetained` reported a retention that had not happened, and the caller ledgered it — H×M, FIXED

Added and fixed 2026-08-22, by two independent reviews of the R-146 fix in PR #14 **after it merged**. Never
published; 0.18.2 is unreleased. Four defects, one cause: **`markRetained` returned `void`, and its only caller
hardcoded the word.**

`releaseDelegationWorkspace` wrote `(await lease.markRetained(reason), "retained")`, so the ledger asserted
*"kept deliberately because a herdr writer tab would not close, so the pane may still be live"* in three
situations where that is false:

- **The helper was already dead.** The lock is back and nothing is running; the fact is `lost`, which is
  exactly the distinction R-103 added the release vocabulary for. An operator reading `retained` goes looking
  for a live pane that does not exist, and the next owner is told nothing crashed.
- **The lease was already released.** Terminality was one-directional — `release()` checked `settled`,
  `markRetained` did not — so a completed handover could be rewritten to `retained:…` and the memoized answer
  flipped with it. Measured: `release() -> released`, reason `completed`; then `markRetained` →
  `retained:herdr-close-failed`; then `release() -> retained`. **The exact mirror of the defect R-146 fixed**,
  introduced by fixing it, reachable through the `try { … } finally { await lease.release() }` shape a public
  export invites.
- **The record could not be written.** The write was swallowed, and settling terminally removed the later
  `release()` that would still have written the handover — so the record stayed `active`, the ledger said
  `retained`, and the next owner reported a phantom `recovered: true`.

**Fixed by making `markRetained` answer in the release vocabulary** (`Promise<LeaseReleaseOutcome>`), with the
caller ledgering what it returns. Each of the four guards is forced by a named test, verified by reverting it
one at a time — including the record-was-written gate, which was unforced on the first attempt and is now
pinned by a test that makes the lease directory unwritable.

**The bounds were also wrong at the top end, and were refusing on the wrong channel.**
`herdrCloseTimeoutMs: Number.MAX_SAFE_INTEGER` — the plausible "effectively no limit" sentinel, given the
argument the guard itself makes about `0` — truncates: `setTimeout` warns *"does not fit into a 32-bit signed
integer. Timeout duration was set to 1"*, so every `herdr tab close` is SIGKILLed after 1ms, before herdr can
act. Measured: callback at 3ms for a 3s sleep. The floor and the ceiling fail in opposite directions and both
silently. Fractions passed too, for a parameter documented as a count.

And the refusal was a `GovernanceRefusal` carrying `WORKSPACE_LEASE_STALE`, which everywhere else in this
package means *the lease went stale or was lost* — so an ADR-0034 controller switching on codes, which is the
reason codes exist (R-103), would classify a permanent caller bug as transient and retry a call that can never
succeed. **A bad argument is not a governance outcome**, so it now throws a `RangeError`. The validation also
moved above the read-lease early return, where it had been validating nothing: a controller smoke-testing its
configuration against a read lease got a false all-clear.

**Two process notes worth more than the patches.**

The R-146 fix was reviewed twice before merging and both passes missed all of this, because they asked *"is
the fix correct?"* and not *"what does the fix's own return value promise?"* The finding came from reading the
CALLER — one line, in a different file, that discarded the result.

And the line ceiling refused `workspace-lease.ts` at 435 lines here, having already refused it at 405 on the
ADR-0035 branch. Both took the same seam (`src/lease-helper.ts`, the lock helper's own program) so the branches
converge; the cap has never been raised, and `delegate.ts` was split at 413 the same way.

**One debt, again.** `scripts/mutation-audit.mjs` lives on PR #10, so these four guards have named regressions
and no catalogue entries. Whichever lands second owes them; the entries are the four reverts above, each
naming the test it must break.

**Trigger:** any function whose result a caller discards in favour of a literal; and any bound validated at one
end only.

## R-153 · Every check in this repository was opt-in — H×M, FIXED

Added and fixed in part 2026-08-22. Not a defect in the product: a defect in how the product's guards were
enforced, and the reason several of them rotted.

**The evidence is the whole review history.** Eight passes over PR #10 found guards that could be deleted with
the entire suite green — ten in one round, fourteen in another, seven in the eighth. Each round fixed its
instances and none of them changed the cause: the only thing forcing rule 7 was a person choosing to run
something. R-34 named that shape long before — *"a check an operator has to know to run is not a control, it is
a feature"* — and the guards here that never failed this way are the mechanical ones: the line ceiling, the
branch guard, the refusal enumeration.

`.github/workflows/ci.yml` now runs, on every pull request and every push to `main`:

- `npm run typecheck`, `npm test`, `npm run test:smoke`;
- **a tree-cleanliness assertion**, because `npm test` once silently overwrote tracked ledger-contract
  fixtures, and a suite that can edit the repository can make itself pass;
- **`npm run test:mutation --if-present`** — the pinned catalogue, so rule 7 stops depending on someone
  remembering. `--if-present` is deliberate and temporary: the catalogue was written on PR #10 and does not
  exist on `main`, so the step is a no-op here and real the moment that branch lands. Said out loud, because a
  step that silently does nothing is R-34 with a green tick.

**`FORCE_COLOR=0` and `NO_COLOR=1` are pinned at the workflow level, and that line is R-143.** The catalogue
parses `node --test`'s reporter to learn which test failed; in a colouring environment it reported
`0/20 guards forced` with all twenty intact. A control that accuses everything is worse than one that is
absent, and CI would have inherited exactly that. The parser strips ANSI now *and* the input is pinned — the
two-defence standard the catalogue applies to its own entries.

**Matrix: 22.19.0 and 24.x.** The floor is the `engines` field, which is a published claim nothing had ever
tested; the ceiling is what this project is developed on.

**What it does NOT cover, stated because a green badge that implies more than it checks is this project's
signature defect.** `npm run test:integration` — 44 tests, and the most load-bearing suite here — needs a real
`pi` process and a real `herdr` server; neither is installed in CI, and faking them would turn the suite into
decoration. It stays a local gate, recorded in the session log with what it last ran against. The paid
`PI_GRANTS_IT_MODEL=1` tier is never run unattended.

**And as of 2026-08-22 it blocks, which is what makes this entry closed rather than half-closed.** The
operator authorised the server-side half: `main` requires a pull request with zero approvals and both CI legs
green, force-pushes and deletions are refused, and **`enforce_admins` is on** — without that, protection binds
everyone except the one account that can breach it, which is precisely how R-85's eleven commits arrived.
Read back from the API after the change: `protected: true`, required checks `["node 22.19.0", "node 24.x"]`.

**Verified by configuration, not by attempting a breach** — and that distinction is the honest part. Pushing a
commit at `main` to watch it bounce would prove it end to end, and would advance `main` outside a PR if the
setting were wrong, which is the one thing rule 10 exists to prevent. The first live proof is therefore the PR
that carries this paragraph: it is the first change in this repository's history that *could not* have been
pushed directly.

**PR #10 carries R-142, the entry that asked for this**, written before the catalogue existed on any branch.
Whichever lands second reconciles them; R-142's own trigger — *"the next review pass finding a guard deletable
with the suite green; if that happens the answer is CI and not a sixth pass"* — fired twice more before this
landed.

**Trigger:** any new check added to this repository that CI does not run; or a `--if-present` step that is
still a no-op after PR #10 merges.

---

## R-133 · A capability namespace is a nine-site change, and ADR-0035 did three — H×H, FIXED

Added and fixed 2026-08-21, reviewing PR #10 before it merged. **Never published**: ADR-0035 is unreleased,
so this was caught inside the release that introduced it.

ADR-0035 minted `workspace:<id>` and taught `normaliseCapability`, `resolve()`'s wildcard rule, and
`childEnv`'s inheritance filter. Six other sites already handled `agent:` and were not touched, and the
review found roughly one defect per untouched site. **The pattern is the risk; the individual defects are
symptoms.**

The severe one: `unknownCapabilities` never learned the namespace, and `delegationContext()` always supplies
a catalog, so every requested `workspace:<id>` was refused `UNKNOWN_TOOL` as *"a typo, or an uninstalled
package"*. **No child could ever hold a workspace capability**, so routing did not attenuate below the root
— it terminated there, and the ADR's headline "two authorities, not one" was unreachable in production. An
attenuation fix that makes the dimension unusable below depth 0 is not the fix it advertised.

The rest: `PI_GRANTS_GATED=workspace:prod` was accepted and inert while the ADR claimed a gate in three
places; `ceilingForDefinition` turned `allowed-tools: workspace:prod` into `tool:workspace:prod`;
`isSafeCapability` — the boundary that *generates* grants — called the newly mandatory capability malformed;
`subsumedBy` reported a false "broader than it looks" flag; and `init` had never heard of the registry the
ADR said it scaffolded.

**Why the probe missed it.** `docs/probes/g36-workspace-attenuation` appends the capability to `ownGrant` by
hand and builds no catalog, so it confirmed the mechanism while exercising a path production does not take.
Recorded because "we measured it" was the reason this went in with a Decision that could not run.

**Fixed** by teaching all six sites, collapsing three into `CAPABILITY_NAMESPACE_PREFIXES`, and organising
`test/workspace-capability.test.ts` **by site** so the checklist is executable. (This entry also claimed the
fix "collapsed three" prefix sites into one list; it collapsed none — both readers already shared it — and
every count written here has been wrong at least once, which is why there is no longer a number.)

**Its own verification claim was wrong, and a third pass caught that too.** This entry first said "eleven
mutations, eleven named failures" — true of the eleven applied, and concealing that **two of the six sites
had no test at all**: `isSafeCapability`/`wildcardsIn` and the registry-reading wiring were each revertible
with the suite green, and three of the docstrings named breakers that did not break. A count of what you
checked is not a measure of what is covered. Every site now has a case, each verified by applying the
revert; the file is the list, not the number.

**Trigger:** a sixth namespace, or any new site that branches on a capability prefix, landing without a case
in `test/workspace-capability.test.ts`. Also: any ADR claiming attenuation "comes for free".

---

## R-134 · An operator warning told them to delete a control that works — M×M, FIXED

Added and fixed 2026-08-21. **Present in published 0.13.0 through 0.18.1 — eight versions.** Found while
fixing R-133, not by either review pass. (This line first read "0.18.0 and 0.18.1", contradicting its own
body two paragraphs below. The status line is what an operator reads for "am I affected", so it is the one
that must not be narrower than the truth.)

`session-report.ts` warned, at session start, that an `agent:` id in `PI_GRANTS_GATED` *"does NOT gate
spawning that definition — the authorisation check for a definition is separate and ungated, so a human is
never asked"*, and advised withholding the capability instead.

**It is R-47's own partial fix, outliving R-47's full fix across eight published versions** (0.13.0 through
0.18.1; 0.12.0, where the gate landed, was never published). R-47 records both: *"PARTLY
FIXED 2026-08-14 (0.11.1): a startup warning named the inert entry"*, then *"FULLY FIXED 2026-08-14 (0.12.0)
by ADR-0024"*. `4673348` — "gating a definition asks before it runs" — is where a gated `agent:<name>` began
blocking the spawn. So the warning was true for one release and false for 0.12.0 through 0.18.1. (First
recorded here as "false from 0.18.0", which was wrong: `dde8eeb` only moved the code into
`delegation-approval.ts`. Corrected same day.)

**ADR-0024's own Costs section leaned on this warning** — *"mitigated by the fact that the warning shipped
hours earlier tells them it currently does nothing"* — and nothing retired it when that very decision
falsified it. The banner talked operators out of a working control, which is R-28's shape in the direction
that loses a gate.

**How it survived is the part worth keeping: a test required it.** `test-integration/governance.it.ts`
asserted the warning's presence — *"an operator who wrote a gate that does nothing must be told"* — with a
comment describing the pre-ADR-0024 mechanism. So deleting the stale claim turned the suite red, and the
suite was defending the claim against whoever noticed. **A test pinning a superseded partial fix is worse
than no test.** It now asserts what ADR-0024 shipped, and that the warning is gone.

**Fixed** by deleting the warning rather than rewording it: both namespaces are gated now, so there is no
live inert case, and a warning with no live case is the next stale claim. A second stale block above the
neighbouring `agent:*`-with-`bash` warning, still explaining why R-47 was "warned rather than enforced", went
with it.

**Trigger:** any operator-facing notify() text asserting that a configuration does nothing — those are claims
about code and they expire. Also: any test whose *name* asserts an absence of enforcement ("warns that it
does not…"). When the enforcement lands, that test becomes the thing protecting the old story.

---

## R-135 · R-26's rule was never enforced on the path that actually spawns — H×H, FIXED

Added and fixed 2026-08-21. **Present in every published version since ADR-0016** made this package the
spawner. Predates ADR-0035; found by the mutation battery for R-133's fix.

*"A root may HOLD `tool:*` — that is authority to grant anything — but handing it down would let every
descendant reacquire the full catalog, which makes attenuation meaningless below the root"* is `childEnv`'s
docstring. `childEnv` is the **interceptor** path — the one ADR-0016 demoted to a tripwire. `delegate.ts`,
the path that actually spawns, built the child's `PI_GRANTS_GRANT` from `result.effective` with **no
filter**, and `tool:*` is not in `UNIVERSAL_CAPABILITIES` (only `fabric_exec` is), so `assertNarrowing` did
not catch it either.

Measured on `92ccbb8`: a parent holding `tool:*` and delegating `tools: ["tool:*"]` produced
`PI_GRANTS_GRANT="tool:*"` in the child. That child could then hand its own grandchildren anything at all.
**Attenuation ended at the root**, which is precisely R-26, on the primary path, for eleven releases.

**How it stayed hidden is the reusable part.** The rule had a test, and the test asserted on `childEnv` —
the path where the rule *was* implemented. A guard and its test on the same one of two routes reads exactly
like a guard on both. This is why the fix is one exported `inheritableGrant` called from both places rather
than a second filter: two spellings of one rule is R-28, and R-28 is the most repeated entry in this
register.

**Fixed** and pinned by a test that asserts on `plan.env`, the delegation path, and fails when
`delegate.ts` is reverted.

**Trigger:** any rule about grants enforced at one call site when two build a child environment. Grep for
`ENV_GRANT` assignments; there should be exactly two, both calling the same helper.

---

## R-136 · A blocking registry path hangs session start — H×M, FIXED

Added and fixed 2026-08-21. **Never published**: introduced and caught inside 0.19.0's development.

0.19.0 made `buildCatalog` and `registeredWorkspaceIds` read the workspace registry, and both are awaited
inside `session_start`. A bare `readFile` on a FIFO therefore blocked the session indefinitely — before the
`holding [...]` line, the executor probe and every control after it — and `delegate` awaits the same promise,
so delegation hung too. Measured: `exit=124` after 8s, repeatedly.

**This is R-79's defect class**, whose entry says *"a FIFO at the target path hung the probe forever, with no
timeout anywhere in the path"*, reintroduced by a new reader four lines from the comment documenting it.

**`AbortSignal.timeout` does not fix it, and the first attempt proved that by still hanging.** A signal is
observed between chunks; a FIFO blocks inside `open(2)` before any read begins.

**Superseded 2026-08-22, and the correction matters.** This entry first said *"`stat` first is the fix"*. It
was not: `stat`-by-name followed by `readFile`-by-name is a TOCTOU any same-uid process can win, and a
*second* size race survived even holding one handle, because `handle.readFile` re-`fstat`s internally — a
192 MiB file was read after a 29-byte measurement. The fix in the product is one handle opened `O_NONBLOCK`,
`fstat`-ed as a descriptor, and read into a bounded buffer. A non-regular registry is refused rather
than treated as empty, because a silent empty registry disables routing while looking healthy.

**Not fixed, and stated rather than implied:** an unresponsive network mount blocks `stat` just as hard. No
in-process timeout can cover a stalled `open`. The size ceiling and the read signal remain as
defence-in-depth for a regular file on a slow mount.

**Trigger:** any new reader of an operator-supplied path that is awaited during `session_start`. Grep for
`readFile` reached from `loadProjectDefinitions`.

---

## R-137 · Routing attenuates by ID, not by DESTINATION — H×M, OPEN

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

## R-139 · The registry id grammar is a breaking change, and was briefly the wrong grammar — M×M, FIXED

Added and fixed 2026-08-22, reviewing PR #10's own fixes.

ADR-0035 made a registry id the tail of a capability id, which makes the operator's registry an input to the
grant grammar. 0.18.0/0.18.1 validated ids for nothing but non-emptiness, so ids in the wild can be any
string, and constraining them is necessarily breaking. Two things went wrong before it was right.

**First, the constraint was missing**, and two shapes were live: an id of `*` minted `WORKSPACE_WILDCARD`, so
an operator registering one worktree as `*` and granting `workspace:*` held routing over every id in the
registry including ones added later; and an id containing a space became **two** capabilities, because
`ceilingForDefinition` splits `allowed-tools` on `[\s,]+` — `allowed-tools: read, workspace:prod bash`
measured as `['tool:bash','tool:read','workspace:prod']`, i.e. routing over production plus a shell, neither
typed by anyone. 0.18.1's comma, one namespace over. A test in the fixing commit **asserted the space case was
safe**, which is worse than not testing it.

**Then the constraint was the wrong one.** It reused `isSafeCapability` — the grammar for a TOOL NAME — which
refused `feature/x`, `claude/issue-42`, `café`, `@scope`, `_tmp`. A git worktree is routinely named after its
branch, so a slash is the ordinary case, and a slash splits nothing: not the comma-separated grant, not
`allowed-tools`. Refusing it bought no safety and broke a working setup, while the justification written
beside it said refusing an id "costs nothing" — true of a hostile id, false of `feature/x`, and renaming one
means editing every grant and every `.pi/grants.env` that names it.

**Now:** `isSafeWorkspaceId` — `[A-Za-z0-9][A-Za-z0-9._/-]*`. **The regex is the specification; the prose
below is a summary and was wrong twice.** It refuses whitespace (which `allowed-tools` splits on),
comma/CR/LF/NUL (which split a grant), `*` (it collided with the wildcard), shell metacharacters (they reach
a generated file the operator is told to paste from), non-ASCII, **and also `@ + % = ^ ! ? ~ { } [ ]` and a
leading `_`, `-` or `.`** — none of which breaks a channel, so `@scope` and `_tmp` are refused for tidiness
rather than for safety. An earlier version of this entry listed those two as casualties of the *old* grammar
that the new one rescued; it does not rescue them. That last is a deliberate trade for a display-spoofing surface in a reviewed file, recorded as
breaking rather than asserted to cost nothing. Documented in the CHANGELOG's breaking section, which described
only the comma rule while the code required far more.

**Not fixed:** one malformed entry refuses the whole registry, and both session-start readers fail soft, so a
single legacy id makes every workspace invisible with no warning — rule 8's own named defect. The refusal is
loud only at the point of use.

**Trigger:** an operator reporting that a registered workspace stopped being listed after upgrading; or any
future capability namespace whose ids come from a file rather than from a grant.

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

## R-141 · A routed child writes into the root it may only hold a read lease on — M×M, OPEN

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

**Trigger:** any env-supplied path a child inherits and resolves relative to its own cwd. Grep for
`process.env[` reached from a function called in the delegating process.

---

## R-142 · The mutation audit is not a control until CI runs it — M×M, OPEN

Added 2026-08-22. `scripts/mutation-audit.mjs` pins twenty `(patch → the test it must break)` pairs, and it
already caught four bad entries in its own catalogue plus a test of mine that passed for the wrong reason. But
**there is no CI configuration anywhere in this repository**, so it is a manually-invoked npm script — and its
own docstring quotes R-34 against exactly that: *"a check an operator has to know to run is not a control, it
is a feature."*

Five review passes each found guards deletable with the whole suite green. The instances were fixed five times;
what did not change is that the only thing forcing rule 7 was somebody choosing to look. A pinned catalogue is
strictly better than a habit — it names what must break, it fails loudly, and it survives the session that
wrote it — but it is still opt-in.

**The minimum that closes this:** a workflow running `typecheck`, `test` and `test:mutation` on every PR, plus
the server-side half `docs/WORKING-RULES.md` already recommends — requiring a PR on `main` with zero required
approvals, which costs a single maintainer nothing. Rule 10's enforcement paragraph makes the same point about
`hooks/pre-commit`: it is wired per clone, so *"if that command prints nothing the hook is inert."* The same
sentence is now true of this script.

**Deliberately not added in this PR.** It is repository infrastructure rather than ADR-0035, and this branch
was just narrowed for precisely that reason — every layer of scope added here landed in code the previous
layer's reviewers had not seen. Adding CI in the commit that argues against scope creep would be the fifth
instance of the thing.

**Also open, from the same review:** the harness excludes three guards from its catalogue by design, each with
its reason stated (winning the `fstat`/read window and the `stat`-by-name swap are not deterministic
in-process; Node closes a `FileHandle` on GC). Those three are measured by hand and forced by nothing. That is
the honest form, not a solved problem — a deterministic instrument for "a size measured beforehand cannot be
trusted" would retire the first of them, and a `/proc` file (which reports `st_size` 0 and still yields
content) is the suggested route.

**Trigger:** the next review pass finding a guard deletable with the suite green. If that happens while this
entry is still OPEN, the answer is CI and not a sixth pass.

## R-143 · The mutation audit reported every guard missing, in the environment it is run in — M×H, FIXED

Added and fixed 2026-08-22, reviewing PR #10 before it merged. **Never published** — the auditor is unreleased
tooling that arrived on this branch.

`npm run test:mutation` printed **`0/20 guards forced a named failure`** at `0a62a42`, and once per entry:
*"a guard nothing forces is not a guard — add the check, or remove the guard."* All twenty guards were intact.
The same sweep, same tree, same commit, re-run with `FORCE_COLOR=0` printed **`20/20`**.

The cause is one line. `node --test`'s spec reporter colours its output when `FORCE_COLOR` is set, this
project is developed in sessions that export `FORCE_COLOR=3`, and the failure matcher was anchored `^\s*✖` —
an escape sequence is not whitespace, so it matched nothing, in every entry, always.

**Why this is worse than a check that flakes.** The auditor's whole purpose is to stop a session trusting a
guard nothing forces. Blind, it accuses twenty guards at once — so the honest response to its output is a
sweep of twenty "fixes" to code that was already correct, which is the loop rule 7's catalogue exists to end.
It fails loudly, as rule 8 wants, and says something false at volume. **"I saw no failure" and "I saw nothing"
are different sentences, and only one of them is a verdict on a guard.**

**Fixed**, with the parsing extracted to `scripts/mutation-parse.ts` so it can itself be tested:

- ANSI is stripped before matching, and `test/mutation-audit.test.ts` forces it — reverting the strip fails
  three of its four tests (verified by reverting it).
- The spawned suite gets `FORCE_COLOR=0` / `NO_COLOR=1`, so the input is pinned as well as the parser.
- A positive control. `reporterWasReadable` distinguishes an unreadable transcript from a clean one, and the
  harness now reports *"the auditor could not read `<file>`'s output — this is NO verdict on the guard"*.
  Verified by pointing an entry at a test file that does not exist.

**Its relation to R-142, which stays open.** That entry says the audit is not a control until CI runs it. This
one is the sharper half: it was not a control **in the environment where it was actually being run** — and CI
inheriting a coloured reporter would have gone red on twenty healthy guards, which is how a control gets
switched off rather than fixed. R-142's trigger says the answer to another unforced guard is CI rather than a
sixth pass; the amendment is that CI must also pin the reporter's environment, or it measures its own terminal.

**Independently found by the sixth pass's fourth reviewer**, which is the useful part of the corroboration:
that reviewer also named the trap, that the tempting repair under CI pressure is to loosen the matcher back to
`stdout.includes(expect)` — the exact defect `41cbc39` had removed one commit earlier. Stripping ANSI keeps the
strict form. Re-measured after the fix, in this environment and with colour forced on: **20/20**.

**A second defect in the same harness, from the same reviewer, fixed here.** The dirty-tree refusal inspected
only the files the catalogue *patches*, while the `contract:` entry deliberately makes `npm test` regenerate
the tracked ledger fixtures — so an uncommitted fixture edit was destroyed silently, and was benign only
because regeneration is byte-identical to what is committed. The check now covers everything a run can write,
verified by dirtying a fixture and watching it refuse.

**A third defect in the instrument, 2026-08-22, found by using it on the R-146 guards.** A run that gets
KILLED was scored as "no verdict unless the entry records a hang" — even when the guard's own named failure had
already printed. Measured: reverting the retain-path `unref` failed `✖ a retained lease releases its process` at
10.0s and *then* wedged the runner, because a sibling test retains a lease in the runner's own process and could
no longer exit. The auditor reported that as *"a guard nothing forces"*, which is the exact inverse of what
happened, and the tempting response is to delete a guard that works. **A kill does not erase a verdict that
already printed**: a named failure now counts whenever it appears, and `hang: true` remains required only where
non-termination is the whole signature and nothing prints. The pattern across all three of this harness's
defects is one thing — *it kept mistaking "I could not read the answer" for "the answer is no."*

**What this does not establish.** That the twenty guards are the right twenty — R-142's exclusion list and
reviewer D's complement audit are the question of coverage, and this entry is only about the instrument being
readable. And the `FORCE_COLOR=0` pin in the spawned environment is redundancy, not the defence: nothing forces
it, which is said here rather than implied.

**Trigger:** any `test:mutation` run reporting more than two entries unforced at once — the prior is a broken
instrument, not twenty deleted guards. And any new parse of a child process's stdout in this repository that
does not strip ANSI first.

## R-144 · The narrowing commit deleted the registry ownership guard and three documents kept selling it — H×H, FIXED (documents), and it corrects R-137's bound

Added and fixed 2026-08-22, found independently by **three** of the sixth pass's four reviewers. Never
published — 0.19.0 is unreleased.

`ebad92a` added a uid/world-writable guard on `PI_GRANTS_WORKSPACE_REGISTRY`. `e1937cf` — *"narrow PR #10 to
ADR-0035"* — removed the code and sent the question to a future ADR. It edited none of the three places that
announce the guard: `docs/SPEC.md`'s registry paragraph (the document `CLAUDE.md` calls authoritative),
`CHANGELOG.md`'s **BREAKING** section (what an upgrading operator reads first), and **R-137's own paragraph
headed "What DOES exist now"**. Measured: a `0666` registry in a `0777` non-sticky directory loads with no
refusal.

**The register entry is the worst of the three, because the false sentence is doing work.** R-137 is OPEN, and
that paragraph is the only thing bounding its blast radius — *"That refuses a registry another **user** can
rewrite in place… It cannot touch this entry's attack at all — a governed child runs as the same uid as its
parent."* With no check at all, R-137's attack does **not** require `tool:write` inside a governed child:
**any** local process that can write that file, or its directory, repoints `workspace:staging` at another
worktree, and every descendant holding that id routes there with a real exclusive write lease. The bound was
inherited from a guard that no longer exists, so the entry understates itself.

**This is CLAUDE.md's headline lesson reappearing in the register entry that records it** — *a claim written
beside a fix is not the fix* — and the sixth pass's version is narrower and more useful: **a commit that
REMOVES a guard has to grep for the guard's claims, exactly as a commit that adds one has to add its test.**
Narrowing scope is not a documentation-free operation. Nothing caught it because there was never a test: the
guard's own tests went out with the guard, so the suite stayed green at 629/629 while three documents lied.

**Fixed** in the documents, not in the code — the code is the ADR-0036 question R-137 already holds. SPEC and
the CHANGELOG now say ownership and mode are unchecked and why a mode check cannot reach the attack; R-137
carries a dated correction of its bound.

**Trigger:** any commit that deletes a check — `grep` the check's own vocabulary across `docs/` and the
package before it lands. And any risk entry whose blast radius is bounded by a *different* entry's mechanism.

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
| 2026-08-09 | R-25, R-26 | Added — `bash` grants read as narrow but aren't (legibility failure); wildcard leaked down the tree (found by test, fixed) | `pi-daddy` |
| 2026-08-09 | R-27 | Added — persisting `always` approvals to a repo-local file lets a commit authorise every clone; mitigated by `cwd`-match on load | ADR-0010 |
| 2026-08-09 | R-25 | Cross-referenced ADR-0010 — gating `bash` by default is the highest-value use of the new approval machinery and also its hardest test (prompt fatigue); carried as an open item, not decided | ADR-0010 |
| 2026-08-12 | R-28 | Added and **FIXED same session** — the `tool_call` hook reached a correct `decideSpawn` through a wrong argument list, refusing every narrow inheriting type in an enumerated-grant session and firing the escalation signal on legitimate traffic. Confirmed by execution before being written. Fixed with a single `decisionContext()` builder + `test/interceptor-wiring.test.ts` (first unit coverage of `extensions/grants.ts`) | architecture-critic, verified locally |
| 2026-08-12 | R-29 | Added — one *Allow once* authorises N concurrent spawns (single flight keyed on a constant subject). Confirmed by a 10-line probe. **Latent**, since `delegate` blocks; a hard precondition for fan-out, and it reopens ADR-0014 | architecture-critic, verified locally |
| 2026-08-12 | R-30 | Added — `pi-herdr`'s `herdr_start_agent`/`herdr_delegate` expose **model-controlled `agentArgs` and `env`**, reopening the g1-argv hole and allowing a forged `PI_GRANTS_GRANT`. Not loaded on this machine; same class as ADR-0013 Finding 6 but through a documented parameter | landscape check |
| 2026-08-12 | R-31 | Added — the pi-subagents port has no version pin and no drift tripwire, and has **already drifted** (upstream 0.15.0, pi 0.84.1 vs probes' 0.83.0). Failure direction is permissive, so drift silently widens ceilings | architecture-critic, verified locally |
| 2026-08-12 | R-22 | Cross-referenced R-31 — R-22 named upstream churn as a risk but wired no trigger; R-31 is that gap made concrete, with a proposed differential test as the tripwire | architecture-critic |
| 2026-08-12 | R-29 | **FIXED** — a joining caller keeps a shared answer only when it was about more than one spawn; a `once` is consumed by exactly one. The per-spawn-key fix was rejected on ADR-0014's own reasoning. Two pre-existing tests were found to be **pinning the defect** and were re-targeted | `pi-daddy` |
| 2026-08-12 | R-31 | **TRIGGER FIRED** — pi 0.84.1 exposes a `parallel` tool absent from `PI_BUILTIN_TOOLS` (pinned "as of 0.83.0"). Gated correctly, but misclassified as an extension capability by `ceilingFor` and the catalog | `docs/probes/g16-herdr` |
| 2026-08-12 | R-32 | Added — **measured**: a governed child inherits all the operator's skills and `CLAUDE.md`, because `planSpawn` passes `--no-extensions` but not `--no-skills` / `--no-context-files`. Confirms `skill:` capabilities enforce nothing | `docs/probes/g16-herdr` |
| 2026-08-12 | R-31 | **RETIRED by deletion** — ADR-0016 removed the port (`src/agent-types.ts`, `src/interceptor.ts`), so there is no longer another project's resolution logic to keep in step. The proposed devDependency pin and differential test were never built and are no longer needed; `PI_BUILTIN_TOOLS` moved to `src/pi-tools.ts` and keeps its own trigger | ADR-0016 |
| 2026-08-12 | R-32 | **FIXED** — `planSpawn` withholds skills, context files and prompt templates, and passes `--skill` per granted skill; an unresolvable granted skill is refused, not dropped. `skill:` capabilities now enforce something for the first time. Verified in a real pi process, and a third leaking resource class (prompt templates) was found while verifying | `pi-daddy` |
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
| 2026-08-14 | R-60 | Added and fixed — `verifyLedger` rethrows any non-`ENOENT` read error, and at session start that call sat inside an **empty** blanket catch, so an unreadable `PI_GRANTS_LEDGER` produced zero output: no alarm, and not even the `holding [...]` line. R-34's own shape one level down, on the damage class R-34 exists to catch. Confirmed by execution before being written; the outer catch is now loud | the fourth question |
| 2026-08-14 | R-49, R-61, R-62 | **The parked items, finished.** R-49 closed by REUSE not hardening — the ledger's lock moved to `src/file-lock.ts` and both writers share it, so the park's reason ("do not harden a layer whose fate item 1 decides") no longer applied. R-61 fell out of it: a failed revoke printed "no persisted approval named X" while the approval stayed in effect. R-62 fixed in part, with the SIGINT completion **refused** and the reason recorded — a listener here would suppress Node's default termination and turn pi's "interrupt this turn" into "exit pi" | finishing the list |
| 2026-08-14 | ADR-0020 | **The measurement is runnable.** `/grants ledger` now counts `persisted` against `prompt` per capability, which that ADR named as the evidence that settles Option 3 and then left to hand-written `jq`. Pre-0.11.1 records are reported as *not counted* rather than folded in, because the older scalar over-claimed `prompt` (R-46) — biasing the one direction the measurement must not be biased in. **Only usage produces the number**; the machinery is no longer what is missing | finishing the list |
| 2026-08-14 | R-60, R-61, R-63 | **The operator reviewed the four unreviewed changes, and three of the four produced a finding.** R-63 is the one that mattered: the ADR-0020 tally counted `persisted` RECORDS as prompts avoided, overstating the layer twentyfold, on the number that decides whether to delete it — the same bias `unattributed` exists to prevent, arrived at from the other side. R-61 gained a `busy` state after its own fix was found to contain a smaller copy of R-61. R-60 gained `test/session-start-guard.test.ts`, which immediately found two more unguarded `await`s. **Every hypothesis that produced a finding was one written down as a hypothesis** — the ones checked and cleared (the lock covering `planWithApprovals`, other booleans rendered as sentences) were cleared in minutes | review round |
| 2026-08-14 | R-64, R-65, R-66 | **Independent red-team pass over the same day's work — four agents, one hypothesis each, and three found a defect.** R-66 is the worst: eight ledger lines asserting a human was prompted where one was (R-46's shape at the concurrency level). R-64: `in` walking the prototype deleted the whole ADR-0020 measurement and marked an intact ledger corrupt. R-65: the pane reaper was disabled by the one failure it was built for, and could hang exit for 80s. **Every finding was re-verified by execution here before being acted on**, and two were worse than reported | red-team pass 3 |
| 2026-08-14 | ADR-0008 | **Documentation corrected, code unchanged, by the operator's decision.** `docs/SPEC.md` and the package README both called `PI_GRANTS_FANOUT` a **session total** — "a session holding `B` may create at most `B` descendants in total". Measured false: `session.fanoutBudget` is read once and never decremented, so three successive `delegate_all(8)` calls in one session are all accepted. What the bound actually is: per-call width plus downward attenuation, so no *subtree* exceeds its root. Making the code match the document was weighed and declined — it would break working setups and needs its own ADR — so the document was made to match the code, which is where the claim was wrong | red-team pass 3 |
| 2026-08-14 | R-67, R-68 | **The lock let two writers in, and the pass that found it used real processes.** R-67: `rm(lockPath)` deletes the path, not your lock — so the stale-break's `stat`/`rm` gap could destroy a live lock, and the unconditional `finally` freed the *new* owner's, cascading to processes that raced nothing. Reproduced 2/120 trials × 16 processes under load, no clock manipulation. Fixed with a per-hold token and `removeIfOurs`. **The first version of that fix had no failing test until the mutation check showed it.** R-68: `busy` keyed on the error TYPE rather than on whether anything had been read, so `EMFILE` asserted an entry was still in effect that nobody had looked for — R-61's defect inside R-61's fix | red-team pass 3 |
| 2026-08-14 | R-69, R-70, R-71 | **The tail of the red-team pass, found by re-auditing the four reports against what had actually shipped.** Seven items had been reported and not fixed. R-69: four causes of an unsatisfied gate produced one indistinguishable record, and ADR-0026 rests on the ledger being able to tell them apart. R-70: a ledger of nothing but declines reported no declines — the quietest output for the loudest file. R-71: two paths could orphan a herdr pane with nothing tracking it. **`src/ledger.ts` hit the 400-line guard during the fix and was split rather than the cap raised**, along the read/write seam every reporting defect so far has lived on | red-team pass 3 |
| 2026-08-14 | R-72 | Added and fixed — five headlines (R-44, R-45, R-46, R-47, R-51) said **OPEN** for defects their own bodies recorded as FIXED, one of them *"FULLY FIXED … by ADR-0024"*. **R-59's shape inside the register R-59 lives in**, and R-59's trigger did not fire because it names `CLAUDE.md`, READMEs and the session log — the places the previous instance was found. A trigger derived from where the last one turned up finds the last one again. The replacement is mechanical: any headline whose body says FIXED | orienting-document sweep |
| 2026-08-16 | R-73…R-76 | **The pi-daddy half of the `principal-pi-skills` integration** (handoff B1/B2/B4, ADR-0028). R-73 shipped and was caught by the smoke test: `npx pi-daddy init` printed nothing and exited 0 for every *installed* copy, because npm makes a bin a symlink and the entry-point guard compared it against `import.meta.url` — a scaffolding command that does nothing looks exactly like one with nothing to do. R-74 and R-76 are accepted consequences of `init` copying definitions and unioning their ceilings, both recorded with what mitigates them; R-75 states that the new startup line is an upper bound. **Every claim about pi and about `principal-pi-skills@2.3.1` was re-measured** — `docs/probes/b2-init-principal-pi-skills` | handoff B1/B2/B4 |
| 2026-08-16 | R-77 | Added and fixed the same session — a skill **directory name** could write a capability into the grant `init` generates (`a,tool:bash` → `tool:bash` in `PI_GRANTS_GRANT`), because a name is interpolated into a comma-separated id list, a sourced shell file and a path at once. Reproduced against the real CLI before being written. Found by asking *what does the generated file interpolate?* — the same "where else does this shape appear?" question that found R-60, and the reason to ask it of anything that writes a file rather than reads one | handoff B1/B2/B4 |
| 2026-08-17 | R-78…R-82 | **Five independent reviewers over PR #2, one hypothesis each — and every one found something.** R-78 is the worst and the most humbling: R-77's own trigger describes it, written the previous day about the name and never applied to the capability id beside it, and it ends in arbitrary code execution from a file this workflow tells operators to commit. R-79 collects four defects in one scaffolder, one of them **B-I6 reintroduced** in a package that documents B-I6 as closed. R-81 is R-28's shape *inside* the module whose header claims to have made R-28's shape inexpressible. **The pattern worth keeping: every finding was in the half of the change nothing had attacked** — a generated file, a CLI with no tests, a classifier written after the planner it claims to defer to | independent review of PR #2 |
| 2026-08-17 | R-75, ADR-0030 | **The setup was wrong, and only running it in a clean environment showed that.** `pi install` registers a package with pi and installs it to the agent root; `npm install` does neither, and three documents said to use it. `init` searched only the project root and told operators to install what they had just installed. Both fixed. ADR-0030 adds a grant store **outside** the workspace so `/grants init` can govern a session with no restart — ADR-0014's reasoning applied to the ceiling instead of the approvals, with the environment still winning so propagation stays single-channel | the two-step setup |
| 2026-08-18 | R-85 | Added, **fixed in part** — eleven commits reached `main` with no PR, by drift rather than decision, and ADR-0033's two critical governance defects are among them. Working rule 10 rewritten after five independent reviewers: the first draft's `never commit to main` forbade the merge the rule requires and offered no recovery, which invites a force-push. Now enforced by `hooks/pre-commit` plus `test/branch-guard.test.ts`, with both remaining gaps (per-clone wiring, no branch protection) stated rather than implied. **It recurred while being verified** — `git stash -u` removed the untracked hook mid-test | independent review of PR #6 |
| 2026-08-19 | R-86…R-89 | Added for ADR-0034 — lease mistaken for confinement, timeout-based stale takeover, correlation mistaken for authority, and task-digest privacy. The chosen writer mechanism is kernel `flock`; correlation is separated from trusted digests; task text remains forbidden | principal-pi-skills v3 assurance integration |
| 2026-08-19 | R-90 | Added and fixed — a load-bearing ledger append after kernel-lock acquisition could strand that writer lease for the life of the still-running parent. Lease ownership now survives the error boundary and every executor path releases in `finally`; regression forces the append failure and reacquires the same root | runtime cleanup audit |
| 2026-08-19 | R-91…R-95 | Added and fixed from three independent reviews — exact-bound single-flight rebinding, caller-underdeclared workspace access, child surviving parent lease release, untrusted receipt head/tree, and inherited-pipe timeout escape. Each now has a regression and narrowed boundary text | independent 0.18.0 review |
| 2026-08-20 | R-96…R-97 | Added and fixed in re-review — chain approval attribution/consumption and unaudited banked answers; critical-token wrapping, fan-out early rejection and false aggregate codes. The pass also tightened v2 validation, named-check crash attachment, staged executable identity and pipe cleanup | independent 0.18.0 re-review |
| 2026-08-20 | R-98 | Added and fixed in final review — herdr close failure releasing a live writer, check lease-loss racing receipt append, infrastructure error masking the critical token, and versioned lines bypassing v2 validation | final independent 0.18.0 review |
| 2026-08-20 | R-93, R-97, R-98 | **Corrected, not rewritten (rule 2).** All three claimed a regression per fix; a 17-mutation audit on a confirmed-green baseline found **four** of those regressions absent — R-93's token guard, R-97's sibling-await, and two of R-98's four. The tests named for them passed for other reasons. All four now fail when the guard is removed. A claimed regression nobody re-derived is indistinguishable from an absent one | six-reviewer pass over the 0.18.0 candidate |
| 2026-08-20 | R-99…R-118 | **Six independent reviewers over the unmerged 0.18.0 candidate, and the capability invariant held on every path any of them could construct** — no fail-open in authority resolution. What they found instead: the writer lease reporting handovers the kernel never performed (R-99, R-100, measured in `docs/probes/g35-flock-fd-inheritance`, which settled a disagreement between two reviewers who had reached opposite conclusions); a bound approval spendable outside the workspace it named (R-110); correlation as a model-writable text channel into the append-only ledger (R-111); a refused delegation banking a 30-day approval (R-113, the same shape as R-96 a third time); and a ledger with no vocabulary for lost, retained or uncontended leases (R-103…R-105). **The headline finding was not a defect but an absence**: eight guards holding up ADR-0034's advertised properties could each be deleted with 558/558 still green, in a project whose own rule 7 says a test that cannot fail is worse than none. R-101 and R-118 are accepted with their reasons stated | six-reviewer pass over the 0.18.0 candidate |
| 2026-08-20 | R-119…R-129 | **Six reviewers over the FIX commits, and the fixes claimed properties the code did not have.** The invariant held a third time; the runtime half did not. Three critical: a terminal append still `strict: true` under four documents saying otherwise (R-119); the anti-silence mechanism satisfied nowhere (R-120); `unbankApprovals` both too narrow and too broad (R-121). R-122 shows the marquee R-106 fix was itself undefended — deleting all four guards left 580/580 green — and over-corrected. **R-127 records a regression claim corrected twice and still not satisfied**, with the test deleted rather than weakened to pass; R-128 the process error of editing a tree five reviewers were mutating; R-129 that the audit everything rests on has no artifact. Also fixed: a failing lease test hung the runner past 900s, which is how a suite that CAUGHT a defect reads as untested | six-reviewer pass over the fix commits |
| 2026-08-20 | R-130 | Added and fixed — the two findings the mutation auditor left open at the new HEAD: the `{release:true}` clean-release handshake was unpinned (deleting it left 586/586 green, so a deliberate handover would have been treated as a crash), and a test of mine overstated what the wiring does with `context_id`. Also records that the auditor corrected its OWN recommendation — pinning `truncated` would have introduced a bug — and that `a882595`'s `docs:` label was wrong for a commit touching five production files | mutation re-verification at the fixed HEAD |
| 2026-08-20 | R-131, ADR-0035 | Added — **workspace routing does not attenuate, and it shipped in 0.18.0.** A child routed to `staging` can route its grandchild to `prod`, and unlike ADR-0012's accepted `bash` escape it leaves a complete, correct-looking ledger record asserting an authorisation nobody granted. R-26's shape in a namespace added five ADRs later. ADR-0035 proposes `workspace:<id>` as a capability so it attenuates through the existing `resolve()` path, and is deliberately left **Proposed** pending a transitivity probe — the evidence R-26 had and this does not | ADR-0034's unresolved list |
| 2026-08-20 | R-131, ADR-0035 | **Measured, then fixed.** `docs/probes/g36-workspace-attenuation` confirmed the escalation against real worktrees and a real lease — grandchild planned with no refusal, took a write lease on `prod`, would have started there — with the control showing grant and depth attenuating through the same child environment. ADR-0035 Accepted and implemented: routing is a capability, `WORKSPACE_NOT_AUTHORIZED` is recorded in `denied`, and `workspace:*` is held but never inherited. All four parts mutation-verified; the probe now measures the refusal too | ADR-0035 |
| 2026-08-20 | R-132 | Added and **fixed** — a capability id containing a comma was admitted by a wildcard's prefix rule and split by the child into several capabilities, minting `tool:bash` from a root that never held it with `denied: []` and a clean-looking ledger line. **Present in published 0.18.0**, verified against `origin/main`; predates ADR-0035, which widened the surface with a second injectable namespace. Two guards, both mutation-verified. The channel was predicted verbatim by `grant-env.ts`'s own comment and guarded everywhere except propagation | found reviewing PR #10 |
| 2026-08-21 | R-133, R-134, R-135, ADR-0035 amended | **Two review passes over PR #10 before it merged: the guard was right and the namespace was taught to three of nine sites.** R-133 is the pattern — the severe symptom being that `unknownCapabilities` never learned `workspace:`, so with a catalog present (always, in production) no child could be granted one and routing *terminated* below the root rather than attenuating, making the ADR's headline "two authorities, not one" unreachable. Also inert: the gate ADR-0035 claimed three times, and the `init` scaffolding it offered as the migration path for a breaking change. R-135 fell out of the mutation battery and is **older and worse**: R-26's own rule was enforced only in `childEnv`, so `delegate.ts` — the path that spawns since ADR-0016 — handed `tool:*` to children for eleven releases, with the rule's test asserting on the other route. R-134 is a session-start warning that told operators to delete a control that had worked since **0.12.0** — six releases — which ADR-0024's Costs section had explicitly relied on, and which an integration test *required* to exist, so the stale claim was defended by the suite. Eleven mutations, eleven named failures; `test/workspace-capability.test.ts` is organised by site so the checklist is executable | second and third review passes over PR #10 |
| 2026-08-21 | R-136, R-137, R-138 | **A third review pass, six reviewers, over the fixes for the second.** Two shipping blockers, both introduced by the fix commit: a blocking registry path hung `session_start` (R-136, R-79's class again, and `AbortSignal` did not rescue it — `stat` before `open` did), and `/grants init`'s dialog granted routing live off a package declaration while the file it generates said "Not granted for you". R-137 closes the gap ADR-0035 asserted away, with **two** mechanisms because ownership and mode cannot distinguish a child from its parent at the same uid — the content pin is what actually closes it. **Ten single edits from the fix commit were revertible with the suite green**, including two of the six site fixes deletable *together*, and its own "eleven mutations, eleven named failures" was a count of what was checked rather than of what was covered. R-138 records four pre-existing findings left unfixed on purpose | third review pass over PR #10 |
| 2026-08-22 | R-136, R-137 reopened, R-139 | **A fourth pass, six reviewers over the third pass's fixes — and R-136 was marked FIXED while a function added by the fixing commit still hung session start on a FIFO.** Three reviewers found it independently; a real `pi` produced zero notifies and timed out. R-136's own trigger ("grep for `readFile` reached from `loadProjectDefinitions`") found it, and nobody ran the trigger. A second hang existed too: `stat`-by-name then `readFile`-by-name is a TOCTOU any same-uid process can win. One reader holding one handle (`open(O_NONBLOCK)` + `fstat` the descriptor) closes both. **R-137's pin is reverted** — defeated four ways, including a measured escalation on the herdr executor, which no existing mechanism crosses. **Fourteen single reverts left every suite green, eight of them edits those commits added**, including the whole "names the file" fix and the pin's own wiring; `npm test` was also silently overwriting tracked contract fixtures. R-139 records the id-grammar break | fourth review pass over PR #10 |
| 2026-08-22 | R-139…R-142, PR #10 narrowed | **A fifth pass, six reviewers over the fourth pass's fixes, and the response was structural rather than another round of patches.** Two blockers: the 1 MiB ceiling bounded the file and not the read (`handle.readFile` re-`fstat`s internally, so holding one handle closed the NAME race and left the SIZE race — 192 MiB read after a 29-byte measurement, race won in 848ms), and the id grammar had a FIFTH site, `isSafeCapability`, which refused the `feature/x` shape the release advertises and dropped the whole definition. **PR #10 was then narrowed to ADR-0035**: registry ownership/mode → R-137, the ledger-path and `tool:delegate` work → R-141, two pre-existing session-start hangs → R-140. And `npm run test:mutation` makes rule 7 mechanical — twenty pinned patch/test pairs, which caught four bad entries of its own, a test of mine that passed for the wrong reason, and a predicate bug in itself that had made its first "20/20" meaningless. R-142 records that it is not a control until CI runs it | fifth review pass over PR #10 |
| 2026-08-22 | R-143 | Added and fixed — `npm run test:mutation` reported **0/20 guards forced** at `0a62a42` with every guard intact, because this environment exports `FORCE_COLOR=3` and the failure matcher was anchored past the escape sequence; colour off, the same sweep printed 20/20. A control that cannot read its instrument accuses twenty guards at once, which is the loop rule 7's catalogue exists to end. Parser extracted and tested, colour pinned in the spawned suite, and an unreadable transcript now says so instead of scoring the guard | sixth review pass over PR #10 |
| 2026-08-22 | R-144…R-148 | **A sixth pass, four reviewers over the fifth pass's fixes, and the capability invariant held a fourth time** — three-level transitivity, both halves of two-authorities, every wildcard channel. Everything found is the claims layer and the runtime half. R-144 is the one to read: the commit that NARROWED this PR deleted the registry ownership guard and left three documents selling it, one of them R-137's own bound, so an OPEN risk understated itself — a commit that removes a guard must grep for the guard's claims. R-145 (a gated routing attempt seizes the destination's writer lease before the human is asked) and R-146 (a retained lease stops its own process exiting, re-derived here: exit=124) are runtime and left OPEN with candidates named. R-147 is rule 8: a refused registry prints nothing anywhere. R-148 measures what R-138 item 1 recorded as unmeasured — two 'exclusive' governed writers on one root when the lease dirs diverge | sixth review pass over PR #10 |
| 2026-08-22 | R-149, R-150 | **The sixth pass's fourth reviewer was asked for the COMPLEMENT of the mutation catalogue rather than its contents, and that framing is the finding.** Twenty pinned pairs answer "do these hold"; nothing answered "which are missing". Seven guards this diff adds are forced by nothing — including the catalog rebuild wired on the quieter of two routes (R-28's shape, in a diff that fixes R-28's shape elsewhere) and `O_NONBLOCK`, forced only by wedging the suite. R-149 is the sharpest: the registry read deadline is deletable with the suite green, and the module still classifies an `AbortError` no code can produce. **Nothing was weakened to make the branch green** — the canonical refusal enum was extended and then made generated, waiver documented, and no released tag ever carried the v2 contract | sixth review pass over PR #10 |
| 2026-08-22 | R-146 | Added and **FIXED from `main`** — a retained writer lease stopped its own process from exiting, measured `exit=124` against `exit=0`, in any host that lets the event loop drain (pi's print mode, a library consumer such as an ADR-0034 external controller; interactive and rpc call `process.exit()`, so there the sweep still ran). **Present in published 0.18.0 and 0.18.1.** R-102 accepted stranding the worktree; nobody had recorded that it stranded the process, and two comments promised the strand lasted "until process exit". Fixed by dropping the parent's references on the retain path only — the lock still outlives the call, and the successor can still acquire, which the regression asserts as a second property | sixth review pass over PR #10, fixed next |
| 2026-08-22 | R-146 corrected, R-151 | **The independent review of the R-146 fix found the fix's own safety argument half-false, and a claim repeated here unchecked.** The helper's `herdr tab close` had no wall-clock timeout, so a herdr that accepts and never answers held the lock forever with no marker — and the fix had removed the only symptom (a hung `pi`), turning R-102's rejected outcome into a silent one. Bounded now, forced by a test with a `herdr` that sleeps. The scope claim was also wrong: `process.exit()` runs exit handlers, so only hosts that let the loop drain (pi's print mode, library consumers) were wedged — `src/cli.ts` was cited as evidence and has one subcommand and no leases. One unref line was unforced and is gone. R-151 records what the fix newly exposes: the reaper and the helper now close the same tab | independent review of PR #14 |
| 2026-08-22 | R-146 (second review) | **The review of the fix found four more, two behavioural.** Retention was not terminal — a later `release()` ran the clean handshake, overwrote `retained:herdr-close-failed` with `completed` and told the helper to exit `clean`, so the pane was abandoned and the ledger claimed a handover; `release()` now answers `retained`, which required making that a real member of `LeaseReleaseOutcome`. `herdrCloseTimeoutMs: 0` silently restored the unbounded hang, because Node reads `timeout: 0` as no timeout (measured 3004ms for a 3s sleep) — both bounds now refused loudly by name. Plus a non-hermetic test and a fake `herdr` that orphaned a `sleep` per run. **And the new refusal test hung the runner instead of failing** — R-119's shape in the commit that cites R-119 — because an unexpected success left an untracked lease holding a live `flock`: a test that proves a refusal must clean up the success it did not expect | second review of PR #14 |
| 2026-08-22 | R-152 | Added and fixed — **`markRetained` returned `void` and its only caller hardcoded `"retained"`**, so the ledger asserted a live pane for a helper that had already died, for a lease already cleanly released (the mirror of R-146, introduced by fixing it), and for a retention whose record never landed. Now answers in the release vocabulary and the caller ledgers what it says; four guards, each forced by reverting it alone. The bounds were wrong at the top end too — `MAX_SAFE_INTEGER` truncates to 1ms and SIGKILLs every close — and refused on the governance channel, inviting a controller to retry a permanent caller bug; a bad argument now throws `RangeError`, and the check moved above the read-lease early return where it had validated nothing. **Both earlier passes asked whether the fix was correct and not what its return value promised** | independent reviews of the merged PR #14 |
| 2026-08-22 | R-153 | Added and **fixed in part** — CI exists. Eight review passes found guards deletable with the suite green because the only thing forcing rule 7 was somebody choosing to look (R-34's shape, for years). `.github/workflows/ci.yml` runs typecheck, the unit suite, a tree-cleanliness assertion, the mutation catalogue (`--if-present` until PR #10 brings it to `main`) and the installed-package smoke on every PR, across the `engines` floor and the development ceiling — with `FORCE_COLOR=0` pinned at the workflow level, which is R-143: the catalogue reported `0/20` with every guard intact in a colouring environment, and CI would have inherited that. **It reports and does not block** — no branch protection, so a red run stops nothing; integration and the model tier are deliberately not covered and the workflow says why | R-142's trigger, fired three times |
