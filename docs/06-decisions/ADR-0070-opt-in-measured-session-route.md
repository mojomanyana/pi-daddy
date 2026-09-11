# ADR-0070: opt-in measured Pi session route

**Status:** accepted candidate

## Context

The default governed child transport uses separate `pi --print --no-session` processes. Its returned text does not carry the provider `Usage` object, so `/grants variants` correctly reports provider usage unavailable. That label is not complete accounting.

Pi's supported SDK/RPC events do expose cumulative provider-reported usage on assistant messages and `message_update`, and settled assistant messages carry authoritative usage. Replacing the default transport would risk its established grant attenuation, process ownership, cancellation, ledger and failure semantics.

## Decision

Add a separate explicit `runMeasuredAgentSession` route rather than changing the default.

- Exact models are limited to `openai-codex/gpt-5.6-sol` and `openai-codex/gpt-5.6-terra` with explicit thinking level.
- One prompt consumes one existing resource-budget attempt before session creation.
- Prompt bytes, requested generation tokens, retained output bytes and wall time have caller-fixed ceilings. The retained-byte check is post-generation and is not claimed as a provider generation-byte cap.
- Settings and sessions are in memory. Resource discovery uses fresh temporary cwd/agent roots, clears context/skills/prompts, loads one factory-named inline extension, and enables no tools.
- Supported auth metadata must report both OAuth and subscription use before launch; no credential value is read, copied or printed. Observed assistant provider/model identity—not requested identity—is checked before success. The complete Pi assistant-message usage shape is retained. Provider token counts and Pi's catalog-priced cost estimates are not subscription charges.
- A pre-aborted caller launches nothing and reserves nothing. Abort during setup is rechecked before prompting. Timeout/operator abort calls the owned session abort path; a settled abort charges cancelled. If the host does not settle inside the explicit termination grace, the call becomes unknown and its reservation remains active rather than being freed or refunded. Malformed usage, non-clean stop reason, identity drift and retained-output overflow charge failed while bounded evidence remains available.
- Results remain `acceptance: not-assessed`; the route cannot adopt, publish, mutate global configuration or expand grants.

The default print route remains unchanged and still reports usage unavailable.

## Consequences

This provides attributable Pi-reported token/cost fields for deliberately selected bounded, no-tool measurement work and supports quality comparisons. It does not provide universal accounting for ordinary children, server latency, subscription-dollar billing, arbitrary tools, writable factory work, retries or recovered sessions. Extending it to effectful work requires a separately qualified effect profile and unchanged ownership guarantees.
