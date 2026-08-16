# Handoff — make `pi-daddy` + `principal-pi-skills` work out of the box

**Status:** proposed, not started. **Audience:** whoever implements this, in either repository.
**Written 2026-08-14** against `pi-daddy@0.13.0`, `principal-pi-skills@2.3.1`, pi 0.84.1.

Everything in the *Problems* section was reproduced by execution, not inferred. The commands are in
`docs/USING-WITH-PRINCIPAL-PI-SKILLS.md`.

---

## The goal, in one sentence

An operator runs two `npm install`s and gets **seven governed subagents**, each with a capability set that
was decided deliberately, visible at a glance, with no hand-copying of files and no YAML editing.

Today they get none of that, and the reasons are small and specific.

---

## Problems, measured

### P1 — the two packages install into different directories

| | Path |
|---|---|
| `principal-pi-agents install` writes to | `~/.pi/agent/`**`agents`**`/` |
| pi-daddy discovers definitions from | `<cwd>/.pi/`**`skills`**`/` and `~/.pi/agent/`**`skills`**`/` |

`principal-pi-agents install` therefore wires the skills into **pi's native agent delegation**, which
pi-daddy does not see and does not govern. Neither package is wrong; they aim at different mechanisms and
nothing says so.

### P2 — no skill declares `allowed-tools`, so none is spawnable

```
$ grep -rl "allowed-tools" node_modules/principal-pi-skills/
(no matches — 7 skills, 6 agent files, zero declarations)
```

pi-daddy refuses a definition with no `allowed-tools`, deliberately (*"undeclared is the weakest state,
never the strongest"*). Verbatim output:

```
BLOCK  plan — agent "plan" declares no `allowed-tools`, so it cannot be spawned —
       add one to <cwd>/.pi/skills/plan/SKILL.md.
```

### P3 — the working setup is entirely manual

Today the operator must, per skill: create a directory, copy the body, hand-write frontmatter, choose a
capability set with no guidance, and assemble a `PI_GRANTS_GRANT` string by hand. Seven times.

### P4 — nothing tells the operator the two are cooperating

pi-daddy's startup line reports the *grant* (`holding [agent:review, tool:read, …]`). It never names the
definitions, never says where they came from, and never says that `principal-pi-skills` is what is being
governed. The operator has to run `/grants` and infer it.

---

## The design

### The load-bearing insight: `allowed-tools` is a **ceiling**, not a grant

This is why P2 is safe for `principal-pi-skills` to fix at the source. pi-daddy computes:

```
effective = ( requested ∩ parentGrant ∩ ceiling ) \ (gated \ approved)
```

`allowed-tools` is `ceiling`. A skill author declaring `allowed-tools: Read, Grep` is stating **what the
skill needs**, not granting anything — the operator's `PI_GRANTS_GRANT` still bounds it, and a capability
the session does not hold is refused however the skill is declared. So the author supplying a sensible,
minimal ceiling is exactly right, and it is what the Agent Skills standard intends. pi-daddy's contribution
is that the declaration becomes **enforced** rather than advisory.

**Consequence for the split of work:** `principal-pi-skills` owns the *ceilings*; `pi-daddy` owns the
*enforcement and the visibility*. Neither has to know much about the other.

### The seven skills are two tiers, and that is the selling point

Proposed ceilings, from each skill's own description:

| Skill | `allowed-tools` | Why |
|---|---|---|
| `decide` | `Read, Grep, Glob` | explores options; changes nothing |
| `architect` | `Read, Grep, Glob` | designs; does not implement |
| `plan` | `Read, Grep, Glob, Write` | reads to plan, writes the plan file |
| `review` | `Read, Grep, Glob` | its own description says *"Reports findings; never edits"* |
| `debug` | `Read, Grep, Glob, Bash` | must run the failing test |
| `build` | `Read, Grep, Glob, Edit, Write, Bash` | writes code; needs everything |
| `git-ops` | `Read, Bash` | git *is* bash |

**⚠ This table is UNRESOLVED and its first draft contradicted itself.** It gave `plan` a `Write` while the
prose beneath claimed `plan` was among "four structurally incapable of modifying anything". Both cannot be
true, and the contradiction is the interesting part rather than a typo — see the open question below.

What is defensible today: **`review` is the only unambiguously read-only skill**, and its own description
says so (*"Reports findings; never edits"*). A `review` subagent that physically cannot write is a
different object from one that has been asked not to, and that alone justifies the integration.

**The open question, which `principal-pi-skills` should settle:** `decide`, `architect` and `plan` all
*produce a document* — an ADR, a design, a plan. That is writing a file, so they are real subagents that
need `Write`, not read-only ones. But:

> **pi-daddy governs which TOOLS, never which PATHS.** `resolve.ts` has no notion of a path, and a sub-tool
> pattern (`Bash(git:*)`, and by the same rule `Write(docs/**)`) is **refused, not reinterpreted** —
> because granting bare `write` would widen a deliberately narrow declaration and dropping it would
> silently narrow. Verified in `docs/SPEC.md` and `README.md`.

So *"an architect that may write an ADR but not your source"* is **not expressible**. Granting `architect`
a `Write` grants it write access to everything, and the honest choice is between a document-producing agent
with real write power and a read-only one that hands its output back as text for the parent to write.

Both are legitimate; they are different products. Do not resolve this by picking the tidier table.

---

## Work items

### A — `principal-pi-skills`

**A1. Declare `allowed-tools` on all seven `SKILL.md` files.** Use the table above. If they are generated
from `contracts/` (the installer's comments say they are), the ceiling belongs in the contract so both
`agents/` and the skill dirs stay in sync.

*Acceptance:* `grep -L "allowed-tools" */SKILL.md` returns nothing.
*Backwards compatibility:* additive. `allowed-tools` is ignored by tools that do not read it, and pi's own
skill loading is unaffected.

**A2. Teach `principal-pi-agents` to install into `skills/` as well.** Either a flag or, better, both by
default, since the two directories serve different mechanisms and an operator wanting one usually wants the
other:

```
principal-pi-agents install              # agents/ AND skills/, as today plus the new half
principal-pi-agents install --agents-only # today's behaviour
```

Keep the existing ownership manifest and its refusal-to-overwrite rule — extend it to cover the new path
rather than writing a second mechanism.

*Acceptance:* after `install`, `~/.pi/agent/skills/review/SKILL.md` exists and declares `allowed-tools`.

**A3. Print the grant the operator needs.** The single highest-value UX line in this document, because
assembling `PI_GRANTS_GRANT` by hand is P3's real cost:

```
$ principal-pi-agents install
installed 7 skills into ~/.pi/agent/skills/

To govern them with pi-daddy (npm i pi-daddy), export:

  PI_GRANTS_GRANT="agent:decide,agent:architect,agent:plan,agent:review,tool:read,tool:grep,tool:glob,tool:delegate"

That grants the four READ-ONLY skills. Add agent:build, agent:debug,
agent:git-ops and tool:bash,tool:edit,tool:write to include the rest —
pi-daddy will ask before any child receives a shell.
```

**A4. A one-line README section** pointing at pi-daddy, with the two-tier table.

### B — `pi-daddy`

**B1. Say what is spawnable at startup (fixes P4).** The startup notify reports the grant and not the
definitions. Proposed addition, only when at least one definition is spawnable:

```
grants: depth 0/2, holding [agent:review, tool:read, tool:grep, tool:delegate]
grants: 4 definitions spawnable — decide, architect, plan, review (3 more need capabilities you do not hold)
```

The parenthetical is the important half: it tells an operator that `build`, `debug` and `git-ops` exist and
are being withheld, which is the difference between "governance is working" and "did the install fail?".

*Constraint:* this runs in `session_start`, which is R-60 territory — put any new `await` in its own
`try/catch` or `test/session-start-guard.test.ts` will fail, by design.

**B2. `npx pi-daddy init` — scaffold a governed project (fixes P3).** Reads whatever skill packages are
installed, writes `.pi/skills/`, prints the grant. Roughly:

```
$ npx pi-daddy init
found principal-pi-skills@2.3.1 — 7 skills, all declaring allowed-tools
wrote .pi/skills/{decide,architect,plan,review,build,debug,git-ops}/SKILL.md
wrote .pi/grants.env

  source .pi/grants.env && pi
```

**Design constraint that must not be lost:** `init` writes files an operator then *reviews and commits*. It
must not silently choose ceilings at runtime — the whole point is that the capability decision is visible,
diffable and in version control. Generating a file the human approves is governance; deciding on their
behalf at spawn time is not.

**B3. ~~Make the extension easier to load.~~ ANSWERED 2026-08-14 — it already is, and the docs were wrong.**
Measured: with `pi-daddy` installed, plain `pi` auto-loads the extension through the package's
`pi.extensions` field. No `-e` is needed. `-e ./extensions/grants.ts` is only for running from a clone of
this repository.

`docs/USING-WITH-PRINCIPAL-PI-SKILLS.md` has been corrected. **`packages/pi-daddy/README.md:303` still shows
the `-e` form without saying it is the from-a-clone case** — fix that as part of B4. This is R-59's shape:
an instruction that works but tells the reader to do something unnecessary, in the document they orient
from.

**B4. A `principal-pi-skills` worked example in the README**, replacing the abstract `review-security`
example with the real one people will actually have installed.

---

## What the operator experiences afterwards

```bash
npm install pi-daddy principal-pi-skills
npx principal-pi-agents install
npx pi-daddy init
source .pi/grants.env
pi
```

```
grants: depth 0/2, holding [agent:decide, agent:architect, agent:plan, agent:review, ...]
grants: 4 definitions spawnable — decide, architect, plan, review (3 more need capabilities you do not hold)
```

Five commands, no YAML edited by hand, and the second line makes it **obvious** that both packages are
active and what each is contributing.

---

## Decisions needed before starting

1. **Do the ceilings in the table belong to `principal-pi-skills`?** The alternative is that pi-daddy ships
   an opinionated overlay. Recommendation: the skill package, because the author knows what the skill
   *needs* and pi-daddy already bounds what it *gets*. But it is the one call that determines who owns
   work item A1.
2. **Should `principal-pi-agents install` write to `skills/` by default, or behind a flag?** Default is
   better UX and slightly more surprising for existing users. Their manifest already refuses to overwrite
   files it does not own, which contains the risk.
3. ~~**Does pi auto-load `pi.extensions` from an installed package?**~~ **Answered by execution: yes.**
   See B3. One fewer decision, and the resulting UX is one command shorter.
4. **Should `pi-daddy init` write `.pi/grants.env`, or print the export?** A file is reviewable and
   committable; an export is harder to forget to apply. A file, plus printing the `source` line, is probably
   both.

---

## Verification plan

Nothing here is done until these pass, and none of them needs a model:

1. **The path test.** After `principal-pi-agents install`, `/grants` in a fresh project lists all seven
   definitions with their ceilings — no manual copying.
2. **The refusal test.** With a grant holding only the four read-only `agent:` ids, `/grants` shows `allow`
   for those four and `BLOCK` naming the missing capability for the other three.
3. **The `bash` gate test.** With `agent:build` and `tool:bash` granted and `PI_GRANTS_GATED` at its
   default, spawning `build` raises an approval dialog before the child receives a shell.
4. **The escalation test.** A session holding `tool:read` but not `tool:write` spawning `build` gets
   `capability escalation blocked` and no process starts.

Tests 2 and 4 already exist in shape in `test-integration/governance.it.ts`; extend rather than duplicate.
