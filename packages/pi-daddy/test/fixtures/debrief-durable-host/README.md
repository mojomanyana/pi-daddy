# Pinned durable P08 writer fixtures

Exact source bodies from https://github.com/mojomanyana/skill-harness at
638494af0a0058edf9a9b1b02e57af894ab46ed6. See provenance.json for original paths and SHA256.
Bodies are data (.ts.txt), not a second implementation or installed harness. The existing retained
TypeScript compiler transpiles them in a new owned directory. Only @skill-harness/core import specifiers
are mapped to a shim re-exporting the three actual pinned core modules. Type-only generated imports are
erased by ordinary compilation. Runtime imports and all implemented guards/writers stay intact.

The fixture invokes actual retention, signal detection/case binding, selected reviewer/CAS, immutable
quality writer, private-seed reopen, artifact reads and explicit reveal. No fake writer success/cache,
provider calls, package lifecycle or install. Deployed host loading/authentication, live pause and model
qualification remain external. Existing older debrief-host pins are retained for original v2 compatibility.
