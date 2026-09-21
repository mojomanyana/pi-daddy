# pi-daddy — orientation

## What this is

pi-daddy governs and coordinates pi's multi-level agent system. An orchestrator holds a catalog of tools and
Agent Skills definitions; when it delegates, each child receives a deliberate subset and nothing more, and a
child may delegate further only a subset of what it holds. Enforcement is pi's own `--tools` allowlist on a
separate child process, with an append-only ledger of every grant and refusal. What it governs is the
**tool surface**; a child holding `bash` can still escape, and containing that is the operating system's
job (ADR-0012, measured in `docs/probes/g5-bash-escape`).

The product is being consolidated under **ADR-0076** into five source layers, one ledger, one state
directory and one environment prefix, followed by context handoff to children. Read that ADR for the
programme and its checklist; do not infer the target shape from the current directory listing.

**Terminology is in `docs/GLOSSARY.md`.** If a noun in any document is not obvious, look there before
reading history.

## Where things live

```
docs/SESSION-LOG.md       — START HERE when resuming: state and NEXT SESSION, newest entry on top
docs/SPEC.md              — what the product is today, present tense; if code and SPEC disagree, fix the SPEC claim
docs/GLOSSARY.md          — every term, one line each
docs/06-decisions/        — ADRs; reversals are kept and marked. 0016 is the architecture (this package is the
                            spawner), 0008 the attenuation invariant, 0012 why bash is out of scope, 0076 the
                            consolidation programme
docs/03-risks.md          — live risk register; R-25 onward are current, R-01..R-24 served the retired thesis
docs/probes/              — measurements against real software, each with a "what this does not establish" section
docs/WORKING-RULES.md     — the ten working rules; rule 10 governs how main is advanced
docs/00-blueprint.md      — the original handoff, immutable source input
docs/archive/             — superseded, kept as evidence, never edited to match today; do not start here
hooks/pre-commit          — refuses a commit on main; wire it per clone with `git config core.hooksPath hooks`
packages/pi-daddy/        — the product (source, extensions, contracts, tests)
```

## Hard rules

- **`main` is only ever advanced by merging a pull request.** Check the branch before the first edit of a
  task, not before the commit. Recovery for work already on `main` is in rule 10 of
  `docs/WORKING-RULES.md`; it is not a force-push.
- **Files are the memory.** Decisions go in ADRs, current state in `docs/SPEC.md`, failure modes in
  `docs/03-risks.md`, measurements in `docs/probes/`. An answer that exists only in chat does not exist.
- **Reversals are recorded, never rewritten.** A dated document says what was believed on its date. Add a
  dated note; do not revise. "DTCM" stays in every historical document because it is the evidence of the
  thesis ADR-0007 retired. Do not find-and-replace it.
- **The blueprint is immutable.** Disagreement is recorded beside it.
- **Measure before asserting, and say which you did.** When a fix advertises a property, add the check that
  forces it in the same commit, or do not write the claim. Two review passes here found every critical
  defect to be a claim written beside a fix rather than a fix.
- **Counts and versions do not belong in orientation documents.** They were wrong within days every time.
  Ask the commands.
- **Terminology:** "workflow skills" are `.claude/skills/` (local-only process tooling). The runtime
  tools and skills this project governs are "tools" or "runtime skills", never bare "skills" where
  ambiguous.

## Working here

`.claude/` is gitignored, so everything in it is local-only and nothing there is required. Locally:
`/adr <title>` creates or progresses a decision record; `/brainstorm <topic>` runs option generation with
the `product-strategist` and `architecture-critic` subagents, which are advisory and never edit.

**This clone is shared with other sessions.** Another session can switch the checked-out branch under you.
Print `git rev-parse HEAD` in the same command as any measurement you intend to write down, or take a
worktree.

```bash
cd packages/pi-daddy
npm test                   # unit tests, fast, no pi, no network (the branch guard spawns git)
npm run typecheck          # src + extensions + tests + integration tests
npm run format:check       # from the repository root: Prettier, width 120, enforced in CI
npm run test:integration   # against a REAL pi process and a real Herdr server, no model tokens
npm run test:smoke         # pack, install into a scratch project, import and use it
PI_GRANTS_IT_MODEL=1 npm run test:integration   # adds an end-to-end tier with a real model (costs money)
PI_GRANTS_KEEP_TMP=1 npm test                   # keep fixture directories after a failure
```

Mutation-testing machinery was removed by explicit user direction on 2026-09-07; historical audit records
are evidence, not a requirement to restore it.

## Facts established by measurement

Re-deriving these wastes a session. Each has a probe under `docs/probes/`.

*About pi:*
- Default tool surface is `read, bash, edit, write`; there is no native subagent tool in pi core, only a
  bundled example extension.
- `--tools` and `--no-tools` hard-enforce, including against `-e`-loaded extension tools. This is the
  enforcement point and why no runtime is needed inside a descendant.
- `bash` subsumes the file and search tools, and a child holding it can create an ungoverned descendant.
- A model-controlled string must never occupy an argv position pi parses: `@file` is read before any tool
  exists, so `--tools` cannot stop it (`docs/probes/g1-argv`). The task is passed with a leading space.
- `AgentToolResult` has no `isError` field; pi sets it only when `execute` throws. A returned
  `isError: true` is silently discarded, so every refusal here is thrown.
- `pi.getAllTools()` is available to an extension immediately; the first-provider-request tool array is not.
- pi has separate switches per resource class: `--no-extensions` does not disable skills, context files or
  prompt templates. `--skill` adds to the discovered set unless `--no-skills` is also passed.
- `--append-system-prompt` accepts literal text or a file path. pi also offers `--fork <session>`,
  `--session <path>`, `ctx.fork()` and `ctx.compact()`, which ADR-0076's context handoff builds on.
- Node refuses to strip types under `node_modules`, so library entry points must be compiled; pi's own
  loader reads extension TypeScript from `node_modules` fine.

*About Herdr (the executor):*
- `herdr agent start … -- <args>` delivers argv verbatim; `--tools` is enforced inside a pane exactly as for
  a direct spawn.
- It has no `--env`; the environment goes on the pane (`tab create --env`), which the agent's shell
  inherits. That is how the grant propagates on this path.
- `agent start` types argv into a shell, so a multi-line argument is refused; a definition body must be
  staged to a file.
- `agent wait --until idle` matches the state the agent was already in, so settling must require a state
  counter to advance (`docs/probes/g16-herdr`).

*About `@tintinweb/pi-subagents` (no longer a dependency, ADR-0016):*
- Its `SpawnOptions` has no `tools` field and its RPC is `ping`/`spawn`/`stop`, so an interceptor there can
  refuse or allow but never narrow. That ceiling is why this package became the spawner.
- `subagents:rpc:spawn` bypasses `tool_call` entirely, and its children are in-process and share one
  `process.env`.

*About `pi-fabric` (evaluated, not installed):*
- `recursive: true` overrides `tools: []` and `extensions: false`, so recursion and containment are mutually
  exclusive there.

*About the field (surveyed 2026-09-21, sources in ADR-0076):*
- No other harness enforces child ⊆ parent on the tool surface, and Claude Code's own documentation says a
  skill's `allowed-tools` does not restrict. That differentiator is intact. Every surveyed competitor offers
  a richer context channel than this package does today; ADR-0076 is the response.
