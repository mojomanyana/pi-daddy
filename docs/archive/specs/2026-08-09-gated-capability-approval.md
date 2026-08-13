# Design — Human approval for gated capabilities

**Date:** 2026-08-09
**Status:** **IMPLEMENTED 2026-08-09, and revised twice since** — read ADR-0011 and **ADR-0014** before
treating anything here as current. ADR-0014 in particular moved the approvals store out of the workspace,
changed `PI_GRANTS_APPROVED` to carry `capability@subject` pairs, and stopped `once` crossing a boundary;
where this document and that ADR disagree, **the ADR is right**.
**Package:** `packages/pi-agent-grants`
**Driver:** SESSION-LOG next-action #1 — *"Human-approval UX for gated capabilities. They currently just
refuse. Needs once/session scopes and a defined answer for background agents with no interactive user."*

**In one sentence:** *`resolve()` already computes `gatedBlocked` — capabilities a session legitimately
holds but which may not enter a child's grant without a human saying so. Today both call sites simply
refuse. This adds the only thing missing: a way to say yes, with a scope, an audit trail, and a defined
answer when no human is present.*

**Gate status.** The G0 waiver is scoped to `packages/pi-agent-grants` — *"resolver, ledger, and a spawn
helper that applies a computed allowlist"*. This work stays inside that package and touches no excluded
component (no Orchestrator, registry, selection, eviction, aggregator). One thing is worth naming rather
than slipping through: **the approval store is the package's first persistent state outside the append-only
ledger.** It is a small JSON file with a fixed schema, not a registry, but it is new persistence and the
user should have been told. It was.

---

## 1. What already exists, and what is actually missing

`ResolveInput` has taken `gated` and `approved` since 0.1.0, and `resolve()` implements

```
effective = ( requested ∩ parentGrant ∩ ceiling ) \ (gated \ approved)
```

There is already a test that **approval cannot conjure a capability** — `approved` only lifts a gate on
something the parent already holds, because `denied` is computed against `parentGrant` independently.

So the security core needs **no change at all**. What is missing is entirely in the wiring:

| Call site | Today | After |
| :--- | :--- | :--- |
| `decideSpawn` (interceptor) | returns `allow: false`, reason *"requires approval for …"* | prompts, re-resolves with `approved` |
| `planDelegation` (`delegate`) | returns `ok: false`, reason *"requires explicit approval"* | prompts, re-resolves with `approved` |

Neither ever fills `approved`. Nothing ever asks anyone.

## 2. Approach — prompt, then re-resolve

Approval is asynchronous and involves a human; `resolve()` is pure, total, and sync, and that purity is the
project's stated security argument (*"the only place an escalation could be introduced, so the only place
needing exhaustive tests — and being pure, it can have them"*).

Three ways to reconcile were considered:

| Option | Verdict |
| :--- | :--- |
| **Prompt, then re-resolve** | **Chosen.** Wiring detects `gatedBlocked`, obtains approvals, calls `resolve()` again with `approved`. `resolve.ts` is not modified. |
| Async resolver taking a callback | Rejected — puts I/O and a human inside the one function whose value is being pure and total. |
| Injected `ApprovalPolicy` object | Rejected — same coupling, more indirection. |

Cost: one extra call to a pure function. Benefit: the security surface is byte-for-byte what it is today.

## 3. The four decisions this design encodes

Taken by the user in session, after each trade-off was stated. Recorded in ADR-0010.

| # | Decision | Rejected alternative |
| :--- | :--- | :--- |
| 1 | **Approval rides down with the grant** — inheritable through the subtree | non-inheritable (one delegation only) |
| 2 | **Scopes: once · session · always**, `always` persisted to disk | memory-only (once + session) |
| 3 | **Keyed `capability@agentType`**, project-scoped file | capability-only; user-global |
| 4 | **`always` is offered only on the interceptor path** | offering it on the delegate path too |

### 3.1 Why decision 4 follows from decision 3

An agent type is a `.md` file **the human wrote**. That makes `docs-writer` a trustworthy key.

The `delegate` tool has no such subject: the only things naming a child are the **task string** and the
**tool list**, both chosen by the model. If the model supplied a role name it could pass
`role: "docs-writer"` over an unrelated task and cash in a persisted approval. **A key the model controls
is not a key.**

So the persisted file contains only `capability@agentType` entries, every one naming a human-authored
file. The `delegate` path offers `deny / once / session` and never writes to disk.

**The delegate path still needs a subject**, because a `session`-scoped approval has to be keyed by
something in order to be recognised on the next call. It uses the fixed literal `<delegate>`, giving keys
like `tool:write@<delegate>`. This is deliberately coarse: *"allow write for delegations this session"*
applies to any `delegate` call from this session, not to a particular child. Keying it more finely would
require a subject only the model can supply, which §3.1 has just ruled out. The angle brackets are not a
legal agent-type filename character, so a `<delegate>` key can never collide with a real type, and — being
memory-only — it never reaches disk where the coarseness would compound.

### 3.2 Why inheritance is safe — the invariant extends to approvals

Approvals propagate under the same discipline as grants, so `propagation.ts`'s race-freedom doctrine is
preserved on both paths:

```
delegate path    (owns the spawn, per-child env object)
    child.approved = approved ∩ effective

interceptor path (global process.env — parent-level facts only)
    pushed         = approved ∩ ownGrant     ← identical for every sibling, nothing to race on
    child on arrival: ownApproved = inherited ∩ ownGrant
```

Which yields, at every level and by construction:

```
approved ⊆ grant
```

**An approval can never name a capability the session does not hold.** It only ever lifts a gate on
something already legitimately held, so it is not a back door around ADR-0008 — it cannot widen a grant,
only unblock part of one. The wildcard is filtered out of inherited approvals exactly as `childEnv`
already filters it out of inherited grants (R-26).

### 3.3 Divergence from pi-fabric, recorded rather than hidden

`docs/specs/2026-08-09-capability-governance-design.md` records that pi-fabric 0.40.3 ships
**non-inherited** write/execute/network approvals and **fails closed on restart** — i.e. it made the
opposite call on both decision 1 and decision 2.

That is a mature implementation disagreeing with this design, and it is not dismissed here. The
divergence is deliberate: a strictly non-inherited approval, combined with children running `--print`
(§4.1), confines gated capabilities to exactly one level below a human — which would make them unusable
in the multi-level tree this project exists to build. The four compensating controls in §5 exist
specifically to close the gap that inheritance and persistence open.

## 4. Components

Pure core first, matching the package's existing structure.

### 4.1 `src/approval.ts` — pure, no I/O

```ts
export type ApprovalScope  = "once" | "session" | "always";
export type ApprovalSource = "prompt" | "session" | "persisted" | "inherited";
export type ApprovalPath   = "interceptor" | "delegate";

approvalKey(capability, subject)      // "tool:write@docs-writer"
offeredScopes(path)                   // interceptor: [once, session, always]; delegate: [once, session]
resolveApprovals({ gated, subject, sessionApprovals, persisted, now })
                                      // -> { approved, needsPrompt, sources }
inheritApprovals(approved, grant)     // approved ∩ grant, wildcard filtered
```

`resolveApprovals` establishes precedence — **inherited → session → persisted → prompt** — so nothing
already satisfied ever raises a dialog. The order matters only for what gets *reported* as the ledger's
`approvalSource`; any hit satisfies equally. Checking all three before prompting is what stops an
orchestrator's tenth delegation from raising a tenth identical dialog.

**Where `hasUI` comes from.** pi installs a `noOpUIContext` in non-interactive modes whose `confirm`
resolves `false` and whose `select` resolves `undefined` (`dist/core/extensions/runner.js:88`), and
`hasUI` is literally `uiContext !== noOpUIContext`. So the background case fails closed in pi itself — no
hang, no throw. Since `delegate` spawns children with `--print`, **`hasUI` is false in every governed
child**: approval is structurally a root-only, human-at-the-terminal act.

### 4.2 `src/approval-store.ts` — the only I/O

`.pi/grants-approvals.json`, project-local:

```json
{
  "version": 1,
  "approvals": {
    "tool:write@docs-writer": {
      "approvedAt": "2026-08-09T14:02:11.331Z",
      "expiresAt": "2026-09-08T14:02:11.331Z",
      "cwd": "/home/alavanja/prepos/pi-daddy",
      "grantAtApproval": ["tool:read", "tool:write"],
      "taskAtApproval": "fix the docs typos"
    }
  }
}
```

`taskAtApproval` is **provenance only and never part of the key** — it exists so that weeks later a
reviewer can see what was being done when the yes was given.

API: `loadApprovals(cwd, now)` · `saveApproval(cwd, key, entry)` · `revokeApproval(cwd, key)` ·
`revokeAll(cwd)` · `listApprovals(cwd)`.

**Read on demand, never cached at session start**, so a revoke takes effect immediately — including one
performed from another session while this one is running.

### 4.3 `src/propagation.ts` — extended

New `ENV_APPROVED = "PI_GRANTS_APPROVED"`, carried alongside the existing `PI_GRANTS_GATED`, populated per
§3.2 and read on child startup into the child's approval set.

### 4.4 `extensions/grants.ts` — wiring

- in-memory `sessionApprovals: Set<string>` (approval keys), dying with the process
- `promptForApproval(ctx, request)` → `ctx.ui.select(title, offeredScopes(path), { timeout, signal })`
- both `tool_call` and `delegate.execute` gain: detect `gatedBlocked` → resolve approvals → re-resolve
- `/grants` gains an approvals section; `/grants approvals` and `/grants revoke` are added

### 4.5 `src/ledger.ts` — four optional fields

| field | meaning |
| :--- | :--- |
| `approved?: Capability[]` | gated capabilities satisfied for this spawn |
| `approvalSource?: ApprovalSource` | where the yes came from |
| `approvalScope?: ApprovalScope` | present only when the source was a live prompt |
| `humanDenied?: boolean` | a person was asked and declined |

All optional, so every existing record stays valid and existing readers are unaffected.

**Why `humanDenied` earns its place.** The ledger currently has one flavour of *no*. After this there are
three, and they demand different responses:

- `denied` — an agent asked for more than it holds. **Escalation attempt.**
- `humanDenied` — a person was asked and said no. **Working as designed.**
- `gatedBlocked` with no `approvalSource` — **nobody was there to ask.** A background run hit a gate; the
  fix is an operator pre-approving it, not an incident.

Collapsing them would hide all three — the same reasoning that already keeps `denied` and `unknown` apart
in `delegate`.

## 5. Lifecycle — what removes an approval

`once` never touches disk. `session` dies with the process. Inherited approvals live in child env vars and
vanish when the child exits. **Only `always` persists**, and four things remove it:

| Mechanism | Rationale |
| :--- | :--- |
| `/grants revoke <key>` or `--all` | Explicit. A persisted gate you cannot take back is worse than no gate. |
| **Agent-type ceiling changed or type deleted** | **Confused-deputy fix — see below.** |
| **30-day expiry** (`expiresAt`) | A gate opened during one project stops applying to a repo revisited next quarter. Loader ignores and drops expired entries. `expiresAt = approvedAt + 30 days`, computed once at write time and stored, so an entry's lifetime is visible in the file rather than implied by the reader's version. Fixed as a `APPROVAL_TTL_DAYS = 30` constant in `approval.ts` — **not runtime-configurable**, because an env var that silently extends every gate is the first thing an impatient operator would set. |
| **`cwd` mismatch** | See §5.2. |

### 5.1 The confused deputy the key creates

The key names a file whose contents can change *after* approval. Approve `tool:write@docs-writer` while
`docs-writer.md` declares `tools: read, write`; later that file gains `bash`, or is deleted and a
different `docs-writer.md` appears. The persisted entry still matches the key and silently applies to a
thing the human never saw.

> **An approval is valid only while the thing it approved is unchanged.** On load, the entry's
> `grantAtApproval` is compared against `ceilingFor(type)` — the agent type's *current* ceiling, read by
> the same `agent-types.ts` the interceptor already uses. If it differs — or the type no longer exists —
> the entry is ignored, dropped, and the next spawn re-prompts.

The comparison is on the sorted capability list, so reordering or reformatting the `tools:` line is not a
change; adding, removing, or renaming a capability is.

Self-healing, needs no new state, and it makes deleted or rewritten agent types clean themselves out.

### 5.2 A committed approvals file must not authorise a clone

A file under `.pi/` in a repo will be committed sooner or later, and then one person's *always* silently
authorises everyone who clones. **The loader ignores any entry whose `cwd` does not match the current
working directory.** A copied or committed file authorises nothing anywhere else; it must be re-approved by
the human sitting in that checkout. This is why `cwd` is stored despite the file already being
project-local. Recorded as **R-27**.

## 6. Error handling — everything denies, except one

| Situation | Behaviour |
| :--- | :--- |
| `hasUI` false (background, `--print`) | Deny. The reason names the cause **and the fix**: *"`tool:write` requires approval and this session has no interactive user (mode: print). Pre-approve it in an interactive session, or drop it from the request."* |
| Dialog timeout | Deny. `ExtensionUIDialogOptions.timeout` gives a live countdown for free. Default **120 seconds**; override with `PI_GRANTS_APPROVAL_TIMEOUT`, **read in seconds** and converted to the milliseconds pi expects. A value of `0` or an unparseable one means *no timeout* — the dialog waits indefinitely, which is safe here because waiting denies nothing. |
| Turn cancelled | The tool's `AbortSignal` is passed as `opts.signal`, so the dialog is dismissed rather than orphaned. |
| `select()` returns `undefined` (dismissed) | Deny — same path as an explicit no. |
| Corrupt / unreadable approvals file | Treated as empty, warn, never throw. A broken cache grants nothing. |
| Anything throws in the approval path | Deny and notify — matching the existing handler's *"a governance layer that errors must deny, not permit"*. |
| **`always` chosen but the file write fails** | **Proceed, downgraded to `session`, with a warning.** |

That last row is the one deliberate exception. The human already said yes and the security decision was
made correctly; refusing the work because a *convenience cache* could not be written would be failing
closed on the wrong thing.

### 6.1 Concurrent prompts

`delegate` sets no `executionMode`, so an orchestrator can fan out several children at once and two can hit
the same gate simultaneously — two stacked dialogs asking the same question. Approval prompts go through a
**single-flight queue keyed on the approval key**: concurrent requests for `tool:write@docs-writer` await
one prompt, and each re-checks session and persisted state on resolution, so the second usually needs no
prompt at all.

## 7. Verification

### 7.1 Unit — `approval.ts` (pure, so exhaustively testable)

- key canonicalisation; `cap@typeA` does not satisfy `cap@typeB`
- `offeredScopes` never yields `always` on the delegate path
- precedence: session → persisted → prompt; nothing already satisfied prompts
- `inheritApprovals` is intersection; wildcard filtered; never exceeds the grant
- three-level transitivity: `approved ⊆ grant` at each level
- approval still cannot conjure a capability (extends the existing test)
- expired entries, foreign-`cwd` entries, and changed-ceiling entries are all ignored

### 7.2 Unit — `approval-store.ts` (temp dir)

missing file → empty · corrupt JSON → empty, no throw · round trip · revoke one · revoke all · write
failure surfaces as a downgrade rather than a throw

### 7.3 Unit — wiring (mocked `ExtensionContext`)

`hasUI: false` → deny with the naming reason · dismissed dialog → deny · *allow once* → proceeds, nothing
persisted · *always* on the interceptor path → persisted · single-flight produces one prompt for two
concurrent requests

### 7.4 Live against real pi

Per this project's convention of not trusting unit tests alone (the README documents live scenarios beside
every claim):

1. TUI, gated `tool:write`, **approve once** → child writes; ledger `approvalSource: "prompt"`, `approvalScope: "once"`
2. Same, **deny** → refused; ledger `humanDenied: true`
3. **`--print` run**, gated `tool:write` → refused with the no-human reason; nothing persisted
4. **`always`** on an agent type, restart pi, delegate again → no prompt; ledger `approvalSource: "persisted"`
5. **`/grants revoke`**, then repeat 4 → prompts again
6. **Inheritance:** approve `write` for a child holding `delegate`; child sub-delegates `write` to a
   grandchild → allowed; ledger `approvalSource: "inherited"` at depth 2
7. **Copy the approvals file to another directory** → ignored (foreign `cwd`)
8. **Edit the agent type's `tools:` line** after approving → re-prompts (§5.1)

## 8. Deliberate non-goals

- **No expiry beyond the fixed 30 days** — no per-entry custom TTLs.
- **No per-user identity.** The file records *that* a human approved, not *which* one. This package has no
  notion of user identity and inventing one here would be worse than the gap.
- **No approval delegation** — a human cannot nominate another human, or an agent, to answer for them.
- **No approvals TUI beyond list and revoke.**
- **No `lastUsedAt` tracking**, which would turn a read-mostly cache into a read-write one on every check.

## 9. Open item carried forward

Whether `bash` should join `gated` by default. It functionally subsumes `read`, `write`, `edit`, `grep`,
`find`, and `ls` (`SUBSUMPTION`, R-25), so gating it would be the single highest-value default — and would
also make approval prompts common enough to test the fatigue question honestly. Out of scope here; noted
against R-25's existing trigger.
