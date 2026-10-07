# pi-daddy

Source target: **0.44.2**. Before installation, verify that `npm view pi-daddy version` and Git tag `v0.44.2` both resolve to this release.

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

This candidate targets Pi 1.0.4 and captured Linux x64 execution. Qualification is limited to Ubuntu WSL2,
kernel `6.18.33.2-microsoft-standard-WSL2`, x86_64 and Node `v26.7.0`; other runtime/kernel combinations, native
Windows and WSL-to-Windows worker interop remain unqualified. Governed Herdr execution refuses until separately qualified. Select captured execution with `PI_DADDY_HERDR=0`. A final must match Pi's settled
JSON output and persisted current branch. Unknown subtree cleanup retains capacity and workspace exclusion.
`PI_DADDY_FANOUT` limits active descendants using conservative subtree reservations, with capacity returned only
after verified settlement. Complete results remain separate from optional recording failures.

Pi and TypeBox are wildcard host-provided peers so Pi's extension loader supplies one shared runtime copy. Development and release qualification pin exact Pi **1.0.4**; later Pi versions require new qualification. Prefer a Pi-managed install under a host pinned to 1.0.4. An ordinary standalone npm install may resolve newer peer versions and is outside this qualification. In a Pi-managed no-peer install, standalone help, version and reporting remain available; run initialization inside Pi with `/grants init`. Use Principal **4.8.0** with this runtime's `delegate_describe` contract. Native phases use `plan`, `build`, `review`, `debug`, and `investigate` with their returned `definitionId`; independent parallel work uses one `delegate_all` batch.

Final capture preserves whitespace and concatenates text blocks without inserting separators. Tool-call terminals, empty visible finals and non-`stop` reasons are unavailable. Persisted message comparisons ignore object key order while preserving array order and every field value. The shared `final-conformance.json` table checks these semantics in both runtime and harness. Capture remains bounded: 4 MiB visible final, 32 MiB protocol line, 64 MiB persisted session, and a 3-second bounded session read. Exceeding a limit reports an unavailable final and blocks dependent handoffs; it does not imply the worker failed to settle.

Retained capacity is rechecked against the original bound ownership and settlement receipt before a new single, parallel or chain dispatch. Exact later proof refunds the reservation once; missing, malformed or mismatched proof and unbound ownership remain retained. Recovery does not rewrite the original failed/unknown outcome or mint new capacity on reload. A single delegation reserves its available subtree; use `delegate_all` to allocate independent parallel children.

The package requires Node.js 22.19.0 or newer. `pi-daddy report` joins episode usage and attribution;
`pi-daddy outcomes` adds Git, CI, amendment, and operator-correction signals for commits carrying a `Pi-Episode`
trailer. A connected dashboard can change model/thinking defaults for its owning session without changing persistent
settings or enforcement.

The full product description is the repository [README](https://github.com/mojomanyana/pi-daddy#readme); the
[CHANGELOG](./CHANGELOG.md) says what each release changed and what to do about breaking changes. The one shipped
contract is `contracts/ledger-record/v1`.
