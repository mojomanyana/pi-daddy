# P06 owned native boundary observations — local Sept8 batch

On kernel `6.18.33.2-microsoft-standard-WSL2`, bounded (four-second) disposable probes returned:

- bwrap with new user/mount/PID/network namespaces, read-only system runtime and `/usr/bin/true`: exit 0.
- unshare user/map-root/mount/PID with `/usr/bin/true`: exit 0.
- setpriv no-new-privs and prlimit nofile around `/usr/bin/true`: exit 0; neither is aggregate containment proof.
- `/sys/fs/cgroup` not writable to the caller: no delegated cgroup resource-cap claim.
- In an actual bwrap namespace, an owned mounted fixture read returned `owned-readable`; an owned
  outside read/write returned `ENOENT`, and a write into the owned read-only mount returned `EROFS`.
  Neither denied marker was created on the host.

The source-owned `prepareDigestProfile` repeats bounded native checks before issuing a runtime handle.
`test/effect-profile.test.ts` adds an owned host-loopback denial, actual process-creation tripwire,
owned-worker cancellation and real launch/admission ordering. `test/resource-budget.test.ts` exercises
real cross-process duplicate/concurrent reservations, aggregate count/byte limits and restart/lost-store
behavior. Run with direct retained Node, without package lifecycle or providers:

```
node --test packages/pi-daddy/test/resource-budget.test.ts packages/pi-daddy/test/effect-profile.test.ts
```

The tests require the native primitive and do not silently treat unsupported containment as green.
They use new private disposable fixture directories, never auth/session discovery, existing workspace
mutation, privileged configuration or external network traffic. A localhost listener is owned by the test.
Full local argv/output/HEAD and receipt evidence is retained outside source under `tmp/p06-local-evidence/`.

**Not established:** hostile-process containment, arbitrary pi/bash execution, frozen administrator-owned
runtime images, aggregate CPU/memory/PID/provider-dollar caps, shared writable destinations, trusted-store
rollback resistance, full-controller-crash cleanup qualification or complete P06/factory acceptance.
Cancellation observations are not used to reclaim any crashed-controller reservation. See the
[explicit contract](../../../packages/pi-daddy/contracts/effect-profile/v1/README.md).
