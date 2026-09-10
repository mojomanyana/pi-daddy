# ADR-0046 — A probed fixed digest profile, not a general agent sandbox

Date: 2026-09-08 (local batch)
Status: Implemented local candidate; independent overall review/formal acceptance pending

## Decision

Add one optional public runtime route, linux-bwrap-digest-v1, using the existing runChild seam. Its input
is a detached byte buffer (at most 16 KiB), not code or a workspace. Fixed trusted code computes a digest
inside actual user/mount/PID/network namespaces; only stdout is a persistent result destination. No shell,
model/provider, writable workspace, custom environment or destination override is admitted. This does not
reverse ADR-0012: existing pi/bash delegation still governs tool surfaces, not reachable arbitrary effects.

A process-local opaque profile is issued only after bounded native probes. Runtime fingerprints are
rechecked before each workload. The operator/kernel/runtime are trusted; neither Node permission flags nor
read-only mounts of an administrator-mutable runtime are represented as hostile-process containment.

Add a separate durable aggregate admission journal, bound to independent authority, canonical root and
journal device/inode. It charges attempts/input bytes and reserves active invocation slots across orders,
experiments, retries and shadows. No cancellation refund, duplicate launch, TTL reclaim or receipt-based
credit exists. Lost controllers leave outstanding slots. Required append/settlement failures still reject;
existing finalizer behavior retains primary errors. No new mutation machinery or model judgment is used.

## Evidence and limits

Owned WSL2 probes found working bwrap/unshare namespaces, denied outside reads/writes and EROFS on an owned
read-only fixture mount. Ordinary tests additionally deny an owned host loopback listener, exercise the
process-creation tripwire and observe actual owned namespace worker shutdown on cancellation. Cross-process
reservation tests cover duplicate/concurrent contention and persistent restart state. These are bounded
owned fixture observations, not a hostile-process qualification.

No writable delegated cgroup was found. Aggregate CPU/memory/PID/provider-money guarantees, arbitrary pi or
shell execution, shared writable roots and alternative lease stores remain unsupported. The profile is a
useful small evidence-byte check, not complete P06 order execution. Trusted setup probes are administrative
control work, not user attempts. Trusted storage rollback and malicious same-UID host writers are excluded.

The public API and precise resource/TCB limits are documented at
packages/pi-daddy/contracts/effect-profile/v1/README.md. New P06 source commits are local only; they are not
part of the separately cleared 7c78769 publication/draft PR. No release or broader publication is claimed.
