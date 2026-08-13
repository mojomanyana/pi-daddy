# ADR-0001: Build vs. Leverage — which capabilities do we build custom?

**Date:** 2026-08-08
**Status:** Proposed (OPEN — decide before G0)
**Driver:** Q-KILL-1, Q-WHAT-1, risk R-06, `docs/archive/04-landscape.md`

## Context

The blueprint prescribes building all five capabilities (C1 mounting, C2 hybrid registry,
C3 aggregation, C4 eviction, C5 observability) as custom middleware. Since it was written,
platform-native features (provider tool search / deferred tools, MCP dynamic tool lists,
agent-SDK subagent summarization) cover parts of C1–C3. Building what the platform already
ships is negative-value work; the moat is only in the deltas (R-06).

Blocked on: A-01/A-02 evidence, the landscape scout pass, and the catalog-size baseline (B1).

**Input (2026-08-09, Q-BASE-1):** The substrate is Mario Zechner's pi coding agent, and the user
chose **build-on-as-dependency over a literal fork** — DTCM composes with pi's published packages
via extension points rather than owning a divergent copy. This narrows the option space: any
"full custom build" here means custom middleware *around* pi, not a modified agent core, and
raises the bar for building anything pi (or its ecosystem) already ships.

**Input (2026-08-09, Q-WHAT-1 decision → ADR-0004):** The MVP cutline is now decided as staged
measure-then-mount, which **constrains this ADR to Option 2 (leverage-first hybrid) as the posture**
and pre-answers several of its capability cells for v1:
- **C1 mounting — leverage, do not build.** Pi's `registerTool`/`setActiveTools` are the mounting
  mechanism; DTCM adds only the *policy* (which tools, when). Blueprint §3.2 message-injection is
  cut (A-03 evidence).
- **C2 registry — build the minimum only.** Stage B needs an index sufficient for one
  `search_tools` meta-tool; the embedded-vector/hybrid question (A-05, A-07) is deferred behind a
  trigger, not decided here.
- **C3 aggregation — do not build in v1.** Cut with a reopen trigger (Q-WHAT-3).
- **C4 eviction — do not build in v1.** Append-only mounting removes the need; A-06 stays unvalidated
  as an accepted state.
- **C5 observability — build FIRST.** It is Stage A, and it is what makes every other build/leverage
  call evidence-based rather than asserted.
What remains genuinely open for this ADR is therefore narrower than when it was seeded: the
capability-by-capability *final* call still waits on Stage A's numbers (A-01/A-02) and a scout pass
on `04-landscape.md`, and on one novelty question now in flight — whether a tool-search extension
already exists in the pi ecosystem, which would turn C2/C1 policy work from "build" into "contribute
upstream or adopt".

## Options considered

### Option 1 — Full custom build (blueprint literal)
Maximum control and provider-independence; maximum surface to maintain; slowest to first value.

### Option 2 — Leverage-first hybrid
Adopt native/platform primitives where they cover a capability at the measured scale; custom-build
only the gaps (likely candidates: C2's exact-tag/bundle semantics, C4's policy engine if A-06
validates, C5's token-delta accounting). Fastest path to a measurable result.

### Option 3 — Defer entirely
If A-01 busts at 3× the expected catalog size (no measurable degradation), park the initiative
with a re-trigger (catalog size or accuracy drop) and spend the effort elsewhere.

**Input (2026-08-09, research-scout landscape pass) — this substantially decides the C1 cell:**
- **C1 mounting is now covered twice over.** Anthropic's tool search is **GA** with published results
  (MCP-eval 49%→74% on Opus 4, 79.5%→88.1% on Opus 4.5, ~85% fewer tool-definition tokens); OpenAI ships
  near-parity on gpt-5.4+; and **pi itself ships the loader-tool/`search_tools` pattern as a documented
  recipe with a ~90-line worked example** (0.80.7, 2026-07-14), routing additive `setActiveTools` changes
  onto native deferred loading. Building C1 would be negative-value work — R-06's trigger has fired.
- **Coverage is not universal, which is where the remaining value sits.** Google has no equivalent (open
  parity request), local models have none, and support is version-gated (Sonnet 4.5+, gpt-5.4+). MCP adds
  nothing — spec rev 2026-07-28 still exposes only `tools/list` + `list_changed`, no search or ranking
  primitive. A multi-provider *policy* layer therefore still has a home.
- **What nobody has published is the evidence.** Every framework prior art (LlamaIndex ObjectIndex +
  ToolRetriever, langchain-ai/langgraph-bigtool, VS Code Copilot's "virtual tools" behind a 128-tool cap)
  is pattern-level with **no published benchmark**. The only numbers come from the providers themselves.
  An open benchmark of tool-context economics on a real multi-provider TS agent is a differentiated
  contribution rather than a fifth reimplementation of retrieve-then-bind.
- **And the ecosystem is crowded where we might have gone next:** ~110 `pi-package` npm packages (40+
  published in the first nine days of August 2026), including ~8 subagent packages, 6+ observability
  packages, ~10 context-management packages, and `pi-cache-optimizer`. **No** package does retrieval over
  a *tool catalog* driving `setActiveTools`.

## Decision

_ (pending Stage A's numbers for the final capability-by-capability call — but the posture and the C1/C3/C4
cells are settled by ADR-0004 and the evidence above. What genuinely remains: whether C2's index earns its
complexity over A-13's control arms, which is a measurement, not a judgement.)

## Consequences

_

## Revisit trigger

A native platform feature covering a capability we chose to build (R-06 trigger), or catalog
growth crossing the scale where a deferred capability starts to bite.
