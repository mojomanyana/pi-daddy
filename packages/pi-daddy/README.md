# pi-daddy

**Capability governance for pi sub-agents.** A grant can only ever *shrink* as it passes down a delegation
tree, so a sub-agent can never hold more of the **tool surface** than its parent — enforced by **pi's own
`--tools` allowlist**, with an append-only ledger of what was granted and what was refused whenever one is
configured.

Both qualifiers are load-bearing and are not buried: a child granted `bash` can escape governance entirely
(ADR-0012, measured), and the ledger is opt-in. See *What this governs, and what it does not*.

> **0.13.0 was the first published release.** Earlier versions were developed in-repo and never shipped, so
> the breaking changes in the changelog describe how this package arrived at its current behaviour rather
> than anything you need to migrate from.
>
> It has been reviewed twice — once by its author against written hypotheses, then by four independent
> agents each given one hypothesis to attack. That pass found eight further defects, including a file lock
> that admitted two writers into its critical section, and all of them are fixed here. The reasoning for
> every decision is in **[CHANGELOG.md](./CHANGELOG.md)** and in the `docs/06-decisions/` ADRs upstream.
>
> **Known gaps are stated rather than implied** — see *Status* at the end of this file. The largest is
> deliberate: a child granted `bash` escapes governance entirely, by decision.

## What this governs, and what it does not

**It governs the tool surface: which tools pi exposes to a model.** That part is structural, not advisory —
`--tools` is enforced by pi core, and an `-e`-loaded extension cannot re-add its own tool past it
(measured). A child granted `read` has no write tool, and no prompt can talk it into having one.

**It does not contain an agent that holds an execution primitive.** A child granted `bash` can run
`env -u PI_GRANTS_GRANT pi …` and obtain a completely ungoverned descendant — no ledger entry, no depth
increment, no grant. Measured, not theorised: `docs/probes/g5-bash-escape`. `env -u` is incidental; the
mechanism is *"the child can execute programs"*, and governance state lives in that program's environment.
Containing **that** is the operating system's job, and is out of scope here (**ADR-0012**).

So: **`bash` is gated by default in a governed session** — a human is asked before any child receives it —
and gating is closed under subsumption, so gating `write` gates `bash` too. Neither makes the escape
impossible. Both stop it happening silently, which is the difference that matters when the realistic threat
is a confused or prompt-injected agent rather than a determined one.

## The invariant

```
effective = ( requested ∩ parentGrant ∩ ceiling ) \ (gated \ approved)
```

Escalation is impossible **by construction**, not by policy. The root holds the full catalog, so grants are
free from the top; every level below can only subtract. No policy engine, no LLM on the security path.

Depth control falls out for free: spawning is itself a capability. Withhold `tool:delegate` and the child is
a leaf — it receives neither `delegate` nor `delegate_all`.

**Cardinality is bounded separately** (ADR-0008, amended 2026-08-12). The invariant above says what a child
may *hold* and nothing about how many children exist; a blocking `delegate` bounded that to one by accident,
and fan-out removes the accident. `PI_GRANTS_FANOUT` is a **subtree budget**: a call
spends from `B` before dividing the remainder among the children, so no *subtree* can exceed what its root
held. A per-call cap of K with depth D would still permit K^D — the same exponential wearing a smaller
number — so the bound is subtractive instead, and composes across processes with no shared state.

**It is not a session total, and the distinction is measurable:** the value is read once from the
environment and never decremented, so one session may issue successive `delegate_all` calls at the full
width. What is bounded is the shape of any *one* tree, not how many trees a turn builds. Bound depth with
`PI_GRANTS_MAX_DEPTH`; nothing bounds the number of turns.

## Why pi's `--tools` is the enforcement point

Measured, not assumed (probes 9–11 in `docs/probes/pi-fabric-eval`):

- `pi --tools read -e npm:pi-fabric` → the model **cannot** call `fabric_exec`.
- `pi --no-tools -e npm:pi-fabric` → likewise blocked.
- No flag → `fabric_exec` works.

So pi core hard-blocks extension tools, and an explicitly `-e`-loaded extension **cannot re-add its own tool
past the allowlist**. That is why this package needs no runtime inside the descendant: it computes the
allowlist and hands it to pi.

## Definitions are Agent Skills, and `allowed-tools` is the ceiling

A sub-agent is a skill you spawn. Definitions are `SKILL.md` files under pi's own skill roots — a directory
containing `SKILL.md` is one definition named after the **directory**, and a top-level `.md` is one named
after the **file**:

```
.pi/skills/deploy/SKILL.md          project, wins on a name collision
~/.pi/agent/skills/review/SKILL.md  global
```

```markdown
---
name: docs-writer
description: Fixes documentation typos.
allowed-tools: Read, Write
---
Fix typos in the documentation. Do not restructure anything.
```

The body becomes the child's system prompt (`--append-system-prompt`); `allowed-tools` becomes its ceiling.

| `allowed-tools` | Ceiling |
| :--- | :--- |
| **absent** | **undeclared — not spawnable at all.** The refusal names the file. |
| empty | nothing; a child with no tools |
| `Read, Write` or `Read Write` | `tool:read`, `tool:write`. Space-separated is the spec's form; commas are tolerated because it is what people type |
| `ext:pkg/tool`, `skill:x`, `agent:y` | passed through **as written** |
| anything else | lowercased and prefixed `tool:` — so `Glob` becomes `tool:glob`, which the catalog then refuses as unknown |
| contains a pattern, e.g. `Bash(git:*)` | **refused, not reinterpreted** |

**Two of those rows are the load-bearing ones.**

*Absent means undeclared.* Under the pi-subagents frontmatter this package used to read, a missing `tools:`
key meant pi's **full default toolset**, so an undeclared definition was the most powerful kind and every
parse failure produced a wildcard — the direction that caused R-28 and review finding F18. The sense is now
inverted: a typo or an unreadable YAML form costs a refusal instead of a grant.

*A sub-tool pattern is refused because every reinterpretation of it is wrong.* pi's `--tools` matches whole
tool names, so granting bare `bash` for `Bash(git:*)` would **widen** a deliberately narrow declaration,
dropping it would silently **narrow** and yield a child that mysteriously cannot work, and matching the
pattern inside a wrapper would be a security control implemented by string-matching a shell command.

**Identity comes from the path, never the frontmatter `name`.** pi keys skills by their directory, so
trusting the frontmatter lets our view and the loader's disagree about which file a name refers to. The spec
requires them to match anyway, so a mismatch is the file's defect and not something to honour.

## Universal capabilities

`fabric_exec` is treated as **universal** — granting it is equivalent to granting the whole catalog, because
it reaches `pi.write`, `pi.bash`, and unrestricted `agents.run`. This is measured, not theoretical: a child
granted `tools: []` (nothing at all) plus `recursive: true` still spawned a grandchild that wrote to disk.

`assertNarrowing()` therefore **throws** if a supposedly narrow grant contains one. A narrow grant with
`fabric_exec` in it is full authority wearing a narrow grant's clothing.

Narrowing is checked **before** the gate, and the order is load-bearing rather than stylistic: because
`assertNarrowing` refuses whatever a human says, the old order reported *"requires explicit approval"* for a
spawn that could never be approved — telling the operator to go and find a human who cannot help. For the
same reason **no dialog is raised** for a spawn retaining a universal capability: asking would be worse than
useless, since a `session`- or `always`-scoped *yes* given there is banked and reused for later spawns that
**do** proceed.

A delegator that legitimately holds `fabric_exec` and knowingly wants a child to have it **cannot** spawn
that child. `assertNarrowing`'s `allowUniversal` flag exists but is deliberately not plumbed through; the
first real need for that override is the evidence it should be added.

## The two tools

```
delegate({ task: "summarise src/", agent: "docs-writer" })     // preferred: an operator-authored definition
delegate({ task: "summarise src/", tools: ["read"] })          // when no definition fits
delegate_all({ children: [ {…}, {…}, {…} ] })                  // several at once, each independently governed
```

- **Prefer `agent`.** Its capabilities *and* its instructions were written by the operator, and the session
  must hold `agent:<name>` to name it at all. `tools:` is the escape hatch: the model chooses the tool list,
  which is why that form can never persist an approval (see below).
- **You cannot grant what you do not hold.** Refusals name the capability and are recorded.
- **Spawning is itself a capability.** Grant `delegate` and the child can sub-delegate; withhold it and the
  child is a leaf — the extension is only passed to children that hold it, so the machinery isn't even
  present. `PI_GRANTS_MAX_DEPTH` remains a backstop.
- **A refusal is a tool *error*, not an answer.** Both tools throw, because `AgentToolResult` has **no
  `isError` field** — pi sets it only when `execute` throws, and a normal return is hardcoded
  `isError: false`. Until 0.5.0 the tool returned `isError: true`, which was silently discarded, so every
  refusal this package made was recorded by pi as a **successful** tool call. Found by the integration suite
  on its first run.
- **A child cannot outlive or overwhelm you.** Output is capped (1 MiB), there is a wall-clock timeout
  (`PI_GRANTS_CHILD_TIMEOUT`, default 600s) with `SIGTERM` → `SIGKILL` escalation so a child cannot ignore
  its way past it, an abort is honoured even if it arrived before the spawn, and a child that exits
  non-zero, times out or is cancelled comes back as a **tool error naming which** — not as an answer.
- **Fan-out is synchronous and bounded.** At most 8 children per call, and the subtree budget bounds the
  total across the whole tree. Every child goes through the same plan-gate-audit path as a single
  `delegate`; `delegate_all` adds only cardinality and sibling identity. **There is deliberately no
  background mode** (ADR-0015): fan-out carried most of the value and background carries nearly all of the
  lifecycle holes, and because the turn still owns its children the parent cannot exit before them, the
  tool-call signal is still live, and there are no ids to dangle across a compaction.
- **One child can be refused while its siblings succeed**, and every outcome is reported. A fan-out that
  hid its refusals would let an orchestrator summarise four reviews when only three happened.

**Verified live, with a real model** (`test-integration/delegation.it.ts`):

| Scenario | Result |
| :--- | :--- |
| Holds `read,write,delegate`; delegates `tools:["read"]`; child told to write a file | **No file exists.** `--tools` is the enforcement point and this is what it buys |
| Holds `read,delegate`; tries `tools:["read","write"]` | Tool **error**: `cannot grant tool:write — this session does not hold it (capability escalation blocked)`; ledger `denied:["tool:write"]`, `blocked:true` |
| `PI_GRANTS_LEDGER` pointed somewhere unwritable | Delegation **refused** — asking for an audit trail makes it a precondition |

### Two executors, one plan

Default is a captured child process. `PI_GRANTS_HERDR=1` runs each child in a visible, attachable **herdr**
pane instead — the same governed argv, the same `--tools` enforcement, somewhere you can watch it.

Opt-in and never auto-detected: where a governed child executes is an operator decision, not a consequence
of what happens to be on `PATH`. Constraints found by building it are in `docs/probes/g16-herdr` — herdr has
no `--env` (the grant rides on the pane, which the agent's shell inherits), `agent start` types argv into a
shell so a multi-line argument must be staged to a file, and `agent wait --until idle` matches the state the
agent was *already* in, so settling requires a state counter to advance.

## Approving a gated capability

`gated` capabilities are ones a session holds but may not pass on without a human saying so.

```
grants: approve tool:bash for deploy?
  task: roll out the staging build

> Deny
  Allow once
  Allow for this session
  Always allow in this project (30 days)
```

**What a yes is *about* differs by call form, and that decides which scopes are offered.**

- **`delegate({agent: X})`** is approved against **`X` itself** — an operator-authored file the session must
  hold `agent:X` to name at all. That is a human-authored subject, so `always` is on offer.
- **`delegate({tools: […]})`** is approved against the constant `<delegate>` and is offered only `once` and
  `session`. The only things naming that child are the task and the tool list, both model-chosen, and **a
  key the model controls is not a key.**

**A persisted approval is void the moment what it was granted for changes.** It pins both the definition's
`allowed-tools` and its body digest, and `/grants approvals` reports *which* check failed rather than
silently showing fewer rows:

| Verdict | Means |
| :--- | :--- |
| `type-changed` | `allowed-tools` gained or lost a capability after approval |
| `instructions-changed` | the tools are untouched but the **body** was rewritten — or the entry carries no body pin at all, which fails closed |
| `expired` | past its 30 days. An unparseable expiry is treated as expired: a cache we cannot read the expiry of is a cache we do not trust |
| `foreign-cwd` | the entry belongs to another directory. Nobody in *this* checkout was asked |
| `type-missing` | the definition was deleted or renamed, and a new file could later claim the name |

**The store lives outside the governed workspace**, one file per governed directory under
`$PI_CODING_AGENT_DIR/grants-approvals/` (default `~/.pi/agent/`). It used to sit at `<cwd>/.pi/grants-approvals.json`, which was self-defeating in
this package's own recommended configuration: `PI_GRANTS_GATED=tool:write` means *"may use write, may not
pass it down without a human"* — and **a session that may use `write` can write the approvals file.** A
reviewer forged an entry end to end, including a matching definition so the ceiling compared equal, and got
a ledger line reading `approvalSource: "persisted"` that was indistinguishable from a real approval. A
legacy in-workspace file is **ignored, not migrated**, with a warning naming it: importing it would import
exactly the entries the move exists to stop trusting. This does **not** defend against a child holding
`bash` (ADR-0012); it closes the self-defeating case, not a boundary the package does not have.

Writes are atomic (temp file plus `rename`, in the same directory so the rename really is atomic) and refuse
to follow a symlink, so a crash or a concurrent writer cannot leave a half-written file, and a corrupt file
cannot make the next legitimate write destroy every other entry.

**Other properties worth knowing:**

- **An approval rides down the tree with the grant**, intersected with what each child actually receives at
  every hop, so `approved ⊆ grant` holds at every level. An approval unblocks part of a grant; it can never
  widen one. `once` is **dropped** on inheritance — the most conservative answer a human can give must not
  produce the least conservative outcome — and the subject is **kept**, so a `<delegate>` approval no longer
  matches any subject one hop down.
- **Concurrent callers share one dialog per `capability@subject`, but only share the *answer* when it was
  about more than one spawn.** `session`, `always`, a decline and an error answer everyone; **a `once` is
  consumed by exactly one caller** and the rest are asked their own question. Measured before the fix: four
  concurrent delegations gating `tool:bash`, one dialog, one click of *Allow once* → four grants, with the
  human having seen only the first caller's task.
- **Holding `tool:*` is authority to grant widely, never authority to skip a human.** A gate is the
  operator's, not the delegator's. A wildcard holder reaches the ordinary dialog like anyone else.
- **A child can never be asked anything.** It runs `--print` with no interactive user, so a gate it hits has
  only two outcomes: satisfied by an inherited approval, or refused with a reason naming the fix. This is
  pi's own behaviour — non-interactive modes install a no-op UI context whose `select` resolves `undefined`
  — so a background delegation hitting a gate is refused, not hung.
- **The ledger distinguishes three flavours of "no"**: `denied` (an agent asked for more than it holds — an
  escalation attempt), `humanDenied` (a person was asked and declined — working as designed), and
  `gatedBlocked` with no `approvalSource` (nobody was there to ask — an operator should pre-approve).
  `humanDenied` is set only for a genuine decline, never for a dismissal, a timeout, or a dialog error —
  those get their own outcome kinds so a caller can tell them apart.

```
/grants approvals                      list them, with why any are being ignored
/grants revoke tool:bash@deploy        take one back
/grants revoke --all
```

**Pruning is lazy and scoped to one project.** Entries are validated on read and removed only on write, so
an expired or type-changed entry lingers in the file until the next approval or revoke. It cannot reach
another project: since ADR-0020 each governed directory has its own file, which is what makes
`/grants revoke --all` mean *this project* rather than *this machine*.

### Verified live, end to end

The whole lifecycle is exercised by `test-integration/approval.it.ts` against a real pi process, and its
model tier watches a real model, a real dialog and a real file. In one test, in this order: the model called
`delegate({agent: "bash-user"})`; the dialog was raised naming the **definition** as its subject with
*Always allow* on offer; the entry landed on disk pinning the ceiling *and* the body digest; the ledger
recorded `approvalScope: "always"`, `approvalSource: "prompt"`; a **different pi process** then ran the same
delegation with **zero dialogs** and a ledger line reading `approvalSource: "persisted"`; and after
rewriting the body — frontmatter byte-identical, so only the digest can catch it — the dialog was raised
again and the dismissed delegation failed.

Seven further tests in that file cost no model tokens and cover the reload and every void reason above.

**What this does not establish.** Dialogs are driven through `pi --mode rpc`, which is the same
`ctx.ui.select` call the TUI dialog serves; **the TUI's own rendering is not exercised.** The earlier
transcripts in `docs/probes/approval-ux` describe an interceptor path that no longer exists — they are kept
as the record of that run and are not a description of this version.

## Running it

```bash
# `agent:` ids say WHICH definitions this session may spawn (0.8.0); `tool:` ids say what it may grant them.
PI_GRANTS_GRANT="agent:review,tool:read,tool:grep,tool:find,tool:ls,tool:delegate" \
PI_GRANTS_LEDGER=.pi/grants.jsonl \
PI_GRANTS_MAX_DEPTH=2 \
pi
```

**Plain `pi`, no `-e`, when you installed this from npm** — the package declares `pi.extensions` and pi
auto-loads it (verified by execution). `-e ./extensions/grants.ts` is for running from a **clone** of the
repository, where there is no `node_modules/pi-daddy` for pi to find.

`/grants` shows the session's grant, its depth, the catalog by kind, and an allow/BLOCK verdict per known
definition — computed by **the same function a real spawn uses**, so the diagnostic cannot disagree with the
enforcer. That is not cosmetic, and it has been got wrong twice. R-28 was a `/grants` that reported "allow"
for spawns the enforcement path refused with a reason misstating the definition file. **R-38 was the same
shape one layer up**: the listing shared the *planner* with enforcement but not the *sequence*, so a
definition covered by a valid persisted approval was reported as blocked while a real spawn proceeded with
no human in the loop. Both paths now go through one `planWithApprovals`, differing in a single argument —
the preview never asks a human and never claims one is missing — and an `allow` that rests on a standing
approval says so:

```
    allow  deploy  tool:bash, tool:read  (tool:bash approved: persisted)
    BLOCK  undeclared — agent "undeclared" declares no `allowed-tools`, so it cannot be spawned — add
                        one to …/.pi/skills/undeclared/SKILL.md. An undeclared capability set is treated
                        as NONE, never as everything.
```

`/grants ledger` reads the ledger back and reports its integrity — record count, escalation attempts, any
unparseable lines with line numbers, and **which instructions actually ran**: records grouped by definition
digest, each compared against the file on disk (`current` / `CHANGED since`), which is what makes ADR-0018's
`definitionDigest` answerable rather than decorative. It exists because nothing in this package had ever read a ledger
back, so a torn line was indistinguishable from a spawn that never happened. A corrupt line is **evidence**
and is left alone rather than repaired. Nothing runs this check automatically.

## Worked example: governing `principal-pi-skills`

The abstract examples above use invented definitions. This one uses the seven skills people actually have
installed. Every transcript below is **copied from a run**, not retyped — the run is
`docs/probes/b2-init-principal-pi-skills` (2026-08-17, `principal-pi-skills@2.3.1`, pi 0.84.1), and where
this section abridges output it says so.

```bash
npm install pi-daddy principal-pi-skills
npx pi-daddy init
```

```
found principal-pi-skills@2.3.1 — 7 skill(s), 0 declaring allowed-tools
wrote .pi/skills/decide/SKILL.md
… six more `wrote` lines, one per skill …
wrote .pi/grants.env

7 skill(s) declare no allowed-tools and cannot be spawned until they do: decide, architect, plan,
build, review, debug, git-ops. Each copy carries a commented `allowed-tools:` line. pi-daddy does
not choose ceilings — that decision is what you review and commit, so it is yours to write.

Live grant (1 capabilities): tool:delegate
```

**That is the honest state today, and the zero is the interesting number.** `principal-pi-skills@2.3.1` —
the published version — declares `allowed-tools` on none of its seven skills, so none of them is spawnable
and `init` says so rather than inventing capability sets to make its output look better. (It is being fixed
at the source, in their PR #30; until that ships, this is what `npm install` gives you.) `init` did the
mechanical work — seven directories, seven copies, the grant file — and left the one decision that has to be
a human's.

You make it, in the file. This is the copy `init` wrote for `decide`, with its commented block elided, and
the ceiling is the one `principal-pi-skills` PR #30 settled on by re-deriving it from the skill's own body:

```diff
  ---
  name: decide
  description: >
    Use when a decision needs making …
  # pi-daddy: this skill declares no `allowed-tools`, so it CANNOT be spawned as a governed sub-agent —
  … four more comment lines …
- # allowed-tools: <list the tools this skill needs, e.g. Read, Grep>
+ allowed-tools: read, grep, find, ls
  ---
```

and in `.pi/grants.env`, whose `PI_GRANTS_GRANT` line `init` wrote as `"tool:delegate"` — you add the rest:

```sh
export PI_GRANTS_GRANT="agent:decide,tool:read,tool:grep,tool:find,tool:ls,tool:delegate"
```

```bash
source .pi/grants.env && pi
```

```
grants: depth 0/2, holding [agent:decide, tool:read, tool:grep, tool:find, tool:ls, tool:delegate]
grants: 1 of 7 definitions spawnable — decide
  withheld: architect (needs agent:architect); build (needs agent:build); debug (needs agent:debug);
  git-ops (needs agent:git-ops); plan (needs agent:plan); review (needs agent:review)
```

The second line is the one worth having. A `decide` sub-agent that **physically cannot write** is a
different object from one that has been asked not to — and now that is enforced by `--tools` rather than
requested in prose. The other six are visibly withheld, each naming its own missing capability, which is the
difference between *governance is working* and *did the install fail?*

**`decide` and not `review`, and the reason is worth a sentence.** An earlier version of this section used
`review` as the read-only example and sourced that to its description saying *"Reports findings; never
edits"* — **a string that appears nowhere in `principal-pi-skills`**. It was invented for a demo file in
this repository and then cited back as their evidence. `review`'s real ceiling, settled upstream from its
body, is `read, grep, find, ls, bash`: it creates a disposable worktree and runs the tests, and denied
`bash` every verdict it returns is `UNVERIFIED`. The structurally read-only tier is `decide`, `architect`
and `plan`.

**Capabilities that can change your machine are written commented** (ADR-0029). When the seven skills do
declare their ceilings, `init` puts `tool:read`, `tool:grep` and friends in the live grant and writes
`tool:bash`, `tool:write` and `tool:edit` — plus the `agent:` ids of the definitions that need them — as
commented lines naming who asked for what. `init` + `source` gives you a working read-only setup; the wide
half costs one deliberate uncomment. The reason is that `PI_GRANTS_GRANT` is what *bounds* a declared
ceiling, so generating it from those same ceilings would give the bound and the bounded one author, and it
would not be you.

Two things this example does **not** claim. pi-daddy governs which **tools**, never which **paths**: a
`Write(docs/**)` is refused rather than reinterpreted, so *"an architect that may write an ADR but not your
source"* is not expressible — the honest choice is between a document-producing agent with real write power
and a read-only one that hands its output back for the parent to write. And the ceilings above are an
example, not a recommendation: what each skill needs is the skill author's call.

### The tripwire

In a **governed** session the `tool_call` hook refuses third-party spawn tools (`Agent`, `subagent`,
`spawn_agent`) and records the refusal, because such a spawn would create a descendant this package did not
provision, does not bound by depth, and does not record. Installing such an extension is a single command,
so refusing is cheap and silence is not.

**It is a tripwire, not a boundary, and the difference is measured:** `subagents:rpc:spawn` reaches
`manager.spawn()` over the event bus and never produces a `tool_call` at all (ADR-0013 Finding 6), so a
tool-name check cannot see it. It catches the ordinary case loudly. It is not containment.

**Governance is opt-in.** With `PI_GRANTS_GRANT` unset, the session holds the wildcard and nothing is
blocked — this extension must never silently tighten a normal workflow. Since 0.5.0 that holds for
**descendants** too: an ungoverned session publishes no governance variables at all. It previously
exported its own observed tool surface as its children's grant, so "inactive" governance quietly governed
everything below it.

### Configuration, and how it fails

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `PI_GRANTS_GRANT` | unset → ungoverned | Presence is what switches governance on. |
| `PI_GRANTS_MAX_DEPTH` | `2` | Child-depth bound. `0` disables spawning. |
| `PI_GRANTS_DEPTH` | `0` | This session's own depth; set by the parent, not by hand. |
| `PI_GRANTS_GATED` | **`tool:bash`** in a governed session | Capabilities needing human approval. Set to `""` to gate nothing. Gating is closed under subsumption, so this also covers `write`/`edit`/`read`/`grep`/`find`/`ls` (ADR-0012). |
| `PI_GRANTS_APPROVED` | unset | Inherited `capability@subject#sha256` entries; set by the parent, clamped to the child's own grant, and honoured only against the definition body the child itself loaded (ADR-0022). |
| `PI_GRANTS_APPROVAL_TIMEOUT` | `120` (seconds) | How long a dialog waits. `0` or an unreadable value means **no timeout**: waiting forever denies nothing, so it is the safe reading of a value we do not understand. |
| `PI_GRANTS_LEDGER` | unset → not recording | **Setting this makes the ledger load-bearing** — see below. |
| `PI_GRANTS_CHILD_TIMEOUT` | `600` (seconds) | Wall-clock limit for a child. Inherited by descendants — an operator preference, deliberately *not* attenuating state. |
| `PI_GRANTS_FANOUT` | `8` | **Subtree budget**: total descendants this session may create. Attenuates downward like depth. Malformed or `0` falls back to the default — a bound a typo can switch off is not a bound. |
| `PI_GRANTS_PARENT_ID` | `d0` | This session's ledger id; set by the parent. Makes sibling records joinable into a tree. |
| `PI_GRANTS_HERDR` | unset | `1` runs children in visible **herdr** panes instead of captured processes. Opt-in, never auto-detected: where a governed child executes is an operator decision, not a consequence of what is on `PATH`. |
| `PI_GRANTS_HERDR_WORKSPACE` | unset | herdr workspace for spawned panes. |
| `PI_GRANTS_HERDR_KEEP_PANE` | unset | `1` keeps each child's pane for inspection. Off by default: a fan-out would flood the workspace. |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi's own variable, not ours — but it decides where persisted approvals live, so it is listed here. |

**A malformed value disables spawning; it never falls back to a default.** An unreadable
`PI_GRANTS_MAX_DEPTH` or `PI_GRANTS_DEPTH` yields `maxDepth: 0` and a startup warning naming the
variable. Before 0.5.0 these were read with `parseInt`, which accepts numeric prefixes (`"2abc"` → `2`)
and otherwise gives `NaN` — and since every comparison against `NaN` is false, a typo did not tighten the
depth limit, it **removed** it.

**Configuring a ledger makes it a precondition, not a log.** If `PI_GRANTS_LEDGER` is set and the write
fails, the delegation is **refused**. Asking for an audit trail is an explicit act, and `ledger.ts` has
always documented that an unrecorded grant should fail closed; until 0.5.0 both call sites silently
swallowed the error. Sessions with no ledger configured are unaffected. Concurrent appends are serialised by
a lock file with a short timeout — failing closed beats hanging — and a lock abandoned by a killed process
is broken after 10s.

## The ledger

Append-only JSONL. One record per governed decision, **including refusals**, which are the interesting ones.

Ids are hierarchical and derived: a child of `d0` is `d0.1`, its own second child `d0.1.2`. Ancestry reads
from the id alone with no join, and it is reproducible, so two runs of the same fan-out produce a diffable
ledger. `denied` non-empty is the one designated escalation signal — **an agent asking for what it does not
hold is an escalation attempt, and it is invisible without a record.**

**Privacy is a property of this file, and the boundary is exact: capability ids, counts and identifiers only
— never prompts, tool arguments or results.** The `definitionDigest` is on the identifier side of that line:
it names a version of operator-authored text already committed to a repository. The **task** is on the other
side and is never recorded, in any field.

## Propagation is race-free by construction

An earlier version wrote each child's computed grant into `process.env`. The environment is process-global,
so concurrent spawns could read each other's values — a real hole. The fix removes the need for a per-child
channel rather than building one:

1. **Everything published to the environment is a parent-level fact** — the parent's own grant, the child
   depth (`parent + 1`), the configured bounds, and this session's own approvals. Identical for every
   sibling, so there is nothing to race on. It is written once at session start and republished only when
   this session's own approvals change, never per spawn.
2. **Each child is spawned with its own explicit `env` object.** It is built by stripping every
   `PI_GRANTS_*` variable from this process's environment and then applying the plan, so the plan is the
   only source of all of them — a key the plan does not set cannot let the parent's value through.
3. **Each child derives its own grant on arrival**: `inheritedGrant ∩ ownObservedTools`, where the observed
   set comes from the `tools` array of its first provider request — authoritative, because it is exactly
   what pi sent the model. (A session's first provider request always precedes its first tool call, so the
   grant is settled before it can delegate.) Only `tool:` and `ext:` ids are filtered this way; an
   observation says nothing about `skill:` or `agent:` (R-36).

The invariant holds transitively — `own = observed ∩ inherited ⊆ inherited` — and it doubles as defence in
depth: a child clamps itself even if it were handed too much.

**The wildcard is held but never inherited.** A root may hold `tool:*` (authority to grant anything), but
handing it down would let every descendant reacquire the full catalog and make attenuation meaningless
below the root. Children inherit the enumerated grant only. A wildcard root that has not yet observed its
tools hands children an empty grant — fail closed.

**The task never touches argv.** pi dispatches `@file` and `-flag` on the *first character* of an argv
element, and `@file` is read **before any tool exists**, so `--tools` cannot stop it: a task beginning `@`
made pi read an arbitrary file into a child holding no tools at all. The task is now the final argv element,
prefixed with one space, unconditionally — a positional guarantee rather than a pattern match against pi's
current parser. Reproduced and closed; `docs/probes/g1-argv`.

## Functional subsumption: `bash` is not one capability among eight

pi's **default** tool surface is `read`, `bash`, `edit`, `write` — measured, not assumed (`grep`, `find`,
and `ls` exist but are not default). So a definition declaring `Read, Grep, Find, Ls` would look
like an escalation from any normal parent, despite being strictly weaker.

It isn't, because **`bash` can run `grep`, `find`, `ls`, `cat`, and `sed`**. `SUBSUMPTION` models that
explicitly, which removes the false positives *and* makes the uncomfortable part visible: a grant
containing `bash` is not a narrow grant. `result.subsumedBy` lists what the parent covers only indirectly,
so a reviewer can see what a grant really means. Pass `subsumption: false` for a strict name-equality check.

## Live capability catalog

Grants are validated against what actually exists in the session, not just against definition files:

| Source | Gives | Why it's trusted |
| :--- | :--- | :--- |
| provider request `tools` array | `tool:` capabilities, **including extension-provided ones** | authoritative — it is exactly what pi sent the model, and reflects any `--tools` allowlist already in force |
| skill roots (`.pi/skills`, `~/.pi/agent/skills`) | `skill:` capabilities | `SKILL.md` directories and top-level `.md` files, per pi's convention |
| the same roots | `agent:` capabilities | one per definition, from the same discovery `delegate` spawns from — so a definition can never be grantable but unspawnable, or listed but unknown |

This closes the **skills** half of "skills and tools" — previously ungovernable — and makes extension tools
visible, which is the only way `ext:`/`tool:` grants can be validated at all.

**Unknown is reported separately from denied**, because the causes and fixes differ: *denied* means the
delegator lacks authority; *unknown* means the capability does not exist here — a typo, or an uninstalled
package. Collapsing them would hide both. Verified live: `tools:["reed"]` →
`unknown capability: tool:reed — not present in this session's catalog (typo, or an uninstalled package?)`,
with no mention of escalation.

Provenance caveat: a provider payload gives tool *names*, not owning packages, so extension tools are
catalogued as `tool:<name>` (which is also how pi's `--tools` matches) and marked `kind: "extension"` for
display rather than qualified as `ext:<pkg>/<tool>`.

**`PI_BUILTIN_TOOLS` is a pinned observation** of pi 0.84.1. Drift misfiles a capability in the catalog; it
cannot grant one, because `--tools` is the authority.

## Use as a library

The resolver, ledger, spawn planner and the whole approval model are pure functions, exported and usable
without pi:

```ts
import { resolve, assertNarrowing, planSpawn, buildRecord, appendRecord } from "pi-daddy";

const result = resolve({
  requested:   ["tool:read", "tool:grep"],
  parentGrant: ["tool:read", "tool:grep", "tool:write"],  // what the delegator holds
  ceiling:     ["tool:read", "tool:grep"],                // the definition's declared maximum
  gated:       ["tool:write"],                            // needs human approval, ever
});

assertNarrowing(result);                 // throws on a smuggled universal capability
const plan = planSpawn({ effective: result.effective, prompt: task });
// -> ["--print","--no-session","--no-extensions","--no-skills","--no-context-files",
//     "--no-prompt-templates","--tools","grep,read"," summarise src/"]

await appendRecord({ path: ".pi/grants.jsonl" }, buildRecord({ /* … */ result, blocked: false, now: new Date() }));
```

Subpaths are exported individually (`pi-daddy/resolve`, `/ledger`, `/spawn`, `/delegate`, `/catalog`,
`/propagation`, `/definitions`, `/fanout`, `/pi-tools`, `/approval`, `/approval-store`, `/approval-prompt`,
`/run-child`, `/run-herdr`).

## Design decisions worth knowing

- **A zero grant is `--no-tools`, never "no flag".** pi rejects an empty `--tools`, and omitting the flag
  silently falls back to pi's defaults — the opposite of a zero grant.
- **`--no-extensions` is always passed**, so ambient user extensions cannot widen a governed child. An
  explicit `-e` still loads, which is exactly why the extension is re-added by hand for a child that holds
  `tool:delegate`, and never otherwise.
- **Each resource class needs its own switch.** `--no-extensions` does not disable skills, context files or
  prompt templates; all three are passed explicitly, and `--skill` *adds* to the discovered set unless
  `--no-skills` goes with it. A granted skill is passed by path and refused if it cannot be located —
  granting a capability the child would silently lack is a lie in the ledger.
- **The ledger fails closed by default.** An unrecorded grant is a hole; `strict: false` only where the
  ledger is advisory.
- **Skills and definitions are capabilities too** (`skill:`, `agent:`), governed by the same machinery — but
  they are not `--tools` entries, so `toPiToolsAllowlist()` filters them out.
- **Rejection reasons never mask one another** — `denied` (escalation), `clipped` (ceiling), and
  `gatedBlocked` (needs approval) are computed independently and reported together, so a request with two
  problems does not report one and hide the other.

## Install

```bash
pi install npm:pi-daddy     # as a pi extension
npm i pi-daddy              # as a library (the resolver, ledger and spawn planner are pure)
npx pi-daddy init           # as a command: scaffold .pi/skills/ and .pi/grants.env from installed
                            # skill packages — see the worked example above
```

The package is all three. pi loads `extensions/grants.ts` through its own transpiling loader, which reads
TypeScript from `node_modules` quite happily; **Node does not** — it refuses to strip types under
`node_modules` — so the library entry points are compiled to `dist/`. Until 0.6.0 `exports` pointed at
`./src/*.ts`, and every consumer import failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` while
every in-repo test passed. `npm run test:smoke` packs a tarball, installs it into a scratch project and
*uses* it, so that gap cannot reopen silently.

## Testing

```bash
npm test                   # 353 unit tests. Fast, pure, no pi, no network.
npm run typecheck          # src + extensions + tests + integration tests
npm run test:integration   # 28 tests against a REAL pi process. ~40s, no model tokens.
npm run test:smoke         # pack, install into a scratch project, import and use it — and run the
                           # installed `pi-daddy init` bin, which is how R-73 was found
PI_GRANTS_IT_MODEL=1 npm run test:integration   # + 4 end-to-end tests with a real model. ~60s, costs money.
```

The resolver is a pure function, which is deliberate: it is the only place an escalation could be
introduced, so it is the only place needing exhaustive tests — and being pure, it can have them. Coverage
includes three-level transitive attenuation, approval-cannot-conjure-a-capability, empty vs. absent
ceilings, and the measured `fabric_exec` escalation.

**The integration suite exists because the extension is where the wiring bugs live** — every defect the live
probes ever found was there rather than in `src/`, and a pure test cannot see how configuration is *read*.
Its default tier drives slash commands, whose handlers run the real decision path over real `SKILL.md` files
in a real pi process **without a model deciding anything**, so it is deterministic and free. The opt-in tier
adds a model choosing to call tools, and asserts on structure (`isError`, the ledger JSON, whether a file
appeared on disk) rather than on model wording.

It earned itself immediately: its first run found that **every delegation refusal was being recorded by pi
as a success.** It is also checked against reintroduced defects, which is the point — restoring the G7 `NaN`
bug makes two of its tests fail, and the approval tests were verified by mutation (making an unpinned body
digest fail *open* fails exactly one test; deleting the body comparison fails three).

`test/file-size.test.ts` fails the build if any file in `src/` or `extensions/` exceeds 400 lines. It caught
its own author the day after it was added: rather than raise the cap, `delegation.ts` was split.

## Status

**0.14.0 — usable, and honest about scope.** What exists and is verified against real pi: the resolver, the
ledger with an integrity reader, the spawn planner, `SKILL.md` definitions with `allowed-tools` as an
enforced ceiling, `delegate` and `delegate_all` with a subtree budget, two executors, and human approval for
gated capabilities (once / session / always, inheritable down the tree, persisted for `always` and pinned to
both the tools and the instructions).

Known gaps, stated because a gap nobody wrote down is the one that surprises somebody:

- **`bash` escapes governance.** Out of scope by decision (ADR-0012).
- **`subagents:rpc:spawn` bypasses the tripwire.** Unfixable from here.
- **The ledger is verified at session start** when one is configured: a damaged trail announces itself, an intact one stays quiet.
- **Pane cleanup covers everything except being killed outright.** A run closes its pane in a `finally`,
  and anything still open is closed on process `exit` — which does **not** cover SIGKILL, nor a SIGTERM
  nothing else in the process is listening for, because Node runs no `exit` handlers there. `herdr tab
  close <id>` is the remedy. No signal handler is installed, deliberately: one here would suppress Node's
  default termination and turn pi's *"interrupt this turn"* into *"exit pi"* (R-62).
- **A definition's *instructions* are governed only by identity.** `agent:<name>` says which file may be
  spawned and the digest says which version ran, but nothing reads a body and judges what it says — the
  operator authorises a file, and its contents are their responsibility.
- **No background delegation.** `delegate` runs to completion and returns the child's output (ADR-0015).
  If one is ever built, ADR-0026 fixes the rule that blocked it twice: a background spawn whose gates are
  unresolved when its tool call returns is **refused**, and an approval arriving later starts nothing —
  otherwise a child's capability set would depend on when a human reached the dialog.
- **Whether persisted approvals earn their keep is still unmeasured.** `/grants ledger` now counts where
  every approval came from, so the question ADR-0020 left open has a command; what it does not have yet is
  a few weeks of real use to answer it.

`docs/SPEC.md` in the repository is the authoritative current-state document; the ADRs hold the reasoning.

Requires pi ≥ 0.83.0, Node ≥ 22.19. MIT.
