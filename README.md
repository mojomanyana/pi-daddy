# pi-daddy — capability governance for pi's multi-level agent system

**Status:** ✅ **SHIPPED AND HARDENED** — `pi-agent-grants` 0.6.0, `pi-token-audit` 0.1.0; all twelve
groups of the independent-review backlog closed
**Started:** 2026-08-08 · **Reframed:** 2026-08-09 (ADR-0007) · **Renamed:** 2026-08-10 · **Hardened:** 2026-08-11
**Source input:** `docs/00-blueprint.md` (architecture handoff — tested; its stated *justification* did not hold, its *architecture* did)

> ## What this is, in one paragraph
>
> **A capability-governance layer for pi's multi-level agent system.** A top orchestrator holds a catalog
> of tools; when it delegates, it hands each sub-agent exactly the subset it should have and withholds the
> rest. Sub-agents may delegate further, but only ever a subset of what they themselves hold — enforced by
> **pi's own `--tools` allowlist**, so the guarantee is structural rather than advisory. Every grant and
> every refusal is recorded. Token savings are a side effect, not the goal.
>
> **What it does not do**, stated as plainly as what it does (ADR-0012): it governs the **tool surface** —
> which tools pi exposes to a model. It does **not** contain an agent that holds an execution primitive. A
> child granted `bash` can start an ungoverned pi, measured in `docs/probes/g5-bash-escape`. Containing
> that is the operating system's job and is explicitly out of scope. `bash` is therefore **gated by
> default** in a governed session — which does not make the escape impossible, only impossible to hand
> over silently.

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
> and `ADR-0007` with the same note, and it is partly load-bearing for **ADR-0006**. **The instrument was
> corrected on 2026-08-11** (group G10): it now reports a character share and says so.

## What exists now

| Package | What it does |
| :--- | :--- |
| `packages/pi-agent-grants` **0.6.0** | The product. Grant resolver (the invariant, exhaustively tested), append-only ledger, spawn planner, a `tool_call` interceptor governing `pi-subagents` spawns, a `delegate` tool that provisions a real child process, human approval for gated capabilities, and bounded child execution. **222 unit + 8 integration + 3 model-driven tests**; installable, with a smoke test that packs and installs it. |
| `packages/pi-token-audit` **0.1.0** | Reports where tokens and money went, plus what share of a request is tool definitions — **by character**, which is the honest quantity; see the note above. |
| `docs/probes/` | Seven probe sets, all run against real pi. `g1-argv/` and `g5-bash-escape/` reproduce real vulnerabilities and their fixes; `g13-subagents-coupling/` establishes what cannot be governed locally and why. |

## How to work it (from Claude Code)

Open Claude Code at this folder's root and use the workflow skills:

| Command | What it does |
| :--- | :--- |
| `/adr <title>` | Opens or progresses a decision record in `docs/06-decisions/`. **The workhorse.** |
| `/brainstorm <topic>` | Structured divergence on one topic, using the strategist + critic subagents, converging on 2–3 candidates. |

Three subagents assist: **product-strategist** (challenges why/who/value), **architecture-critic**
(red-teams designs against failure modes and hidden costs), and **research-scout** (current-state
landscape research with sources). All three are advisory — they never edit files.

**`/kickoff`, `/validate`, `/gate` and `/spec` were removed on 2026-08-11.** They drove the discovery
programme ADR-0007 retired: `/kickoff` would interview you about a falsified thesis, and `/spec` refuses
until a gate passes that no longer means anything. Git history has them.

## The operating loop

Measure → Decide (ADR) → Test-first → Verify against real pi → Record what the evidence does *not* cover.

That last step is not decoration. Nearly every significant finding here contradicted careful reasoning —
children turned out to be in-process, a returned `isError` turned out to be discarded, a "token share"
turned out to be a character ratio — and each was caught by running something rather than by thinking
harder about it.

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
| `docs/06-decisions/` | **Fourteen ADRs**, reversals kept rather than tidied. **0004** MVP cutline (Superseded) · **0005** park (Superseded) · **0006** unpark + re-target (magnitude claim since falsified) · **0007** the reframe · **0008** the monotonic-attenuation invariant · **0009** pi-fabric (**parked**) · **0010** approval semantics · **0011** universal capabilities · **0012** `bash` is a governance hole · **0013** the `pi-subagents` reality gap · **0014** approval-store integrity. 0001–0003 remain Proposed. |
| `docs/reviews/` | Two independent whole-codebase reviews and their cross-referenced aggregate — a twelve-group backlog, **all twelve now closed**. The rationale for most of the hardening. |
| `docs/proposals/` | `pi-subagents-tools-parameter.md` — drafted for the user to file upstream. |
| `docs/probes/` | Measurement probes, each with a "what this does not establish" section. |
| `packages/` | Shipped code. Exists under scoped gate waivers recorded in the G0 report. |
| `docs/ROADMAP.md` | Phases D0→D4 — **obsolete**, retained as a record; written for the retired thesis. |
| `docs/gate-reports/` | The G0 verdict and the baseline report; the G0 report records both waivers. |
| `docs/specs/` | The capability-governance design artifacts. Predate ADRs 0012–0014 — read those first. |

## Hard rules (enforced via `.claude/rules/phase-gates.md`)

1. ~~**No production code before gate G1**~~ — **retired 2026-08-11.** Two packages shipped under scoped
   waivers recorded in `docs/gate-reports/G0-2026-08-09.md`, and the phase plan the gates belonged to is
   obsolete. A rule forbidding what the repository already contains protects nothing. The *documentation*
   and *evidence* disciplines that actually carried the project are now the live rules — see
   `.claude/rules/phase-gates.md`.
2. Every decision becomes an ADR. Every load-bearing claim gets an assumption ID. Every answer is
   written into these files.
3. `docs/00-blueprint.md` never gets edited. Disagreements with it become assumptions, risks, or ADRs.
