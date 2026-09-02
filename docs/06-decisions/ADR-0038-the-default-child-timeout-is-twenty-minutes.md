# ADR-0038: The default child timeout is twenty minutes

**Date:** 2026-09-02
**Status:** Accepted
**Driver:** Repeated `CHILD_TIMED_OUT` outcomes at the ten-minute default

## Context

`PI_GRANTS_CHILD_TIMEOUT` lets an operator choose a per-child wall-clock limit, but an unset, zero, or
malformed value uses the package default. The default was 600 seconds. The operator reports that useful
sub-agent work is routinely being cut off at that exact limit. This establishes that the current limit is
frequently reached; it does not establish that every timed-out child would finish within twenty minutes.

## Options considered

### Option 1 — Keep ten minutes

Retains faster cleanup of hung children, but preserves the repeatedly observed cutoff.

### Option 2 — Raise the default to twenty minutes

Gives normal long-running work twice as long while preserving a finite hard deadline and the existing override.

## Decision

Use 1200 seconds as the default child wall-clock limit. `PI_GRANTS_CHILD_TIMEOUT` remains measured in seconds,
inherited by descendants, and operator-overridable. Zero and malformed values continue to select the default
rather than disabling the limit.

## Consequences

Long-running children get twenty minutes by default. A genuinely hung child may now occupy process, pane, and
workspace-lease resources for up to ten minutes longer. Existing operators with an explicit timeout see no
change.

## Revisit trigger

Revisit when completed-work measurements show twenty minutes is still routinely too short, or when the longer
hang/resource occupancy causes an operational problem.
