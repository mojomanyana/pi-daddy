# pi-daddy — capability governance for pi's multi-level agent system

## What This Project Is

**Capability governance for pi's multi-level agent system.** A top orchestrator holds a catalog of tools
and skills; when it delegates, it grants each sub-agent a deliberate subset and withholds the rest.
Sub-agents may delegate further, but only ever a subset of what they themselves hold. Enforced by pi's own
`--tools` allowlist, with an append-only ledger of grants and refusals.

**Reframed 2026-08-09 (ADR-0007).** The blueprint justified itself on *context bloat / token cost*, and
discovery took that as the goal — building a measurement programme that correctly falsified it at gate G0.
The actual goal was always **narrowing control over sub-agents**, which is what the blueprint's
*architecture* (Top Agent → Orchestrator → provisioning) described. Judge work on **control correctness**,
not on token savings. The name "Dynamic Tool & Context Management" describes the retired thesis.

**Renamed 2026-08-10.** The project is **pi-daddy**. "DTCM — Dynamic Tool & Context Management" named the
token-economics thesis that ADR-0007 retired, so it was replaced everywhere the name is *operational* —
this file, `README.md`, `docs/archive/GETTING-STARTED.md`, and everything under `.claude/`.

**"DTCM" is deliberately left intact in the historical record**: every ADR, `docs/03-risks.md`, and the
registers now under `docs/archive/` (`01-discovery.md`, `02-assumptions.md`, `04-landscape.md`,
`ROADMAP.md`). Those mentions *are* the retired thesis — "DTCM's MVP is staged", "park the DTCM initiative" — and rewriting them would erase the evidence
of the thing that was abandoned, which is the one thing those documents exist to preserve. **Do not
find-and-replace them.** A register entry describes what was believed on its date; renaming it makes the
record lie.

**Re-architected 2026-08-12 (ADR-0016).** Earlier versions were a governance layer wrapped around
`@tintinweb/pi-subagents` — a `tool_call` interceptor deciding whether *someone else's* spawn was
permissible, able to refuse or allow but never to narrow. **This package is now the spawner**, so the grant
is an argument rather than a veto. Definitions are **Agent Skills (`SKILL.md`)** files whose `allowed-tools`
becomes the grant; the pi-subagents ceiling port is deleted; the interceptor survives only as a tripwire.

**Current state: `pi-agent-grants` 0.11.1, `pi-token-audit` 0.1.0.** Twenty-three ADRs decided. 283 unit +
19 integration tests (+4 more with a real model), typecheck and smoke clean.

**What the product claims, precisely** — this wording is load-bearing and was narrowed by ADR-0012: it
governs the **tool surface**, i.e. which tools pi exposes to a model, enforced structurally by pi's own
`--tools` allowlist. It does **not** contain an agent holding an execution primitive: a child with `bash`
can run `env -u PI_GRANTS_GRANT pi …` and get an ungoverned descendant (measured —
`docs/probes/g5-bash-escape`). Containing that is the OS's job and is out of scope.

**`docs/SPEC.md` is the authoritative statement of what exists today.** Do not re-derive it from the ADRs.

## Where Things Live

```
docs/SPEC.md              — WHAT THE PRODUCT IS, current state, no history. Read this second.
docs/SESSION-LOG.md       — START HERE when resuming: state, verified facts, next actions. Newest on top.
docs/03-risks.md          — live risk register. R-25 onward are current; R-01..R-24 serve the retired thesis
docs/06-decisions/        — twenty-three ADRs. Reversals are kept and marked: 0004→superseded, 0005 park→
                            superseded, 0006 (magnitude claim falsified), 0007 THE REFRAME, 0008
                            attenuation + cardinality, 0009 pi-fabric (parked), 0010 approvals, 0011
                            universal capabilities, 0012 bash, 0013 pi-subagents (superseded by 0016),
                            0014 approval integrity, 0015 which path is primary (declined to decide, and
                            says why), 0016 THIS PACKAGE IS THE SPAWNER — the current architecture,
                            0017 agent:<name> authorises a definition, 0018 the ledger records WHICH
                            instructions ran, 0019 the persisted-approval store made reachable again,
                            0020-0023 the first red-team pass: per-project approval files, the task is
                            never stored, an inherited approval names its instructions, and agent:*
docs/probes/              — measurement evidence, all against real software. Each has a "what this does
                            not establish" section: baseline/, pi-fabric-eval/, approval-ux/,
                            adr-0011-universal/, g1-argv/, g5-bash-escape/, g13-subagents-coupling/,
                            g16-herdr/ (herdr as an executor + four constraints found by building it)
docs/00-blueprint.md      — the architecture handoff, verbatim (immutable source input)
docs/archive/             — SUPERSEDED, kept as evidence, never edited to match today. The retired-thesis
                            registers (discovery, assumptions, landscape, metrics), ROADMAP, gate reports,
                            both code reviews, the old specs, the completed implementation plan, and the
                            dead upstream proposal. See its README for why each stopped being current.
packages/pi-agent-grants  — THE PRODUCT (0.7.0): SKILL.md definitions, resolver, ledger, delegate +
                            delegate_all, catalog, human approval, two executors (process | herdr pane)
packages/pi-token-audit   — token/cost audit (0.1.0). ITS HEADLINE NUMBER IS WRONG: the "tool-definition
                            share" is a character ratio, not a token share (falsified 2026-08-10, G10)
```

## How To Work Here

- `/adr <title>` — create or progress a decision record. **The workhorse; use it for anything that
  changes what the product claims.**
- `/brainstorm <topic>` — option generation plus a strategist/critic stress-test on one topic.

Subagents: `product-strategist`, `architecture-critic`, `research-scout` (advisory only; they never edit).

**`/kickoff`, `/validate`, `/gate` and `/spec` were removed on 2026-08-11.** They drove the discovery
programme ADR-0007 retired — `/kickoff` would have interviewed you about a falsified thesis and `/spec`
refuses until a gate passes that no longer means anything. They are in git history if ever needed.

```bash
cd packages/pi-agent-grants
npm test                   # 250 unit tests — fast, pure, no pi, no network
npm run typecheck          # src + extensions + tests + integration tests
npm run test:integration   # 9 tests vs a REAL pi process — ~20s, no model tokens
npm run test:smoke         # pack, install into a scratch project, import and USE it
PI_GRANTS_IT_MODEL=1 npm run test:integration   # + 3 end-to-end with a real model (~60s, costs money)
```

## Hard Rules

- **The phase-gate rule is RETIRED** — two packages shipped under recorded waivers. `.claude/rules/phase-gates.md`
  keeps the filename so links resolve, and its live rules (documentation, evidence and terminology
  discipline) are the ones that carried this project. Probes still go only under `docs/probes/`.
- **Files are the memory.** Decisions → ADRs; current state → `docs/SPEC.md`; failure modes →
  `docs/03-risks.md`; measurements → `docs/probes/`. An answer that exists only in chat does not exist.
- **The blueprint is immutable.** `docs/00-blueprint.md` is source input; disagreement is recorded
  beside it, never edited into it.
- **Terminology:** "workflow skills" = `.claude/skills/` (process tooling for this workspace).
  The agent-runtime tools/skills this project will eventually manage are called "tools" or
  "runtime skills" in specs — never bare "skills" where it could be ambiguous.

## Start Here

1. **`docs/SESSION-LOG.md`** — newest entry on top. Current state and **`## NEXT SESSION`**, the ranked list
   of what is actually left.
2. **`docs/SPEC.md`** — what the product is, precisely, with no history. This is the one to trust about
   present behaviour; do not re-derive it from the ADRs.
3. **`ADR-0016`** (this package is the spawner) → **`ADR-0008`** (the invariant + its cardinality
   companion) → **`ADR-0012`** (why `bash` is out of scope).

**Do not start from `docs/archive/`.** Everything in there is superseded and kept only as evidence — the
discovery questions, assumptions register, landscape, metrics, ROADMAP and both code reviews all serve the
token-economics thesis ADR-0007 retired. Its README says why each stopped being current.

**Facts established by measurement; re-deriving them wastes a session.**

*About pi:*
- Default tool surface is only `read, bash, edit, write`. There is **no native subagent tool** in pi core.
- `--tools` / `--no-tools` **hard-enforce**, including against `-e`-loaded extension tools. **This is the
  enforcement point**, and it is the reason no runtime is needed inside a descendant.
- `bash` subsumes the file/search tools, so a grant containing it is not narrow — and a child holding it
  can create a wholly **ungoverned** descendant (`docs/probes/g5-bash-escape`).
- A model-controlled string must never occupy an argv position pi parses: `@file` is read **before any
  tool exists**, so `--tools` cannot stop it (`docs/probes/g1-argv`).
- `AgentToolResult` has **no `isError` field**. pi sets it only when `execute` **throws**; a returned
  `isError: true` is silently discarded.
- `pi.getAllTools()` is available to an extension immediately; the first-provider-request tool array is not.
- Node refuses to strip types under `node_modules`, so library entry points must be compiled. **pi's own
  loader has no such limit** and reads extension TypeScript from `node_modules` fine.

- pi has **separate** switches for each resource class: `--no-extensions` does **not** disable skills,
  context files or prompt templates. Each needs its own flag, and `--skill` *adds* to the discovered set
  unless `--no-skills` is also passed (`docs/probes/g16-herdr`).
- `--append-system-prompt` accepts **either literal text or a file path**.

*About herdr (0.7.5) — the executor:*
- `herdr agent start … -- <args>` delivers argv **verbatim**, and `--tools` is enforced inside a pane
  exactly as for a direct spawn.
- It has **no `--env`**; the environment goes on the **pane** (`tab create --env`), which the agent's shell
  inherits. That is how the grant propagates on this path.
- `agent start` **types argv into a shell**, so a multi-line argument is refused outright — a definition's
  body must be staged to a file.
- `agent wait --until idle` matches the state the agent was **already** in, so settling must require a
  state counter to advance. Everything in `docs/probes/g16-herdr`.

*About `@tintinweb/pi-subagents` (measured at 0.14.3 and 0.15.0) — NO LONGER A DEPENDENCY (ADR-0016):*
- `SpawnOptions` has **no `tools` field** and the RPC is `ping`/`spawn`/`stop`, so an interceptor there can
  **refuse or allow, never narrow**. That ceiling is why this package became the spawner instead.
- `subagents:rpc:spawn` **bypasses `tool_call` entirely**, so the tripwire cannot see those spawns.
- Its children are **in-process**, so they share one `process.env` — unlike ours.

*About `pi-fabric` (evaluated, not installed):*
- `recursive: true` overrides `tools: []` *and* `extensions: false`, so recursion and containment are
  mutually exclusive there.
