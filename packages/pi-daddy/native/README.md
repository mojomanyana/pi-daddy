# Captured worker artifact

The packaged Linux x64 helper is built from `worker.c` with the official Zig 0.14.1 compiler
archive and static musl target pinned in `toolchain.json`. No system compiler or libc is used.
The distribution is published at <https://ziglang.org/download/>; the archive SHA-256 was checked
against <https://ziglang.org/download/index.json>. `provenance.json` records all build inputs,
output bytes/hash and the unmodified license files copied from that archive.

From `packages/pi-daddy`, `npm run build:worker` downloads and hash-checks the pinned archive,
extracts it into a fresh temporary directory, rebuilds, and writes the binary, checksum,
provenance, license copies and `src/executors/worker-artifact.ts`. Node 22.19+ and `tar` are required.
`node scripts/build-worker.ts --verify` repeats the build in a new directory and compares every
output byte without modifying tracked files; CI runs this on each Node matrix leg. An existing
archive can be supplied with `PI_DADDY_WORKER_TOOLCHAIN_ARCHIVE`; it must pass the same hash check.
The temporary compiler is removed after each run. The verified archive cache is under the OS
temporary directory; it is never part of the npm package.

The runtime verifies the opened executable against the SHA-256 constant compiled into its
JavaScript before executing that same held descriptor. The adjacent checksum is for independent
verification, never runtime authority. This binds the artifact to the reviewed package contents;
it does not protect a package whose JavaScript was modified by the same user.

The build checks ELF64/x86-64 and absence of dynamic/interpreter program headers. Runtime still
requires the qualified Linux kernel facilities: subreaper, pidfds and `/proc` child enumeration.
No compiler runs during package installation or execution.
