# ADR-0054: Explicit work signals and durable blind debrief bridge

Status: implemented locally; overall review and live qualification pending
Date: 2026-09-08

## Decision

Consume actual skill-harness638494af0a0058edf9a9b1b02e57af894ab46ed6 writer ports in the existing
P08 presenter, not another archive or decision ledger. Ten exact upstream bodies and their SHA256 pins
are retained as fixture data and compiled with retained TypeScript for ordinary integration tests.
Product host wiring accepts the independently loaded module ports; structural interfaces are not module
or human authentication. No caller pin flag, worker metadata or cached eligibility grants permission.

Signal pages are explicit work-signals-v1 opt-in, with independently selected batch and observation.
Case-v3 IDs/reasons/metrics and original case-v2 coverage are bounded and validated. Zero-card issues
remain visible. Counts describe selected batches; history/author/CAS remain the actual harness writer's.
Old case-v2/manual routes remain available and do not reinterpret signal batches.

Explicit private blind retention returns the comparison ID/author for independent host persistence.
The pre-reveal capability exposes only view/readArtifact/quality. Opening/reconnecting never retains a
new seed or calls reveal to discover a vote. Explicit choose writes one immutable quality choice; explicit
reveal rechecks original quality and bytes before identity/cost exposure. Missing/malformed bytes refuse.
Required writer failures remain failures, even after complete writes. Reconnect may read the original vote
without replaying the write; this is not a claim of power-loss durability or authenticated human judgment.

Signals/durable binding opt into checkpoint-v2, pinning independent IDs alongside original attention /
request fields. This remains a host-owned attention transport, not canonical decision storage. One blind
question takes one of five total slots, with no refill on answers/skip/reconnect. Automatic/busy/absent
presentation is still deferred; arbitrary artifact text may leak identity and is not universally redacted.

## Consequences and evidence

Existing dashboard render/actions consume the presenter directly. Actual compiled harness fixtures cover
selected pages, all new signal reasons, zero-card issues, v2 compatibility/refusal, foreign observations,
author/CAS failures, absent originals, immutable conflicting choices, failed quality sync followed by
read-only reconnect, actual new-process reopen and explicit reveal. No model/provider execution, package
lifecycle/install, new worker hooks, runtime controller or publication is added.

Contract and limits: packages/pi-daddy/contracts/debrief/v2/README.md. Full qualification still requires
independent deployed host provenance/identity, durable attention service, live pi/Herdr pause integration,
P09/P12 model-backed qualification/casting, and the single overall source/spec/CI review. Ordinary local
fixture successes and conditional host facts are not those qualifications.
