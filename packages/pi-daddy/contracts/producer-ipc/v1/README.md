# Producer IPC v1 — local, explicit host integration

This is a **separate opt-in fixed model-free emitter**, not an operation on `linux-bwrap-digest-v1`,
not a new P11 experiment opcode, and not permission to run a model. Digest/hold operations and their
null model/effort/skills contract are unchanged. Ordinary pi extensions, tools and runtime-injection
restrictions are unchanged. No SDK, credentials, provider configuration or networking client is imported.
Historical `dist` is not this candidate: compile the exact pinned source into a fresh private output.

## Callable API

Exports are available from `pi-daddy` and `pi-daddy/producer-ipc`:

- `producerIpcBinding(value)` validates and detaches/freezes the closed binding below.
- `producerIpcBindingDigest(binding)` hashes its canonical UTF-8 JSON bytes.
- `producerIpcDemand(binding)` produces an existing v4 `AttemptDemand`: primary, no parent;
  attempt ID = execution ID, input digest = binding digest, input bytes = **whole parent binding**.
- `createProducerIpcHost({ owner, binding, exchange })` creates a single-use original host capability.
- `startProducerIpc({ owner, permit, binding, host, signal, timeoutMs })` consumes an **already reserved**
  original permit and returns a `Promise<ProducerIpcRun>`. It never reserves a replacement itself.

```ts
import {
  openResourceBudget, resourceBindingDigest, newExecutionId,
  producerIpcBinding, producerIpcDemand, createProducerIpcHost, startProducerIpc,
} from 'pi-daddy';

// Existing independently retained v4 budget. Use ONE original module graph and owner object.
const owner = openResourceBudget(existingExperimentBudget);
const binding = producerIpcBinding({
  version: 'producer-ipc-v1', budgetDigest: resourceBindingDigest(existingExperimentBudget),
  orderId: existingOrderId, experimentId: existingExperimentId, executionId: newExecutionId(),
  charterSha256: independentlyFrozenHostCharterHash, invocationId: allowedHostInvocationId,
});
const [permit] = await owner.reserveBatch([producerIpcDemand(binding)]);
const port = createProducerIpcHost({ owner, binding,
  async exchange(frames, context) {
    // Actual one-use Readable replay of original child stdout, validated after EOF AND child exit.
    // No parent identity, charter hash, credentials, URL, model payload or host socket in frames.
    const observation = await trustedHost.exchangeSubscriptionSdk(
      frames, hostOnlySdkBinding, hostOnlyTransport, context.binding.charterSha256, context.signal,
    );
    // Host-owned journal references ONLY, not votes/output/acceptance or transport authentication.
    return { claimRef: originalClaimReference(observation), responseRef: originalResponseReference(observation) };
  },
});
const run = await startProducerIpc({ owner, permit, binding, host: port,
  signal: originalCallerAbortController.signal, timeoutMs: 30_000 });
const observed = await run.result;        // Bounded observation; NEVER release a hold from this.
const final = await run.completion;       // Waits for original child, invoked host, required accounting.
const mechanicallyComplete = final.outcome === 'completed' && final.settlement === 'acknowledged';
// Even mechanicallyComplete is NOT live qualification, model correctness, a grant or P01 acceptance.
```

`trustedHost`, SDK binding, transport, expiring approval and reference selection are **host-owned**.
The example's `exchangeSubscriptionSdk(..., sourceSignal?)` is the coordinator-supplied local29a API;
this producer does not import, ship, execute or authenticate it. The host must independently validate
its charter/approval and enforce its own journal, invocation uniqueness, request/response/call budgets,
subscription-only route and source cancellation. Reading this document supplies none of that authority.
All coding/evaluated model execution remains on the user's existing Codex subscription only; no live call
was made in these tests. The producer's inert callback fixtures are not a substitute for that host.

## Frame, identity and evidence contracts

`ProducerIpcBinding` has exactly `version, budgetDigest, orderId, experimentId, executionId,
charterSha256, invocationId`. Hashes are lowercase SHA-256; execution ID is an existing-format `exec:UUID`;
other IDs are 1..128 ASCII alphanumeric/colon/underscore/hyphen characters. Reordered input properties
canonicalize to that listed order. Whole binding bytes are charged, **not** provider request/token bytes.
The independently retained binding plus its persisted reservation digest supplies correlation, not a new
journal or a recovered permit. Old digest-input reservations cannot be relabelled as IPC reservations.

Child capability/output is exactly UTF-8 `JSON.stringify({id: binding.invocationId, sequence: 1})+'\n'`.
Sequence 1 is **per invocation**, not the host journal's global claim ordinal. The child gets only that
base64-encoded frame in argv; this is not secret transport. The parent captures at most 1024 raw bytes,
requires original stdout EOF and successful original child completion, then checks byte equality, not a
permissive JSON parse. Wrong identity/sequence, extra/duplicate fields, whitespace, malformed UTF-8, missing
LF, repeated or oversized output cannot dispatch. There is no prefix dispatch or response channel to child.
The host receives a **buffered replay**, not a live bidirectional child pipe. It must consume that original
stream before acknowledgement; the producer never reconstructs a frame from host identity metadata.

`exchange(frames: Readable, context: { binding, signal }): Promise<{ claimRef, responseRef }>` is called
at most once per original host port. Both references are 1..128 characters from the same ASCII ID alphabet;
extra payload/decision fields refuse. They are unverified evidence references, never policy or votes.
The child has already exited before host exchange starts; the resource hold spans both serial lifetimes.
This does **not** place the host, SDK or model execution inside the child namespace.

## Lifetime and failures

`run.started` resolves `spawned | not-spawned`; spawn is not readiness. `run.readiness` resolves
`frame-ready | not-ready` only after original child evidence is available. Both can remain pending during
unknown underlying I/O. `run.child` is the frozen original `ChildRunResult | null`; null means no executor
result was obtained, not a successful child. An actual spawn error is `not-spawned`; an exception after
spawn without an executor result is `unknown` and returns failed/unknown completion **without settlement**.
Actual code, signal, text, abort/timeout/truncation are retained.
`run.inspect()` only returns a frozen process-local snapshot; no reopen/retry/reconcile/settlement occurs.

`result` is the first terminal **effect observation**, with `outcome`, closed `reason`, current child/host
state, frame hash, references and settlement state. It is immutable; it may say child/host/settlement are
pending. `completion` returns later evidence without upgrading cancelled/timed-out/failed outcome.
Late valid host references can appear there while the earlier result remains unchanged.
A completed effect plus `settlement: failed-or-unknown` is **not successful completion**, even if a later
budget read sees complete settlement bytes or zero active slots. No read repairs this receipt.

Original caller cancellation is composed with a bridge-owned deadline and forwarded to both existing
`runChild` and host I/O. `timeoutMs` is an integer 50..30000, includes admission/runtime preparation after
claim, and is checked again at asynchronous control boundaries. It bounds an observation, not blocked
kernel I/O or synchronous host JavaScript. The fixed child retains its 3000ms/50ms grace/3500ms hard cap,
1024-byte combined output cap and unchanged binary/namespace/per-process CPU/FD/heap guards.
There is no security-policy modification, alternate command, fixture mount, environment or fallback API.

Original v4 permits are branded to their creating owner object. Copies, separately reopened owners,
different bindings, already settled/in-progress settlement and consumed permits refuse. A valid exclusive
handoff blocks early calls to the old public `permit.settle`; the original private settlement closure is
held until child and invoked host acknowledge. The original locked admission check rejects a pending/paused
barrier before launch; a failed admission still settles a charged failure. Claims are process-local and
single-use even after failure. There is no crash/receipt/PID/path/module-copy recovery.

Cancellation/timeout does not free an unknown lifetime: an uncooperative host or unacknowledged child keeps
`completion` pending and the active reservation held. When both acknowledge, original accounting releases
only the active slot. Attempts and whole-binding bytes stay charged on success, failure and cancellation.
Pending dispatch reconciliation still needs explicit original authority after quiescence. A host port must
return/reject only after its owned I/O acknowledges termination; the bridge cannot prove remote server
termination from promise rejection, authenticate journal references, or enforce provider-money/cgroup caps.

## Behavioral evidence / exclusions

`test/producer-ipc.test.ts` uses the actual unchanged namespace launcher for positive stream/correlation
and real forwarded Node children for malformed/oversized/identity/EOF negatives. Test-only forwarding never
adds a production alternate launcher. `test/producer-ipc-lifetime.test.ts` forces real process liveness
under delayed signal delivery, no-readiness cancellation/timeout, host cancellation/late acknowledgement,
existing admission barriers, persisted-binding mismatch, reuse, spawn/setup errors and mandatory sync/close
failures after complete bytes. Signal/EOF and
filesystem fault injection is labelled; it is not evidence that the local kernel naturally lost them.

These are local mechanical tests, not live SDK/Herdr/model operation, human/role authentication, Ubuntu24
support, the cause of historical namespace denials, or overall/native-P01 acceptance. Original review,
seq226 and retained/inconclusive P17D remain unchanged. No ordinary model-driven controller choice, full
factory scheduling, generic mutation, rescue/retry/refund or publication is introduced.
