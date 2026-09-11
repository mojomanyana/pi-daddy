# ADR-0071: Daily declared-work actions use recorded P01 snapshots

Status: candidate

The process-owned daily host now creates a v3 intent budget bound to the owner-private declared `.pi/work.jsonl`. Read-only rendering derives at most eight labelled proposals from the current exact selection: moving a selected obligation first, selecting a recorded scope whose scope revision is the exact successor, or selecting a recorded snapshot under the same scope as an alternative. Callers may also supply bounded labelled proposals.

Rendering does not apply a proposal. The selected label is rebuilt as an `intent-request-v1` with the current intent revision and selection, added to the host's exact request/digest authority, and sent through the existing dashboard host/selection/tip CAS, intent validator, ordinary-dispatch hold and append-once P01 application. A later frame derives a new action set from the resulting selection. Unknown acknowledgement does not release the ordinary hold.

Only the canonical `.pi/work.jsonl` exception is admitted under `.pi`; other internal paths remain refused. New declarations create the `.pi` parent owner-private so the existing pinned device/inode and mode checks apply. After acknowledged application, the host atomically rebinds `work-current.json`, updates its control/observation selection, and calls the owning grants session to replace its cached ordinary declaration before the intent hold releases. Scope/alternative actions are not displayed when that owner callback is unavailable. The next governed occurrence therefore names the new obligation; stale rebind fails before ordinary dispatch is released. The refresh label reports the rebound snapshot. None of this claims work acceptance.
