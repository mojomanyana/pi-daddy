# ADR-0043: Node types are a peer contract

**Date:** 2026-09-03
**Status:** Accepted
**Driver:** The published declarations expose `NodeJS.*`; a strict TypeScript consumer without `@types/node` fails to compile (R-154).

## Options considered

1. Keep Node types dev-only and document the consumer prerequisite.
2. Remove every `NodeJS.*` name from the public declarations.
3. Declare `@types/node >=22` as a peer, matching the package's Node engine floor.

## Decision

Choose option 3. The package asks consumers for the type namespace its public API uses. The peer is not
optional: marking it optional would preserve the exact no-types consumer failure this decision closes.

## Consequences

Package managers install or require a compatible Node type package. Consumers pinning an incompatible major
may receive a peer-resolution warning. Avoiding Node names remains a future API cleanup, not a prerequisite for
an honest current package contract.

## Revisit trigger

Remove the peer when the emitted public declarations no longer reference the `NodeJS` namespace.
