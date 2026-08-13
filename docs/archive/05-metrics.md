# D0 Metrics — Baseline First, Then Targets

**Rule:** no target without a baseline; no baseline without a measurement method. The baseline is
captured BEFORE any design freeze so the initiative can be judged honestly — including the option
of killing it (Q-KILL-1/2).

**Prerequisite:** the baseline agent must be pinned first (Q-BASE-1/2) — these numbers are
measured on it, unmodified.

---

## 1. Baseline measurement plan (do this in D0)

Measurement scripts live in `docs/probes/baseline/` (measurement-only code is allowed in D0).

| # | Measure | How |
| :--- | :--- | :--- |
| B1 | Tool/skill catalog size | count tool definitions the baseline agent exposes; note realistic growth rate |
| B2 | Tokens per turn attributable to tool definitions | log usage from provider responses with and without the catalog attached |
| B3 | Tokens per completed task (in/out, cached/uncached) | provider usage fields across a fixed goal set |
| B4 | Task/tool-selection success rate | N representative goals → % where the right tool(s) were chosen (manual judgment; keep the goal set — it becomes the regression suite) |
| B5 | p50/p95 end-to-end latency per task | timestamps in the agent loop |
| B6 | Cost per task | B3 × provider pricing (note: local models ≈ 0 marginal cost — the cost argument only bites on hosted providers) |
| B7 | Catalog-scaling curve | B4 re-run at 10/50/200 tools (padded with generated distractors) — this doubles as the A-01 validation. **Amended 2026-08-09:** must reach **≥100 tools** (published effects only exist above ~50; the measured elbow is 40–60), must include a **real-catalog arm** beside the synthetic one (synthetic distractors are easier to separate, so a padded-only curve reads optimistic), and must run the **A-13 control arms** — static profiles, and "model picks from a names+one-liner list" — beside retrieval |
| B8 | Inter-turn gap distribution | timestamps between user turns; feeds R-15's cache-regime parameter — without it the A-02 model produces one number and hides a bifurcation |
| B9 | Distinct tools used per session (p50/p90) | from traces; decides whether append-only mounting decays (R-23) and whether static profiles would have covered the session (A-13) |
| B10 | Mid-turn divergence rate | for each user turn, would every tool actually used rank in the top-k for that turn's *first* message? Computable from baseline traces with no new code; quantifies R-16 before any selection design is chosen |

**Deliverable:** `docs/gate-reports/baseline-YYYY-MM-DD.md` with the seven numbers + the fixed goal set.

### 1a. Amendments from ADR-0004 (2026-08-09) — this section IS Stage A

The MVP cutline decision makes this baseline capture the near-term deliverable rather than a
prerequisite chore. Three amendments:

1. **Two catalogs, not one.** Every B-number is captured on the user's own pi catalog **and on ≥1
   catalog that is not the author's own** (community or synthetic), reported per-catalog, never
   averaged. Rationale: Q-WHY-1 grounds the baseline on one setup while Q-WHO-1 makes the OSS
   community the primary user — publishing a win that nobody reproduces is worse than publishing
   nothing (**R-13**). The catalog manifests and the fixed goal set ship with the results.
2. **Two new dependencies, both CRITICAL.** B2/B3/B6 and the whole cache-aware cost model depend on
   **A-12** (does pi's event bus expose `cached_read`/`cache_write` per turn?). If A-12 busts, cache
   accounting is recorded as a **named blind spot** in the baseline report and M1 is declared
   unmeasurable-on-this-substrate rather than quietly approximated. **A-11** (`setActiveTools`
   persistence across resume/compaction) rides along as a micro-probe because it gates Stage B.
3. **The exit is a decision, not a report** (**R-12**). See §2a.

### 2a. Stage A exit decision rule — thresholds written BEFORE the data is collected

R-12's forcing function. Fill the three thresholds below **before** running the probes; the report
then reads off which branch fired, so the decision cannot be rationalized after the fact.

| Branch | Condition (fill thresholds before collecting) | Action |
| :--- | :--- | :--- |
| **Gate 0 — the spreadsheet kill test (run FIRST, costs nothing)** | A-02's break-even inequality **S > 11.5·c·C** evaluated with measured B1 and B3. At c≈0.15 this needs roughly **≥110 tools (~27k tokens of definitions)**, and the threshold rises linearly with session length | If B1 is far below that, selection-based mounting is **cost-negative before a line is written** → skip to Park/Adjust. Do this before the B7 sweep |
| **Proceed to Stage B** | B7 shows a selection-accuracy knee at or below ___ tools (within reach of realistic catalogs, B1) **and** the A-02 model shows JIT net cost ≤ full-cached − ___% at realistic turn counts, **stated per provider class** (R-14) and **per cache regime** (R-15) **and** the A-13 control arms do not match retrieval within ___ points | Build Stage B (post-G1) — see ADR-0004 for its amended shape |
| **Park (O6)** | B7 flat — no degradation beyond ___ points at 3× realistic B1 — **and** A-02 shows cached-full-catalog cost dominance | Park with re-triggers: catalog growth past the measured knee; pi/pi-ai shipping native tool search (R-06) |
| **Adjust** | Mixed: a knee exists but cache economics are negative, or A-11/A-12 bust | Re-brainstorm the mechanism (e.g. cache-stable mount region, or measurement-only release) before any build |

Whichever branch fires is recorded in the baseline report **and** in ADR-0004's Consequences.

## 2. Success metrics (targets set at G0 from Q-HOW answers — do not invent numbers before baselining)

| # | Metric | Definition | Target (fill at G0) |
| :--- | :--- | :--- | :--- |
| M1 | Net cost per task | cache-aware, per provider | ≤ baseline − __% |
| M2 | Context tokens per delegated turn | prompt tokens attributable to tool schemas | ≤ __ |
| M3 | Selection/task success | B4 method, same goal set | ≥ baseline (non-negotiable floor); **upper bound: any selection layer's win is capped by the ~10pp non-recoverable confusion gap (A-01 evidence)** |
| M4 | Added latency | p95 delta vs. baseline per delegated turn | ≤ __ ms |
| M5 | Mount thrash rate | re-mount of same tool within N turns / total mounts | ≤ __% |
| M6 | Stale-call rate | calls to unmounted tools / total calls | ≈ 0 (state machine must define recovery) |
| M7 | Aggregator fidelity | A-04 golden-set decision-divergence | ≤ __% |

## 3. Instrumentation the design must carry (feeds D1 specs — blueprint §4 Observability)

Every delegated turn emits one structured trace event. **v1 (seeded 2026-08-08) — superseded, kept for
the record:**

`{turn_id, query, retrieval: [ids+scores], mounted: [ids], mount_reason, evicted: [ids+reason],
tokens: {prompt, completion, cached_read, cache_write}, latency_ms: {retrieval, mount, llm, aggregate}}`

### 3a. Schema v2 — required repairs (architecture-critic F6/F31, 2026-08-09)

**The v1 event cannot reconstruct a failed turn, and specifically cannot diagnose R-01 — the register's
only H×H risk.** Shipping it would mean shipping an instrument that cannot answer the question the
project exists to answer. Trace schemas are the hardest thing to change after users have data, so
**this repair happens before any code is written.** Seven additions, each with why it is load-bearing:

| Add | Why v1 fails without it | Available from |
| :--- | :--- | :--- |
| `active_tools_after: [names]` (or a stable hash) | `mounted` is a *delta*; reconstructing the active set at failure needs a full replay, and pi's session tree branches, so replay order is ambiguous | `getActiveTools()` / the `active_tools_change` entry |
| `cache_miss_cause` | With R-01 as the top risk, reporting cache-write tokens without *why* the prefix broke (tools changed / system prompt rebuilt / TTL expired / compaction rewrote history) makes it undiagnosable | partly free: the **`pi.ai.deferred`** flag gives native-deferred hit/miss; the rest is ours |
| `session_id` + parent message id | Cannot locate the turn in pi's branching JSONL tree | session entry |
| `model` + `provider` id | Retrieval results are not reproducible; and per R-14 the cache regime differs by provider, so a turn is uninterpretable without it | `pi.ai.request` span / `message_end` |
| `catalog_content_hash` (+ embedding-model version if any) | R-07/R-20 are undetectable without it | ours |
| tool-call outcomes: name called, in-active-set?, succeeded? | **M6 stale-call rate is unmeasurable as specified in v1** | `pi.tool.name`, `pi.tool.call_id`, `pi.tool.is_error`, `pi.tool.replay`, `pi.tool.recovery` |
| prefill/TTFT split in `latency_ms` | Cannot separate "retrieval was fast" from "we lost the cache and paid prefill" | `pi.ai.stream.time_to_first_chunk_ms` |

Also required by R-11: an explicit **`no_search_this_turn`** marker, so a turn where the model never
searched is visible as data rather than as absence. And per R-15, record the **inter-turn gap** so each
turn is attributable to a cache regime.

**Writer contract (critic F34):** async, bounded buffer, drop-on-backpressure, opt-in, redacting, and it
**never throws into the host** — an observability extension that can kill a turn is worse than no
observability. **Privacy (R-18):** `query` and tool arguments are sensitive; ship a separate
"shareable" projection excluding free text. Note pi's own telemetry contract permits primitives only and
prohibits prompts/arguments/outputs outright — inherit that posture.

### 3b. How M2 is actually measured (R-21) — write this down before code

"Prompt tokens attributable to tool schemas" exists in **no** provider usage field, and pi ships nothing
between "total input tokens" and "which tool ran". The method is therefore **local**: count/diff the
serialized `tools` array at the **`before_provider_request`** event — the seam pi's own docs describe as
"mainly useful for debugging provider serialization and cache behavior". Consequences to state publicly:
per-provider serialization must match pi-ai's, the figure carries an **error bar**, and it must be
labelled a measurement-with-method rather than a provider-reported number. A differential A/B (two
requests) is the alternative and costs double while diverging behaviorally — not preferred.

### 3c. Build on the event bus, not on telemetry spans (A-12)

`packages/telemetry` ships only `NOOP_TELEMETRY_CONTEXT` and `InMemoryTelemetryContext`, with no
production exporter and no documented way to install a `TelemetryContext` into the **CLI**. Every one of
the 6+ existing community observability packages therefore attaches as an event-bus subscriber. Stage A
does the same, and treats span attribute names as a reference for *what to capture*, not as the
transport.

## 4. Anti-metrics (things we refuse to optimize at the expense of)

Task success rate (M3 floor), debuggability (a failed turn must be explainable from its trace
alone), and dev-loop simplicity (one command still runs everything unless ADR-0002 decides otherwise).
