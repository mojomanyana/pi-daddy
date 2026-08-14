# DTCM Roadmap — Phases & Gates

**The rule that makes this real: work in phase N+1 does not start until gate N passes via `/gate`.**

> ## 🔧 STATUS: BUILDING — reframed 2026-08-09 (ADR-0007)
>
> **The phase plan below is obsolete and retained as a record.** It was built for the *token-economics*
> thesis, which G0 correctly falsified (`gate-reports/G0-2026-08-09.md`) before ADR-0007 established that
> token cost was never the goal. The project is now **capability governance for pi's multi-level agent
> system**, judged on control correctness rather than cost.
>
> **Where the work actually lives now:** `packages/pi-daddy` (the product) and
> `packages/pi-token-audit`, both under scoped gate waivers recorded in the G0 report. Read
> `docs/SESSION-LOG.md` for the current state and next actions, then `ADR-0007` → `ADR-0008` → `ADR-0009`.
>
> **What survives from below:** the gate discipline itself (it produced a real falsification), the probe
> convention, and the D1 artifact list — repurposed, since `docs/specs/2026-08-09-capability-governance-design.md`
> supersedes the four blueprint artifacts. **Phases D1–D4 as written no longer describe the plan.**
>
> The economics wake-up call still works if that thesis is ever revived:
> `python3 docs/probes/baseline/session_stats.py`, with five re-triggers in ADR-0005.

---

## Phase D0 — Discovery & Validation  ← CLOSED (G0 NO-GO, then reframed — see ADR-0007)
**Intent:** decide what/why/who/where with evidence, not vibes. No production code.

Work items: pin the baseline (Q-BASE-1/2/3 ✓) · answer `01-discovery.md` (★★★ first) · capture the
baseline numbers (`05-metrics.md` §1) · validate CRITICAL assumptions A-01, A-02, ~~A-03~~ (BUSTED as
stated — message-injection obsolete), A-07, A-08, **A-11, ~~A-12~~ (VALIDATED 2026-08-09), A-13**
(A-04 **is** descoped from the MVP per ADR-0004 → ACCEPTED-UNVALIDATED; A-07 narrows to "what does the
selection layer actually need, if anything?") · ~~scout pass on `04-landscape.md`~~ (**done 2026-08-09** —
matrix and scout log filled; R-06 trigger fired) · decide ADR-0001/0002/0003 · ~~accept ADR-0004~~
(**Accepted 2026-08-09**) · fill targets M1–M7.

**Updated 2026-08-09 by ADR-0004 (MVP cutline = staged measure-then-mount).** The remaining D0 work
*is* Stage A, and it is legal in D0 because it is measurement-only code under `docs/probes/`:

**Revised again 2026-08-09** after the critic/scout evidence pass. Work items are ordered so the cheapest
kill tests run first — three of them cost hours or nothing and can spare the rest of the campaign:

| # | Stage A work item | Probe location | Unblocks |
| :--- | :--- | :--- | :--- |
| 0a | **Repair the trace schema to v2 before writing code** (`active_tools_after`, `cache_miss_cause`, session/branch id, model+provider id, catalog hash, tool-call outcomes, prefill/TTFT split, `no_search_this_turn`, inter-turn gap) | design only — `05-metrics.md` §3a | R-04; makes R-01 diagnosable at all. Trace schemas can't change once users have data |
| 0b | **Grep pi's config schema for an existing tool allowlist/enable-disable** (~20 min) | `docs/probes/A-13/` | A-13; may show static profiles already ship → could delete part of Stage B |
| 0c | **The spreadsheet kill test**: A-02 break-even `S > 11.5·c·C` with measured B1/B3 | `docs/probes/A-02/` | Q-KILL-1's cheapest path; can disqualify mounting before any code |
| 1 | Trace instrumentation of an unmodified pi session — **event-bus subscriber, not telemetry spans** (no CLI hook for a `TelemetryContext`); writer must be async, bounded, non-throwing, opt-in, redacting | `docs/probes/baseline/` | B2/B3/B5/B6; R-18; the schema itself |
| 2 | B1–B10 capture on the user's own catalog **and ≥1 non-author catalog**, reported per-catalog | `docs/probes/baseline/` | baseline report; R-13 |
| 3 | B7 scaling curve — **≥100 tools**, with a real-catalog arm beside the synthetic one, **and the A-13 control arms** (static profiles; model picks from names+one-liners) | `docs/probes/A-01/` | A-01; Q-WHY-2; Q-WHAT-4; A-13 |
| 4 | Cache-aware cost model — **parameterized by inter-turn think time and reported per provider class** | `docs/probes/A-02/` | A-02; R-14; R-15; M1 target |
| 5 | `setActiveTools` persistence: grep the live session JSONL for `active_tools_change`, resume, then `/compact` and re-check the `tools` array | `docs/probes/A-11/` | A-11; Stage B feasibility |
| 6 | Retrieval eval: recall@5 for BM25 vs. embeddings vs. **brute-force cosine** vs. **names-list**, one fixed ≥30-query set | `docs/probes/A-05/` | A-05; A-07; A-13; ADR-0002's backend choice |
| ~~7~~ | ~~Does the event bus expose cached tokens?~~ | — | **Done 2026-08-09** — A-12 VALIDATED from source; `pi.ai.deferred` also found as a free R-01 observable |

**The numeric knee threshold that would justify Stage B must be written into the baseline report
plan BEFORE the data is collected** (R-12's forcing function). Stage A's exit is a decision —
proceed to Stage B / park per O6 / adjust — not a report.

**Stage B is production code and therefore lands after G1, not in D0.** It is the D2 walking skeleton,
not a D0 deliverable — and per ADR-0004's amendments its *shape* (search index vs. capability index vs.
static profiles) is decided by Stage A's control-arm data, not assumed now.

### Gate G0 — go/no-go on the initiative → **NO-GO, PARKED 2026-08-09**
- [~] All ★★★ questions ANSWERED — **PARTIAL** (9/12; Q-HOW-1/Q-HOW-2 never set, moot on a park)
- [x] Baseline report exists in `gate-reports/` — `baseline-2026-08-09.md` (partial by design: Gate 0 only)
- [x] CRITICAL assumptions VALIDATED / BUSTED / ACCEPTED-UNVALIDATED (no silent UNVALIDATED) — A-02 BUSTED, A-03 BUSTED-as-stated, A-12 VALIDATED, A-04 ACCEPTED-UNVALIDATED; the rest carry evidence + reason work stopped
- [ ] ADR-0001, ADR-0002, ADR-0003 status = Accepted — **still Proposed; moot on a park.** ADR-0004 Accepted then **Superseded by ADR-0005**
- [ ] Metric targets M1–M7 filled from Q-HOW answers — **not filled; moot** (only M3 gained a ceiling)
- [x] **Kill check: Q-KILL-1 evidence reviewed — explicit decision NOT to proceed (ADR-0005).** This is the item that decided the gate
- **Output:** `gate-reports/G0-2026-08-09.md` — **NO-GO / PARKED**

---

## Phase D1 — Design Specs (the blueprint's Developer Directives 1–4)
**Intent:** turn validated answers into reviewable specs. Still no production code.
Outputs land in `docs/specs/YYYY-MM-DD-<artifact>-design.md`, via `/spec`.

| Artifact (`/spec <name>`) | Contents | Done means |
| :--- | :--- | :--- |
| `contracts` | Top Agent ↔ Orchestrator JSON interfaces; the trace-event schema from `05-metrics.md` §3; error/stale-call semantics | architecture-critic reviewed; every message has a schema + example; budgets attached |
| `registry` | Data model for the hybrid registry honoring ADR-0002 — tool record: id, name, tags, semantic description, JSON Schema; bundles; source-of-truth + reindex triggers (Q-WHERE-3, R-07) | retrieval eval plan included (A-05 method) |
| `lifecycle` | Eviction state machine: states, transitions, TURN_BASED/AUTONOMOUS/TIMEOUT (or the single policy A-06 justifies), stale-call recovery, thrash guard | state diagram + exhaustive transition table; M5/M6 test plan |
| `scaffolding` | Directory/package layout per ADR-0003 (module vs. service vs. library), dev-loop story, integration path into the baseline agent | buildable-tomorrow concreteness; no capability without an owning spec |

### Gate G1 — design freeze, code unlock
- [ ] Four specs exist, each with budgets (M-targets) and a test/eval plan
- [ ] architecture-critic adversarial review recorded per spec (concerns + dispositions)
- [ ] Risk register re-reviewed; no unmitigated H×H
- [ ] MVP cutline restated in one sentence at the top of each spec (Q-WHAT-2)
- **Output:** `gate-reports/G1-YYYY-MM-DD.md` — passing G1 lifts the no-production-code rule

---

## Phase D2 — Walking Skeleton (first code) = **ADR-0004 Stage B**
Per ADR-0004 the skeleton is narrower than originally seeded: **search → mount → call**, with
**no eviction** (mounts are monotonic/append-only within a session, which is R-01's design-level
mitigation). One pi extension exposing a single always-mounted `search_tools(query)` meta-tool,
behind a config flag, emitting the same trace event Stage A already emits — so before/after numbers
come from identical instrumentation. Measured against the Stage A baseline (M1–M4, M6) on the fixed
goal set, on ≥2 catalogs. Must also measure **R-11 (under-search)**: % of goals requiring an
unmounted tool where a search call actually occurred — and decide Q-WHAT-4 (compact capability index
or not) before shipping.
**Exit:** metrics report vs. targets; explicit decision: proceed / adjust / kill (Q-KILL-2).

## Phase D3 — Aggregation & Policies
Aggregator flow (if A-04 validated), bundles, remaining eviction modes (if A-06 justified them),
approval/decision gating where tool calls are sensitive.

## Phase D4 — Observability & Hardening
Dashboards/reports for mount lifecycle and token savings, failure-mode drills (R-03/R-05
scenarios), integration docs for a second consumer if ADR-0003 chose the extraction path.

---

## Standing cadence
At every gate: refresh `04-landscape.md` (R-06), re-review risks, re-run the fixed goal set.
