# ADR-0042: Routing authority needs an inherited destination pin

**Date:** 2026-09-03
**Status:** Accepted; implementation deferred
**Driver:** Probe g37 shows that rewriting the registry repoints an authorised workspace ID to an unauthorised destination while the ID-level capability check still passes (R-137).

## Context

`workspace:<id>` attenuates the name, not the mutable id-to-path meaning. File ownership cannot distinguish a
same-uid governed child from its parent. The first content-pin attempt was reverted after four failures,
including missing Herdr propagation and an unsafe second registry reader.

## Options considered

1. **Status quo with the explicit non-claim.** No new mechanism, but the measured destination escalation
   remains.
2. **Strip the ambient registry and supply each child a narrowed immutable registry.** Strong destination
   control, but introduces per-child files and another parser/distribution lifecycle.
3. **Root resolves an id-to-canonical-destination digest map and descendants inherit only the entries their
   effective grant authorises.** Reuse the one bounded registry reader; both executors receive the same pin,
   and missing, empty, malformed or mismatched pins refuse.

## Decision

Choose option 3. The inherited map is authority, not advisory metadata: descendants cannot mint it, every
workspace capability handed down narrows it, and routing requires an exact canonical-destination match. The
process and Herdr paths must share one propagation builder. No new reader may bypass the existing regular-file,
size and bounded-read checks.

## Consequences

A registry rewrite no longer changes what an inherited ID means. The cost is a new environment wire, failure
behavior for sessions that cannot establish the root pin, and extra care around `/grants init` after session
start. No implementation lands in this wave: the previous attempt failed specifically because it was treated as
a small patch, and the accepted mechanism needs a positive g37 reversal plus mutations for both executors,
empty/malformed state and attenuation.

## Revisit trigger

Reconsider option 2 if the inherited map cannot fit the bounded environment for realistic registries or if
controllers need independently signed destination manifests.
