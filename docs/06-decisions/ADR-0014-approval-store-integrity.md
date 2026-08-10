# ADR-0014: The persisted-approval file is forgeable by the agent it gates

**Date:** 2026-08-10
**Status:** **Accepted 2026-08-10 — Option 1 (relocate the trust root) + the scope/subject/durability
fixes.** **Implemented 2026-08-11** — 222 unit + 11 integration tests passing.
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

## Decision

**Option 1 (relocate the trust root) plus the scope, subject and durability fixes.** Taken 2026-08-10.

1. **The approvals store moves out of agent-writable space**, to `~/.pi/agent/`, keyed by project path.
   This closes forgery for any agent that lacks write access to the user's home directory — the realistic
   case, since the whole point of a grant is that the child is narrowed and a narrowed child does not
   receive it. Existing workspace files need a migration path.
2. **Scope and subject are threaded through propagation.** `PI_GRANTS_APPROVED` carries
   `capability@subject` pairs together with the scope, so a `once` approval **never crosses a spawn or
   process boundary**, and a `<delegate>`-subject approval can no longer satisfy a different subject. This
   is a **breaking change to the propagation format** between versions.
3. **Durability:** atomic replace, no symlink following, and a corrupt file must not cause the next
   legitimate write to delete valid entries.

**Signing (Option 2) was rejected as an alternative and noted as an addition.** Its key needs exactly the
safe location Option 1 provides, so it is Option 1 plus cryptography rather than a competing choice.
**Dropping `always` (Option 3) was rejected** because repeated prompting is itself what drives reflexive
approval, which is how gates stop working — trading a security property for an ergonomic one that has its
own security cost.

### Proportionality, stated so the effort matches the threat

Under **ADR-0012** — accepted the same day — a child holding `bash` can start a completely ungoverned pi.
**Hardening this store against an agent that already has a shell buys confidence, not security.** Option 1
is worth it because it is small and closes the *self-defeating* case (an agent gated on `write` writing its
own approval). Going further here, before the `bash` question changes, would be misallocated effort.

The scope, subject and durability fixes are worth doing under any option: they are unambiguous defects, and
each one inverts the meaning of something a human explicitly chose.

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
