# ADR-0047 — Read-only daily intent and execution snapshots

Date: 2026-09-08
Status: Implemented local candidate; overall review and formal acceptance pending

The existing dashboard/plugin gains an explicit read-only daily mode. It consumes the exact P03
execution-archive-projection-v1 schema/fixture at harness a311df8c991108ada7b6f4b901332232a78e9a44,
vendored without changes and with hashes. It independently rebuilds work-v4 intent with P01 validation.
Archive outcomes never supply acceptance; only a separately supplied genuine host context may do so.
The CLI accepts exact scope selection but no authority file or environment-derived decisions.

Show unstarted obligations, exact attached attempts, revision, acceptance, runtime, coverage/obstacles and
source references separately. Report unavailable/stale authority, snapshot/unknown freshness, and reconnect
gaps; never elect a file tail as active branch or carry old runtime through an error frame. The tracker is
in-memory continuity metadata, not a second authority store. Rendering is deterministic and terminal-safe.

Ordinary fixtures exercise two authorized acceptances out of three obligations alongside completed archive
exits, shared logical names, unstarted work, changed scope, evidence loss, invalid inputs and reconnect.
Repeated actual CLI reads leave owned session/control files and message counts unchanged. Plugin-open
transport is fixture-tested; fresh isolated compiled plugin-command checks are not live Herdr qualification.
No deployed live P03 policy/subscription/freshness source was supplied, so that route remains BLOCKED.

The v1 P04 read-model/types/fixture for P07/P08 are documented under
packages/pi-daddy/contracts/daily-view/v1. P05 control is not invoked; P02/P06 unsupported clauses remain.
No source push, worker/model call, status prompt, native gate or new mutable authority store is introduced.
