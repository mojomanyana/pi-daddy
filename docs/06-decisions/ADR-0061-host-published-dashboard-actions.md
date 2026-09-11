# ADR-0061 — Host-published human dashboard actions

**Status:** implemented on the stacked post-merge C03 branch; not released.

## Context

The connected dashboard accepted only complete JSON host requests on stdin. Although CAS, exact authority and idempotence were correct, ordinary steering required a person to copy host/selection/tip digests and native envelopes.

## Decision

The original dashboard host may publish a bounded set of `{key, label, request}` actions. Before display or execution it verifies that every request matches the current host, selection and journal tip and that its exact digest is already in the independent authority's request set. The frame exposes only key, label and operation. A person types the listed key; the private host connection resolves it to the original request and the existing `action` validator performs the effect.

Unknown, stale, duplicate-key, malformed or no-longer-authorized actions refuse before an effect. Refresh remains read-only. Raw JSON remains accepted for compatibility and automation, but is no longer the presented ordinary workflow.

## Evidence and limits

Red-first host tests cover rendered labels without CAS disclosure, unknown-key refusal, exact execution, and the real private socket path. The slice supplies the safe human action mechanism; producers still must construct concrete pause/resume/priority/cancel requests under their existing authority, and busy-child steering remains to be observed before C03 is complete.
