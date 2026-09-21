# B1 containment finding and primary-error preservation — handoff

**Date:** 2026-09-04
**Branch:** `b1-containment-finding`
**Baseline:** `62e9d027514e9fc6d689d505d7ef733a07f1470c`
**Release action:** none — no publish, tag, push, model call or judge call.

## Identity and evidence gate

The checkout was `main` at the exact required baseline, which contains the required commit by equality. It
was clean apart from the untracked `.pi/`; no `test/workspace.test.ts` process was present. Work then moved
to `b1-containment-finding` before the first repository edit.

`/home/neman/Code/principal-v3-qualification-20260901` was read only. No file there or in any other repository
was modified. The preserved principal product checkout was already dirty and remains untouched.

## Measured containment finding

The supplied filesystem finding is substantiated:

- `wave-a-v6-s02-luna-subject-r1`'s invocation record names the empty initial CWD
  `measurement/wave-a-v6/packet/work/wave-a-v6-s02-luna-subject-r1`.
- Its retained JSONL (`805f9d2b6136bc0cb4c85f24c81a300fa140afecff9b0528829bbafc5149a075`)
  records `pwd`, the empty local search, a qualification-root search, reading `// teh balance`, and the exact
  absolute-path `edit` to `// the balance`.
- `git status` in the frozen product checkout reports only
  `M build/tests/fixtures/C1/notes.ts`; its diff is exactly that one-word comment change. The contaminated
  file hash is `323fd7a02ab449548abb3d7a08a7774d9f643b3bcb593d2b0f17d4a0acee7756`;
  the pinned `HEAD` form hashes to `302dfeed16840b7cb5863d0067c43b680f64ea6acde42344613a419f50a62f08`.
- File mtime `2026-09-03T00:14:16.077715026Z` is inside receipt window
  `2026-09-03T00:14:01.203Z`–`00:14:22.107Z`; the JSONL edit result is timestamped
  `2026-09-03T00:14:16.085Z`.
- `WAVE_A_V7_FINAL.json` (`60e92abd782e43bbd25314f2f7e2b26c5e03730701fba9d3f1494f2441388dc7`)
  retains the next prepare's `qualification product checkout must be clean` refusal.

This proves an unsandboxed child can write outside its initial working directory, and records one model doing
so without being given the target path. It does **not** prove a pi-daddy governance failure: the child used
tools it held, and pi-daddy claims tool-surface governance, not filesystem confinement.

R-177 records the measured/accepted boundary. `docs/probes/g38-cwd-is-not-containment/README.md` provides
read-only re-verification commands and hashes without copying evidence. SPEC's execution-primitive,
`WRITER_ROOT`, and known-gap text links the probe. ADR-0012 records that its evidence-in-practice revisit
trigger fired but makes no new sandbox decision.

## Important evidence correction

The retained evidence does **not** substantiate the supplied statement that Wave A v6's hidden primary was
specifically the dirty-checkout prepare refusal. `WAVE_A_V6_PREFINAL_EXCEPTION_DIAGNOSIS.json`
(`843e7d8bfdf89551de76b9528b8ba4d36b2c0f6c9613d64dae47e41735412c35`) says the primary exception was not
persisted and cannot be reconstructed; `WAVE_A_V6_FINAL.json` likewise calls it an unspecified earlier
exception. The dirty-checkout message is retained by v7. This change records the proven sequence and does not
upgrade the plausible v6 cause into a measured fact.

The broader masking defect is proven: v6's `finalReport()` attempted absent `manifest-v5.canonical.json`, its
ENOENT replaced the active primary in stderr, and no controller final report was written.

## Same shape in pi-daddy and repair

The audit found the same primary-masking shape in four production paths:

1. `runHerdrPane`'s throwing writer-tab cleanup in a bare `finally`;
2. `runNamedCheck`'s staged-directory and lease finalizers;
3. temporary Git-index cleanup in `computeGitCandidateIdentity`;
4. `init`'s new-file handle close.

`src/finalization.ts` adds one shared `runWithFinalizers` boundary. It runs every finalizer. When the operation
already failed, the same extensible primary `Error` object survives, preserving refusal codes and
`instanceof` classification, while all finalizer failures are attached and added to its message. Frozen or
non-Error primaries remain the first member and cause of an `AggregateError`. If the operation succeeded,
finalizer failure remains loud. `executePlannedChild` also recognizes an attached `HerdrWriterCloseError`, so
the workspace writer lease is retained even when another executor error is primary.

R-178 records the consumer hazard and local repair.

## Tests and Rule 7

The new regression, `a finalizer failure cannot mask the primary Herdr failure`, injects both an executor
rejection and a writer-tab close failure. Before production repair it failed because the observed error was
`HerdrWriterCloseError`, not the exact primary object. After repair it requires the primary identity, primary
message prefix and attached finalizer diagnostic.

Mutation entry `finalization: cleanup replaces the primary failure` replaces the preservation branch with the
finalizer error and must produce that named failure. A second guard removes attached writer-close recognition
and must fail `an attached Herdr close failure still retains the writer lease`.

## Verification

Commands ran from `packages/pi-daddy` with `HEAD` printed as
`62e9d027514e9fc6d689d505d7ef733a07f1470c` where recorded:

- Focused red: **1 failed** — finalizer replaced the primary with `HerdrWriterCloseError`.
- Focused green: **2 passed, 0 failed** (existing writer-close guard plus new masking regression).
- `npm test`: **741 passed, 0 failed**.
- `npm run typecheck`: **passed**.
- `npm run test:integration` without `PI_GRANTS_IT_MODEL`: **48 passed, 0 failed; 3 opt-in model tests skipped**.
- `npm run test:smoke`: first run **failed ENOSPC** because `/tmp` was 99% full. Twenty-nine stale
  package-owned `/tmp/pi-daddy-check-exec-*` directories occupied 4,266,459,136 bytes; only those were removed.
  Immediate rerun: **passed** — `smoke: installed package imports, dashboard, plugin, and pi-daddy init — OK`.
- `npm run test:mutation` at committed candidate `a85da62faa7fe859d9edbbb52013d9a6f06a5db2`: **126/126 guards forced a named failure**.
- `git diff --check`: **passed**.

## Workspace hygiene

The pre-existing untracked `.pi/` remains unmodified and unstaged. Qualification evidence and all other
repositories remain untouched. A post-mutation process check found one mutation-created
`test/workspace.test.ts` Node process still running from this checkout; it was sent SIGTERM, exited, and a
second process check was empty. No push was performed.
