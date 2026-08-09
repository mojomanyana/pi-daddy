# ADR-0010: Approval semantics for gated capabilities — inheritable, persisted, keyed on agent type

**Date:** 2026-08-09
**Status:** Accepted
**Driver:** SESSION-LOG next-action #1 (human-approval UX). Extends **ADR-0008** (monotonic attenuation) to
the `gated`/`approved` terms of the resolver. Touches **R-25** (`bash` subsumption) and creates **R-27**.

## Context

`resolve()` has implemented `effective = ( requested ∩ parentGrant ∩ ceiling ) \ (gated \ approved)` since
0.1.0, and both `ResolveInput.gated` and `ResolveInput.approved` already exist. But nothing in the package
ever fills `approved` — so a gated capability is not *gated*, it is **permanently refused**. There is no
way to say yes.

Four facts constrain any design here. All are measured, not assumed:

1. **pi already fails closed without a human.** In non-interactive modes pi installs a `noOpUIContext`
   whose `confirm` resolves `false` and `select` resolves `undefined`
   (`dist/core/extensions/runner.js:88`); `hasUI` is `uiContext !== noOpUIContext`. No hang, no throw.
2. **pi gives extensions real dialogs.** `ExtensionUIContext.select/confirm/input` accept
   `{ timeout, signal }`, and both the `tool_call` hook and a registered tool's `execute` receive an
   `ExtensionContext` (`dist/core/extensions/types.d.ts:68`, `:371`).
3. **`delegate` spawns children with `--print`.** Therefore `hasUI` is false in **every governed child**,
   and approval is structurally a root-only, human-at-the-terminal act.
4. **Agent types are human-authored files; `delegate`'s subject is not.** An agent type is a `.md` file the
   user wrote. `delegate` receives only a task string and a tool list, both chosen by the model.

Assumption load: **none unvalidated**. This ADR rests on facts 1–4 above and on ADR-0008's invariant, all
of which are either measured or already regression-tested.

## Options considered

### Option 1 — Non-inheritable, memory-only (the pi-fabric shape)

An approval authorises exactly one delegation and never touches disk.

- **Buys:** the tightest possible semantics; a yes cannot outlive the moment it was given; no persistence,
  so nothing to revoke, expire, or accidentally commit.
- **Costs:** combined with fact 3, gated capabilities can then enter a grant **only one level below a
  human-attended session** — every deeper re-delegation is refused because the child cannot prompt.
- **Forecloses:** using gated capabilities anywhere in the multi-level tree this project exists to build.

### Option 2 — Inheritable, persisted, keyed on agent type (chosen)

An approval rides down the subtree with the grant; scopes are once / session / always; `always` persists to
a project-local file keyed `capability@agentType`.

- **Buys:** gated capabilities remain usable at depth, which is the product's whole premise; repeated
  workflows stop re-prompting; every persisted key names a file the human wrote.
- **Costs:** four new failure modes — a yes reaching further than intended, a stale approval outliving its
  context, a rewritten agent type inheriting an old approval, and a committed file authorising clones.
  Each needs a compensating control (see Consequences).
- **Forecloses:** nothing structurally; Option 1 remains reachable by configuration.

### Option 3 — Inheritable, persisted, keyed on a model-supplied role

As Option 2, but `delegate` gains a `role` parameter forming the persisted key.

- **Rejected on a security argument, not a preference.** The model chooses the role string, so it could
  pass `role: "docs-writer"` over an unrelated task and cash in a persisted approval. **A key the model
  controls is not a key.**

## Decision

**Option 2.** Approvals are **inheritable** — they ride down the subtree with the grant, intersected with
the child's effective grant at each hop. Scopes are **once · session · always**. `always` persists to a
project-local `.pi/grants-approvals.json` keyed `capability@agentType`, and is offered **only on the
interceptor path**, where the subject is a human-authored file; the `delegate` path offers deny / once /
session and never writes to disk.

The security core is unchanged: the wiring prompts and then calls the existing pure `resolve()` a second
time with `approved` filled. `resolve.ts` is not modified.

For v1 this means: a background or `--print` run **cannot approve anything** and refuses with a reason that
names the missing human and the fix; an operator wanting unattended gated work must pre-approve
interactively.

## Consequences

**Positive.**

- The attenuation invariant extends to approvals rather than being punctured by them:
  `approved ⊆ grant` at every level, by construction, because inheritance intersects with the child's
  effective grant and the wildcard is filtered exactly as `childEnv` already filters it (R-26).
- An approval still cannot conjure a capability — `denied` is computed against `parentGrant`
  independently, and the existing test for this remains valid unchanged.
- The ledger gains three distinguishable flavours of *no* — escalation attempt, human declined, and nobody
  present to ask — which call for completely different responses and were previously indistinguishable.

**Negative, each with its compensating control.**

| Cost incurred | Control |
| :--- | :--- |
| A yes reaches the whole subtree | Intersected with effective grant at every hop; recorded per level in the ledger as `approvalSource: "inherited"` |
| A persisted yes outlives its context | 30-day expiry; loader ignores and drops expired entries |
| A rewritten agent type inherits an old approval | `grantAtApproval` compared against the type's current ceiling on load; mismatch or missing type ⇒ entry dropped, re-prompt |
| A committed file authorises every clone | Loader ignores entries whose `cwd` ≠ current working directory (**R-27**) |
| A persisted gate cannot be taken back | `/grants approvals` and `/grants revoke`, read on demand so revocation is immediate across sessions |

**Neutral, and recorded rather than hidden.** `pi-fabric` 0.40.3 — evaluated empirically by this project —
ships **non-inherited** approvals and **fails closed on restart**, i.e. it chose Option 1 on both axes. This
ADR knowingly diverges. The reason is fact 3: strict non-inheritance plus `--print` children confines gated
capabilities to one level below a human, which defeats the purpose in a multi-level system. The five
controls above exist specifically to close the gap that divergence opens. If they prove insufficient, the
revisit trigger below fires and Option 1 is still reachable.

**Deliberate non-goals.** No per-user identity (the file records *that* a human approved, not *which* one);
no approval delegation to another human or agent; no custom per-entry TTLs; no `lastUsedAt` tracking, which
would turn a read-mostly cache into a read-write one on every check.

## Revisit trigger

Any of:

- A ledger entry showing `approvalSource: "inherited"` at a depth where the approving human could not
  plausibly have known the descendant would exist — evidence that inheritance reaches too far.
- A persisted entry surviving a change the ceiling check failed to catch (i.e. an agent type materially
  changed without its `tools:` line changing).
- Approval-prompt frequency high enough that users report reflexive approval — the fatigue failure mode,
  which would fire hardest if `bash` were ever added to `gated` by default (open item, R-25).
- `pi-fabric` or pi core shipping a first-class approval primitive, which would make this package's
  version redundant rather than merely divergent.
