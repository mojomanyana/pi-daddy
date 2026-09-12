# Publishing pi-daddy 0.25.2

Owner authorization: 2026-09-12. Registry baseline: 0.25.1. Only pi-daddy changes.

1. Preserve PR #46 merge `3451fca5ff6a5d20ab138bd905fc422e86abd8ed`. Land metadata via a green PR.
2. From a fresh clean worktree at the exact release merge, run typecheck/build and installed-package smoke.
   Retain one canonical npm pack archive, JSON inventory and SHA-256/SHA-512 integrity.
3. Install that archive in a fresh isolated prefix with skill-harness 0.15.0 and Pi 0.85.1.
   Load explicit extensions with in-memory stores and zero provider requests; verify public entrypoints
   and bundled native reporter bytes. No paid model call is needed for this metadata-only release.
4. Recheck 0.25.2 is absent; publish the canonical archive once. If ambiguous, inspect registry bytes before retry.
5. Verify registry version, latest and downloaded bytes. Create immutable v0.25.2 at the exact release merge
   and its GitHub Release. Never overwrite versions/tags or bypass authentication.
6. After publication verification, separately perform the explicitly authorized local package update.
   Do not restart unrelated sessions. Fresh human cancellation testing remains a separate acceptance gate.

---

## Prior 0.25.1 runbook (historical)

# Publishing pi-daddy 0.25.1

The owner authorized merge and publication on 2026-09-12. Registry baseline: 0.25.0.
Only pi-daddy changes; skill-harness 0.15.0 and Principal 3.2.0 remain unchanged.

1. Preserve feature PR #44 merge `233c495a88ee19e4a82203b50425700409807b91`.
   Land this metadata-only patch release through a green PR; no direct main commit.
2. From a fresh clean worktree at the exact release merge, run typecheck/build and installed-package
   smoke, then retain a canonical npm pack archive, JSON inventory and SHA-256/SHA-512 integrity.
3. Install the exact archive under a fresh isolated prefix. Load only explicit pi-daddy and
   skill-harness 0.15.0 extensions in an SDK host with in-memory stores, no active tools and zero
   provider requests. Verify public entrypoints, learning bridge and bundled native reporter bytes.
   The recorded live Terra executor smoke on the unchanged PR #44 runtime is the live gate
   for this metadata-only patch; do not repeat paid calls solely for the version bump.
4. Recheck that 0.25.1 is absent, then publish the canonical archive exactly once. If the response
   is ambiguous, inspect registry metadata and downloaded bytes before considering any retry.
5. Verify registry version, latest tag and downloaded archive bytes. Create immutable tag
   `v0.25.1` at the exact release merge and a GitHub Release. Never overwrite a published version,
   rewrite a tag, bypass authentication/OTP, or globally install/link as part of publishing.

Publication is distinct from the subsequent fresh human demo, browser acceptance and host setup repair.

---

## Prior 0.25.0 runbook (historical)

# Publishing pi-daddy 0.25.0

Live npm baseline: 0.24.0. The owner authorized merge, release and publication on 2026-09-12. `pi-daddy` is the only public package; the workspace root is private. Principal is unchanged.

## Required order

1. Preserve merged feature PR #41 ancestry (`5cea7c0` contains exact reviewed head `8b8fc7d`) and land version 0.25.0, lockfile, tests, changelog, package entrypoint documentation and this runbook through a green release PR.
2. In a fresh clean worktree of the exact release merge, run typecheck/build and the package smoke. Pack `packages/pi-daddy` once with normal lifecycle scripts, retain npm's JSON inventory and hash the archive.
3. Install that exact archive under a fresh temporary prefix. With canonical skill-harness 0.15.0 artifacts, load only the two package extensions in an SDK host using in-memory credentials/model store/settings/session, empty resource discovery, no active tools and zero provider requests. Verify root, `pi-daddy/daily-dashboard-host`, `pi-daddy/measured-session`, `pi-daddy/measured-order` and learning-bridge entrypoints.
4. If the bounded real-Pi release path smoke is required, use only the predeclared factory occurrence: subscription `openai-codex/gpt-5.6-sol` subject and `openai-codex/gpt-5.6-terra` judge, no tools, explicit factory extensions, no global discovery, finite process/call/time ceilings and no fallback. It proves paths, not efficacy.
5. Recheck npm immediately before mutation. Publish the canonical pi-daddy archive exactly once only after skill-harness core → adapters → CLI → meta-package 0.15.0 are registry-verified. On ambiguous publication inspect registry and downloaded bytes before any retry.
6. Verify cache-busted registry metadata and downloaded bytes, then create immutable `v0.25.0` at the exact release commit and its GitHub Release. Never overwrite a version, rewrite a tag, bypass security/OTP or globally install/link the package.

Release does not supply daily trust labels, human quality choice, configured adoption, acceptance, publication outcome or later outcomes.
