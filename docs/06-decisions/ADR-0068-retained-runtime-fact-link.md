# ADR-0068 — Link exact retained runtime facts from daily observation

Status: implemented candidate; review pending
Date: 2026-09-11

## Context

The released null-facts profile derives a silent coverage case from retained work, but its linkage does not expose a compact artifact for exact attempt completion and obligation coverage/acceptance facts. Consumers can re-read the complete work projection, yet the case → evidence navigation remains indirect. Missing checkpoint, expected-wait and prior-acceptance evidence must stay unavailable rather than being inferred from process completion.

Skill-harness source commit `28b55d40a64ce7af8ed23410a137f2e3a075e522` adds a content-addressed `observed-work-runtime-v1` artifact to the existing archived-work signal linkage. It derives only from the pinned work-v4 projection.

## Decision

Re-pin the loaded dashboard bridge and its byte-verified fixture to that exact harness source. During a work observation, publish the returned `runtimeFactsManifestId` in the observation's metadata. The artifact records exact attempt identity/state/resolution, terminal observed occurrence digests when present, and each obligation's projected acceptance and coverage. It explicitly lists checkpoint, expected-wait and prior-acceptance history as unavailable in this projection-only artifact; separately supplied host facts retain their own linkage and provenance.

The manifest identity is evidence navigation, not acceptance, a checkpoint, a defect label, or authority. Existing signal cases remain silent and harness-owned. The source job still catches semantic derivation failure as an observation issue without blocking the worker; it does not substitute an empty artifact.

## Validation

The harness regression fails before the artifact exists, then requires two fixture attempts with terminal evidence, unresolved acceptance, and explicit unavailable fact classes. Pi-daddy's red-first production-host regression requires the manifest ID on the current work observation. Exact vendored source digests, source/tree identity, host-boundary tests, typecheck and existing no-note coverage behavior remain checked.
