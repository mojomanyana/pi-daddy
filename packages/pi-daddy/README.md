# pi-daddy

Capability governance and coordination for [pi](https://github.com/badlogic/pi-mono)'s multi-level agent system. An
orchestrator grants each sub-agent a deliberate subset of what it holds and withholds the rest; a sub-agent may delegate
further, but only ever a subset of what it holds. Enforcement is pi's own `--tools` allowlist on a separate child
process, with an append-only, hash-chained ledger of every grant and refusal.

```bash
pi install npm:pi-daddy
pi
```

`/grants` shows the session's ceiling and spawnable definitions; `/grants init` writes `.pi/pi-daddy/settings.json`,
the one reviewable file you commit. A definition is an [Agent Skills](https://agentskills.io/specification) `SKILL.md`
whose `allowed-tools` is the ceiling and whose body is the child's system prompt.

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
answer is recorded.

The full product description is the repository [README](https://github.com/mojomanyana/pi-daddy#readme); the
[CHANGELOG](./CHANGELOG.md) says what each release changed and what to do about breaking changes. The one shipped
contract is `contracts/ledger-record/v1`.
