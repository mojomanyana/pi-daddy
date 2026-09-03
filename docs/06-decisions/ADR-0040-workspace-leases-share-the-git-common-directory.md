# ADR-0040: Workspace leases share the Git common directory

**Date:** 2026-09-03
**Status:** Accepted; implementation blocked on a measured positive probe
**Driver:** Host and devcontainer sessions can use different lease directories and both acquire “exclusive” locks for the same canonical worktree (R-148).

## Context

The lock filename is keyed by the canonical root, but contention occurs only when processes open the same
lock file. Adding the lease directory to the hash does not help: two directories still contain two unrelated
files. `src/workspace.ts` already computes `gitCommonDir` while validating a worktree.

## Options considered

1. **Keep one operator-mandated shared `PI_GRANTS_WORKSPACE_LEASE_DIR`.** Small code change, but correctness
   depends on every host/container configuration agreeing and mounting it at one shared location.
2. **Place the lock under the validated worktree's `gitCommonDir`.** The authority and the coordination
   object share one repository-owned location; linked worktrees naturally converge on the common directory.
3. **Status quo with the namespace qualifier.** Honest but preserves the measured split-brain.

## Decision

Choose option 2, subject to a probe proving host/container and linked-worktree contention, permissions,
worktree cleanup behavior and both process/Herdr executors. The lock belongs under a pi-daddy-specific
subdirectory of `gitCommonDir`; metadata and cleanup must remain token-safe. The environment override may be
retained only as an explicit compatibility escape hatch that forfeits cross-namespace exclusivity.

## Consequences

Correctly mounted repositories get one coordination point without duplicate operator configuration. The
negative cost is writing coordination state under Git metadata, which may be read-only or differently mounted;
such cases must refuse rather than fall back. No code is changed in this wave because the project requires a
measured probe before adding this safety claim, and the existing probes establish only the defect.

## Revisit trigger

Reverse to a mandated shared directory if the positive probe shows `gitCommonDir` is not shared in the
supported devcontainer/worktree layouts or cannot safely host lock state.
