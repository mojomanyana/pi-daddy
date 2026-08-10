# ADR-0014: The persisted-approval file is forgeable by the agent it gates

**Date:** 2026-08-10
**Status:** **Proposed — needs a decision.** The store's location must be settled before any code.
**Driver:** Review group **G3** (findings A-C3/B-C1, B-C6, A-S1, A-S6, A-R2, B-I6). Directly undermines
**ADR-0010**'s approval semantics and the compensating control **R-27** records.

## Context

**ADR-0010** made a persisted `always` approval evidence that *a human said yes*. Six findings say that
evidence cannot be trusted, and one of them is self-defeating in the package's own documented setup.

### 1. The gate defeats itself in its recommended configuration

`.pi/grants-approvals.json` lives **inside the governed workspace**, has no integrity control, and is read
as proof of human consent. Its two guards defend against the wrong things: the `cwd` match (R-27) stops a
file arriving from another checkout, and `grantAtApproval` stops an agent type changing after approval.
**Neither defends against local forgery.**

`PI_GRANTS_GATED=tool:write` means "may use `write`, may not pass it down without a human". A session that
may use `write` **can write the approvals file.** The reviewer demonstrated this end to end, including
authoring a matching agent-type file so `grantAtApproval` compares equal. No dialog is raised, and the
ledger records `approvalSource: "persisted"` — **indistinguishable from a real human approval.**

The audit trail does not merely miss this; it asserts the opposite of what happened.

### 2. A human's most conservative answer produces the least conservative outcome

- **A-S1** — `obtainApprovals` returns `approved` regardless of the scope chosen, and it is written into
  the child's `PI_GRANTS_APPROVED` and republished onward. **"Allow once" is inherited by the entire
  descendant subtree.**
- **B-C6** — single-flight returns one `once` outcome to *every* concurrent caller sharing
  capability+subject, so one "once" satisfies several simultaneous spawns.

These are independent, and both invert the meaning of the word the human chose.

### 3. The subject is erased one hop down

**A-S6.** `approval.ts:33` argues at length that a model-controlled key is not a key — and a
`<delegate>`-subject approval is published to children as a **bare capability matching any subject**. The
argument and the propagation disagree.

### 4. The file is fragile as well as forgeable

- **A-R2** — a corrupt file makes the next legitimate write **silently destroy every other entry**
  (reproduced). Entries are validated on read but pruned only on write.
- **B-I6** — writes follow project-controlled **symlinks**; no locking, no atomic replace.

**Assumption load:** none unvalidated; findings 1 and 4 were reproduced by reviewers.

## Options considered

### Option 1 — Move the store outside agent-writable space

Put approvals under `~/.pi/agent/` (or an OS keychain / state directory), keyed by project path.

- **Buys:** closes forgery for every agent that does not hold write access to the user's home — which is
  the realistic case, since grants are for *narrowing* and a narrowed child does not get the home
  directory. Small, well-understood change.
- **Costs:** a child granted `bash` still reaches it (see **ADR-0012** — that hole subsumes this one).
  Loses per-project portability, and needs a migration for existing files.
- **Forecloses:** nothing.

### Option 2 — Sign the entries

HMAC each entry with a key held outside the workspace; reject unsigned or mismatched entries.

- **Buys:** integrity even if the file stays in the workspace, and it makes tampering *detectable*, which
  a location change alone does not.
- **Costs:** a key that must live somewhere the agent cannot read — which is Option 1 wearing a hat, plus
  cryptography. If the key is reachable, the signature proves nothing.
- **Forecloses:** nothing.

### Option 3 — Drop `always`; keep only `once` and `session`

Remove persistence entirely. An approval lives in memory and dies with the process.

- **Buys:** deletes the entire attack surface — no file, no forgery, no corruption, no symlink, no
  locking. Findings 1 and 4 disappear rather than being mitigated. Simplest thing that is honest.
- **Costs:** real ergonomic loss. `always` exists because repeated prompting is the main driver of
  reflexive approval, and reflexive approval is how gates stop working. This trades a security property
  for a usability one that itself has security consequences.
- **Forecloses:** nothing technically; reversible if the store is later made trustworthy.

### Option 4 — Keep the store, fix scope and subject only, document the forgery

Fix A-S1, B-C6 and A-S6 (thread `scope` through propagation so `once` never crosses a boundary; propagate
`capability@subject` pairs), plus atomic replace and no-follow. State the forgery limit in the README.

- **Buys:** fixes everything except the trust root, at moderate cost, keeping `always`.
- **Costs:** leaves the headline finding open. "A human approved this" remains unverifiable, and the
  ledger keeps recording `approvalSource: "persisted"` as though it were.
- **Forecloses:** nothing.

## Recommendation

**Option 1 for the trust root, plus the scope/subject/durability fixes from Option 4** — and treat Option 3
as the honest fallback if Option 1 proves awkward.

The scope, subject and durability fixes should happen under every option: they are unambiguous defects,
none of them needs a decision, and each inverts the meaning of something a human explicitly chose.

For the trust root, Option 1 buys the most per unit of complexity. Option 2 does not stand alone — its key
needs exactly the safe location Option 1 provides, so it is an addition to Option 1, not an alternative.

**A caveat that should shape how much is spent here.** Under **ADR-0012** a child holding `bash` can
already start an ungoverned pi, which makes approval integrity moot for that child. **Do not spend heavily
on Option 2 while ADR-0012 is open** — the weaker link is elsewhere, and hardening this one first would
buy confidence rather than security.

## Consequences

**If the recommendation is taken:**

- **ADR-0010**'s `always` semantics survive, with the store relocated and a migration path.
- `PI_GRANTS_APPROVED` carries `capability@subject` pairs and a scope, so `once` stops crossing process
  boundaries — a **breaking change** to the propagation format between versions.
- **R-27** (committed approvals file authorising every clone) largely dissolves: the file leaves the repo.

**While unresolved:**

- Any gated capability is approvable by the agent it gates, provided that agent can write to the workspace
   — which the package's own recommended `PI_GRANTS_GATED=tool:write` example guarantees.
- A `once` approval silently becomes a subtree-wide one.
- A corrupt file silently deletes valid entries on the next write.

## Revisit trigger

- **ADR-0012** resolving toward an OS sandbox → Option 2 becomes worth its cost, since the sandbox could
  hold the key.
- Any observed forged approval in a real ledger.
- pi gaining a first-class secret or state store outside the workspace → Option 1 becomes trivial.
