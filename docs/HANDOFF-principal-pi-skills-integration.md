# Handoff — make `pi-daddy` + `principal-pi-skills` work out of the box

**Status:** **section B is DONE (2026-08-16, ADR-0028); section A is untouched and still belongs to
`principal-pi-skills`.** B1, B2 and B4 shipped in `pi-daddy` 0.14.0; B3 was answered by execution on
2026-08-14. Each item below carries a dated note saying what was built and where it differs from the sketch.
**Audience:** whoever implements this, in either repository.
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

**SETTLED 2026-08-16 by `principal-pi-skills` PR #30**, which re-derived the ceilings from the skill
*bodies* and overturned three of the seven rows this handoff proposed. Its decision record is
`docs/DECISION-capability-ceilings.md` in that repository. **The table below is theirs, and it is correct;
the proposal it replaced is kept underneath because the errors are the instructive part.**

| Skill | `allowed-tools` | Confers write? |
|---|---|---|
| `decide` | `read, grep, find, ls` | no |
| `architect` | `read, grep, find, ls` | no |
| `plan` | `read, grep, find, ls` | no |
| `review` | `read, grep, find, ls, bash` | **yes, via `bash`** |
| `debug` | `read, grep, find, ls, bash` | **yes, via `bash`** |
| `build` | `read, grep, find, ls, edit, write, bash` | **yes** |
| `git-ops` | `read, bash` | **yes, via `bash`** |

Reproduced here through `parseSkillDefinition` → `ceilingForDefinition` → `expandSubsumed`: all seven parse
with zero patterns, and the write column matches exactly.

**The open question is answered: `decide`, `architect` and `plan` do NOT get `write`.** The premise to
reject is *"writing a document is writing a file"* — in that framework a document is a **message**, and
`build/SKILL.md:15` had already said so: *"You are the only phase that writes durably. Plan reads."* All
three advisory skills already end in a fenced block they **emit**, so returning text is not a degradation
traded for safety; it is what they do today with no pi-daddy involved.

### What this handoff got wrong, kept because the errors are the lesson

1. **A fabricated citation.** It called `review` *"the only unambiguously read-only skill"* and sourced
   that to its description saying *"Reports findings; never edits."* **That string exists nowhere in
   `principal-pi-skills`** — it was invented for the demo `SKILL.md` in
   `docs/USING-WITH-PRINCIPAL-PI-SKILLS.md` and then cited back as their evidence. Inventing a source and
   attributing it is worse than being wrong, and rule 5 exists to prevent exactly this.
2. **`review` is not read-only.** Its body creates a disposable worktree and runs the tests
   (`review/SKILL.md:58-68`); denied `bash`, every verdict is `UNVERIFIED`, which its own body calls *"not
   a soft approve"*. The one row called defensible was the one that breaks its skill.
3. **`Glob` is not a pi tool.** Built-ins are `bash, edit, edit-diff, find, grep, ls, parallel, read,
   write` (`src/pi-tools.ts`). Six of seven proposed rows carried `Glob`, so six of seven would have been
   refused by the catalog as unknown.
4. **`plan` was given `Write` in the table while the prose called it incapable of modifying anything.**
   The prose was right and the table was wrong.
5. **`bash` subsumes `write` and `edit`** (`SUBSUMPTION`, `src/resolve.ts:43-53`) — so "structurally
   incapable of modifying anything" was unsound for any row holding `bash`. This is pi-daddy's own code,
   and the handoff did not consult it.
6. **`agents/*.md` already declared these ceilings.** `agents/plan.md` had `tools: read, grep, find, ls`
   and `agents/review.md` had `…, bash`, committed before the question was asked. A table derived "from
   each skill's own description" was reading the wrong field.

**The two-tier property the integration sells survives, restated honestly:** the tiers are **advisory vs.
executing**, not *"four incapable of modifying anything"*. Exactly four are structurally incapable, and
they are the four whose bodies say so.

<details>
<summary>The original proposal, for the record</summary>

| Skill | proposed | why it was wrong |
|---|---|---|
| `decide` | `Read, Grep, Glob` | `Glob` unknown to pi |
| `architect` | `Read, Grep, Glob` | `Glob` unknown to pi |
| `plan` | `Read, Grep, Glob, Write` | `Write` contradicted the prose; `Glob` unknown |
| `review` | `Read, Grep, Glob` | needs `bash` or every verdict is `UNVERIFIED` |
| `debug` | `Read, Grep, Glob, Bash` | `Glob` unknown |
| `build` | `Read, Grep, Glob, Edit, Write, Bash` | `Glob` unknown |
| `git-ops` | `Read, Bash` | the one row that survived |

</details>

---

## Work items

### A — `principal-pi-skills`

**A1. DONE 2026-08-16 — `principal-pi-skills` PR #30 (open).** All seven declare `allowed-tools`, in pi's
lowercase tool names, and the three generated from `contracts/*.md.tmpl` declare it there so `SKILL.md` and
both `agents/` twins cannot drift — as this item asked. It also fixed a latent defect in that repo that this
handoff never spotted: `agents/debug.md` carried **no** `tools:` key at all, and in pi-subagents an absent
`tools:` means the *full default toolset* — so the debug twin was silently the most powerful of the three,
the exact inversion pi-daddy exists to reverse.

*Original text: "Declare `allowed-tools` on all seven `SKILL.md` files. Use the table above. If they are
generated from `contracts/`, the ceiling belongs in the contract."*

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

**B1. DONE 2026-08-16 (0.14.0).** `extensions/spawn-summary.ts`, classified by the real planner
(`planWithApprovals` with `ctx: null`) rather than by a second reading of the rules. **Two deliberate
differences from the sketch below**, both in ADR-0028: it prints even when *nothing* is spawnable — the
proposal's "only when at least one definition is spawnable" is silent for exactly the operator in P2's state
— and the withheld ones are grouped by *reason*, because a gate and an escalation have different fixes.
Measured in a real pi process: `docs/probes/b2-init-principal-pi-skills` and
`test-integration/governance.it.ts`.

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

**B2. DONE 2026-08-16 (0.14.0).** `src/cli.ts` + `src/init.ts` + `src/skill-packages.ts`, with a `bin`.
The design constraint below is what the module is built around and is restated in ADR-0028: a declared
`allowed-tools` is copied **byte for byte**, an undeclared one gets a *commented* placeholder and stays
unspawnable, an existing file is **kept** rather than overwritten, and the generated grant authorises only
what can actually be spawned. Discovery reads each package's own `pi.skills` manifest field — measured
against `principal-pi-skills@2.3.1` — and never scans for files named `SKILL.md`. **Open question 4 was
answered "both"**: a file, plus the `source` line printed.

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

**B4. DONE 2026-08-16 (0.14.0).** *"Worked example: governing `principal-pi-skills`"* in
`packages/pi-daddy/README.md`, every line of it produced by running the commands
(`docs/probes/b2-init-principal-pi-skills`). It shows the **honest** current state — seven skills, zero
declaring `allowed-tools`, so `init` reports `0 declaring` and grants one capability — rather than the
after-A1 state, and says what changes when A1 lands. The `README.md:303` `-e` line B3 asks about **was
already corrected** in commit `a7b934a`, the same commit that added this handoff; it now reads *"for running
from a **clone** of the repository"*.

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

**Status 2026-08-16:** test 1 is met by a different route than it names — `npx pi-daddy init` rather than
`principal-pi-agents install`, since A2 has not landed — and test 2 is met and covered by a new integration
test. Tests 3 and 4 were already covered by `test-integration/` and are unchanged by section B. All of it is
in `docs/probes/b2-init-principal-pi-skills`.

1. **The path test.** After `principal-pi-agents install`, `/grants` in a fresh project lists all seven
   definitions with their ceilings — no manual copying.
2. **The refusal test.** With a grant holding only the four read-only `agent:` ids, `/grants` shows `allow`
   for those four and `BLOCK` naming the missing capability for the other three.
3. **The `bash` gate test.** With `agent:build` and `tool:bash` granted and `PI_GRANTS_GATED` at its
   default, spawning `build` raises an approval dialog before the child receives a shell.
4. **The escalation test.** A session holding `tool:read` but not `tool:write` spawning `build` gets
   `capability escalation blocked` and no process starts.

Tests 2 and 4 already exist in shape in `test-integration/governance.it.ts`; extend rather than duplicate.
