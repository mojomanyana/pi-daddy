# D0 Landscape — Build vs. Leverage Worksheet

**Purpose:** the blueprint was written as if nothing existed. Before building, map what already
covers each capability. This file feeds **ADR-0001 (build vs. leverage)** and is refreshed by
**research-scout** at every gate (last refresh: seeded 2026-08-08 — needs a scout pass for
current versions/features before G0).

## Capability key

C1 JIT tool mounting · C2 Hybrid registry (semantic + exact/bundles) · C3 Sub-agent output
aggregation · C4 Configurable eviction lifecycle · C5 Observability (mounts, lifecycle, token deltas)

---

## Prior art matrix (seed — verify & date every cell before G0)

| Platform / pattern | C1 mount | C2 registry | C3 aggregation | C4 eviction | C5 observability | Notes for our decision |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Anthropic Tool Search / deferred tools** — verified 2026-08-09 | ● **GA, not beta.** `tool_search_tool_regex_20251119` / `_bm25_20251119`; all tools still sent, deferred ones marked `defer_loading:true` (≥1 non-deferred required, max 10,000 deferred, 5 results/search). Deferred defs excluded from the prefix; hits appended as expanded `tool_reference` blocks → "the prefix is untouched, so prompt caching is preserved". Sonnet/Haiku/Opus 4.5+. Not metered as a server tool. `defer_loading`+`cache_control` on one tool = 400. Bedrock: InvokeModel only, not Converse | ◐ regex/BM25 only — **but an official client-side path exists**: your own tool returns `tool_reference` blocks and the API expands them, with an embeddings cookbook recipe | ○ | ◐ platform-managed, not policy-configurable | ◐ usage visible, no token-delta accounting | **Published results: MCP-eval 49%→74% (Opus 4), 79.5%→88.1% (Opus 4.5), ~85% fewer tool-def tokens.** Strongest "don't build C1" argument — and the custom-search path means an embeddings index can ride the cache-preserving route. Unverified: whether pi-ai exposes that client path or only `addedToolNames`→native deferral |
| **OpenAI tool_search / defer_loading** — added 2026-08-09 | ● Responses API, hosted **and** client-executed (`tool_search_call` → `tool_search_output`); tools loaded at the **end** of context so "the model's cache [is] preserved from one request to another". gpt-5.4+ | ◐ | ○ | ○ | ○ | Near-parity with Anthropic; also on Azure Foundry. Docs state no GA/beta status and carry no date — unresolved |
| **Google / Gemini** — added 2026-08-09 | ○ **no equivalent** — open parity feature request (googleapis/python-genai #2185) | ○ | ○ | ○ | ○ | This is why native coverage cannot be assumed for a multi-provider agent: the same DTCM design has opposite cache economics here (R-14) |
| **MCP (Model Context Protocol)** — verified 2026-08-09 | ◐ dynamic tool lists, `listChanged` notifications — **and nothing more**: spec rev 2026-07-28 still has only `tools/list` + `notifications/tools/list_changed`, **no standard search or ranking primitive** | ◐ server-side tool exposure; grouping ≈ bundles per server | ○ | ○ | ○ | Doubly irrelevant here: pi refuses MCP by design, and MCP adds no selection primitive anyway. `pi-mcp-adapter` 2.21.1 / `pi-mcp-extension` 1.5.0 re-add it for those who want it |
| **VS Code Copilot "virtual tools"** — added 2026-08-09 | ● ships in production: past `virtualTools.threshold`, tools auto-group per extension/MCP server or category, and "virtual tools act as directories that only activate and show the tools they contain when the model calls them" — forced by a hard **128-tools-per-request cap**. Experimental in v1.103 (July 2025) | ◐ grouping, not retrieval | ○ | ○ (additive only) | ○ | Existence proof that shipping clients hit this wall and solve it by grouping, not by eviction. **No published accuracy results** — the cap is the forcing function |
| **Claude Agent SDK (subagents, compaction, hooks)** | ◐ per-agent tool allowlists | ○ | ● subagents return summaries, not raw context — this IS the aggregator pattern | ◐ context compaction/editing | ◐ | Covers C3 substantially if adopted rather than rebuilt. |
| **LangGraph (dynamic `bind_tools`, ToolNode)** | ◐ per-request tool binding is trivial | ○ BYO retriever | ◐ subgraphs | ○ BYO | ◐ LangSmith traces | Framework, not solution: gives primitives, C2/C4 still get built. Python-first (ADR-0002 relevance). |
| **LlamaIndex tool retrieval (ObjectIndex)** | ◐ retrieve-then-bind pattern | ◐ vector tool retrieval out of the box | ○ | ○ | ○ | Reference implementation of C2's semantic half. |
| **pi coding agent (the substrate) — filled 2026-08-09 from Q-BASE-3, upgraded same day by the scout pass** | ● **not just the mechanism — the whole recipe.** `docs/extensions.md` has a "Dynamic Tool Loading" section: "Keep loader tools, such as `search_tools`, active and leave searchable tools inactive… call `pi.setActiveTools([...currentTools, ...matchingTools])`. The change must be additive" + a complete ~90-line worked example, noting the search "could use BM25, embeddings, a remote catalog, or project-specific routing". Shipped 0.80.7 (2026-07-14) as "cache-friendly dynamic tool loading". pi-ai maps additive changes onto **native deferred loading** (Anthropic 4.5+, OpenAI Responses gpt-5.4+, Kimi via OAI-compat); others fall back to sending `Context.tools` normally | ◐ a tool table, no index. **Nothing in the ~110-package ecosystem does retrieval over a tool catalog** (nearest: `monotykamary/pi-lazy-extensions`, an "experiment" lazy-loading whole *extensions*; `vxio/pi-lazy-loader`). No MCP by design | ○ core (no task/subagent tool — only bash/edit/edit-diff/find/grep/ls/read/write; README: sub-agents belong "via extensions rather than core inclusion"). ◐ a *usage-accounting contract* exists: "If a tool makes nested LLM calls, return their combined `Usage` as `usage`". **~8 ecosystem packages fill it** (pi-subagents 0.44.0, @gotgenes/pi-subagents, pi-crew, pi-fabric, …) | ◐ compaction (auto on overflow + manual `/compact`; `reserveTokens` 16384, `keepRecentTokens` 20000, tool results truncated to 2000 chars), lossy; no per-tool eviction. **Non-additive tool changes never use deferred loading** — the substrate penalizes eviction | ● **cache-aware usage ships**: pi-ai `Usage` = `{input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost{…}}` across 25+ providers, on `message_end` + the `pi.ai.request` span; `pi.ai.deferred` flag; `pi.tool.*` outcomes; `time_to_first_chunk_ms`. ○ **no tool-definition attribution, no active-tool count, no catalog size.** Caveat: telemetry ships only NOOP+InMemory contexts, no CLI hook → use the event bus (33 events) | **The floor is far higher than assumed.** Mounting *and its cache-safe provider routing* are free; what pi leaves empty is the **catalog, the selection policy, and the token-attribution numbers**. Author publicly holds DTCM's thesis (MCP = 7–9% of context). Ecosystem: ~110 `pi-package` npm packages, 40+ in the first nine days of Aug 2026, incl. 6+ observability and ~10 context-management packages — **so O5 must not be pitched as tracing** |

● = covers · ◐ = partial · ○ = absent · ? = unknown until the baseline survey

---

## ⚠ The matrix above surveys the WRONG SHELF (noted 2026-08-09, ADR-0007)

C1–C5 are framed around *tool retrieval and mounting*. The reframed product is **capability governance for a
multi-level agent system**, so the relevant prior art is sub-agent orchestration and per-agent capability
scoping. Second matrix, for the right shelf:

**Capability key (v2):** D1 spawn sub-agents in scoped sessions · D2 per-sub-agent tool/skill provisioning ·
D3 mid-run steering · D4 multi-level bounds (depth, attenuation, budgets) · D5 grant audit trail

| Package / platform | D1 spawn | D2 provisioning | D3 steering | D4 multi-level bounds | D5 grant audit | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`@tintinweb/pi-subagents` 0.14.3 — ALREADY INSTALLED AND IN USE by this user** | ● `Agent` tool: fg/bg, `resume`, `inherit_context`, `isolation: worktree`, schedules, RPC over the event bus | ● **but static per type**: `tools:` allowlist (built-ins, `*`, `none`, `ext:<extension>/<tool>`), `disallowed_tools:` denylist, `extensions:`/`skills:` toggles, `isolated:`. **No `tools` parameter on the `Agent` call** | ● `steer_subagent` — injects a message, interrupts after the current tool execution | ○ no depth limit, no grant attenuation; `isolated:true` blocks nesting only incidentally | ◐ per-subagent JSONL transcripts; **no ledger of what was authorised vs refused** | **This is the substrate to extend, not to replace.** ~70% of the requirement. Delta = call-time grants, depth/attenuation, ledger, registry |
| **`pi-fabric` 0.40.3 — READ 2026-08-09; implements ~the whole delta** | ● child agents, one-shot + persistent actors, councils, mesh; **code mode**: model writes a type-checked TS program in a QuickJS sandbox via one `fabric_exec` tool | ● **dynamic per-call**: `agents.run({ tools: [...] })`, `agents.setTools({id,tools})` at runtime; `extensions:false` opts a child out of Fabric entirely | ● `steer`, `followUp`, `tell`, `stop` through an acknowledged mesh control plane | ● **`agents.maxDepth` (`0` disables spawning)`; approvals do NOT inherit — only the `agent` risk passes to recursive children, not network/execution/write; `agents.budgetUsd` shared append-only ledger across the tree, race documented, race-free ceiling `agents.maxPerExecution`** | ◐ `FabricExecutionTraceV1`, bounded 512 KiB envelope + operations list; **no evidence refused/denied grants are recorded** | **Decisively answers ADR-0001 on this shelf: leverage, don't build.** Risk classes `read`/`write`/`execute`/`network`/`agent` × `allow`/`ask`/`auto`/`deny`; Allow-once/Allow-session scopes; approvals serialized so one-time grants never widen to siblings; **fail-closed** on dismissal/no-UI/restart. Enforces via Pi's native `tool_call` preflight — the same mechanism our spec proposed. Residual gaps: per-skill granting, denied-grant ledger field |
| **`pi-crew`, `@gotgenes/pi-subagents`, `@narumitw/pi-subagents`, `pi-background-tasks`, `@quintinshaw/pi-dynamic-workflows`** | ● (various) | ? | ? | ? | ? | ~8 subagent packages exist; unread. Crowded shelf — a fresh scout pass here is the highest-value research |
| **pi core** | ○ no subagent tool by design ("via extensions rather than core inclusion") | ● **`--tools` allowlist, `--exclude-tools` denylist, `--no-tools`, `--no-builtin-tools`** at the CLI, applying to built-in + extension + custom tools; `createAgentSession()` in-process | ◐ `steer()`/`followUp()`, `shouldStopAfterTurn`, `tool_call` blocking | ○ | ◐ event bus + cache-aware usage | The provisioning *mechanism* for child-process sub-agents is already in the CLI |
| **Claude Agent SDK** | ● subagents | ◐ per-agent tool allowlists | ◐ hooks | ○ | ○ | Same pattern, different ecosystem — evidence the shape is right |

**Unread and load-bearing:** `pi-fabric`'s depth/budget implementation (D4), and whether any of the ~8
packages already ships a grant ledger (D5) or call-time scoping (D2 dynamic).

## Questions the OLD matrix had to answer before ADR-0001 — status after the 2026-08-09 scout pass

1. **C1 — ANSWERED, and it deletes the capability from our scope.** Provider-native tool search is GA
   (Anthropic, with published numbers) and pi *documents the loader-tool recipe itself* (0.80.7), routing
   additive changes onto native deferred loading. Custom mounting is not D3+ material — it is **not ours
   at all**. The residue is that coverage is partial (no Google, no local models, version-gated), so a
   multi-provider *policy* layer survives as unclaimed ground.
2. **C2 — REFRAMED, and now the only live build question.** The exact-match half is indeed just a
   dictionary, and pi already has the tool table. But the sharper question surfaced by the critic is
   whether an index is needed *at all*: A-13's capability-index control arm (~15 tok/tool in the stable
   prefix, no retrieval hop, no R-07/R-20) may match retrieval. This is now a Stage A measurement.
3. **C3 — ANSWERED for v1: cut.** pi has no core subagent seam (a nested-`Usage` accounting contract
   instead) while ~8 ecosystem packages provide delegation — so a standalone aggregator service was never
   the comparison; the real one is "adopt someone's subagent package + add a compression contract", and
   the compression contract is the only defensible delta. Deferred with a trigger (Q-WHAT-3).
4. **C4 — ANSWERED in the negative, on external evidence.** No shipping production design does per-turn
   eviction (Anthropic, OpenAI, VS Code virtual tools are all additive), and non-additive tool changes
   forfeit the provider cache-preserving path — so the substrate penalizes what A-06 assumed we needed.
   No trace was needed to make the call; R-23 records the condition that would reopen it.
5. **C5 — ANSWERED, and it is the one capability we build first.** pi logs cache-aware usage across all
   providers (`cacheRead`/`cacheWrite`/`cacheWrite1h` on `message_end` and `pi.ai.request`) plus
   `pi.ai.deferred`, `pi.tool.*`, and TTFT — but **nothing attributing tokens to tool definitions, no
   active-tool count, no catalog size**. The smallest addition is schema v2 (`05-metrics.md` §3a) built as
   an event-bus subscriber, with tool-def attribution derived at `before_provider_request`. Caution: 6+
   observability packages already exist, so this must be pitched as *tool-context economics*, not tracing.

## Deliberate non-goals (filled by ADR-0001's decision)

Pre-filled 2026-08-09 by the Q-WHAT-1 decision (ADR-0004) for v1, pending ADR-0001's final
capability-by-capability call once Stage A's numbers exist:
- **C1 mounting mechanics** — leverage pi's, build none. Message-injection mounting (blueprint §3.2)
  is a non-goal outright.
- **C3 aggregation** — non-goal for v1 (reopen trigger in Q-WHAT-3).
- **C4 eviction policies** — non-goal for v1; append-only mounting removes the need.
- **Containerized vector/KV services** — non-goal for v1 (adoption tax, Q-HOW-3).
- **C2 registry** — build only what one `search_tools` meta-tool requires; hybrid/vector deferred
  behind A-05/A-07 triggers.
- **C5 observability** — the one capability built FIRST (it is Stage A), but as a trace event only,
  not a UI.

## Scout log

| Date | What was checked | Key finding | Source |
| :--- | :--- | :--- | :--- |
| 2026-08-09 | pi identity, license, version, integration depths (Q-BASE-1) | Mario Zechner's pi, `github.com/earendil-works/pi`, MIT, v0.84.1, very active; extension / SDK / fork are the three depths | repo LICENSE, README, docs/sdk.md, docs/extensions.md, npm |
| 2026-08-09 | pi language, stack, loop seams (Q-BASE-2) | TypeScript/Node ≥22.19, TypeBox schemas, `agent.state.tools` mutable per turn, `transformContext`/`convertToLlm`/event bus seams | packages/agent + packages/ai READMEs, docs/extensions.md |
| 2026-08-09 | pi tool-management + context floor (Q-BASE-3) | Mounting mechanism ships; policy does not. No MCP by design; compaction is lossy; Pi Packages are the distribution channel | coding-agent README, docs/extensions.md, Zechner blog 2025-11-30 |
| 2026-08-09 | pi delegation seam (gates A-04/O4) | No core subagent tool; a nested-`Usage` accounting contract instead; ~8 ecosystem packages fill the slot → A-04's only delta is the compression contract, not delegation | pi README, `src/core/tools/` listing, docs/extensions.md, docs/sdk.md, npm `pi-package` search, pi.dev gallery |
| 2026-08-09 | Does a tool-search extension already exist in pi? (gates Stage B novelty) | **Stronger than "exists": pi documents the `search_tools` recipe itself** with a ~90-line example, shipped 0.80.7, mapped onto native deferred loading. No ecosystem package does retrieval over a *tool catalog* | docs/extensions.md "Dynamic Tool Loading", CHANGELOG 0.80.7 (2026-07-14), npm keyword search (~110 pkgs), awesome-pi.site |
| 2026-08-09 | A-11 — does `setActiveTools` survive resume/compaction? | Source persists+replays `ActiveToolsEntry{type:"active_tools_change"}`; docs say state does **not** persist and mandate reconstruction in `session_start`; `session-format.md` omits the entry type entirely (doc lags code). **pi's own example would clobber the replayed set.** Compaction interaction unresolved | harness `session/types.ts`, `reducer.ts`, `ai/src/types.ts`, `agent-loop.ts`, docs/extensions.md, docs/session-format.md, docs/compaction.md |
| 2026-08-09 | A-12 — cached-token exposure | **YES** — `cacheRead`/`cacheWrite`/`cacheWrite1h` survive 25+-provider normalization and reach `message_end` + `pi.ai.request`. No tool-def attribution ships; use the event bus, not spans (no CLI hook for a TelemetryContext) | `harness/telemetry.ts`, `packages/telemetry/README.md`, `ai/src/types.ts`, CHANGELOG 0.81.0 / 0.84.0 |
| 2026-08-09 | Tool-count vs. accuracy literature (Q-WHY-2, A-01) | Measured elbow **40–60 tools**; F1 66.3→45.9 (Sonnet 4.5) over 51→584 tools; **~10pp confusion gap no retrieval can recover**; the 10–40 band is **unmeasured**; under-showing hurts more than over-showing on hard queries | arXiv 2606.17519, 2605.24660 (Meta), 2505.03275, 2505.10570, 2604.21816; Anthropic + OpenAI docs |
| 2026-08-09 | Provider-native coverage for a multi-provider non-MCP TS agent | Anthropic GA (49→74%, 79.5→88.1%, ~85% token cut); OpenAI gpt-5.4+ parity; **Google none**; MCP adds no search primitive. Coverage is version-gated and partial → a policy layer still has a home | platform.claude.com, developers.openai.com, MS Learn, python-genai #2185, MCP spec rev 2026-07-28 |
| 2026-08-09 | Embedded vector search maturity in TS (A-07, ADR-0002) | All pre-1.0: sqlite-vec 0.1.10-alpha.4, LanceDB 0.33.0, SQLite Vec1 announced-not-released (v0.7). Local ONNX embeddings viable (transformers.js MiniLM). **Brute-force cosine is the right control arm; no Docker justified** | asg017/sqlite-vec, npm @lancedb, sqlite.org/vec1 + forum 2026-03-30, nodejs.org/api/sqlite, HF transformers.js |
| 2026-08-09 | Prior art of retrieval-based selection in production | Providers publish numbers; **frameworks publish none** (LlamaIndex ObjectIndex, langgraph-bigtool, VS Code virtual tools). Every shipping design is additive/monotonic — **none does per-turn eviction** (evidence against A-06). A TS agent CLI's defer_loading request sat 3 months and closed stale — pi is ahead of that curve | Anthropic engineering post, VS Code v1.103 + docs, LlamaIndex docs, langgraph-bigtool, arXiv 2606.17519, openclaw#16076 |
