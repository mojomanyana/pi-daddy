# Pi 1.0.4 qualification fixtures

This isolated, test-only package exercises the published SDK and CLI with a scripted local provider. It does not use an installed global Pi, global auth/settings, a remote model, or production pi-daddy runtime modules. Its lock is independent of the production workspace lock.

From this directory on the qualified Linux/WSL Node >=22.19 runtime:

```sh
npm ci --ignore-scripts --cache ../../../../tmp/npm-cache
PI_OFFLINE=1 npm test
npm run check
```

The tests name the production/API behavior that would break each assertion. `npm run capture` regenerates the five real CLI JSONL fixtures and `fixtures/provenance.json`. Keep the retained fixture bytes and provenance together. The capture changes only the disposable cwd and installed package path prefixes; string whitespace, LF record boundaries, U+2028/U+2029, timestamps, IDs, and event ordering are preserved. It waits for actual child process close and drained pipes; tests assert semantic settlement separately.

The scripted provider establishes API wiring and lifecycle semantics, not model obedience, live authentication validity, isolation from hostile processes, or native-Windows worker containment. Public SDK host methods used by the harness (session binding/reload, mutable manager and refreshContext) are not assumed available inside an ordinary extension. Extension discovery uses only getCommands, resources_discover and before_agent_start. No private runtime methods or casts to private SDK internals are used.

One configured scope's resource exclusion is not a universal revocation across other scopes; the disabled-resource fixture deliberately matches the discovery and exclusion scopes. Provider configuration status has no explicit no-auth-required variant. The auth test counts credential-store calls around passive status reads without invoking auth resolution.
