# Probe — generic runtime enforcement primitives (ADR-0034)

- **Date:** 2026-08-19
- **Environment:** Linux, Node v26.7.0, util-linux `flock` 2.41.3.

## What it measures

Against real OS processes and real Git worktrees, without a model:

1. a kernel-held writer lease refuses a second writer for the same canonical root;
2. writers for distinct roots can coexist;
3. killing the parent lease owner with **SIGTERM or SIGKILL** closes the helper's pipe; the helper stops an
   attached writer process before releasing the kernel lock, and the next acquisition records recovery;
4. a named check starts at the validated canonical worktree root with computed Git head/tree identity; and
5. shell metacharacters remain one literal argv element and create no marker file.

Run from the repository root:

```bash
node docs/probes/g34-runtime-enforcement/probe.mjs
```

The captured result is [`transcript-2026-08-19.json`](transcript-2026-08-19.json):

- `same_workspace_conflict: WORKSPACE_WRITE_CONFLICT`
- `distinct_workspace_parallel: acquired`
- `sigterm_recovery: recovered-after-child-stop` and `sigkill_recovery: recovered-after-child-stop`
- check exit `0`, canonical temp-worktree CWD, literal hostile argv, marker absent.

## What it does not establish

- **Filesystem confinement.** The CWD check prevents accidental misrouting only. The check executable or a
  child holding `bash` can use absolute paths, change directory and spawn arbitrary processes.
- **Exclusion of unrelated writers.** `flock` coordinates pi-daddy lease holders; an IDE, hook, another
  runtime, or ordinary process can ignore it.
- **Network isolation.** None is configured or claimed.
- **Portability beyond this measured Linux path.** A missing/failed `flock` command is designed to refuse
  with `WORKSPACE_LEASE_STALE`; this probe does not establish a Windows/macOS adapter.
- **The propensity of a model to escape.** No model runs here.
- **Power-loss durability or a tamper-proof ledger.** The lease metadata and ledger remain ordinary files.
