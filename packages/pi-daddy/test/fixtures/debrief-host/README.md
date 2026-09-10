# Immutable foreign-source data for ordinary P08 integration fixtures

`provenance.json` records exact Git blob SHA256/source/commit. The `.ts.txt` files are unchanged source
bytes, not current pi-daddy TypeScript modules or a shipped harness installation. No source guard or
project typecheck exclusion was changed. The first attempt to name these raw snapshots `.ts` correctly
failed the pi-daddy typecheck because foreign package/type aliases were absent; that log is retained.

`test/debrief-host-fixture.ts` verifies every hash and uses the retained TypeScript transpiler to emit an
isolated disposable module set. Only the `@skill-harness/core` import specifier is redirected to the exact
pinned `work-capture` implementation; type-only imports disappear normally. Actual case builder/archive /
reviewer/decision and blind-assessment methods execute on owned files/bytes. No fixture generator lifecycle,
model/provider, worker prompt, install or write to the source harness checkout is involved. This is runtime
fixture integration, not a full foreign-project typecheck or installed package qualification.
