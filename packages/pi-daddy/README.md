# pi-daddy

Capability governance and coordination for [pi](https://github.com/badlogic/pi-mono)'s multi-level agent system. An
orchestrator grants each sub-agent a deliberate subset of what it holds and withholds the rest; a sub-agent may delegate
further, but only ever a subset of what it holds. Enforcement is pi's own `--tools` allowlist on a separate child
process, with an optional append-only, hash-chained governance ledger.

```bash
pi install npm:pi-daddy
pi
```

`/grants` shows the session's ceiling and spawnable definitions. `/grants init` writes the review copy at
`.pi/pi-daddy/settings.json`, stores the enforced grant outside the workspace, enables the project ledger, and applies
the decisions to the running session; commit the review copy when the project's ignore rules permit it. A definition
is an [Agent Skills](https://agentskills.io/specification) `SKILL.md` whose `allowed-tools` is the ceiling and whose
body is the child's system prompt.

```
delegate({ agent: "review-security", task: "Review the diff." })
delegate_all({ children: [ { agent: "review-security", task: "…" }, { agent: "review-perf", task: "…" } ] })
delegate_chain({ steps: [ { agent: "plan", task: "…" }, { agent: "build", task: "Implement: {previous}" } ] })
```

```
effective = ( requested ∩ parentGrant ∩ ceiling ) \ (gated \ approved)
```

Escalation is impossible by construction on the tool surface. It does not contain an agent holding an execution
primitive: a child granted `bash` can start an ungoverned descendant, so `bash` is gated by default and every gate
answer is recorded when a governance ledger is configured.

The package requires Node.js 22.19.0 or newer. `pi-daddy report` joins episode usage and attribution;
`pi-daddy outcomes` adds Git, CI, amendment, and operator-correction signals for commits carrying a `Pi-Episode`
trailer. A connected dashboard can change model/thinking defaults for its owning session without changing persistent
settings or enforcement.

The full product description is the repository [README](https://github.com/mojomanyana/pi-daddy#readme); the
[CHANGELOG](./CHANGELOG.md) says what each release changed and what to do about breaking changes. The one shipped
contract is `contracts/ledger-record/v1`.

## Execution cache: explicit SDK path (UNTESTED, per request)

### Implementation checkpoint

This is a **draft implementation, not a completed or release-ready feature**.

Implemented:

- Explicit SDK-owned native Bash factory, session/epoch ownership and current-authority checks.
- Shared scheduling within that owned root, live dependency invalidation, replay and force-rerun mechanisms.
- Private broker/shell images, Watchman observation, bounded reader/storage ownership and explicit recovery.
- Operator controls, additive history, model-facing and supported structured-output provenance.
- A conservative GNU checksum candidate profile, static helper manifests and compiled package exports.
- Startup/discovery/init fixes that retain cleanup failures on their initiating owner.

Remaining, in order:

1. Add the minimal Pi APIs authorized by the operator on 2026-10-07. **No Pi patch is included yet.**
   Expose actual captured native construction/options and an asynchronous admission/attachment seam so
   root and delegated CLI children can share the coordinator without inferring authority from metadata.
2. Expose native output-accumulator descriptor ownership and physical close/retry recovery; complete
   root-scoped legacy ledger writer/file-lock cleanup. Awaiting a result is not that cleanup certificate.
3. Finish and qualify automatic root/child attachment, reload/disable/crash recovery and complete resource
   accounting. Unknown/custom Bash and Herdr remain ordinary until a supported binding is established.
4. Run the deferred basic end-to-end check, then fix concrete failures. Follow with regression/CI/package
   checks, useful additional profiles, workload benchmarks and formal acceptance before release.

Verification at this checkpoint: `npm run build --workspace=pi-daddy` succeeded. Tests and review rounds
were deliberately deferred for the latest implementation; it is **UNTESTED (per request)**. Earlier
component test results do not validate this candidate. No cache activation, install or release occurred.
Formal whole-feature acceptance remains pending (0/38); no performance or whole-resource guarantee is claimed.

This checkout does **not** enable a cache. The default Pi CLI, custom/unknown Bash implementations, captured
CLI children and Herdr remain ordinary and unqualified. Cache composition is opt-in and defines its own native
Bash constructor/options; it does not discover another tool's options from a name or metadata.

`createExecutionCacheExtension` is exported from `pi-daddy`. Pass it to a supported SDK's
`DefaultResourceLoader.extensionFactories`, reload that loader, create the SDK session with that loader and
`await session.bindExtensions({})`. Use it instead of a separately configured Bash override. Example configuration:

```ts
import { createExecutionCacheExtension, type CacheSessionControls } from "pi-daddy";

let cache: CacheSessionControls | undefined;
const extension = createExecutionCacheExtension({
  cwd,
  installedEntry: new URL(import.meta.resolve("@earendil-works/pi-coding-agent")),
  enabled: false,
  nativeOptions: {
    shellPath: "/bin/bash",
    exposeSessionEnvironment: false,
    // This is the host's deliberate ordinary native environment too, not a cache-only rewrite.
    spawnHook: ({ command, cwd }) => ({
      command, cwd, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    }),
  },
  manifests: ["fixture.sha256"],
  watchman: { ownedExecutable: "/absolute/path/to/watchman" },
  onDiagnostic: (message) => console.error(message),
  onControl: (owner) => { cache = owner; },
});
```

Only the inspected, hash-matching installed SDK 0.84.1 / Pi 1.0.2 default native factories are candidates. Missing
factories, changed sources, custom operations, permission-restricted runtime or incompatible inputs do not qualify.
Unknown source binding leaves the existing tool untouched. The explicit product keeps ordinary work separate from
optimization teardown; startup failure is diagnosed and retained rather than converted to an empty successful result.

After binding, `/grants cache enable` explicitly starts a cold owning root. Command verbs are `status`, `explain`,
`enable`, `clear`, `force` (next eligible call, with no active calls), `disable`, `shutdown`, and `recover`. Disable is terminal
for that epoch; restart/reload cold rather than revive it. SDK hosts **must await `cache.shutdown()` before
`session.dispose()`**, whose installed API is synchronous and is not a resource-cleanup certificate. Reload/session
replacement stops old owners and creates a cold native binding; failed old owners remain available for explicit
physical recovery. Recovery never changes the original rejected startup/stop or reopens admission.

The single candidate profile accepts only the exact effective command
`LC_ALL=C exec /usr/bin/gnusha256sum --strict -c fixture.sha256` (substitute the configured safe manifest name),
`/bin/bash`, the ordered environment shown above, and an explicit positive timeout no longer than six hours.
Manifest members must be supported regular workspace files on local ext4/tmpfs. GNU/Bash/loader/library bytes and
loader configuration must match the profile's inspected fixture inventory. Preload, changed membership, unsupported
filesystems, missing members, prefix/hook differences, and other commands bypass before a shell image is issued.
`src/products/cache-checksum-profile.ts` is the inventory; it is **not** a general shell determinism proof.

Watchman and fingerprints implement `personal-best-effort-v1`: not an atomic/current-source certificate. Known
uncertainty bypasses; rare missed aliases/context changes remain possible. Watchman never grants permission or
makes side effects, clocks, randomness, services, or arbitrary shell programs cacheable. An explicitly supplied
`sharedSocket` can be observed but its external daemon is never stopped or called product-owned.

Defaults bound entries (256), dependency edges (20,000), running commands (2), pending work (16), native calls (32),
retained output (32 MiB, 1 MiB/item), native images (256 MiB), and input captures (2, 32 MiB / 128 paths each).
Host `limits` can only narrow these numbers. Root-owned reads additionally cap pending I/O (32) and concurrent
read allocations (32 MiB), including ledger tails. Configuration checks the sum of named buffer reservations
against `bufferedBytes` (512 MiB); `status` exposes the component calculation. Broker publication is charged
against the image-storage allowance before reserving per-call images. These are component/allocation limits,
**not** a measured total-memory/storage or latency guarantee: SDK accumulator buffers, JS object/string overhead,
helper heaps, kernel memory and growing Watchman logs are not covered by this sum. Workspace `settings.json.executionCache.enabled: false` narrows startup; workspace `true` does
not enable caching, choose profiles, widen grants, or mint credentials. Grants and actual SDK tool availability
are rechecked by the owning factory before admission and delivery.

Visible calls emit validated, versioned cache facts; optional ledger history uses the existing `control` envelope.
`onHistory` observes those facts without granting authority. Reports/dashboard accept this additive body separately
from delegated lifecycle. Reuse/join model-facing content/details name their original execution/time. On owned
Pi 1.0.2, the actual native `outputSchema` also gains an optional `executionCache` object and returned native
`structuredContent` gains that provenance; `output`, `truncated`, `full_output_path`, `exit_code`,
`wall_time_seconds`, native details and error status are preserved. The wall time is native delivery time, not
estimated savings; `originalStartedAt`/`originalEndedAt` identify the underlying execution. SDK 0.84.1 remains
text/details only, with no invented structured output or inferred ordinary status. No raw environment/credentials enter history, and no history hydrates
results or serves as qualification evidence. Telemetry queue overflow is diagnosed without altering native output.
Record-tail reads use a bounded 1 MiB range on the original descriptor, joined by the root reader owner; failed
closes retain serialized explicit recovery. Oversized last records refuse append without a whole-file fallback
or a destructive repair recommendation. Only an actual typed open `ENOENT` means an absent ledger.

`npm run build` assembles static Linux x64 shell/broker assets and source/binary digest manifests. Other platforms
publish unavailable manifests; no installation, capability changes, Pi patching or activation occur. Watchman and
the existing protected lease prerequisites must already be available. The native lease/source guarantee is unchanged.

Deferred opt-in basic SDK QA / measurement tooling (not run by build, not executed for this implementation):

```bash
# From the package directory (the selected deferred script is included in the package):
node scripts/cache-sdk-basic-qa.ts /absolute/sdk/dist/index.js /absolute/watchman 10
```

It uses actual SDK tools, checks changed-input failure, replay, sharing, clear/force and original-resource shutdown,
and reports observed cold/warm timings only. Formal qualifiers, primary workload/hot-lookup budgets, stress,
cancellation, recursive/captured-child participation and total-memory/storage measurements remain pending.
The inspected native SDK also hides full-output accumulator descriptors: its stream finalizer waits for `finish`,
not a Root-owned physical-close/retry capability. Product-owned ledger tails now have that capability, but the
legacy record writer/file-lock helpers still use their existing internal I/O/cleanup semantics; the cache reader
scope does not certify those descriptors. These and the hidden native accumulator remain unresolved complete
all-resource coverage, not certificates supplied by awaiting a native result. Existing delegation uses captured
CLI subprocesses (`runChild.onSpawn` is synchronous and post-spawn), not an owned SDK child factory/authorized
pre-spawn attachment. No shared-child API or credentials are fabricated for that unsupported path. Do not promote this candidate to release-ready cache admission on that basis.
There is no performance, full-suite, review or release-acceptance claim for this untested code.
