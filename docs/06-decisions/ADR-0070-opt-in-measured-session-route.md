# ADR-0070: opt-in measured Pi session route

**Status:** accepted candidate

## Context

The default governed child transport uses separate `pi --print --no-session` processes. Its returned text does not carry the provider `Usage` object, so `/grants variants` correctly reports provider usage unavailable. That label is not complete accounting.

Pi's supported SDK/RPC events do expose cumulative provider-reported usage on assistant messages and `message_update`, and settled assistant messages carry authoritative usage. Replacing the default transport would risk its established grant attenuation, process ownership, cancellation, ledger and failure semantics.

## Decision

Add a separate explicit `runMeasuredAgentSession` route rather than changing the default.

- Exact models are limited to `openai-codex/gpt-5.6-sol` and `openai-codex/gpt-5.6-terra` with explicit thinking level.
- One prompt consumes one existing resource-budget attempt before session creation.
- Prompt bytes, output bytes, output tokens and wall time have caller-fixed ceilings.
- Settings and sessions are in memory. Resource discovery uses fresh temporary cwd/agent roots, clears context/skills/prompts, loads one factory-named inline extension, and enables no tools.
- Provider/model identity and the complete Pi assistant-message usage shape are checked before success. Provider token counts and Pi's catalog-priced cost fields are retained as reported, not recomputed or described as subscription billing.
- Timeout/operator abort calls the owned session abort path and the charged attempt settles cancelled; malformed usage, identity drift and output overflow settle failed.
- Results remain `acceptance: not-assessed`; the route cannot adopt, publish, mutate global configuration or expand grants.

The default print route remains unchanged and still reports usage unavailable.

## Consequences

This provides attributable Pi-reported token/cost fields for deliberately selected bounded, no-tool measurement work and supports quality comparisons. It does not provide universal accounting for ordinary children, server latency, subscription-dollar billing, arbitrary tools, writable factory work, retries or recovered sessions. Extending it to effectful work requires a separately qualified effect profile and unchanged ownership guarantees.
