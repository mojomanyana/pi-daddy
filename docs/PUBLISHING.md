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
