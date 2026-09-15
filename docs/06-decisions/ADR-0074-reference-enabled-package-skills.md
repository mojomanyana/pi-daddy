# ADR-0074: Reference enabled installed runtime skills

Date: 2026-09-15. Status: accepted for the 0.27.1 candidate, pending independent review and release gates.

## Context

Pi already autoloads configured skill packages. The ADR-0028 scaffold copied those skills into `.pi/skills`,
creating duplicate warnings and local files that could mask upgraded installed definitions. The runtime
catalog and definition reader could only see skill roots, which made copying seem necessary.

## Decision

Use Pi's `DefaultPackageManager.resolve` with read-only `SettingsManager.fromStorage` and a missing-source
callback returning `skip`. Definitions, catalog and setup share enabled paths, resolver precedence and
filters. Never install packages, execute extensions, run a model or persist settings while discovering.
A malformed settings file stops discovery. `PI_CODING_AGENT_DIR` is respected through Pi's `getAgentDir`.

Setup references these definitions in place and derives its existing conservative grant from the selected
ceiling, including a local override. It does not copy or rewrite configured definitions, even with force.
Legacy npm packages never registered with Pi retain explicit-manifest copy scaffolding for compatibility;
the fallback cannot re-enable a configured disabled or missing package. Runtime never scans npm roots.

This reverses ADR-0028's universal copy mechanism, not its prohibition on inventing ceilings or ADR-0029's
withheld-capability defaults. Existing copies and grants are not automatically deleted, widened or migrated.
Unsupported YAML collection ceilings remain undeclared; missing ceilings never become unrestricted.

## Evidence and limits

Focused regressions exercise configured global/project npm manifests, wildcard declarations, resource
exclusions, local override ceilings, init/repeat/force without copies, missing packages, malformed settings,
and absent/unsupported ceilings. Reintroducing copying or bypassing resolver filtering fails these tests.
Independent review, installed artifact validation and CI are required before release. These are read-only
and filesystem tests; they establish neither model behavior nor session CLI resource overrides unknown to
a cwd-only discovery API. Existing in-memory sessions require their normal resource refresh after upgrade.
