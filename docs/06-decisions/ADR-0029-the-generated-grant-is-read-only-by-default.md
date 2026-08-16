# ADR-0029: the grant `init` generates is read-only by default

**Date:** 2026-08-17
**Status:** Accepted (2026-08-17, by the operator, from three options)
**Driver:** an independent review of PR #2. `architecture-critic`, given ADR-0028 to attack, found that its
central boundary was drawn around the wrong object — and that the decision this ADR records had been made by
default, in a line of code, with no entry in ADR-0028's "Options considered".

## Context

ADR-0028 says `pi-daddy init` *"never chooses a ceiling"*, and that is true. It is also, as the review put
it, **beside the point**: `init` chooses the **grant**, and the grant is what bounds ceilings.

The handoff's whole argument for why a third party may safely author `allowed-tools` is one sentence:

> `allowed-tools` is `ceiling`. A skill author declaring `allowed-tools: Read, Grep` is stating **what the
> skill needs**, not granting anything — **the operator's `PI_GRANTS_GRANT` still bounds it**, and a
> capability the session does not hold is refused however the skill is declared.

`init` set `PI_GRANTS_GRANT := ⋃ ceilings`. **That makes the bound and the bounded have one author, and it
is not the operator** — the safety argument for section A depends on exactly the independence that section B
removed, and neither document noticed.

Three facts make it concrete rather than theoretical:

- **Only `tool:bash` is gated by default** (`DEFAULT_GATED`, verified). `tool:write` and `tool:edit` are
  not, so a source-and-go operator handed children write access **with no dialog at all**. R-76 claimed the
  union was "mitigated by gating"; that mitigation covered one of the three wide capabilities.
- **After A1 lands upstream the union is the whole toolset.** The settled ceilings are
  `read, grep, find, ls, bash, edit, write` across the seven skills, so the generated default would be
  maximal width — and ADR-0028's own consequence sentence describes the workflow as *"the edit step
  disappears"*, i.e. nobody performs the edit the mitigation assumes.
- **A package could also inject `tool:*` and `agent:*`** through a declared ceiling, which `init` annotated
  as *"pi 0.84.1 has no tool for … refused as an unknown capability"* — the exact opposite of what
  `unknownCapabilities` does with them (it exempts both, by decision). Refused outright now; see R-78.

## Options considered

### Option 1 — keep the union, warn loudly

The generated file works for every skill immediately; `init` + `source` + `pi` and all seven are spawnable.
The wide capabilities stay live, with an accurate annotation replacing the inverted one. **Cost:** the
default artefact of a five-command install is a session that can hand `write` and `edit` to any child with
no human in the loop, in a *governance* package, relying on an operator editing a file the workflow tells
them they need not edit. That is R-25's shape — a control an operator learns to skip — with a comment on top.

### Option 2 — comment out the wide ones (**chosen**)

The live grant is what the copied skills declare **minus** anything that can change the machine:
`DEFAULT_GATED` (today `tool:bash`), `tool:write`, `tool:edit`, `tool:edit-diff`, and the universal
capabilities. Those are emitted as commented lines naming the definitions that need them, together with the
`agent:` ids of the definitions that cannot run without them.

**Cost, stated plainly:** out of the box, `init` + `source` gives a working **read-only** setup and `build`
does not run. The operator uncomments two lines and adds one id to change that. **What it buys:** the
default is safe, the widening is a deliberate act, and the file still chooses no ceiling — it chooses which
of the declared capabilities start live, which is a decision about *this project's starting grant* and
belongs to the artefact under review.

### Option 3 — ask interactively

Rejected, and it is worth saying why: it moves the decision to run time, which is the thing ADR-0028 exists
to prevent, and it breaks non-interactive use.

## Decision

**Option 2.** `WITHHELD_BY_DEFAULT` lives in one place (`src/grant-env.ts`), is derived from `DEFAULT_GATED`
rather than restating it so the two cannot drift, and is **a judgement written down so it can be argued
with** — that is the point of putting it in an ADR rather than a filter.

The rule behind the list: *a capability that can change the machine or execute does not become live because
a package asked for it.* Reading, searching and listing do.

## Consequences

- **The read-only tier of `principal-pi-skills` works out of the box** once A1 ships — `decide`, `architect`
  and `plan` are exactly the three whose settled ceilings contain nothing withheld. That is a coincidence of
  their design and this rule agreeing, not something either arranged, and it is the strongest evidence the
  line is drawn in a sensible place.
- **`review`, `debug`, `git-ops` and `build` need one uncomment**, because all four declare `bash`.
  Anyone who believed `review` was read-only should read the correction in the handoff: its body creates a
  worktree and runs the tests, and denied `bash` every verdict it returns is `UNVERIFIED`.
- **An `agent:` id is withheld with the capability it needs.** Authorising a definition to run and then
  refusing it at spawn time is a worse answer than not authorising it, and it would put an id in the grant
  whose definition cannot work — the shape ADR-0028 rule 3 already refuses for undeclared skills.
- **A cross-referenced `agent:<other>` is reported, never granted** — a ceiling may legitimately name
  another definition, but a name `init` did not write here would authorise a file from any skill root,
  including `~/.pi/agent/skills`, which other tools install into.
- **This does not make `init`'s output safe to source unread.** It makes it safe to source *unedited*. The
  file still names definitions and capabilities an operator should look at, and the printed next step is
  still `$EDITOR .pi/grants.env` before `source`.
- **Deliberate non-goal:** `init` still does not decide *ceilings*. ADR-0028's boundary is unchanged; this
  ADR names the second boundary that was being crossed silently beside it.

## Revisit trigger

- **An operator uncomments the whole withheld block on every project.** Then the split is not carrying its
  weight and the honest answer is Option 1 with the accurate warning, not a longer list.
- **`DEFAULT_GATED` grows or shrinks.** `WITHHELD_BY_DEFAULT` derives from it; a change there silently
  changes what `init` generates, and that should be a decision rather than a consequence.
- **A capability arrives that is neither clearly read-only nor clearly mutating.** The list is a judgement,
  and the first genuinely ambiguous entry is the moment to write down the rule properly rather than extend
  it by intuition.
