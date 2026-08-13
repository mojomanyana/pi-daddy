# ADR-0016: pi-daddy is the spawner, not a fence — on pi core, herdr, and Agent Skills

**Date:** 2026-08-12
**Status:** Accepted
**Driver:** the user's direction, given twice and unambiguously: *"reconsider all of this without
pi-subagents or any other third party plugin or skill aside pi-daddy … and my own set of
skills/sub-agents in principal-pi-skills"*, *"herdr is a must"*, and *"I am willing to refactor my
principal-pi-skills to support what is needed but I would prefer we implement some widely adopted
standard on this topic"*. Supersedes most of ADR-0013 and reframes ADR-0015. Evidence:
`docs/probes/g16-herdr`.

## Context

**The supported world is now exactly four things:** pi core (0.84.1), `pi-agent-grants` (this package),
`principal-pi-skills` (the user's own skills and agent definitions), and **herdr** (0.7.5) as the
execution substrate. No third-party pi extension is in the trust path — not `@tintinweb/pi-subagents`,
not `@andrewjacop/pi-herdr`.

**Three consequences follow immediately, and they are large.**

1. **pi core has no subagent tool.** With pi-subagents gone, nothing spawns anything unless this package
   does. `delegate` is not *a* path; it is *the* path.
2. **The interceptor fires on nothing.** `SPAWN_TOOLS` is `{"Agent", "subagent", "spawn_agent"}` — all
   three are pi-subagents' tool names. The `tool_call` hook, the ported ceiling rules, and ADR-0013's
   entire subject matter address a package that is no longer installed. **R-28, fixed earlier today, lived
   on that path**; its fix now serves only the `/grants` diagnostic.
3. **The user's agent definitions are inert.** `agents/*.md` in `principal-pi-skills` use pi-subagents'
   frontmatter, and the only thing left that parses it is `src/agent-types.ts`. Meanwhile `delegate`
   cannot read them at all: `DelegationRequest` is `{task, tools[], model, provider, thinking}` — an
   explicit tool list, chosen by the model, with no notion of a named agent.

So the package is one feature away from being the runtime for definitions that currently have no runtime.

**Measured this session** (`docs/probes/g16-herdr`), because the substrate had to be verified before being
built on:

- herdr runs on WSL2 — it hosts the user's entire live workspace. The "Linux unverified" warning attaches
  to the `pi-herdr` extension, which this decision does not use.
- `herdr agent start <NAME> --kind pi --pane <ID> -- <args>` delivers argv **verbatim**, echoed back in
  the reply. This is the property everything below rests on: the grant is argv *we* construct, with no
  model-facing parameter between `planSpawn` and the process.
- `--tools read` is **enforced inside a pane**; `--no-tools` yields no tools at all. A pane is an ordinary
  pi process — herdr supplies the terminal, not the runtime.
- **`--no-extensions` does not disable skills or context files** (R-32). A child spawned with `--tools
  read` still loaded all eight of the operator's skills and `CLAUDE.md`. This is a defect in the shipped
  product, not a property of herdr.
- `herdr agent wait --until idle` matches the **pre-existing** idle state (R-33), so a naive harvest can
  merge N empty results.

**On standards.** For skills there is a real, widely adopted one: **Agent Skills** (`SKILL.md`), open since
December 2025 at agentskills.io, supported by 16+ tools within three months, and already followed by
`principal-pi-skills`. Its complete frontmatter is `name` and `description` (required), plus `license`,
`compatibility`, `metadata`, and `allowed-tools`. For *subagent* definitions **there is no ratified
standard** — the de-facto convention is Claude Code's `.claude/agents/*.md`, which pi-subagents copied and
which the user already uses. Adopting "a standard" there would mean adopting what already exists.

The decisive detail is in `allowed-tools`. The spec calls it *"a space-separated string of tools that are
**pre-approved** to run"*, marks it **experimental**, and implementations diverge — some enforce it, others
silently ignore it. **It declares intent and blocks nothing.** That is precisely the gap this project
exists to fill.

## Options considered

### Option 1 — Keep the pi-subagents frontmatter as our definition format
**Buys** zero refactoring; the user's files work unchanged, and `ceilingFor` already implements the rules.
**Costs** carrying a faithful port of a package we no longer install, with a *permissive* failure direction
and no drift tripwire (R-31, whose trigger has already fired). We would be maintaining compatibility with
someone else's resolution semantics for no remaining reason. **Forecloses** the interop the user asked for.

### Option 2 — Invent a pi-daddy definition format
**Buys** exact fit: we could express gating, depth, delegation rights and skill scoping as first-class
fields. **Costs** a bespoke format nobody else reads, in a project whose author explicitly asked for a
widely adopted one, and it would strand `principal-pi-skills` outside the 16-tool ecosystem it currently
sits in. **Rejected on the user's stated preference**, which is also the better engineering call.

### Option 3 — Agent Skills (`SKILL.md`) as the single definition format; a subagent is a skill you spawn
**Buys** the standard, and it collapses a duplication the user's own framework already strains against:
`principal-pi-skills` deliberately makes `plan`/`review`/`debug` **dual-use** — a loaded skill *and* a
subagent system prompt, rendered from one contract precisely so the two cannot drift. With pi's
`--append-system-prompt`, that duplication stops being necessary: the `SKILL.md` body becomes the child's
system prompt and `allowed-tools` becomes its grant. `agents/*.md` need not exist as a parallel format.
**Costs** a refactor of `principal-pi-skills` (offered), and a mapping problem — see the Decision.
**Forecloses** nothing: `metadata` is the spec's sanctioned extension point for anything it lacks.

### Option 4 — Keep the interceptor as a full fence anyway
**Buys** protection if pi-subagents is ever installed. **Costs** maintaining the ported ceiling rules and
their drift risk for a package that is not present. **Partially adopted** — see Decision point 5, which
keeps a *tripwire* while deleting the *port*.

## Decision

**pi-daddy becomes the subagent runtime, with governance built in, rather than a governance layer over
someone else's runtime.** Concretely:

1. **`delegate` is the only spawn path**, and it gains the ability to spawn a **named definition** —
   `delegate({agent, task})` — resolving the name to a file on disk, computing its ceiling, and
   intersecting that with the session's grant. The existing attenuation invariant (ADR-0008) is untouched:
   a definition is an **upper bound**, never a grant.
2. **Agent Skills (`SKILL.md`) is the definition format**, and **`allowed-tools` is the capability
   declaration.** Where the spec has a field, we use it; where it does not, we use its `metadata` map with
   `pi-daddy-` prefixed keys (values are strings, per the spec) and **never invent top-level frontmatter**,
   so the user's skills stay valid for the other tools that read them.
3. **We supply the enforcement the standard explicitly does not.** `allowed-tools` is advisory by
   specification; passed through `--tools`, it becomes structural, enforced by pi core, and recorded in the
   ledger. **This is the product's sentence now:** *the standard declares intent; pi-daddy makes it
   enforced.*
4. **`allowed-tools` patterns are refused, loudly, not reinterpreted.** The spec's example is
   `Bash(git:*) Read`. pi's `--tools` is **name-granularity only** and cannot express "bash, but only git".
   The three ways to reinterpret are all wrong: granting bare `bash` **widens** a deliberately narrow
   declaration (the permissive direction, which is how R-31 and R-28 both did damage); dropping the tool
   silently **narrows** and produces a child that mysteriously cannot work; and pattern-matching inside a
   wrapper would be a security control implemented by string matching on a shell command. So a definition
   using a pattern is a **configuration error**, reported with the tool, the pattern, and the reason —
   per rule 8, fail closed *and* be loud. Revisit if pi gains sub-tool granularity.
5. **The interceptor is demoted to a tripwire, and the ported ceiling rules are deleted.** Keeping a
   *refusal* is cheap and worth it — installing pi-subagents is one command away, and a silently
   ungoverned spawn path is the exact thing this project exists to prevent. Keeping the *port* is not: its
   only purpose was to compute what pi-subagents would grant, and we no longer need to permit those spawns
   at all. The tripwire refuses spawn tools it does not own and says why. **R-31 evaporates with the port**,
   and `ceilingFor` simplifies to our own format, whose semantics we define.
6. **herdr is a supported execution backend, not the only one.** `planSpawn` already produces the plan;
   `runChild` and `runHerdrPane` are two executors for it. `runChild` stays as the dependency-free default
   so the package remains testable and usable without herdr; herdr is what makes fan-out *visible and
   attachable*, which is the reason it was made a requirement.

**For v1 this means** the PR-review scenario works end to end: N narrow reviewers, each with its own tools,
its own skills, its own system prompt and no knowledge of the others, running in parallel panes, harvested
and merged by the parent, which then delegates a fixer under a different grant.

## Consequences

**Positive.** The product becomes a thing rather than a policeman for a thing. The user's definitions gain
a runtime. The interop story improves rather than degrades — `SKILL.md` files stay readable by 16+ tools,
and the value we add is the one thing none of them do. A large amount of accidental complexity leaves with
the port.

**Negative.** `principal-pi-skills` needs a refactor (offered, not imposed). Two features the abandoned
route had for free must now be built: parallel execution and result harvesting. **R-32 is a shipped defect
on the path we are keeping** — governed children today inherit every skill and `CLAUDE.md` — and it is now
on the critical path rather than a tidy-up. Work done earlier today against the interceptor is largely
superseded: R-28's fix survives only for `/grants`, and `test/interceptor-wiring.test.ts` exercises a path
that will no longer run.

**What this supersedes.** ADR-0013 (govern pi-subagents properly) is superseded except for its measured
findings, which stay as evidence. ADR-0015's option set was framed around a choice between two paths and is
reduced to its rejections (D and F) and its one durable insight — that fan-out and background are separable.
`docs/archive/proposals/pi-subagents-tools-parameter.md` is **dead**: do not file it.

**Deliberate non-goals.** Containing an agent that holds `bash` remains out of scope (ADR-0012) — and note
that `review.md` and `principal-review.md` both declare `bash` today, so the most-used definition is the
least contained. A pane is **not** a security boundary; it is a terminal, and a human can type into a
governed child by design. Sub-tool granularity (`Bash(git:*)`) is not ours to implement.

## Revisit trigger

- **pi gains sub-tool granularity** in `--tools` → decision point 4 reopens and patterns become enforceable
  rather than refused.
- **Agent Skills ratifies an agent/subagent definition** distinct from a skill → point 2 reopens; today
  there is no such thing to adopt.
- **`allowed-tools` leaves experimental status with different semantics** → point 3's framing must be
  re-checked against what the spec then says.
- **pi-subagents (or any third-party spawner) is installed** → the tripwire in point 5 must actually
  refuse, and that should be tested, not assumed.
- **herdr's CLI breaks argv passthrough or the pane lifecycle** (`docs/probes/g16-herdr` is the baseline)
  → point 6's backend needs re-verification; `runChild` is the fallback that keeps the package working.
