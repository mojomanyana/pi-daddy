# pi-daddy

**Capability governance for pi's multi-level agent system.** An orchestrator grants each sub-agent a
deliberate subset of what it holds and withholds the rest. Sub-agents may delegate further, but only ever a
subset of what they themselves hold — enforced by **pi's own `--tools` allowlist**, with an append-only
ledger of every grant and refusal whenever a ledger is configured.

**Release state (verified 2026-09-02):** npm `latest`, tag `v0.21.1` and the non-draft GitHub Release identify
the same released source. It passed 731 unit tests, 47 non-model integration tests against real pi/Herdr,
typecheck, installed-package smoke and 110/110 mutation guards. A fresh registry install confirmed the shipped
default child timeout is 20 minutes (1,200,000 ms).

One explicit `/grants init` now persists both the project grant and `.pi/grants.jsonl`; merely installing the
package initializes nothing, and legacy stores are not silently migrated. **Known open issue R-175:** malformed
and absent project stores are still indistinguishable at session construction, so malformed state can make a
root session ungoverned. `docs/SESSION-LOG.md` and `docs/SPEC.md` are the current detailed record.

**Want to run it?** [`docs/RUNNING-IT.md`](docs/RUNNING-IT.md) — setup in six steps, then a feature built
end to end with seven governed sub-agents, sequential where output feeds input and parallel where it does not.

## What it actually does

A spawnable agent is an **Agent Skills `SKILL.md`** file — the open standard, already read by 16+ tools. Its
`allowed-tools` field becomes the grant; its body becomes the child's system prompt.

```yaml
---
name: review-security
description: Reviews a diff for authn/authz, injection and secrets handling.
allowed-tools: Read, Grep
---
Review ONLY the diff you are given, for security. Report findings; never edit.
```

```
delegate_all({ children: [
  { agent: "review-security", task: "Review the diff." },
  { agent: "review-perf",     task: "Review the diff." },
  { agent: "review-api",      task: "Review the diff." },
]})
```

Three children, concurrently, each a separate OS process with its own tool allowlist, its own instructions,
and no knowledge of the others. Optionally in visible, attachable [herdr](https://herdr.dev) panes.

**The standard's `allowed-tools` is specified as "pre-approved" and marked experimental — it declares intent
and blocks nothing.** Passed through `--tools` it becomes structural. That is the contribution: *the
standard declares intent; pi-daddy makes it enforced.*

## The guarantee, and its limit

```
effective = ( requested ∩ parentGrant ∩ ceiling ) \ (gated \ approved)
```

Escalation is impossible **by construction**, not by policy. No policy engine, no LLM on the security path.

**What it governs:** the tool surface. A child granted `read` has no write tool and no prompt can talk it
into one.

**What it does not:** an agent holding an execution primitive. A child granted `bash` can
`env -u PI_GRANTS_GRANT pi …` and obtain a wholly ungoverned descendant — measured, not theorised
(`docs/probes/g5-bash-escape`). Containing *that* is the operating system's job and is explicitly out of
scope. So `bash` is **gated by default** in a governed session, and gating is closed under subsumption. That
does not make the escape impossible; it stops it happening **silently**, which is what matters when the
realistic threat is a confused or prompt-injected agent rather than a determined one.

`docs/SPEC.md` lists every other known gap, because a gap nobody wrote down is the one that surprises
somebody.

## Where to look

| Path | What it is |
| :--- | :--- |
| **`docs/SPEC.md`** | **What the product is, precisely. No history. Start here.** |
| `docs/SESSION-LOG.md` | Current state and what's next, newest first. |
| `docs/03-risks.md` | Live risk register. R-25 onward are current. |
| `docs/06-decisions/` | Twenty-five ADRs. Reversals kept and marked — **0016** is the current architecture; **0008** the invariant; **0012** why `bash` is out of scope; **0017**–**0019** authorise a definition, record which instructions ran, and pin an approval to both; **0020**–**0023** are the first red-team pass. |
| `docs/probes/` | Measurement evidence against real software. Each states what it does **not** establish. |
| `docs/archive/` | Superseded, kept as evidence, never edited to match today. Don't start here. |
| `packages/pi-daddy/` | The product. |

## Running the tests

```bash
cd packages/pi-daddy
npm test                   # 596 unit tests — pure, no pi, no network
npm run typecheck          # src + extensions + test + test-integration
npm run test:integration   # 44 tests against a REAL pi process, no model tokens
npm run test:smoke         # pack, install into a scratch project, import and USE every subpath
PI_GRANTS_IT_MODEL=1 npm run test:integration   # + 10 end-to-end with a real model (costs money)
```

## How this project works

Decisions live in ADRs (`/adr`), option-space exploration in `/brainstorm`, and measurements in
`docs/probes/`. Three advisory subagents — `product-strategist`, `architecture-critic`, `research-scout` —
never edit files.

Two conventions have earned their keep, and `.claude/rules/phase-gates.md` explains why:

- **An answer that exists only in chat does not exist.** Every reversal here was survivable because the
  reasoning was written down beside the decision.
- **Measure before asserting, and say which you did.** Nearly every significant finding contradicted
  careful reasoning — children are in-process, `isError` on a returned tool result is silently discarded,
  `--no-extensions` does not disable skills. Each probe states what it does not establish.
