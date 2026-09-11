# ADR-0066 — Explicit repair for a dashboard linked from another package

Status: implemented candidate; review pending  
Date: 2026-09-11

## Context

The dashboard deliberately verifies that Herdr's `pi-daddy.dashboard` registration points at the plugin root bundled with the currently loaded pi-daddy package. That prevents a disabled or same-ID foreign copy from being enabled or invoked. It also makes isolated installs and upgrades awkward: Herdr correctly reports the old global link, the startup handshake diagnoses “linked from a different package,” and then stops. The released demo therefore had to avoid the automatic launcher and start the dashboard explicitly.

The existing `linkDashboardPlugin` path is already the only operation used after the literal **Install and open** choice. The missing behavior is consent and routing, not another installer or weaker provenance checking.

## Decision

When exact plugin inspection reports only a package-root mismatch, the Herdr-hosted startup handshake offers **Relink and open / Not now**. Only the literal affirmative choice invokes the existing link operation against the current package's resolved bundled root, re-inspects exact root and protocol compatibility, and opens through the existing verified host/pane path.

**Not now**, dialog dismissal, timeout, and UI teardown do not relink and do not write a suppression preference. A later correctly loaded session may ask again. Protocol-major mismatch, disabled state without matching provenance, unavailable discovery, and any other incompatibility retain their existing fail-closed diagnostics. `/grants dashboard` remains non-installing.

This does not silently mutate the global plugin registry, choose between packages, weaken exact-root checks, touch another Herdr session, or claim that a package version proves loaded runtime identity.

## Validation

A red-first handshake regression starts with the exact plugin ID linked to an old root, chooses **Relink and open**, and requires one link to the current root plus one pane open. A negative regression chooses **Not now** twice and requires no link and no persisted preference. Existing absent-install, dismissed-dialog, host-verification, protocol, disabled/provenance-order, pane identity, and command-does-not-install tests remain green.
