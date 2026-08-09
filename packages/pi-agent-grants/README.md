# pi-agent-grants

**Capability governance for pi sub-agents.** A grant can only ever *shrink* as it passes down a delegation
tree, so a sub-agent can never confer more than it holds — enforced by **pi's own `--tools` allowlist**, with
an append-only ledger of what was granted and what was refused.

Built because that guarantee does not exist elsewhere. `@tintinweb/pi-subagents` provisions statically per
agent type; `pi-fabric` provisions dynamically but **cannot constrain a recursive child at all** (measured:
`docs/probes/pi-fabric-eval`).

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

## Universal capabilities

`fabric_exec` is treated as **universal** — granting it is equivalent to granting the whole catalog, because
it reaches `pi.write`, `pi.bash`, and unrestricted `agents.run`. This is measured, not theoretical: a child
granted `tools: []` (nothing at all) plus `recursive: true` still spawned a grandchild that wrote to disk.

`assertNarrowing()` therefore **throws** if a supposedly narrow grant contains one. A narrow grant with
`fabric_exec` in it is full authority wearing a narrow grant's clothing.

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
blocked — this extension must never silently tighten a normal workflow.

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

## Status

**0.4.0 — early, and honest about scope.** What exists and is verified against real pi: the resolver, the
ledger, the spawn planner, the `tool_call` interceptor for `pi-subagents` spawns, the `delegate` tool for
governed provisioning, and — new in 0.4.0 — human approval for gated capabilities (once / session / always,
inheritable down the tree, persisted for `always`; see *Approving a gated capability* above). That part is
unit-tested, typechecked, and now verified live against real pi (see below). What does not exist yet: background/streaming delegation (`delegate` runs to
completion and returns the child's output). Known gap in the interceptor path: it can only enforce, not
provision, until `pi-subagents`' `Agent` tool gains a `tools` parameter.

Live verification of the approval feature has been done — `docs/probes/approval-ux` — and on its first run
**seven of eight scenarios behaved as specified**. The eighth found a real defect (an approval inherited down
the `delegate` path was applied but not recorded in the ledger) and a second, pre-existing defect in
`delegate`'s default model resolution turned up in the same run. **Both are now fixed and re-verified live**;
see *Verified live* above. The probe directory deliberately still describes the original run, with a dated
resolution note pointing here.

Requires pi ≥ 0.83.0, Node ≥ 22.19. MIT.
