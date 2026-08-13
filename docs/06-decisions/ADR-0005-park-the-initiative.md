# ADR-0005: Park the initiative — measured economics do not support JIT tool mounting

**Date:** 2026-08-09
**Status:** Accepted (user decision, 2026-08-09, on measured evidence)
**Supersedes:** ADR-0004 (MVP cutline). ADR-0004's Stage A *executed and worked* — it produced the
evidence that selects this outcome. Its Stage B is cancelled.
**Driver:** Q-KILL-1 (economic kill path fired) · A-02 (BUSTED for the measured catalog) · A-13 (control
arm wins) · `docs/archive/gate-reports/baseline-2026-08-09.md` · risks R-01, R-13

## Context

ADR-0004 sequenced the MVP as "measure first, then ship a selection layer", with a pre-committed
decision rule in `05-metrics.md` §2a whose **Gate 0** was the cheapest test: evaluate A-02's break-even
inequality against a measured catalog before writing anything. That gate ran on 2026-08-09 against the
user's real pi history — 82 session files, 46 project scopes, 1,956 tool calls, $76.12 of actual spend,
at zero cost, because pi persists per-message `usage` (including `cacheRead`/`cacheWrite`/`cost`)
directly in its session JSONL.

**It failed by an order of magnitude, in every parameter bracket.**

| Measured | Value |
| :--- | :--- |
| Catalog size (B1) | **≈ 20 tools** |
| Tools ever used | 11 |
| Distinct tools per session (B9) | p50 **3** · p90 **4** · max 10 |
| bash + read + write + edit | **98.1% of all tool calls** |
| Per-request context (C) | p50 **49,964** tokens · p90 223,217 |
| Prompt cache read : write | **114 : 1** — 91.1% of prompt tokens served from cache |

Against `S > 11.5 · c · C`: savable tool-definition tokens are 2,250–6,000, against a requirement of
~28,700 at the most generous churn rate tested (c = 0.05). **JIT mounting loses by 5×–102×; no cell
pays.** In dollars, one mount event costs $0.187 at median context — **4.2× the entire median session's
total cost of $0.044**.

**Why it fails is more important than that it fails**, because it generalizes: the initiative was aiming
at the smaller term. Tool definitions are 4.5–12% of a request here. They sit at the **head** of the
cacheable prefix, which makes them *cheap to keep* (the cache serves them at read rates) and *expensive
to change* (any mutation invalidates everything downstream). History and file content are the large term,
sit at the **tail**, and are cheap to attack. A 114:1 cache read/write ratio means this workload is
already near the best case that "just cache the full catalog" can achieve — there is nothing for JIT
mounting to win.

Independently, A-13's control arm won outright: a **4-tool working set out of ~20** means pi's default
core tool set already *is* the correct static profile. There is no selection *problem* at this scale —
only a selection *cost*.

Two earlier findings had already thinned the opportunity before Gate 0 ran: pi **ships the
`search_tools` loader-tool recipe itself** with a worked example (0.80.7), and provider-native deferred
loading (Anthropic GA, OpenAI gpt-5.4+) covers the mounting mechanism — so R-06's convergence trigger had
already fired at both the provider and the substrate.

**Honest limit on this evidence (R-13):** it is a single catalog, and it is the author's own. It is
conclusive for this setup and silent about the OSS pi community that Q-WHO-1 named as the primary user.
The park is therefore a decision about *this* target, not a proof about everyone.

## Options considered

### Option 1 — Park with re-triggers **(CHOSEN)**
Stop now, on measured evidence, with named wake-up conditions and a working instrument to watch them.
**Buys:** the whole engineering cost avoided; the register makes resumption cheap; the D0 discipline gets
its intended payoff — a gate that could fail, did. **Costs:** the OSS contribution Q-WHO-1 envisaged does
not ship; the work is shelved while pi keeps moving (~15 minor versions per resumption cycle, R-22).
**Forecloses:** nothing permanently — every input is recorded.

### Option 2 — Re-baseline on the many-tool product agent
Q-WHY-1 pain #3 named an agent whose roadmap needs dozens-to-hundreds of tools; its planned catalog,
not this one, would be the relevant B1. **Buys:** tests the one scenario where the economics could
genuinely flip (above ~110 tools *and* in small-context sessions). **Costs:** requires that agent's tool
inventory to exist; deferring on a roadmap rather than a measurement is how R-08 starts.
**Not chosen** — recorded as a re-trigger instead, so it fires on a fact rather than an intention.

### Option 3 — Pivot to the big term (compress context/history rather than tool definitions)
What the data actually recommends: 135.6M cacheRead tokens and a 50k median context say history and file
content are where the money goes, and unlike tool definitions they are cache-friendly to compress
(appending a summary preserves the prefix). **Buys:** aims at the measured cost driver; the critic's F4
argues it is the only cache-positive intervention on the original option list. **Costs:** a different
project from the one this workspace was chartered for; pi already ships compaction, and ~10 pi
context-management packages exist, so the delta is unproven and the space is crowded.
**Not chosen now** — recorded below as the most promising direction if the topic is ever resumed.

### Option 4 — Survey other pi users' catalogs before deciding
**Buys:** would make the park definitive for the whole community rather than for one setup, directly
addressing R-13. **Costs:** more discovery spend on an initiative whose own author's catalog is 5× below
the viability threshold. **Not chosen** — folded into a re-trigger.

## Decision

**Park the DTCM initiative.** No Stage B, no D1 specs, no production code. The gated workspace closes at
D0 with a NO-GO recorded at G0 (`gate-reports/G0-2026-08-09.md`), and the reason is evidence, not
attrition: the cheapest pre-committed test in the plan fired and disqualified the thesis for the target
catalog by 5×–102×.

**For v1 this means** everything in Q-WHAT-3's cut list stays cut, and the two things that were *kept* —
the trace-event schema and the `search_tools` selection layer — are cut as well. What survives as
deliverable artifacts: the measurement probe (`docs/probes/baseline/`), the baseline report, and this
register.

## Consequences

**Positive**
- The engineering cost of a cost-negative feature is avoided entirely, on numbers rather than instinct.
- The D0 gate discipline is vindicated: a pre-committed threshold, written before the data, produced a
  falsification instead of a rationalization. This is R-12's forcing function working exactly as designed.
- Real transferable knowledge was produced: the break-even inequality `S > 11.5·c·C`, the head-of-prefix
  cache asymmetry, and the finding that *tool definitions are the small term* apply to any agent
  considering dynamic tool loading — not just to pi.
- A reusable, zero-cost instrument now exists that any pi user can run against their own history.

**Negative**
- Q-WHO-1's OSS contribution does not ship; the community gets nothing from this cycle.
- Resuming costs context re-establishment against a fast-moving substrate (R-22).
- The conclusion rests on one catalog (R-13) — it is possible that DTCM is viable for someone whose
  catalog we never measured, and the park accepts that risk knowingly.

**Deliberate non-goals from here**
The Orchestrator, the hybrid registry, the aggregator, the eviction policy engine, containerized
vector/KV services, message-injection mounting, tool bundles, sub-agent isolation, a standalone service,
and a second language. All were already cut for v1; the park makes them cut, full stop.

## Revisit trigger — with the instrument that watches it (critic F40: a park with no instrument has no wake-up call)

**The instrument is `docs/probes/baseline/session_stats.py`.** It is read-only, stdlib-only, zero-cost,
and reruns in seconds:

```bash
python3 docs/probes/baseline/session_stats.py            # your own history
python3 docs/probes/baseline/session_stats.py /other/sessions
```

Reopen this decision when the instrument (or a new fact) shows any of:

1. **Catalog crosses ~110 tools** while per-request context stays near today's ~50k — the point where
   `S > 11.5·c·C` can clear. Equivalently: tool definitions exceeding roughly a quarter of a typical
   request. Watch: rerun the probe after adding Pi Packages.
2. **A small-context, many-tool workload appears** — definitions dominate a request rather than being
   4.5–12% of it. The many-tool product agent from Q-WHY-1 pain #3 becoming real is the concrete case;
   its catalog inventory is the trigger, not its roadmap.
3. **p90 distinct-tools-per-session rises well above ~4 toward catalog size** — a genuine selection
   problem replacing today's selection *cost*.
4. **The cache economics invert** — cache read:write ratio collapsing from 114:1 (e.g. a workload with
   long idle gaps against a short TTL, per R-15), or pi/pi-ai losing native deferred loading (R-14).
5. **Someone else's measured catalog contradicts ours** — the R-13 escape hatch. If a real pi user's
   history shows a 150-tool catalog with a wide working set, the park was local, not general.

If resumed, **start from Option 3 (attack the context term), not from the blueprint** — that is where the
measured money is, and the blueprint's own priority ranking is what this evidence inverted.
