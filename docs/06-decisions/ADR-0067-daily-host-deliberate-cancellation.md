# ADR-0067 — Daily host publishes deliberate exact-attempt cancellation

Status: implemented candidate; review pending  
Date: 2026-09-11

## Context

The released production daily host publishes pause/resume for new admission and explicit source refresh. The underlying connected host already supports `ordinary-cancel`, and the original grants extension retains exact live child targets and abort handles. Production did not publish those existing controls as understandable dashboard actions, so deliberate cancellation still required a separately constructed request rather than the normal daily UI.

Cancellation must remain distinct from pausing future dispatch. A read or refresh must never cancel, stale displayed state must not target a replacement, and a settled/missing attempt must not be reconstructed from ledger history.

## Decision

For each currently active attempt retained by the original session, up to the existing eight-child ordinary fan-out width, the daily host publishes a `cancel-exec-…` action labelled with the exact execution ID. It constructs the existing `ordinary-cancel-v1` request from the original port's binding, current revision and complete target, binds both native and host request digests into the current authority callback, and routes execution through the existing connected-host validator.

A cancellation action is available only while the original handle is active. Any revision, target, label or displayed-tip change makes the action stale before an effect. One cancellation advances the original revision, so another attempt requires a fresh frame. The operation requests abort only for that child; sibling and parent lifetimes, runtime outcome, acceptance, and new-dispatch pause state remain separate.

No PID lookup, terminal typing, recovered handle, model judgment, automatic cancellation, or new transport is introduced. More than eight simultaneously active ordinary attempts remain visible but are outside this first action list; a later paged/parameterized interaction may extend selection without weakening exact binding.

## Validation

A red-first production-host test starts a real fixture child through the ordinary public tool, requires an exact labelled cancel action, invokes it through the private dashboard connection, observes the original child's cancelled/aborted result, and requires the action to disappear after settlement. Existing busy-child pause/resume, host-boundary, cancellation acknowledgement-loss and exact authority tests remain green.
