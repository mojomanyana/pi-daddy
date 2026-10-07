# Third-party notices

## Herdr Pi lifecycle integration

`src/executors/vendor/herdr-pi-lifecycle.ts` is the unmodified official Herdr Pi lifecycle integration, copied from Herdr `v0.8.2`, blob `67bc41889abc2791d6dcdfe8279bdc24186cc6fe` (SHA-256 `9b1c41cd72520fc2abe5f2a2aec995c12a926cce844df472c7fd5fcae4f4dbfa`).

It is licensed under Apache License 2.0. A copy of that license is distributed at `THIRD_PARTY_LICENSES/herdr-Apache-2.0.txt`.

## Captured Linux x64 worker

`native/linux-x64/worker` statically links the musl libc shipped in the official Zig 0.14.1
Linux x86-64 compiler distribution. Its complete copyright/license notice is reproduced in
`THIRD_PARTY_LICENSES/musl-COPYRIGHT.txt`; Zig's runtime notice is in `THIRD_PARTY_LICENSES/zig-MIT.txt`.
These are copied directly from the SHA-256-pinned compiler archive by `scripts/build-worker.ts`.
The worker does not link glibc. `native/provenance.json` records source, compiler archive, artifact
and license hashes. See `native/README.md` to reproduce and verify the committed binary.
