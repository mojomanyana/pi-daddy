# pi-daddy — capability governance for pi's multi-level agent system

**Status:** 🔧 **BUILDING** — reframed to capability governance; two packages shipped under scoped gate waivers
**Started:** 2026-08-08 · **Reframed:** 2026-08-09 (ADR-0007)
**Source input:** `docs/00-blueprint.md` (architecture handoff — tested; its stated *justification* did not hold, its *architecture* did)

> ## What this is, in one paragraph
>
> **A capability-governance layer for pi's multi-level agent system.** A top orchestrator holds a catalog
> of tools; when it delegates, it hands each sub-agent exactly the subset it should have and withholds the
> rest. Sub-agents may delegate further, but only ever a subset of what they themselves hold — enforced by
> **pi's own `--tools` allowlist**, so the guarantee is structural rather than advisory. Every grant and
> every refusal is recorded. Token savings are a side effect, not the goal.
>
> **The name is now wrong.** "Dynamic Tool & Context Management" describes the thing this project stopped
> building; something like *pi-capability-governance* would match reality.

## How it got here (the short version — the ADRs have the long one)

The blueprint justified itself on **context bloat**: too many tool definitions, too many tokens. Discovery
took that as the goal, pinned the substrate (Mario Zechner's **pi**, TypeScript, MIT), and ran a
pre-committed economic test against **82 real pi sessions** ($76.12 of actual spend). It failed decisively —
tool definitions are 4.5–12% of a long session's context, cheap to keep because the cache serves them and
expensive to change because they sit at the head of the cacheable prefix. **The project was aiming at the
smaller term**, and G0 returned NO-GO.

Then the user supplied the missing context: the goal was never token cost. It was **narrowing control over
sub-agents in a multi-level system** — which is what the blueprint's *architecture* (Top Agent →
Orchestrator → provisioning) was always about. ADR-0007 records the reframe, including that risk **R-17**
had written the desired feature down as a hazard.

The economic findings survive as knowledge rather than as a verdict: the break-even inequality
`S > 11.5·c·C` and the head-of-prefix cache asymmetry.

> **A third finding did not survive.** A "measured fresh-session figure of 72% of prompt tokens spent on
> tool definitions" was reported here until 2026-08-10. It is **not a token measurement**: `promptTokens`
> cancels out of the calculation, leaving `toolChars / payloadChars` — a character ratio, confirmed as
> such across a 72× swing in token count (review finding A-C4). It is recorded in `docs/SESSION-LOG.md`
> and `ADR-0007` with the same note, and it is partly load-bearing for **ADR-0006**. Fixing the
> instrument that produced it is group **G10** of the review backlog.

## What exists now

| Package | What it does |
| :--- | :--- |
| `packages/pi-agent-grants` **0.2.0** | The product. Grant resolver (the invariant, exhaustively tested), append-only ledger, spawn planner, a `tool_call` interceptor governing `pi-subagents` spawns, and a `delegate` tool for dynamic provisioning. 63 tests; verified live against real pi in five scenarios. |
| `packages/pi-token-audit` **0.1.0** | Reports where tokens and money went, including the tool-definition share pi does not expose. Self-calibrating chars-per-token, measured per turn rather than assumed. |
| `docs/probes/baseline/` | Zero-cost analyser for pi session history — anyone can run it on their own catalog. |
| `docs/probes/pi-fabric-eval/` | Eleven probes establishing that in `pi-fabric`, recursion and containment are mutually exclusive by construction. |

## How to work it (from Claude Code)

Open Claude Code at this folder's root and use the workflow skills:

| Command | What it does |
| :--- | :--- |
| `/kickoff` | Reads the project state, picks the highest-leverage open questions, interviews you, records answers into these docs. |
| `/brainstorm <topic>` | Structured divergence on one topic (e.g. "registry storage"), using the strategist + critic subagents, converging on 2–3 candidates. |
| `/validate <A-ID>` | Runs the validation method for one assumption from `docs/02-assumptions.md` and updates its status with evidence. |
| `/adr <title>` | Opens a new decision record in `docs/06-decisions/`. |
| `/gate` | Checks the current phase's exit criteria and writes a go/no-go report to `docs/gate-reports/`. |
| `/spec <artifact>` | Phase D1 only (refuses before G0 passes). Produces one of the blueprint's four design artifacts into `docs/specs/`. |

Three subagents assist: **product-strategist** (challenges why/who/value), **architecture-critic**
(red-teams designs against cache economics, latency, and failure modes), and **research-scout**
(current-state landscape research with sources).

## The operating loop

Brainstorm → Validate → Decide (ADR) → Gate → only then Spec → Gate → only then code.

Answers live in files, not in chat. If a session ends, the next session resumes from these
documents alone.

## Files

| File | Purpose |
| :--- | :--- |
| **`docs/SESSION-LOG.md`** | **Start here when resuming** — current state, verified facts, open decisions, next actions. |
| `docs/00-blueprint.md` | The handoff, verbatim. Immutable source input. |
| `docs/01-discovery.md` | The baseline/what/why/who/where question bank — the working document of Phase D0. |
| `docs/02-assumptions.md` | Every load-bearing claim, each with a validation method and status. |
| `docs/03-risks.md` | Risk register with early-warning triggers. |
| `docs/04-landscape.md` | Build-vs-leverage worksheet: what existing platforms already cover. |
| `docs/05-metrics.md` | Success metrics + the baseline measurement plan (measure before building). |
| `docs/06-decisions/` | Nine ADRs, reversals kept rather than tidied. **0004** MVP cutline (Superseded) · **0005** park (Superseded) · **0006** unpark + re-target · **0007** the reframe to capability governance · **0008** the monotonic-attenuation invariant · **0009** pi-fabric adopt-or-reject (**parked**, with a re-trigger). 0001–0003 remain Proposed. |
| `docs/probes/` | Measurement probes: `baseline/` (session-history analyser) and `pi-fabric-eval/` (capability-control evaluation). |
| `packages/` | Shipped code — `pi-agent-grants`, `pi-token-audit`. Exists under scoped gate waivers recorded in the G0 report. |
| `docs/ROADMAP.md` | Phases D0→D4 — **obsolete**, retained as a record; it was written for the retired token-economics thesis. |
| `docs/gate-reports/` | Output of `/gate` runs. |
| `docs/specs/` | (created in D1 by `/spec`) The four design artifacts. |

## Hard rules (enforced via `.claude/rules/phase-gates.md`)

1. **No production code before gate G1** — still the rule, and still enforced. Two **scoped waivers** are
   recorded in `docs/gate-reports/G0-2026-08-09.md`, each with the user's reason: one for `pi-token-audit`,
   one for `pi-agent-grants`. Everything else stays gated — no Orchestrator, no semantic registry, no
   retrieval layer, no eviction engine, no aggregator. Probes still go in `docs/probes/` only.
2. Every decision becomes an ADR. Every load-bearing claim gets an assumption ID. Every answer is
   written into these files.
3. `docs/00-blueprint.md` never gets edited. Disagreements with it become assumptions, risks, or ADRs.
