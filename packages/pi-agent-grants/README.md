# pi-agent-grants

**Capability governance for pi sub-agents.** A grant can only ever *shrink* as it passes down a delegation
tree, so a sub-agent can never confer more than it holds — enforced by **pi's own `--tools` allowlist**, with
an append-only ledger of what was granted and what was refused.

Built because that guarantee does not exist elsewhere. `@tintinweb/pi-subagents` provisions statically per
agent type; `pi-fabric` provisions dynamically but **cannot constrain a recursive child at all** (measured:
`docs/probes/pi-fabric-eval`).

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

Depth control falls out for free: spawning is itself a capability. Withhold `agent:`/`tool:Agent` and the
child is a leaf.

## Why pi's `--tools` is the enforcement point

Measured, not assumed (probes 9–11 in `docs/probes/pi-fabric-eval`):

- `pi --tools read -e npm:pi-fabric` → the model **cannot** call `fabric_exec`.
- `pi --no-tools -e npm:pi-fabric` → likewise blocked.
- No flag → `fabric_exec` works.

So pi core hard-blocks extension tools, and an explicitly `-e`-loaded extension **cannot re-add its own tool
past the allowlist**. That is why this package needs no runtime inside the descendant: it computes the
allowlist and hands it to pi.

## What an agent type's ceiling actually is

Since 0.5.0 (**ADR-0013**) the ceiling is computed to match what `@tintinweb/pi-subagents` really builds,
rule for rule, because a ceiling that disagrees with the spawner is not a conservative approximation — it
is a **wrong audit record**, and the old disagreement ran in the permissive direction.

| `tools:` in the type's frontmatter | Ceiling |
| :--- | :--- |
| **absent** | every built-in — **not** the wildcard. `csvList` returns its defaults |
| `none` / empty | nothing |
| `*` / `all` | every built-in, plus any plain entries |
| CSV, inline array, **or YAML block list** | those entries |
| only `ext:` entries | zero built-ins, those selectors |

**The block-list case was the bug.** The old reader treated `tools:\n  - read\n  - grep` as an *absent*
key, absence meant the wildcard, and with a wildcard delegator the spawn was allowed while the ledger
recorded `effective: ["tool:*"]` for a child that actually held two tools.

**Identity comes from the filename**, as `pi-subagents` does (`basename(file, ".md")`); the frontmatter
`name` is ignored. Trusting it let our registry and the spawner disagree about which definition a type
refers to.

**And the ceiling is not just `tools:`.** `extensions:` defaults to true, so most types also inherit the
session's extension tools — those are part of the ceiling too. If that surface cannot be enumerated, the
ceiling is the wildcard: an un-enumerated inheritance cannot be honestly bounded, and an under-counted
ceiling is one that gets *allowed*.

> **Known limit, measured.** None of this makes the interceptor a provisioning path. `pi-subagents` has no
> `tools` parameter on its `Agent` tool or in `SpawnOptions`, its registry is unreachable from another
> extension, and its cross-extension RPC has no config query — so **refuse-or-allow remains the ceiling on
> that path**. See `docs/probes/g13-subagents-coupling` and the upstream ask in
> `docs/proposals/pi-subagents-tools-parameter.md`.

## Universal capabilities

`fabric_exec` is treated as **universal** — granting it is equivalent to granting the whole catalog, because
it reaches `pi.write`, `pi.bash`, and unrestricted `agents.run`. This is measured, not theoretical: a child
granted `tools: []` (nothing at all) plus `recursive: true` still spawned a grandchild that wrote to disk.

`assertNarrowing()` therefore **throws** if a supposedly narrow grant contains one. A narrow grant with
`fabric_exec` in it is full authority wearing a narrow grant's clothing.

**Since 0.5.0 (ADR-0011), every path refuses one — including the interceptor.** Before that, the concept
was handled three different ways: `delegate` refused, while the interceptor either silently stripped the
capability from the ledger entry (wildcard delegator) or silently passed it through (enumerated grant).
The stripping was cosmetic and is gone: `effective` is a **record** on the interceptor path, not a
provisioning instruction, so filtering it changed the audit entry while the child still received
`fabric_exec`. A line that looks like enforcement but only edits an audit record is worse than no line.

A related consequence: no approval dialog is raised for a spawn that retains a universal capability.
`assertNarrowing` refuses it whatever the human says, so asking was worse than useless — a `session`- or
`always`-scoped *yes* given there was banked and reused for later spawns that **did** proceed.

For v1 a delegator that legitimately holds `fabric_exec` and knowingly wants a child to have it **cannot**
spawn that child. `assertNarrowing`'s `allowUniversal` flag exists but is deliberately not plumbed through
`decideSpawn`; the first real need for that override is the evidence it should be added.

## Use

```ts
import { resolve, assertNarrowing, planSpawn, buildRecord, appendRecord } from "pi-agent-grants";

const result = resolve({
  requested:   ["tool:read", "tool:grep"],
  parentGrant: ["tool:read", "tool:grep", "tool:write"],  // what the delegator holds
  ceiling:     ["tool:read", "tool:grep"],                // agent-type frontmatter maximum
  gated:       ["tool:write"],                            // needs human approval, ever
});

assertNarrowing(result);                 // throws on a smuggled universal capability
const plan = planSpawn({ effective: result.effective, prompt: task });
// -> ["--print","--no-session","--no-extensions","--tools","grep,read", task]

await appendRecord({ path: ".pi/grants.jsonl" }, buildRecord({ /* … */ result, blocked: false, now: new Date() }));
```

`result.denied` is the field that earns the ledger: **an agent asking for what it does not hold is an
escalation attempt**, and it is invisible without a record.

## Intercepting spawns (wired into `@tintinweb/pi-subagents`)

The extension hooks pi's `tool_call` and refuses any `Agent` spawn whose agent type would hold more than
the current session holds, or that exceeds the depth bound.

```bash
PI_GRANTS_GRANT="tool:read,tool:grep,tool:find,tool:ls" \
PI_GRANTS_LEDGER=.pi/grants.jsonl \
PI_GRANTS_MAX_DEPTH=2 \
pi -e ./extensions/grants.ts
```

`/grants` shows the session's grant, its depth, and an allow/block verdict per known agent type.

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
| `PI_GRANTS_LEDGER` | unset → not recording | **Setting this makes the ledger load-bearing** — see below. |
| `PI_GRANTS_CHILD_TIMEOUT` | `600` (seconds) | Wall-clock limit for a `delegate` child. Inherited by descendants. |

**A malformed value disables spawning; it never falls back to a default.** An unreadable
`PI_GRANTS_MAX_DEPTH` or `PI_GRANTS_DEPTH` yields `maxDepth: 0` and a startup warning naming the
variable. Before 0.5.0 these were read with `parseInt`, which accepts numeric prefixes (`"2abc"` → `2`)
and otherwise gives `NaN` — and since every comparison against `NaN` is false, a typo did not tighten the
depth limit, it **removed** it.

**Configuring a ledger makes it a precondition, not a log.** If `PI_GRANTS_LEDGER` is set and the write
fails, the spawn or delegation is **refused**. Asking for an audit trail is an explicit act, and
`ledger.ts` has always documented that an unrecorded grant should fail closed; until 0.5.0 both call
sites silently swallowed the error. Sessions with no ledger configured are unaffected.

### Verified live against real agent types

Using the author's own `~/.pi/agent/agents/*.md`, with the grant set to pi's real default surface
(`tool:read,tool:bash,tool:edit,tool:write`):

| Spawn | Result |
| :--- | :--- |
| `plan` (`read, grep, find, ls`) | **allowed** — bash subsumes grep/find/ls; subagent ran and returned `PLAN_OK`. Ledger: `effective:[find,grep,ls,read]`, `denied:[]` |
| `debug` (**no** `tools:` key) | **blocked** — `agent type "debug" declares no tools: allowlist, so it would receive pi's full toolset; the delegator does not hold tool:*` |
| `review` from a read-only parent | **blocked** — `requires tool:bash … (capability escalation blocked)`; ledger records `denied:["tool:bash"]` |

A type with no `tools:` key is treated as requesting the wildcard, so it is blocked for any delegator that
does not explicitly hold `tool:*`. Absence of a restriction is the dangerous case, so it fails closed.

## Governed delegation — the `delegate` tool (provisioning)

The interceptor above can only permit or refuse someone else's spawn. The `delegate` tool **provisions**:
the grant is an argument, so the orchestrator hands each child exactly the capabilities it should have.

```
delegate({ task: "summarise src/", tools: ["read"] })
```

- **You cannot grant what you do not hold.** Refusals name the capability and are recorded.
- **Spawning is itself a capability.** Grant `delegate` and the child can sub-delegate; withhold it and the
  child is a leaf — the extension is only passed to children that hold it, so the machinery isn't even
  present. Depth control needs no separate mechanism (`maxDepth` remains as a backstop).
- **A refusal is a tool *error*, not an answer.** `delegate` throws on refusal, because `AgentToolResult`
  has **no `isError` field** — pi sets `isError` only when `execute` throws, and a normal return is
  hardcoded `isError: false`. Until 0.5.0 the tool returned `isError: true`, which was silently discarded,
  so every refusal this package made was recorded by pi as a **successful** tool call. Found by the
  integration suite on its first run.
- **A child cannot outlive or overwhelm you.** Output is capped (1 MiB), there is a wall-clock timeout
  with `SIGTERM` → `SIGKILL` escalation so a child cannot ignore its way past it, an abort is honoured
  even if it arrived before the spawn, and a child that exits non-zero, times out or is cancelled comes
  back as a **tool error naming which** — not as an answer. See `src/run-child.ts`.
- **No propagation race, structurally.** Each child is spawned with its **own explicit `env` object**, so
  nothing per-child is written to the shared `process.env`. The child's environment is built by stripping
  every `PI_GRANTS_*` variable from this process's own environment and then applying the plan, so the plan is
  the only source of all of them — an omitted key cannot let the parent's own value through. The
  interceptor's constraint — only parent-level facts may be pushed, because that channel is global — does not
  apply when we own the spawn.

### Verified live

| Scenario | Result |
| :--- | :--- |
| Holds `read,bash,edit,write,delegate`; delegates `tools:["read"]`; child told to write | Child: *"I don't have a write tool available. My available tools are: `read`"* — **no file created** |
| Holds `read,delegate`; tries `tools:["read","write"]` | `delegation refused: cannot grant tool:write — this session does not hold it (capability escalation blocked)`; ledger `denied:["tool:write"]` |

## Approving a gated capability

> **0.6.0 changed where approvals live and what crosses a boundary (ADR-0014).**
>
> **The store moved out of the workspace**, to `$PI_CODING_AGENT_DIR` (default `~/.pi/agent/`). It used to
> sit at `<cwd>/.pi/grants-approvals.json`, which was self-defeating in this package's own recommended
> configuration: `PI_GRANTS_GATED=tool:write` means *"may use write, may not pass it down without a
> human"* — and **a session that may use `write` can write the approvals file**. Forged entries produced
> a ledger line reading `approvalSource: "persisted"`, indistinguishable from a real approval.
>
> A legacy in-workspace file is **ignored, not migrated**, with a warning naming it. Importing it would
> import exactly the entries the move exists to stop trusting. Re-approve when next asked.
>
> **`PI_GRANTS_APPROVED` now carries `capability@subject` pairs**, and `once` never crosses a boundary.
> Previously the scope a human chose was discarded one hop down, so *"Allow once"* was inherited by an
> entire descendant subtree, and a `<delegate>`-subject approval matched *any* subject. This is a
> **breaking change** to the propagation format between versions.
>
> **This does not defend against a child holding `bash`** — see ADR-0012, which accepts that such a child
> escapes governance entirely. The point is to close the self-defeating case, not to claim a boundary the
> package does not have.

`gated` capabilities are ones a session holds but may not pass on without a human saying so. They used to
just refuse — this version adds the yes. Refusing before this could not be revisited; the underlying
resolver has always computed `gatedBlocked` and `approved`, but nothing ever filled `approved`.

```
grants: approve tool:write for docs-writer?
  task: fix the docs typos

> Deny
  Allow once
  Allow for this session
  Always allow in this project (30 days)
```

- **`always` is offered only on the interceptor path**, where the subject is an agent type — a `.md` file
  the user wrote, so it names something the human controls. The `delegate` tool's only subject would be a
  task string and a tool list, both chosen by the model — and a key the model controls is not a key, so
  `delegate` offers only deny / once / session and never persists.
- **An approval rides down the tree with the grant**, intersected with what each child actually receives at
  every hop. So `approved ⊆ grant` holds at every level, the same way `effective ⊆ parentGrant` already
  does for grants: an approval unblocks part of a grant, it can never widen one.
- **`--print` and background runs have no interactive user**, so they refuse with a reason naming the fix.
  This is pi's own behaviour, not ours — non-interactive modes install a no-op UI context whose `select`
  resolves `undefined`, so a background delegation hitting a gate is refused, not hung.
- **Persisted approvals live in `.pi/grants-approvals.json`**, expire after 30 days, and are void once their
  agent type's `tools:` line changes — a confused-deputy fix, since the key names a file whose contents can
  change after approval. They are also **ignored entirely in any directory other than the one they were
  approved in**, so a committed approvals file authorises nobody who clones the repo (R-27).
- **The ledger distinguishes three flavours of "no"**: `denied` (an agent asked for more than it holds — an
  escalation attempt), `humanDenied` (a person was asked and declined — working as designed), and
  `gatedBlocked` with no `approvalSource` (nobody was there to ask — an operator should pre-approve).
  `humanDenied` is set only for a genuine decline, never for a dismissal, a timeout, or a dialog error —
  those get their own outcome kinds so a caller can tell them apart.

```
/grants approvals                        list them, with why any are being ignored
/grants revoke tool:write@docs-writer    take one back
/grants revoke --all
```

### Verified live

Against pi 0.83.0 with a real `docs-writer` agent type (`tools: read, write`) and `PI_GRANTS_GATED=tool:write`.
Dialogs were driven through `pi --mode rpc`, which is the same `ctx.ui.select` call the TUI dialog serves —
the TUI's own rendering was not exercised.

**Where the evidence lives.** `docs/probes/approval-ux` holds the full transcripts for the first eight rows,
as a record of that run. The last three rows — the re-verification after the two defects below were fixed,
the gated-alongside-unheld case, and `delegate` with no explicit `model` — were confirmed in later runs
whose fixtures were throwaway, so they are **not reproducible from this repository**. The probe's
`drive.mjs` and its "How to rerun" section are enough to reconstruct them.

| Scenario | Result |
| :--- | :--- |
| Dialog, **Allow once** | Sub-agent ran (`DOCS_OK`); ledger `approvalSource:"prompt"`, `approvalScope:"once"`; **no** approvals file written |
| Dialog, **Deny** | `grants: blocked spawn — tool:write was denied by a human`; ledger `humanDenied:true` with `denied:[]` |
| `pi --print` (no human) | `tool:write requires approval and this session has no interactive user (mode: print). Pre-approve it…`; ledger has `gatedBlocked` and **no** `humanDenied`; no approvals file created |
| **Always allow**, then a fresh process | Entry persisted with a 30-day expiry and `grantAtApproval`; the new process asked nobody — ledger `approvalSource:"persisted"` |
| `/grants revoke tool:write@docs-writer` | File emptied; the very next process prompted again |
| Approvals file **copied to another directory** | `(ignored) tool:write@docs-writer — foreign-cwd`, and `docs-writer` still blocks there — while the same bytes stay valid in the original directory |
| Agent type's `tools:` line **changed** after approval | `(ignored) tool:write@docs-writer — type-changed`; the next spawn prompted again |
| Inherited approval (`PI_GRANTS_APPROVED`), **interceptor** path | Depth-2 spawn allowed with no prompt; ledger `approved:["tool:write"], approvalSource:"inherited"` |
| Inherited approval, **`delegate`** path (child re-delegates to a grandchild) | Grandchild allowed at depth 2 under the inherited approval, with `approvalSource:"inherited"` recorded. The run that first exercised this found the record missing; **fixed and re-verified** — see below |
| Gated capability requested alongside one this session does not hold | Spawn refused for the unheld capability with **no dialog** — driver armed with *Always allow*, no `SELECT` emitted, no approvals file created |
| `delegate` with no explicit `model` | Child started and returned its output (`exitCode: 0`) on the session's own provider-qualified default |

**The two defects this table's first run exposed are fixed.** They are named here because the probe record
(`docs/probes/approval-ux`) describes the run as it happened and must not be rewritten:

1. **Inherited approvals were unrecorded on the `delegate` path.** `delegate.execute` pre-filled
   `approved: inheritedApprovals` into the *first* `planDelegation` call, so `resolve()` returned an empty
   `gatedBlocked`, the approval flow never ran, and `buildRecord` received no `approvalSource`. It was an
   auditability gap, never an escalation — `approved ⊆ grant` held at every hop — but ADR-0010 names the
   per-level `approvalSource:"inherited"` record as the compensating control for inheritance reaching down a
   subtree. The pre-fill is gone; both paths now resolve approvals the same way and both record the source.
2. **`delegate`'s default child model was a bare id.** `ctx.model?.id` carries no provider, `planSpawn`
   emitted `--model <id>`, and pi could resolve that to a provider the user has no key for — so every
   delegation without an explicit model died at child startup. The default is now
   `` `${ctx.model.provider}/${ctx.model.id}` ``, and the tool's `model` parameter documents that form.

**One consequence of `cwd`-matching plus lazy pruning, worth knowing before it surprises you.** Entries are
validated on read but only pruned on write, and a write rewrites the file with the valid set alone. So in a
checkout where the approvals file arrived from somewhere else — committed, or copied — the first `always`
approval a developer gives silently deletes every other developer's `foreign-cwd` entry. Harmless: those
entries authorised nothing in this directory in the first place, and their owners' own checkouts are
untouched. But the file does shrink without anyone asking it to.

### Enforce, not provision — the interceptor's limit

`pi-subagents`' `Agent` tool has **no `tools` parameter**: a delegator picks a `subagent_type` whose
capability set is fixed in that type's file. So this interceptor decides whether a spawn is *permissible*
and blocks it otherwise; it cannot hand a child a narrower set than its type declares. That is still the
security property — a spawn exceeding the delegator's grant never happens — and adding a `tools` parameter
upstream is what would turn enforcement into provisioning.

Because refusal is the only lever this path has, two cases that used to be allowed now block outright
(both new in 0.5.0, ADR-0011):

- **The agent type declares a universal capability.** Refused, whether the delegator holds an enumerated
  grant or `tool:*`. The interceptor cannot hand the child a narrower set, so allowing the spawn means
  handing over the whole catalog.
- **The agent type requires approval for a gated capability and the delegator holds `tool:*`.** The
  wildcard branch used to return before the gated check ran, so an operator who set `PI_GRANTS_GATED`
  without `PI_GRANTS_GRANT` got a gate that silently did nothing. **A gate is the operator's, not the
  delegator's**: holding the wildcard is authority to grant widely, never authority to skip a human.

  **Known rough edge, verified live** (`docs/probes/adr-0011-universal`, Finding 1): on the wildcard path
  this is a *hard refusal*, not a prompt. The message says "requires approval" but no dialog is offered,
  because that branch returns before a `ResolveResult` exists for the approval flow to act on. It fails
  closed and is safer than the silent pass-through it replaced, but there is no way to give the approval
  it names — grant an enumerated `PI_GRANTS_GRANT` instead of `tool:*` if you want the dialog. Awaiting a
  decision; see the probe.

### Propagation is race-free by construction

An earlier version wrote each child's computed grant into `process.env` inside the `tool_call` handler.
The environment is process-global, so concurrent spawns could read each other's values — a real hole.

The fix removes the need for a per-child channel rather than building one:

1. **Everything pushed down is a parent-level fact** — the parent's own grant, the child depth
   (`parent + 1`), and the configured bounds. Identical for every sibling, so there is nothing to race on.
   The environment is written **once**, before any spawn can occur, and never mutated per spawn.
2. **Each child derives its own grant on arrival**: `inheritedGrant ∩ ownObservedTools`, where the observed
   set comes from the `tools` array of its first provider request — authoritative, because it is exactly
   what pi sent the model. (A session's first provider request always precedes its first tool call, so the
   grant is settled before it can delegate.)

The invariant still holds transitively — `own = observed ∩ inherited ⊆ inherited` — and it doubles as
defence in depth: if a spawn ever slipped past the interceptor, the intersection clamps the child anyway.

**The wildcard is held but never inherited.** A root may hold `tool:*` (authority to grant anything), but
handing it down would let every descendant reacquire the full catalog and make attenuation meaningless
below the root. Children inherit the enumerated grant only. A wildcard root that has not yet observed its
tools hands children an empty grant — fail closed.

### Functional subsumption: `bash` is not one capability among eight

pi's **default** tool surface is `read`, `bash`, `edit`, `write` — measured, not assumed (`grep`, `find`,
and `ls` exist but are not default). So an agent type declaring `tools: read, grep, find, ls` would look
like an escalation from any normal parent, despite being strictly weaker.

It isn't, because **`bash` can run `grep`, `find`, `ls`, `cat`, and `sed`**. `SUBSUMPTION` models that
explicitly, which removes the false positives *and* makes the uncomfortable part visible: a grant
containing `bash` is not a narrow grant. `result.subsumedBy` lists what the parent covers only indirectly,
so a reviewer can see what a grant really means. Pass `subsumption: false` for a strict name-equality check.

## Live capability catalog

Grants are validated against what actually exists in the session, not just against agent-type files:

| Source | Gives | Why it's trusted |
| :--- | :--- | :--- |
| provider request `tools` array | `tool:` capabilities, **including extension-provided ones** | authoritative — it is exactly what pi sent the model, and reflects any `--tools` allowlist already in force |
| skill roots (`.pi/skills`, `~/.pi/agent/skills`) | `skill:` capabilities | `SKILL.md` directories and top-level `.md` files, per pi's convention |
| agent-type files | `agent:` capabilities | the same definitions the interceptor reads |

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

`/grants` shows the catalog broken down by kind.

## Design decisions worth knowing

- **A zero grant is `--no-tools`, never "no flag".** pi rejects an empty `--tools`, and omitting the flag
  silently falls back to pi's defaults — the opposite of a zero grant.
- **`--no-extensions` is always passed**, so ambient user extensions cannot widen a governed child. Explicit
  `-e` paths would still load, so this package never passes one.
- **The ledger fails closed by default.** An unrecorded grant is a hole; `strict: false` only where the
  ledger is advisory.
- **Skills and agent types are capabilities too** (`skill:`, `agent:`), so they are governed by the same
  machinery — but they are not `--tools` entries, so `toPiToolsAllowlist()` filters them out.
- **Rejection reasons never mask one another** — `denied` (escalation), `clipped` (ceiling), and
  `gatedBlocked` (needs approval) are reported independently.

## Tests

```bash
npm test     # 149 passing
```

The resolver is a pure function, which is deliberate: it is the only place an escalation could be
introduced, so it is the only place needing exhaustive tests — and being pure, it can have them. Coverage
includes three-level transitive attenuation, approval-cannot-conjure-a-capability, empty vs. absent ceilings,
and the measured `fabric_exec` escalation.

**Verified end to end**, not just unit-tested: a child spawned from this package's own planned argv with a
`["tool:read"]` grant reported `NO_WRITE_TOOL` and **created no file** when told to write.

## Testing

```bash
npm test              # 188 unit tests. Fast, pure, no pi, no network.
npm run test:integration   # 8 tests against a REAL pi process. ~17s, no model tokens.
PI_GRANTS_IT_MODEL=1 npm run test:integration   # + 3 end-to-end tests with a real model. ~60s, costs money.
```

The integration suite exists because `extensions/grants.ts` is where the wiring bugs live — every defect
the live probes ever found was in the extension, not in `src/`. Its default tier drives the `/grants`
command, whose handler runs the real decision function over real agent-type files in a real pi process
**without a model deciding anything**, so it is deterministic and free. The opt-in tier adds a model
choosing to call tools, and asserts on structure (`isError`, the ledger JSON, whether a file appeared)
rather than on model wording.

It earned itself immediately: its first run found that **every delegation refusal was being recorded by pi
as a success** (see *Governed delegation*, first bullet). It is also checked against reintroduced bugs —
restoring the G7 `NaN` defect makes two of its tests fail.

## Status

**0.6.0 — early, and honest about scope.** What exists and is verified against real pi: the resolver, the
ledger, the spawn planner, the `tool_call` interceptor for `pi-subagents` spawns, the `delegate` tool for
governed provisioning, and human approval for gated capabilities (once / session / always, inheritable down
the tree, persisted for `always`; see *Approving a gated capability* above). That part is unit-tested,
typechecked, and verified live against real pi (see below). What does not exist yet: background/streaming
delegation (`delegate` runs to completion and returns the child's output). Known gap in the interceptor
path: it can only enforce, not provision, until `pi-subagents`' `Agent` tool gains a `tools` parameter.

### Hardening in 0.5.0, from two independent reviews

Beyond ADR-0011, four groups of the review backlog
(`docs/reviews/2026-08-10-aggregated-findings.md`) are closed:

- **G1 · the argv channel.** The delegation task occupied a CLI-parsed position, so a task beginning
  `@` made pi read an arbitrary file into a child that held **no tools at all** — `--tools` never applies,
  because no tool is involved — and one beginning `-` could pass `--approve`. Reproduced and closed;
  `docs/probes/g1-argv`.
- **G6 · the ledger.** It reported allowed wildcard spawns as escalation attempts, and dropped every
  refusal that was decided before resolution. Both fixed at the type level, so a new early exit cannot
  reintroduce them.
- **G7 · configuration.** Malformed bounds now fail closed and say so; ungoverned sessions publish
  nothing; the catalog is awaited rather than raced.
- **G8 · child processes.** Caps, timeout, abort-before-spawn, real errors for failed children.

Eight groups remain open, three of them needing decisions rather than patches — including that a child
holding `bash` can run `env -u PI_GRANTS_GRANT pi …` and create a completely ungoverned descendant.
**Read the backlog before relying on this package.**

### 0.6.0 is a breaking change too

Three, all from the ADRs accepted on 2026-08-10/11:

- **`bash` is gated by default** in a governed session, and gating is closed under subsumption, so
  `PI_GRANTS_GATED=tool:write` now also gates `bash` (**ADR-0012**). Set `PI_GRANTS_GATED=""` for the
  old behaviour.
- **Agent-type ceilings changed** to match what `pi-subagents` actually builds (**ADR-0013**). An absent
  `tools:` key now means *every built-in* rather than the wildcard, a YAML block list is finally read,
  and identity comes from the filename. Some spawns that were refused now succeed, and vice versa.
- **`PI_GRANTS_APPROVED` carries `capability@subject` pairs** and `once` no longer crosses a boundary
  (**ADR-0014**). A 0.5.x parent and a 0.6.x child do not understand each other's format.

Also: `delegate` is now registered only when the session may delegate, which is what the docs always
claimed; and persisted approvals moved out of the workspace, with any legacy file ignored and reported.

### 0.5.0 is a breaking change

Spawns that succeeded in 0.4.0 now fail. Both cases are listed under *Enforce, not provision* above: an
agent type declaring a universal capability is refused on **both** spawn paths, and a wildcard-holding
delegator no longer bypasses a configured gate. **That reliance was never sound** — the guarantee this
package sells is that a sub-agent cannot receive more than a narrow grant, and each of those spawns handed
it either the entire catalog or a capability an operator had explicitly gated. The rationale, the options
weighed, and the revisit triggers are in `docs/06-decisions/ADR-0011-universal-capabilities-across-both-spawn-paths.md`.

If a spawn starts failing after upgrading, the ledger names the capability and the reason; there is
deliberately no override flag yet.

Live verification of the approval feature has been done — `docs/probes/approval-ux` — and on its first run
**seven of eight scenarios behaved as specified**. The eighth found a real defect (an approval inherited down
the `delegate` path was applied but not recorded in the ledger) and a second, pre-existing defect in
`delegate`'s default model resolution turned up in the same run. **Both are now fixed and re-verified live**;
see *Verified live* above. The probe directory deliberately still describes the original run, with a dated
resolution note pointing here.

Requires pi ≥ 0.83.0, Node ≥ 22.19. MIT.
