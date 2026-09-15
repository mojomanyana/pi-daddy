# ADR-0075: Explicit completed history in the ledger dashboard

Date: 2026-09-15. Status: accepted for implementation, pending independent review.

## Context

The operator confirmed six Pi delegations were recorded. The ledger renderer retained only the latest
three quiet roots per workflow or ungrouped tree and silently omitted the rest. Details exposed grant and
correlation fields but did not expand those roots. Completed children already had a collapsed count, but
also lacked a user input to expand them. The complete ledger was intact; compact presentation obscured it.

## Decision

Keep the existing compact defaults: three quiet roots per group and two quiet children per parent. Emit a
hidden-root count in each affected group. Add a local history display state: h followed by Enter expands
all quiet roots and children, and the same input restores the compact limits. The prompt names the current
Expand/Collapse action. Details remains a separate d input; neither toggle changes the other.

The renderer history option overrides both compact limits. Active (authorised, starting, running) and
attention (failed, refused, incomplete) branches and their ancestors remain exempt from limits in both
states. Selection, chronology, projection identity, ledger content and host authority stay unchanged.

History input is available only on the ledger path, without a connected host, separate debrief or daily
view. Connected daily controls and their action keys retain their existing meaning. The product guide now
separates connected daily diagnostics/attempt history from the ledger's governance Details and h control.
The local toggles are transient and reset when the process restarts.

## Alternatives and consequences

Making Details expand history would conflate two independent display choices. Showing every completed
root by default would remove the compact view. A count alone would explain omission without making the
missing executions reachable. An explicit reversible toggle preserves the compact default and makes the
retained history inspectable. Expanded histories can exceed the terminal viewport; this change adds no
pagination, incremental ledger reader or persistence of view preferences.

## Evidence and limits

Focused renderer regressions exercise six completed roots, workflow and ungrouped counts, expansion and
collapse, and every active/attention state nested under completed ancestors with both limits set to zero.
CLI tests exercise the production display helper through file-backed frames and real readline input in an
offline child process. Removing the summary, ignoring history, dropping its draw/input wiring, or allowing
limits to hide interesting descendants breaks named assertions. Non-ledger helper coverage preserves the
existing prompt and does not consume h or action keys.

Validation uses synthetic ledger records and existing local dependencies. No model call, live Pi/Herdr
control, installation or publication is involved. This does not establish installed-package behavior in an
operator's live pane, unlimited-history performance or acceptance of any recorded delegation.
