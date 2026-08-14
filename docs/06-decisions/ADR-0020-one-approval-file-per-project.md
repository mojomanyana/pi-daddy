# ADR-0020: one approval file per project

**Date:** 2026-08-14
**Status:** Accepted (2026-08-14, by the user, Option 1 over a steelmanned Option 3 — delete persistence)
**Driver:** R-41, measured. Revises the storage layout ADR-0014 chose; R-42, R-43 and R-49 all live in the
same read-modify-write. Depends on nothing; ADR-0021 and ADR-0022 are separate decisions taken beside it.

## Context

ADR-0014 moved the approvals store **out of the governed workspace** to close a demonstrated forgery: with
`PI_GRANTS_GATED=tool:write`, a session that may use `write` could write its own approval and produce a
ledger line reading `approvalSource: "persisted"` that was indistinguishable from a human's. That decision
was right and is not reopened here. **What it also chose, without weighing it, was one file for every
project**, with each entry scoped by its own `cwd` field — reusing the R-27 check for a second purpose.

**That shared file has now produced four defects, three of them in the same eight lines.** All were found by
a red-team pass on 2026-08-13 and reproduced by execution before being written down:

- **R-41, the one this ADR is about.** `saveApproval` loaded the file, dropped every non-matching-`cwd`
  entry as `foreign-cwd`, and wrote back **only the valid set** — so approving anything in `/work/web`
  *deleted* the approval given in `/work/api`. Fixed in 0.10.2 by carrying foreign entries through.
- **The half that is still open, and cannot be fixed inside this layout.** The storage key is
  `capability@subject` with **no project component**. Two checkouts holding definitions of the same name —
  `review`, `deploy`, i.e. what happens the moment an operator reuses their own conventions — cannot both
  hold an approval. Measured: A saves, B saves the same key, A now reads its own entry as `foreign-cwd` and
  re-prompts; re-approving in A evicts B. They take turns indefinitely.
- **R-43.** `revokeAll` wrote an empty file, so `/grants revoke --all` in one checkout revoked every
  checkout on the machine. Fixed in 0.10.2.
- **R-42.** The atomic-write temp file was named per process, so two concurrent writes unlinked each
  other's temp and **both** reported failure having written nothing. Fixed in 0.10.2.

The pattern is the point: every one of these is a consequence of *many projects sharing one mutable
document*. R-49 (an unlocked read-modify-write can resurrect a revoked approval) is the fifth, still open,
and has the same cause.

**What the store is for**, because it decides how much machinery it deserves: ADR-0012 gates `bash` by
default, and R-25 records that a control causing prompt fatigue is a control an operator eventually switches
off with `PI_GRANTS_GATED=""`. Persistence exists to stop the default gate being disabled out of irritation.
That is a real job, and it is the argument that kept the layer alive in ADR-0019.

## Options considered

### Option 1 — one file per project *(chosen)*

`~/.pi/agent/grants-approvals/<basename>-<hash>.json`, where the hash is the first 16 hex of
`sha256(cwd)`. One document per governed directory. (It shipped at 6 hex — 24 bits — and was widened the
same day as R-57: this option deletes the `foreign-cwd` carry-through on the premise that one file means
one directory, so inside a collision R-41 returns with its mitigation gone. The premise has to be worth
what was removed to rely on it.)

**Buys:** the collision becomes inexpressible rather than handled — there is no shared keyspace to collide
in. `revoke --all` cannot reach another project because it cannot name another project's file. A corrupt or
half-written file affects exactly one project. Cross-project write contention disappears entirely, so
R-42's fix only has to cover concurrency *within* one project, and R-49's window narrows to two sessions in
the same directory. Every `foreign-cwd` code path becomes dead weight that can be deleted rather than
maintained — and the `cwd` field stays, still doing R-27's original job of refusing an entry copied
somewhere else.

**Costs:** filenames under `$HOME` hint at project directory names. Accepted, and it leaks nothing new —
the entries have always contained full `cwd` paths, in the same directory. Answering *"show me every
approval on this machine"* becomes a directory scan rather than one read; nothing asks that today.

### Option 2 — nest by project inside one file

`{version: 2, projects: {"<cwd>": {"<key>": entry}}}`.

**Buys:** one file to inspect or delete; the collision is fixed.
**Costs:** every write still rewrites every project's data, so R-41, R-42, R-43 and R-49 all remain
*possible* and are prevented only by code being careful. That is precisely the bet that has now lost four
times. Rejected for that reason rather than on taste.

### Option 3 — delete persistence entirely *(steelmanned; this is the option to keep in mind)*

Drop the 30-day store; keep `once` and `session`.

**The case for it is strong and got stronger.** This file has produced **nine** recorded defects: R-37 (no
version from 0.7.0 to 0.9.0 could write it at all), R-38 (the preview disagreed with the enforcer about it),
R-40 (`npm test` rewrote the developer's real store), R-41, R-42, R-43, R-44 (a model-authored task landed
on disk), R-49, R-50. Deleting it removes 220 lines, `entryVerdict`'s four checks, `/grants approvals`,
`/grants revoke`, and all of ADR-0014's atomic-write and symlink work — the largest mutable-state surface in
the package. ADR-0019 rejected deletion twelve hours before most of this evidence existed, so the balance
genuinely moved.

**Why it lost anyway:** the cost lands on ADR-0012's default `bash` gate, which is the one gate an operator
does not opt into and therefore the one most exposed to fatigue. A gate answered every session is a gate
that gets switched off, and R-25 says so. Option 1 removes the *cause* of five of the nine defects while
keeping the property that justifies the layer.

### Rejected sub-option — migrate the existing file

Entries carry their own `cwd`, so splitting the old file into per-project files is mechanical and lossless,
and the trust root does not change (unlike ADR-0014's move, where importing old entries would have imported
exactly the entries whose trustworthiness the change existed to remove). It is nevertheless **not done**:
migration is code that runs once, is exercised on precisely one input per machine, and lives in the layer
with nine defects. The old file is ignored and named in a warning; re-approving costs a click.

## Decision

**Persisted approvals move to one file per governed directory**, at
`$PI_CODING_AGENT_DIR/grants-approvals/<basename>-<first 16 hex of sha256(cwd)>.json`. The single shared
`grants-approvals.json` is **ignored, not migrated**, and reported once at session start so an operator
whose approvals stopped applying learns why. Each entry keeps its `cwd` field and `entryVerdict` keeps
checking it — a file copied between machines or checkouts still authorises nothing (R-27). `revokeAll` and
`saveApproval` operate on one project's file and can no longer see another's, so the `foreign-cwd` handling
those two paths gained in 0.10.2 is removed as dead code rather than left as a second line of defence
against a case that can no longer arise. For v1 this means the keyspace collision is closed, and
`/grants approvals` continues to describe exactly one project.

## Consequences

**Positive.** Two checkouts with same-named definitions each keep their own approval. `revoke --all` is
project-scoped by construction rather than by a `cwd` comparison. One project's corrupt file cannot
suppress another's approvals. Cross-project write contention is gone.

**Negative.** A machine-wide view of approvals now requires reading a directory; no command does that
today, and if one is wanted it is a new feature rather than a regression. Operators upgrading re-approve
once. The directory accumulates a file per project ever governed, including deleted checkouts — those
entries expire after 30 days but their files persist, which is litter rather than a hazard.

**Neutral.** The store remains a **convenience cache**, not a security control: the security decision was
made by a human at the moment of approval, so a failure here must never fail the work.

**Deliberate non-goals.** No file locking (R-49 stays open and is now scoped to one project). No migration.
No garbage collection of files for directories that no longer exist. No `skill:`- or machine-level view.

## Revisit trigger

An operator with enough governed checkouts that the directory becomes unmanageable, or any concrete need to
answer *"what has been approved anywhere on this machine?"* — both of which argue for Option 2's single
document, and neither of which is hypothetical if this package is ever used across a monorepo's worth of
subdirectories. Note that a session started in a **subdirectory** is a different project to this code, so it
gets its own file and its own re-prompt; that was already true before per-project files, but it is
fragmentation as well as litter.

**Toward Option 3 (delete persistence), amended 2026-08-14 after a reviewer called the original trigger
unfalsifiable — correctly.** It said *"any further defect traced to this layer"*, which every defect since
would have tripped and none did, so it decided nothing. Defect count is the wrong axis: R-37, R-38, R-40 and
R-44 were all *"nobody had ever exercised this"*, and it has now been exercised end to end. The replacement,
either half of which is sufficient:

- **One** instance of `entryVerdict` honouring an approval it should have voided. That is the single
  property the layer was kept for, so one is enough.
- **Two** defects at M×M or above, in `approval-store.ts` or `extensions/approvals.ts`, that reach a
  **released** version — as opposed to being caught in the session that introduced them, which is what has
  happened to every one so far.

And the benefit side, which this ADR asserts rather than measures: it keeps the layer on R-25's fatigue
argument with no number behind it. The ledger now records `approvalSources` per capability (0.11.1), so
counting `persisted` against `prompt` over a few weeks of real use settles Option 3 with evidence instead of
argument, and needs no new machinery.

**Dated note, 2026-08-14 (0.13.0) — the trigger is now runnable, and the decision is unchanged.**
*"Needs no new machinery"* was true of the data and false of the answer: `approvalSources` was recorded and
nothing read it, so settling this ADR required hand-written `jq` and therefore never happened. `/grants
ledger` now prints the tally — `N prompt · N persisted · N session · N inherited`, and *"N of M attributed
yes(es) came from the persisted store"*, which is the number stated as what it measures: prompts the
operator did not see, and which deleting the layer converts back into prompts.

Records written before per-capability sources existed are reported as **not counted** rather than folded in.
The pre-0.11.1 scalar described a whole set even when its sources differed (R-46), so including it would
report humans as having been asked about capabilities they were never asked about — inflating `prompt`
against the `persisted` number this trigger turns on. Old lines shrink the sample; they must never colour it.

**This does not settle anything yet.** Only usage produces the number, and that is still the operator's to
run. What changed is that the missing piece is now *use* rather than *tooling*.

R-49 was also closed the same day, which the "deliberate non-goals" above list as out of scope for this ADR
("no file locking"). That remains true of *this* decision — the fix was reuse of the ledger's existing lock,
not a new mechanism, and it leaves nothing extra to remove should Option 3 ever be taken.
