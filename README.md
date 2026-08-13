# pi-daddy

**Capability governance for pi's multi-level agent system.** An orchestrator grants each sub-agent a
deliberate subset of what it holds and withholds the rest. Sub-agents may delegate further, but only ever a
subset of what they themselves hold — enforced by **pi's own `--tools` allowlist**, with an append-only
ledger of every grant and refusal.

**Status:** `pi-agent-grants` **0.10.1**, `pi-token-audit` **0.1.0**. 272 unit + 17 integration tests (+4
more with a real model); typecheck and smoke clean.

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
| `docs/06-decisions/` | Nineteen ADRs. Reversals kept and marked — **0016** is the current architecture; **0008** the invariant; **0012** why `bash` is out of scope; **0017**–**0019** authorise a definition, record which instructions ran, and pin an approval to both. |
| `docs/probes/` | Measurement evidence against real software. Each states what it does **not** establish. |
| `docs/archive/` | Superseded, kept as evidence, never edited to match today. Don't start here. |
| `packages/pi-agent-grants/` | The product. |
| `packages/pi-token-audit/` | Token/cost audit. **Its headline number is wrong** — the "tool-definition share" is a character ratio, not a token share. |

## Running the tests

```bash
cd packages/pi-agent-grants
npm test                   # 272 unit tests — pure, no pi, no network
npm run typecheck          # src + extensions + test + test-integration
npm run test:integration   # 17 tests against a REAL pi process, no model tokens
npm run test:smoke         # pack, install into a scratch project, import and USE every subpath
PI_GRANTS_IT_MODEL=1 npm run test:integration   # + 4 end-to-end with a real model (~60s, costs money)
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
