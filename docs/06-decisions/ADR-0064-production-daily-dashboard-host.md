# ADR-0064 — Explicit production daily dashboard host

Status: implemented candidate; live qualification pending
Date: 2026-09-11

## Decision

Add `/grants host <fresh-id>|stop` as the smallest production composition of existing components. It runs inside the original grants extension process so the dashboard keeps the actual ordinary-child handles. The already-loaded skill-harness extension publishes a frozen exact-source API bridge; pi-daddy checks the closed source identity and required source-job functions before adopting it. This same-process declaration is not human/module authentication or hostile-code isolation.

Starting a fresh host creates a private host directory, a bounded dispatch budget, a no-exposure trust policy, exact archive policy, and host journal. It copies the currently declared work bytes and an explicitly empty fact declaration into the host source area, then runs the existing facts/work ingestion jobs. Empty arrays assert no waits, checkpoints, violations or prior acceptance. They do not infer those facts from absence. The dashboard therefore has an attributable startup snapshot. A listed `refresh-current-work` action atomically replaces only the host mirror from the same selected declared ledger and advances the existing exact source checkpoint; periodic frame redraw remains read-only and never invokes the copy or source job.

The host publishes one current control key—`pause-new-dispatch` or `resume-dispatch`—and the explicit `refresh-current-work` source action. Requests are created from the current host tip, selection and native dispatch revision and pass the existing whole-request and native digest validators. A pause acquires the existing original ordinary admission hold before applying dispatch control. Already-running children continue under their original callers; only later ordinary admission refuses. Resume releases that exact hold only after an acknowledged applied native resume. Unknown acknowledgement retains the hold. Stop closes the socket and does not cancel children.

No JSON/CAS envelope, fixture helper, PID discovery, worker monitoring prompt, transport rewrite, automatic acceptance, quality choice, retry, or controller recovery is added. A restarted process uses a fresh id; existing host state is evidence, not authority.

## Validation

Targeted tests cover exact loaded-bridge identity, asynchronous CAS-context action publication, real source ingestion and attached attempt visibility, pause during an actual busy ordinary child, refused new dispatch, resume, and a later successful child. Existing pending-resource, intent-boundary, cancellation and displayed-action tests remain unchanged.
