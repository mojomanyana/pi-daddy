# Probe — does `flock`'s command inherit the lock file descriptor? (R-99)

- **Date:** 2026-08-20
- **Environment:** Linux (WSL2), Node v24.14.0, util-linux `flock` 2.39.3.

## Why this exists

Two independent reviewers of the 0.18.0 candidate reached **opposite** conclusions about the same code, and
both said they had measured it:

- one reported that SIGKILLing the `flock` wrapper leaves the helper holding the lock, so a later
  acquisition returns exit 73;
- the other reported that `flock` sets `FD_CLOEXEC`, so the wrapper's death releases the lock and only a
  stray *process* leaks.

The writer lease's entire teardown story depends on which is true, so it was measured rather than argued.
This is rule 5 doing its job on a disagreement between two careful readings.

## What it measures

Against real `flock` and real processes, no model:

1. whether the command `flock` execs holds an fd on the lock file at all (`/proc/<pid>/fd`);
2. whether the lock is held while wrapper and command are both alive;
3. whether the command **survives** SIGKILL of the wrapper;
4. whether the lock is **still held** after the wrapper alone is killed — the buggy teardown path;
5. whether killing the command too frees it;
6. whether `-o/--close` exists in this `flock` (i.e. whether not-inheriting is opt-in).

Run from the repository root:

```bash
node docs/probes/g35-flock-fd-inheritance/probe.mjs
```

## Result

Captured in [`transcript-2026-08-20.json`](transcript-2026-08-20.json):

| finding | value |
|---|---|
| `child_holds_lock_fd` | `true` |
| `held_while_both_alive` | `held` |
| `child_survives_wrapper_kill` | `true` |
| `held_after_wrapper_kill_only` | **`held`** |
| `held_after_child_kill` | `free` |
| `close_flag_documented` | `true` |

**The exec'd command inherits the lock file descriptor and holds the lock in its own right.** Killing only
the wrapper leaves the lock held by an orphan. `-o, --close` exists precisely because inheriting is the
default, and pi-daddy does not pass it.

So the first reviewer was right and the `FD_CLOEXEC` claim was wrong. The fix in `src/workspace-lease.ts`
gives the holder its own process group and kills the **group**, which also covers the readiness-timeout
path where the helper's pid is not yet known.

## What this does not establish

- **That `--close` would be the better fix.** It would release the lock as soon as the wrapper dies — which
  is the *fail-open* direction for a lease whose purpose is to be held while a governed writer lives. Not
  measured, and deliberately not chosen.
- **Portability.** util-linux 2.39.3 on one Linux kernel. A different `flock` implementation, macOS, or
  Windows is not covered; ADR-0034 already makes `flock` a stated platform requirement.
- **Anything about `flock`'s behaviour under `--wait`, shared locks, or NFS.** Only the exclusive,
  non-blocking, local-filesystem path this package uses was exercised.
- **That the process-group kill is sufficient in every teardown case.** It is verified by unit test for the
  readiness-timeout path (`test/workspace.test.ts`, "teardown kills the whole holder group") and by this
  probe for the mechanism; a helper that has already been reparented out of the group by something else is
  not covered.
- **That no lock can ever be stranded.** The herdr close path deliberately gives up after a bounded number
  of attempts and releases anyway (R-102); that is a different mechanism and is not measured here.
- **Pid-recycling safety.** The helper signals a recorded pid with no start-time identity check (R-101).
  Not exercised.
