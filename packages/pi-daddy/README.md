# pi-daddy

Capability governance and coordination for [pi](https://github.com/badlogic/pi-mono)'s multi-level agent
system. An orchestrator grants each sub-agent a deliberate subset of what it holds and withholds the rest; a
sub-agent may delegate further, but only ever a subset of what it holds. Enforcement is pi's own `--tools`
allowlist on a separate child process, with an append-only ledger of every grant and refusal.

## Install

```bash
pi install npm:pi-daddy
```

Start a fresh pi session. Run `/grants` to see the session's tool ceiling and the definitions it can spawn.
`/grants init` records a project ceiling in `.pi/pi-daddy/settings.json`, the reviewable file you commit.

## What a definition is

An [Agent Skills](https://agentskills.io/specification) `SKILL.md`. Its `allowed-tools` is the ceiling; its body
is the child's system prompt.

```yaml
---
name: review-security
description: Reviews a diff for authn/authz, injection and secrets handling.
allowed-tools: Read, Grep
---
Review ONLY the diff you are given, for security. Report findings; never edit.
```

```
delegate({ agent: "review-security", task: "Review the diff." })
delegate_all({ children: [ { agent: "review-security", task: "…" }, { agent: "review-perf", task: "…" } ] })
delegate_chain({ steps: [ { agent: "plan", task: "…" }, { agent: "build", task: "Implement: {previous}" } ] })
```

Each child is a separate OS process with its own tool allowlist, its own instructions, and no knowledge of
the others, optionally in a visible [Herdr](https://herdr.dev) pane.

## The guarantee, and its limit

```
effective = ( requested ∩ parentGrant ∩ ceiling ) \ (gated \ approved)
```

Escalation is impossible by construction on the **tool surface**. It does not contain an agent holding an
execution primitive: a child granted `bash` can start an ungoverned descendant (measured, `docs/probes/g5-bash-escape`).
Containing that is the operating system's job, so `bash` is gated by default and every gate answer is recorded.

## Where to look

| Document | What it is |
| :--- | :--- |
| [PRODUCT-GUIDE.md](./PRODUCT-GUIDE.md) | How to use it day to day: delegation, work plans, the dashboard, learning. |
| [REQUIREMENTS.md](./REQUIREMENTS.md) | The current requirement register with boundaries. |
| [`docs/SPEC.md`](../../docs/SPEC.md) | What the product is, precisely, present tense. Environment variables, refusal codes, bounds. |
| [`docs/GLOSSARY.md`](../../docs/GLOSSARY.md) | Every term, one line each. |
| [CHANGELOG.md](./CHANGELOG.md) | Newest first; breaking changes say what to do. |

## Tests

```bash
npm test                   # unit tests, no pi, no network
npm run typecheck
npm run test:integration   # against a real pi process and a real Herdr server, no model tokens
npm run test:smoke         # pack, install into a scratch project, import and use it
```
