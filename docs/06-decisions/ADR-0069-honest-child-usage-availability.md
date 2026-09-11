# ADR-0069 — Report child provider usage as unavailable on the print transport

Status: implemented candidate; review pending
Date: 2026-09-11

## Context

Pi 0.84.2 exposes assistant `message_end` usage inside an extension-hosted session and accepts nested model `Usage` on a tool result. The ordinary pi-daddy child, however, runs as a separate `pi --print --no-session` process. The current result boundary retains text, exit/timeout/cancellation, output bytes, execution identity and controller timing; it does not receive the child's assistant message event or an authoritative provider/billing counter.

The primary/shadow report previously listed execution outcomes without stating this absence. A planned response ceiling or number of expected children could therefore be mistaken for measured provider-call or billing evidence.

## Decision

Keep the existing transport and its hard controller bounds. `/grants variants` now always states that child provider usage is unavailable, that the child print transport retains no `Usage` event, and that fan-out, output bytes and wall time remain controller-bounded.

Do not synthesize token counts from text, count a child process as exactly one provider call, equate client elapsed time with server time, or populate dollar cost from model catalog prices. Do not switch ordinary children to JSON/session transport solely for accounting: that would change the execution/result contract and requires a separate same-guarantees design and migration.

A future route may return nested `Usage` only when it can bind the complete child event to the exact execution and preserve retries, compaction, cancellation, output and settlement semantics. Until then, usage-dependent comparison/casting remains ineligible rather than zero-cost.

## Validation

A red-first primary/shadow command test required the unavailable label after all original child outcomes settled. The old report failed that assertion; the candidate passes while retaining the existing completed/failed/cancelled outcomes. Typecheck and the 400-line source ceiling remain green.
