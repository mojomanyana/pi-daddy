# Governing `principal-pi-skills` with pi-daddy

**Every command and every output below was run against real pi 0.84.1, `pi-daddy@0.13.0` and
`principal-pi-skills@2.3.1` on 2026-08-14.** Nothing here is inferred.

> **Updated 2026-08-16 (`pi-daddy` 0.14.0, ADR-0028): steps 2 and 3 are now one command.** `npx pi-daddy
> init` does the copying and writes the grant file; you still choose each ceiling, because that is the one
> decision this package will not make for you. See *The short way* below — re-measured against the same two
> package versions, `docs/probes/b2-init-principal-pi-skills`. **Everything above this note is unchanged and
> still true**, and the manual walkthrough is kept: it is what `init` writes, and reading it once is how you
> know what you are committing.

## They do not compose out of the box, and it is worth knowing why

`principal-pi-skills` ships seven skills — `decide, architect, plan, build, review, debug, git-ops` —
described as working *"unedited as loaded skills or as subagent system prompts"*. That is exactly the shape
pi-daddy spawns. But two things stop them meeting by default, and both are measurable:

**1. Different directories.**

| | Reads / writes |
|---|---|
| `principal-pi-agents install` | `~/.pi/agent/**agents**/` |
| pi-daddy discovers definitions from | `<cwd>/.pi/**skills**/` and `~/.pi/agent/**skills**/` |

So `principal-pi-agents install` wires the skills into **pi's own native agent delegation**, which pi-daddy
neither sees nor governs. That is not a bug in either package — they are aimed at different mechanisms.

**2. No `allowed-tools`.** Not one of the seven skills, nor the six files under `agents/`, declares it:

```
$ grep -rl "allowed-tools" node_modules/principal-pi-skills/
(no matches)
```

pi-daddy treats an absent `allowed-tools` as **not spawnable**, deliberately — *"undeclared is the weakest
state, never the strongest."* Dropping a stock skill into `.pi/skills/` and expecting a spawn produces this,
verbatim:

```
BLOCK  plan — agent "plan" declares no `allowed-tools`, so it cannot be spawned —
       add one to <cwd>/.pi/skills/plan/SKILL.md. An undeclared capability set is
       treated as NONE, never as everything.
```

**Which is the point.** You are deciding what each skill may touch. That decision is not in the skill,
because the skill's author cannot know your threat model.

## The short way (0.14.0)

```bash
pi install npm:pi-daddy
pi install npm:principal-pi-skills
pi                      # then, inside pi:
/grants init
```

**`pi install`, not `npm install`** — it registers the package with pi, which is what makes the extension
auto-load; presence in `node_modules` alone does nothing. `/grants init` asks only about the capabilities
that can change your machine and applies the answer to the running session, no restart (ADR-0030).
`npx pi-daddy init` does the same scaffolding from a shell, and both search pi's install root as well as
the project's.

```
found principal-pi-skills@2.3.1 — 7 skill(s), 0 declaring allowed-tools
wrote .pi/skills/{decide,architect,plan,build,review,debug,git-ops}/SKILL.md
wrote .pi/grants.env
```

`init` copies every skill the package declares in its own `package.json` (`"pi": {"skills": [...]}`) into
`.pi/skills/`, and writes `.pi/grants.env` with every capability annotated by the definition it came from.
**It chooses no ceiling.** Because none of the seven declares `allowed-tools` today, each copy carries a
*commented* placeholder and the generated grant authorises none of them — `init` says so rather than
inventing capability sets to make its own output look better.

So the remaining work is exactly the decision, and nothing else: uncomment and complete the
`allowed-tools:` line in each definition you want, then add its `agent:<name>` to `PI_GRANTS_GRANT`. Then:

```bash
source .pi/grants.env && pi
```

```
grants: depth 0/2, holding [agent:review, tool:read, tool:grep, tool:delegate]
grants: 1 of 7 definitions spawnable — review
  withheld: architect, build, debug, decide, git-ops, plan — need agent:architect, …, which this session does not hold
```

A second `init` **keeps** every file that already exists, so it cannot destroy a ceiling you wrote;
`--force` rewrites and discards them.

## Step by step: one governed skill

The long form of the same thing — what `init` writes, and why each line is there.

### 1. Install both

```bash
pi install npm:pi-daddy
pi install npm:principal-pi-skills
```

**`pi install`, not `npm install`.** It fetches the package *and registers it in pi's settings*, which is
what makes pi auto-load the extension — presence in `node_modules` alone does nothing. It installs into
`$PI_CODING_AGENT_DIR/npm/node_modules`, so your project may have no `node_modules` at all, and that is
normal. `npm install` into the project also works and pins the version for a team, but then the extension
needs `-e ./node_modules/pi-daddy/extensions/grants.ts`. `pi-daddy init` searches **both** locations.

### 2. Copy a skill in and declare its tools

The body is the child's system prompt; the frontmatter is the grant. Take the skill's body unchanged and
add one line:

```bash
mkdir -p .pi/skills/review
```

`.pi/skills/review/SKILL.md`:

```markdown
---
name: review
description: Reviews a diff for correctness and simplicity. Reports findings; never edits.
allowed-tools: Read, Grep
---

<the entire body of node_modules/principal-pi-skills/review/SKILL.md, unchanged>
```

`Read, Grep` is the whole decision: a reviewer reads and searches. It cannot write, cannot run a shell, and
no prompt can talk it into either — `--tools` is enforced by pi core in a separate OS process.

**The directory name is the identity.** `.pi/skills/review/` makes the definition `review`, regardless of
what the frontmatter `name` says.

### 3. Grant the session the authority to spawn it

```bash
export PI_GRANTS_GRANT="agent:review,tool:read,tool:grep,tool:delegate"
export PI_GRANTS_LEDGER="$PWD/.pi/grants.jsonl"     # optional but recommended
pi
```

This is the explicit-environment route. If you instead run `/grants init` inside pi, that one project choice
stores the grant and enables `$PWD/.pi/grants.jsonl` for the current and future plain `pi` sessions; no exports
are needed (ADR-0037). A pre-0.21 stored grant needs one rerun to add ledger consent.

**Plain `pi` — no `-e`.** The package declares `pi.extensions`, and pi auto-loads it for an installed
package; verified by execution. You only need `-e ./extensions/grants.ts` when running from a **clone** of
this repository, where there is no `node_modules/pi-daddy` for pi to find.

Four capabilities, each doing one job:

| Capability | Why it is there |
|---|---|
| `agent:review` | authority to run **that definition**. Withhold it and `review` cannot be spawned at all |
| `tool:read`, `tool:grep` | the parent must hold what it hands down. A grant can only ever **shrink** |
| `tool:delegate` | authority to delegate at all. Withhold it and the session is a leaf |

### 4. Check before you rely on it

`/grants` runs the **real planner** over every definition and prints what would happen. It costs no model
tokens:

```
grants: ACTIVE
  holding    agent:review, tool:read, tool:grep, tool:delegate
  depth      0 of max 2
  catalog    11 capabilities — 9 builtin, 0 extension, 1 skill, 1 agent-type
    allow  review  tool:grep, tool:read
```

`allow review — tool:grep, tool:read` is the confirmation: that child will get exactly those two tools.

### 5. Use it

Ask pi to delegate normally — *"have the review agent look at this diff"*. It calls
`delegate({agent: "review", task: "..."})`, and the child starts as a separate `pi` process with
`--tools read,grep` and the skill body as its system prompt.

## What refusals look like

All three produced by the commands above:

**Missing `agent:` authority** — the definition is fine, the session is not allowed to run it:

```
BLOCK  review — cannot spawn "review" — this session does not hold agent:review
       (the definition lives at .../review/SKILL.md). It may spawn: agent:plan.
```

**Escalation** — the definition wants more than the parent holds. This is the invariant, and it is refused
before any process starts:

```
BLOCK  review — cannot grant tool:grep — this session does not hold it
       (capability escalation blocked)
```

**Undeclared tools** — the stock principal-pi-skills case, shown above.

Each names the capability and the file, because a refusal you cannot act on is a bug report addressed to
nobody.

## Making it the default for all your work

Two levels, and the second one deserves care.

**Per project** — commit `.pi/skills/` to the repository. Everyone who clones it gets the same governed
definitions, reviewed like any other code. This is the recommended shape: *what a reviewer may touch* is a
project decision, and it belongs in the project.

**Machine-wide** — put the governed copies in `~/.pi/agent/skills/` instead, and export the grant from your
shell profile:

```bash
# ~/.bashrc — applies to EVERY pi session on this machine
export PI_GRANTS_GRANT="agent:review,agent:plan,agent:debug,tool:read,tool:grep,tool:delegate"
export PI_GRANTS_LEDGER="$HOME/.pi/grants.jsonl"
```

**Three things to know before you do that:**

1. **An exported grant governs every session, including the ones where it is wrong.** A grant is a ceiling,
   so the failure is a refusal rather than an exposure — but a too-narrow global grant means a confusing
   `BLOCK` in an unrelated project six weeks later. `PI_GRANTS_GRANT` unset means *ungoverned*, which is the
   documented default; governance is opt-in.
2. **`agent:*` is not the shortcut it looks like.** It authorises every `SKILL.md` in **both** roots —
   including `~/.pi/agent/skills/`, which other tools install into. pi-daddy warns at startup if you pair it
   with an ungated `tool:bash`, because that is *every body on disk running with a shell*.
3. **One ledger for every project mixes their records.** `PI_GRANTS_LEDGER` is not scoped per project; two
   different `review` definitions in two checkouts are distinguishable in `/grants ledger` only because it
   compares the source path as well as the name.

## What this does not do

**It does not govern a child that holds `bash`.** A child granted `bash` can run
`env -u PI_GRANTS_GRANT pi …` and obtain a completely ungoverned descendant. Measured, and out of scope by
decision (ADR-0012). `bash` is gated by default in a governed session so it cannot happen silently — but if
you grant a principal-pi skill `Bash`, you have granted it everything, and `allowed-tools: Read, Grep` is
doing real work that `allowed-tools: Bash` would undo.

**It does not read the skill body.** `agent:review` says *which file* may run and the ledger's
`definitionDigest` says *which version* ran. Nothing judges what the instructions say — you authorise a
file, and its contents are your responsibility.
