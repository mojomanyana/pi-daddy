# pi-daddy

**Capability governance for pi sub-agents.** A grant can only ever *shrink* as it passes down a delegation
tree, so a sub-agent can never hold more of the **tool surface** than its parent — enforced by **pi's own
`--tools` allowlist**, with an append-only ledger of what was granted and what was refused whenever one is
configured.

Both qualifiers are load-bearing and are not buried: a child granted `bash` can escape governance entirely
(ADR-0012, measured), and recording is opt-in — explicitly by environment or by running `/grants init` once
for this project. See *What this governs, and what it does not*.

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

## The three tools

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
- **A refusal is a tool *error*, not an answer.** All three tools throw, because `AgentToolResult` has **no
  `isError` field** — pi sets it only when `execute` throws, and a normal return is hardcoded
  `isError: false`. Until 0.5.0 the tool returned `isError: true`, which was silently discarded, so every
  refusal this package made was recorded by pi as a **successful** tool call. Found by the integration suite
  on its first run.
- **A child cannot outlive or overwhelm you.** Output is capped (1 MiB), there is a wall-clock timeout
  (`PI_GRANTS_CHILD_TIMEOUT`, default 1200s) with `SIGTERM` → `SIGKILL` escalation so a child cannot ignore
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

### Three ways to delegate

| Tool | Shape |
| :--- | :--- |
| `delegate` | one sub-agent |
| `delegate_all` | several **at once**, independent and unaware of each other |
| `delegate_chain` | several **in order**, each receiving the previous one's output |

A chain's handoff is wrapped in a labelled, **nonce-delimited** fence, so the previous agent's output arrives as
data — and because the nonce is minted after that agent finished, it cannot forge a closing delimiter to escape its
own fence. The label itself is framing and this README will not pretend otherwise; the nonce is the mechanism.

A legacy uncorrelated chain is **gated upfront**: every step is planned first, and every approval it needs is
asked for before the first step starts. Exact correlated steps gate only after their composed task exists;
binding a template and spending it on different generated instructions would be false assurance. One dialog
per capability and definition names the step that needs it. Decline an upfront gate and nothing runs. A step
that could never run refuses before anyone is asked; `Allow once` covers exactly the step it named. A failed
step stops the rest, and you still get everything completed—except `BLOCKED_CRITICAL_ASSURANCE`, which
remains a failed tool call. Each step spends one unit of the fan-out budget.

### Two executors, one plan

Either a captured child process, or a visible, attachable **herdr** pane — the same governed argv, the same
`--tools` enforcement, somewhere you can watch it.

**Which one runs is decided by a probe (ADR-0031).** `PI_GRANTS_HERDR` is three-state: **unset** probes once at
session start (`herdr tab list`, 2s bound) and uses panes if a server *answers*; **`1`** demands herdr and
**refuses every delegation** if it is unreachable, rather than quietly relocating; **`0`** demands subprocesses and
skips the probe. Which one was chosen is printed at session start, shown by `/grants`, and recorded per child in
the ledger.

Still **never auto-detected from `herdr` being on `PATH`** — a binary with no server behind it would make every
delegation fail at `tab create`, on a path nobody chose. Only a reachable server counts.

A child's pane goes in **your own herdr workspace** by default, so switching to one is a tab away. Constraints found by building it are in `docs/probes/g16-herdr` — herdr has
no `--env` (the grant rides on the pane, which the agent's shell inherits), `agent start` types argv into a
shell so a multi-line argument must be staged to a file, and `agent wait --until idle` matches the state the
agent was *already* in, so settling requires a state counter to advance.

### Persistent Herdr dashboard

When this pi process is itself hosted inside Herdr 0.8+, `/grants dashboard` opens a managed right split:

```text
PI-DADDY
◆ principal-feature · critical · declared
● plan       running   0:42 · pane w7:p13
└─ ⛔ deploy refused   0:00

depth 2 · 1 active
```

The plugin ships inside pi-daddy and is linked globally only after an explicit **Install and open** choice.
Literal **Not now** and **Never ask** choices are persisted; dismissing or losing the dialog stores nothing.
`/grants dashboard` never installs silently and prints the exact manual command when the plugin is absent. It
checks the bundled plugin root and protocol before suggesting that a disabled plugin be enabled. Panes and
ledgers stay workspace/tab-specific: reuse rechecks the pane's current workspace/tab, a wrong-host open is
closed and rejected, and malformed nested pane state refuses rather than risking a duplicate. A stored entry's
workspace/tab/ledger must also agree with its hash key before reuse. Invocation `cwd` sets the first pane
process directory but is not pane identity, so the same workspace/tab/ledger still reuses one pane across caller directories. Opening uses a right split targeted at this pi pane with `--no-focus`.

The view is a read-only ledger projection. Yellow is authorised/starting/running, green completed, red failed
or refused, and grey incomplete/historical. Old completed subtrees collapse; active ancestry stays visible.
It never displays task text, prompts, tool arguments, child output, or raw corrupt lines. Displayed ledger
values must satisfy the v3 identifier grammars (unsafe frozen-v2 values are redacted), and Unicode C1/bidi or
other control/format characters are removed before terminal output.

Provenance markers are explicit: **P** planned phase, **O** observed inline activity, **V**
controller-validated transition, **E** pi-daddy-enforced child, **D** caller-declared correlation. A principal
run can label itself through `run_id`, `phase`, effective assurance and `policy_label`; pi-daddy does not parse
principal workflow prose or invent pending/completed phases.

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

- **Legacy session/always approvals ride down the tree with the grant**, intersected with what each child
  actually receives, so `approved ⊆ grant` holds at every level. `once` is dropped. A correlated approval
  instead binds the exact definition, task, requested/effective sets, workspace/context and parent, and
  never crosses a delegation boundary — approval for one probe cannot become subtree authority.
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

## Runtime enforcement for external controllers (0.18.0)

All fields are optional; existing callers behave unchanged.

- `correlation` carries join-only run/task/workspace/context IDs, opaque policy metadata, base/head/tree SHAs
  and sequence floors. Supplied IDs/digests never authorize; trusted digests are computed separately.
- `workspace: {workspace_id, access}` resolves through `PI_GRANTS_WORKSPACE_REGISTRY`, validates a canonical
  Git worktree root, and sets initial CWD. A caller cannot label a write-capable grant read-only. Kernel
  util-linux `flock` allows one **pi-daddy-governed** writer per canonical root; `setpriv --pdeathsig` plus
  helper attachment stops the writer process or herdr tab on parent death before release. This does not confine paths or exclude unrelated writers; `bash` remains an escape.

  **BREAKING in 0.19.0 — routing now requires a capability.** A delegation naming `workspace_id: W` needs
  `workspace:W` in the caller's grant, or it is refused `WORKSPACE_NOT_AUTHORIZED`. Every grant that routes
  must add it: `PI_GRANTS_GRANT="tool:read,tool:delegate,workspace:W"`. `pi-daddy init` lists the registered
  ids commented in `.pi/grants.env`. A child can only route on to ids it was granted itself, so this is also
  the list of what any descendant could reach; `workspace:*` exists but is held and never inherited, which
  makes it the wrong answer for anything but a single-worktree setup. `PI_GRANTS_GATED=workspace:W` asks a
  human first. Enforced by pi-daddy before the spawn, not by pi's `--tools` — see `docs/SPEC.md` on the
  enforcement classes.

  **BREAKING in 0.19.0 — a registry id must match `[A-Za-z0-9][A-Za-z0-9._/-]*`.** An id is now the tail of a
  capability id, so it has to survive the grant grammar. **Slashes and dots are fine**, so a worktree named
  after its branch (`feature/x`) works. Refused, with the file and the id named: whitespace (it splits a
  definition's `allowed-tools`), commas and newlines (they split a grant), `*` (it collided with
  `workspace:*`), shell metacharacters (they reach a generated file you are told to paste from), non-ASCII,
  and `@ + % = ^ ! ? ~ { } [ ]` or a leading `_`, `-` or `.`. **One bad entry refuses the whole registry**, so
  rename before upgrading. The regex is the specification; that list is a summary.

  **Also new in 0.19.0:** the registry must be a **regular file under 1 MiB**. A FIFO or device there would
  block session start rather than fail, and the read is bounded so a file that grows after its size is checked
  is refused rather than allocated. What is *not* checked: ownership, permissions, and whether a descendant
  holding a write tool repointed an entry — routing attenuates by **id**, not by **destination**
  (`docs/probes/g37-registry-tamper`, tracked as R-137).
- Refusals retain current prose and add stable codes such as `CAPABILITY_ESCALATION`,
  `GATED_UNAPPROVED`, `APPROVAL_SCOPE_MISMATCH`, and `WORKSPACE_WRITE_CONFLICT`.
- Ledger v3 adds unique execution/parent identity, joinable capability/lease/lifecycle/check events, and
  provenance-labelled workflow facts while retaining frozen v2 and legacy readers.
- `pi-daddy/check-runner` selects an operator-named absolute executable+argv definition, never a shell
  command string. Check IDs use the v3 ASCII identifier alphabet and are refused before execution if they do
  not fit their generated receipt identity. It strips sensitive inherited environment, enforces timeout/output caps, executes a
  private copy of the exact executable bytes it hashed, and pre/post-verifies Git head/candidate-tree
  identity under an exclusive coordination lease. The executable remains arbitrary code; no filesystem or
  network sandbox is claimed.

Public subpaths: `pi-daddy/correlation`, `pi-daddy/refusals`, `pi-daddy/workspace`,
`pi-daddy/check-runner`.

### Canonical ledger v3 contract

Machine consumers should import or resolve
`pi-daddy/contracts/ledger/v3/ledger-event.schema.json`, not infer a format from prose. Generated fixtures for
all five events are adjacent. v3 adds globally unique `executionId`, explicit `parentExecutionId`, bounded
start deadlines, optional Herdr pane identity, and provenance-labelled workflow facts. `childId` remains the
readable logical tree position and is never an occurrence join.

Dispatch on version before event: no version/discriminator is a legacy 0.17 grant record; explicit v2 uses the
frozen published v2 contract; explicit v3 uses the new closed contract; every other explicit version fails
closed and is never read as legacy. `verifyLedger` and the dashboard share exact runtime v3 validation, so a
lookalike string version, missing join identity or malformed nested correlation cannot be `OK` in one and
corrupt in the other. Explicit v2 is checked against its exact frozen schema before the dashboard labels it
historical; malformed v2 never becomes a grey row or orphan count. A field/event/enum/requiredness or semantic change requires another ledger version. See
`contracts/ledger/v3/README.md`; the v2 path remains available unchanged.

## Running it

```bash
# `agent:` ids say WHICH definitions this session may spawn (0.8.0); `tool:` ids say what it may grant them.
PI_GRANTS_GRANT="agent:review,tool:read,tool:grep,tool:find,tool:ls,tool:delegate" \
PI_GRANTS_LEDGER=.pi/grants.jsonl \
PI_GRANTS_MAX_DEPTH=2 \
pi
# The relative ledger is resolved once at session start and inherited as one absolute path,
# so routed descendants changing cwd still append to this tree.
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

`/grants dashboard` verifies that this exact pi PID is hosted in its declared Herdr pane, verifies the ledger
and plugin, then opens or reuses a right split without changing focus. `/grants ledger` reads the audit file
back and reports its integrity — record count, escalation attempts, any unparseable lines with line numbers
and content-free reasons (never copied ledger bytes), and **which instructions actually ran**: records grouped by definition
digest, each compared against the file on disk (`current` / `CHANGED since`), which is what makes ADR-0018's
`definitionDigest` answerable rather than decorative. It exists because nothing in this package had ever read a ledger
back, so a torn line was indistinguishable from a spawn that never happened. A corrupt line is **evidence**
and is left alone rather than repaired. Session start checks integrity automatically; `/grants ledger` gives
the full report.

## Worked example: governing `principal-pi-skills`

The abstract examples above use invented definitions. This one uses the seven skills people actually have
installed. Every transcript below is **copied from a run**, not retyped — the run is
`docs/probes/b2-init-principal-pi-skills` (2026-08-17, `principal-pi-skills@2.3.1`, pi 0.84.1), and where
this section abridges output it says so.

```bash
pi install npm:pi-daddy
pi install npm:principal-pi-skills
pi                      # then, inside pi:
/grants init
```

**`pi install`, not `npm install`** — it registers the package with pi, which is what makes the extension
auto-load; presence in `node_modules` alone does nothing. `/grants init` asks only about the capabilities
that can change your machine and applies the answer to the running session, no restart (ADR-0030). That one
project opt-in now also enables `.pi/grants.jsonl` immediately and for every later plain `pi` start
(ADR-0037), so `/grants ledger` and `/grants dashboard` need no shell export. Merely installing the package
does not initialize unrelated directories. `npx pi-daddy init` does the same scaffolding from a shell, and
both search pi's install root as well as the project's. A pre-0.21 stored grant is not retroactive recording
consent; run `/grants init` once after upgrading to enable its default ledger.

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
| `PI_GRANTS_GRANT` | unset → use this directory's stored init choice, or ungoverned when none exists | Presence switches governance on and bypasses the whole cwd store; this is how children and CI stay environment-only. |
| `PI_GRANTS_MAX_DEPTH` | `2` | Child-depth bound. `0` disables spawning. |
| `PI_GRANTS_DEPTH` | `0` | This session's own depth; set by the parent, not by hand. |
| `PI_GRANTS_GATED` | **`tool:bash`** in a governed session | Capabilities needing human approval. Set to `""` to gate nothing. Gating is closed under subsumption, so this also covers `write`/`edit`/`read`/`grep`/`find`/`ls` (ADR-0012). |
| `PI_GRANTS_APPROVED` | unset | Inherited `capability@subject#sha256` entries; set by the parent, clamped to the child's own grant, and honoured only against the definition body the child itself loaded (ADR-0022). |
| `PI_GRANTS_APPROVAL_TIMEOUT` | `120` (seconds) | How long a dialog waits. `0` or an unreadable value means **no timeout**: waiting forever denies nothing, so it is the safe reading of a value we do not understand. |
| `PI_GRANTS_LEDGER` | unset → a v2 `/grants init` choice uses `<cwd>/.pi/grants.jsonl`; otherwise not recording | Presence overrides the project default; `""` disables it for one run. Any effective path is load-bearing. |
| `PI_GRANTS_WORKSPACE_REGISTRY` | unset | Operator-owned `{version:1, workspaces:{id:{path}}}` file, required only for workspace-routed spawns. |
| `PI_GRANTS_WORKSPACE_LEASE_DIR` | under `$PI_CODING_AGENT_DIR/pi-daddy/` | Kernel writer locks and ownership metadata. |
| `PI_GRANTS_CHILD_TIMEOUT` | `1200` (seconds) | Wall-clock limit for a child. Inherited by descendants — an operator preference, deliberately *not* attenuating state. |
| `PI_GRANTS_ALLOW_UNRESOLVED_MODELS` | unset | Exact `1` lets pi attempt custom model resolution; otherwise an explicit provider/id missing from pi's session catalogue refuses before lease, approval or spawn. |
| `PI_GRANTS_FANOUT` | `8` | Per-call width and downward subtree budget; not a session-total counter. Malformed or `0` falls back to the default. |
| `PI_GRANTS_PARENT_ID` | `d0` | Readable logical tree position; set by the parent and allowed to repeat across calls. |
| `PI_GRANTS_EXECUTION_ID` | unset at a root | Unique governed execution occurrence; set by the parent. Lifecycle/lease joins use this, never `PI_GRANTS_PARENT_ID`. |
| `PI_GRANTS_HERDR` | unset ⇒ **probe** | Three-state. Unset probes for a reachable herdr and uses panes if one answers; `1` demands panes and refuses every delegation if herdr is unreachable; `0` demands captured subprocesses. Never detected from `herdr` merely being on `PATH`. |
| `PI_GRANTS_HERDR_WORKSPACE` | the parent's `HERDR_WORKSPACE_ID` | herdr workspace for spawned panes. Defaults to the workspace this session is in, so a child is a tab away rather than a workspace away. |
| `PI_GRANTS_HERDR_KEEP_PANE` | unset | `1` keeps each child's pane for inspection, and no sweep closes it. Off by default: a fan-out would flood the workspace. |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi's own variable, not ours — but it decides where stored project grants/ledger consent and persisted approvals live. |

**A malformed value disables spawning; it never falls back to a default.** Stored grants are likewise
tri-state: only a missing file is opt-out; malformed, unsupported-version, unreadable or wrong-cwd state is a
loud empty-grant session with a `GRANT_STORE_INVALID` ledger line. An unreadable
`PI_GRANTS_MAX_DEPTH` or `PI_GRANTS_DEPTH` yields `maxDepth: 0` and a startup warning naming the
variable. Before 0.5.0 these were read with `parseInt`, which accepts numeric prefixes (`"2abc"` → `2`)
and otherwise gives `NaN` — and since every comparison against `NaN` is false, a typo did not tighten the
depth limit, it **removed** it.

**Configuring a ledger makes it a precondition, not a log.** This applies equally to an explicit
`PI_GRANTS_LEDGER` and to the project default accepted through `/grants init`: if the write fails, delegation
is **refused**. Asking for an audit trail is an explicit act, and `ledger.ts` has always documented that an
unrecorded grant should fail closed; until 0.5.0 both call sites silently swallowed the error. Legacy v1 grant
stores and sessions with no ledger configured are unaffected. Concurrent appends are serialised by a lock file
with a short timeout — failing closed beats hanging — and a lock abandoned by a killed process is broken after
10s.

## The ledger

Append-only JSONL. Version 3 records capability decisions, workspace leases, child lifecycle, check receipts
and workflow facts. Every per-child capability decision is present, **including refusals**. The reader still
accepts frozen v2 and legacy grant-only lines.

`childId` is hierarchical and readable (`d0.1`, `d0.1.2`) but repeated/parallel calls may reuse it. v3 adds a
random `executionId` and explicit `parentExecutionId`; those are the only lifecycle/lease occurrence join.
A v2 lifecycle is therefore shown historical/unjoined rather than guessed. A v3 starting deadline and the
executor timer share one absolute budget — waiting for the strict starting append consumes it, a later running
event cannot replace it, and process SIGTERM grace stays inside it under an independent hard-kill timer. That
timer bounds the governed PID while live. Soft and hard deadline callbacks first allow one event-loop turn for
pending child exit delivery; retained descendant pipes cannot rewrite a PID that already exited successfully as
timed out. A pending running append always lands before a terminal event. `denied` non-empty remains the designated escalation signal — **an agent asking for what it does not hold is an escalation attempt, and it
is invisible without a record.**

Workflow facts are identifier-only and mark `planned`, `observed`, or `controller_validated`; they can never
claim pi-daddy enforcement. Capability/lifecycle records are the enforced class. Correlation remains
caller-declared: optional `schema_version` is exactly `1.0`, and `assurance_scope` is either entire-run with an
empty selector list or selectors with one or more non-empty strings. Fields eligible for display use the v3
ASCII identifier grammar rather than prose.

**Privacy is a property of this file, and the boundary is exact: capability ids, counts and identifiers only
— never prompts, task text, tool arguments or results.** Trusted `definitionDigest` and `taskDigest` values
identify the exact operator body and task. A predictable task can be guessed from SHA-256, so its digest is
sensitive/linkable metadata, not anonymization. Caller-supplied digest-looking values remain under
`correlation` and never authorize. Public v3 builders validate their serialized wire form against the same
closed runtime contract the readers use; `deadlineAt` therefore cannot be a `Date.parse` lookalike. Schema and
runtime share the seconds `00`–`59` timestamp profile because JavaScript deadline arithmetic cannot represent
leap seconds, and a normalized-away top-level null assurance scope is not schema-valid.

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
import { resolve, assertNarrowing, planSpawn, buildRecord, appendRecord, digestTask, newExecutionId } from "pi-daddy";

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

await appendRecord({ path: ".pi/grants.jsonl" }, buildRecord({
  /* capability fields … */ result, blocked: false, executor: "process",
  executionId: newExecutionId(), parentExecutionId: null, taskDigest: digestTask(task), now: new Date(),
}));
```

Subpaths are exported individually (`pi-daddy/resolve`, `/ledger`, `/spawn`, `/delegate`, `/catalog`,
`/propagation`, `/definitions`, `/fanout`, `/pi-tools`, `/approval`, `/approval-store`, `/approval-prompt`,
`/run-child`, `/run-herdr`, `/dashboard-projection`, `/dashboard-render`).

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

The package is also the source of the optional Herdr plugin: the extension offers to link the trusted
`herdr-plugin/` directory explicitly, and `pi-daddy-dashboard` is the terminal renderer binary. pi loads
`extensions/grants.ts` through its own transpiling loader, which reads
TypeScript from `node_modules` quite happily; **Node does not** — it refuses to strip types under
`node_modules` — so the library entry points are compiled to `dist/`. Until 0.6.0 `exports` pointed at
`./src/*.ts`, and every consumer import failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` while
every in-repo test passed. `npm run test:smoke` packs a tarball, installs it into a scratch project and
*uses* it, so that gap cannot reopen silently.

## Testing

```bash
npm test                   # 739 unit tests. Fast, pure, no pi, no network.
npm run typecheck          # src + extensions + tests + integration tests
npm run test:integration   # 48 tests against a REAL pi process/Herdr server, no model tokens.
npm run test:smoke         # pack/install; exercise library exports, both bins, the v2/v3 contracts,
                           # bundled Herdr plugin, dashboard, and `pi-daddy init`
PI_GRANTS_IT_MODEL=1 npm run test:integration   # + 10 end-to-end tests with a real model. Costs money.
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

**0.20.0 — live Herdr dashboard and ledger v3.** Adds the explicit installation handshake,
`/grants dashboard`, duplicate-safe right split, pure live projection, unique execution/parent identity,
workflow provenance facts and principal correlation labels. Enforcement is unchanged.

**0.19.0 — workspace routing is a capability.** Routing now attenuates through `workspace:<id>`; see the
changelog for the breaking migration.

**0.18.1 — security fix for malformed capability IDs.** Capability IDs containing comma, CR, LF, NUL or
surrounding whitespace are refused before resolution and again before grant serialization, preventing a
wildcard-covered string from splitting into authority the parent never held.

**0.18.0 — generic runtime enforcement, still honest about scope.** The governed spawn path now includes
optional correlation, exact task-bound approvals, registered-worktree CWD validation, OS-backed governed
writer leases, structured refusals, lifecycle/lease ledger events, and a no-shell named-check subpath. All
new spawn fields are optional; legacy callers retain their behavior.

Known gaps, stated because a gap nobody wrote down is the one that surprises somebody:

- **`bash` escapes governance.** Out of scope by decision (ADR-0012); workspace routing and leases do not contain it.
- **A workspace lease coordinates only pi-daddy-governed writers.** It is not a filesystem sandbox and cannot stop unrelated processes. The measured writer path currently requires util-linux `flock`.
- **A named check is arbitrary code without shell interpolation.** It may write, use the network, invoke a shell or leave descendants; no OS containment is claimed.
- **`subagents:rpc:spawn` bypasses the tripwire.** Unfixable from here.
- **The ledger is verified at session start** when one is configured: a damaged trail announces itself, an intact one stays quiet.
- **A pane outlives its tool call only if its child settled.** A child that answered keeps its pane so you can
  read it, and it is swept when you get your prompt back (`agent_settled`), with process `exit` as a backstop. A
  child that did **not** settle — timeout, abort, failed start — loses its tab at once, because closing the tab is
  the only way to stop a herdr agent (`herdr agent stop` does not exist). At most 8 panes are open at once, and
  only *settled* ones are ever reclaimed: if they are all live the cap yields rather than killing a child.
- **Pane cleanup does not cover being killed outright.** SIGKILL, and a SIGTERM nothing else is listening for,
  run no `exit` handlers — by Node's design — so a pane can be orphaned; `herdr tab close <id>` is the remedy. No
  signal handler is installed, deliberately: one here would suppress Node's default termination and turn pi's
  *"interrupt this turn"* into *"exit pi"* (R-62, re-rated M×L now that panes are the default path).
- **A running delegation is visible.** One status block per call — per child: its definition, its herdr agent, its
  pane id, its state, elapsed time, and the last three lines it printed. Bounded in height and width, so a fan-out
  cannot flood your screen. It is a **display, never the result**.
- **The dashboard whole-file polls.** The MVP is sized for 10 MiB; 50 MiB or 100 ms p95 projection is the
  switch point for incremental replay.
- **v2 is historical in the dashboard.** It has no unique occurrence ID, so lifecycle is reported unjoined
  rather than matched by reusable `childId`.
- **principal-pi-skills does not yet publish a generated graph declaration.** Explicit correlation and
  provenance facts render; prompt prose is never parsed into a graph.
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
