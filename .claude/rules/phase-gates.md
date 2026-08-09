# Rules — pi-daddy phase discipline

These rules apply to all work in this project.

## Phase discipline

1. The project is gated: D0 (discovery) → G0 → D1 (specs) → G1 → D2+ (code). The current phase is
   whatever the latest `docs/gate-reports/` verdict says; no passing G0 report means D0.
2. **Before G1 passes: no production code.** This project deliberately has no `src/` yet —
   creating one is itself gated. Throwaway measurement probes are allowed only under
   `docs/probes/`, must carry a README stating what they measure and how to rerun, and nothing
   outside `docs/probes/` may import from them.
3. If the user asks to skip ahead ("just build it"), name the gate and the shortest path through
   it — then do what they decide. The gates serve the user; the user outranks the gates. Record
   any deliberate bypass in the gate report as WAIVED with their reason.

## Documentation discipline

4. Decisions live in ADRs (`docs/06-decisions/`), load-bearing claims live in the assumptions
   register, failure modes live in the risk register, and answers live in `docs/01-discovery.md`.
   An answer that exists only in chat does not exist.
5. `docs/00-blueprint.md` is immutable source input. Disagreement with it is recorded as an
   assumption, risk, or ADR — never edited into it.

## Terminology discipline

6. "Workflow skills" = `.claude/skills/` (process tooling for this workspace). The runtime
   tools/skills this project will eventually manage are called "tools" (or "runtime skills") in
   all documents — never bare "skills" where it could be ambiguous.
