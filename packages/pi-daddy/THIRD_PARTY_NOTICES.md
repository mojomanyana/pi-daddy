# Third-party notices

## Captured Linux x64 worker

`native/linux-x64/worker` statically links the musl libc shipped in the official Zig 0.14.1
Linux x86-64 compiler distribution. Its complete copyright/license notice is reproduced in
`THIRD_PARTY_LICENSES/musl-COPYRIGHT.txt`; Zig's runtime notice is in `THIRD_PARTY_LICENSES/zig-MIT.txt`.
These are copied directly from the SHA-256-pinned compiler archive by `scripts/build-worker.ts`.
The worker does not link glibc. `native/provenance.json` records source, compiler archive, artifact
and license hashes. See `native/README.md` to reproduce and verify the committed binary.
