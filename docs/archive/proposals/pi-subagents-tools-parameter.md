# Proposal — a `tools` parameter for `pi-subagents` sub-agents

**Status:** draft, for `mojomanyana` to review and file at
`https://github.com/tintinweb/pi-subagents/issues`.
**Target:** `@tintinweb/pi-subagents` 0.14.3.
**Written:** 2026-08-10. Evidence: `docs/probes/g13-subagents-coupling`.

> **How to use this document.** It is written as an issue body, in the second person, so it can be pasted
> and edited down. Everything in it is measured against 0.14.3 rather than assumed. Cut freely — the ask is
> in *What I'd like*, and the rest is supporting evidence a maintainer may or may not want.

---

## What I'd like

**A way for a caller to spawn a sub-agent with fewer tools than its agent type declares.**

Concretely, either of these would be enough — the first is smaller, the second is more general:

1. **A `tools` parameter on the `Agent` tool and on `SpawnOptions`**, intersected with the type's own
   `builtinToolNames` (never widening it):

   ```ts
   interface SpawnOptions {
     // …existing fields…
     /** Restrict this spawn to a subset of the type's tools. Intersected, never widening. */
     tools?: string[];
   }
   ```

2. **An RPC method that reports a type's resolved configuration**, so a caller can at least *know* what a
   spawn will receive even if it cannot change it:

   ```
   subagents:rpc:describe  →  { type, toolNames, extensions, skills, model }
   ```

Option 1 enables provisioning. Option 2 enables auditing. They are useful independently, and I would take
either.

## Why

I maintain a capability-governance layer for pi (`pi-agent-grants`). The model is that a top orchestrator
holds a catalog of tools and grants each sub-agent a deliberate subset — enforced structurally by pi's own
`--tools` allowlist, which hard-blocks even `-e`-loaded extension tools.

That works when I spawn the child myself. It does not work through `pi-subagents`, and I want it to,
because `pi-subagents` is the sub-agent mechanism people actually have installed.

**Today my extension can only refuse a spawn, never narrow it.** A delegator picks a `subagent_type` whose
capability set is fixed in that type's file, so my choice is binary: allow the spawn as declared, or block
it. For an orchestrator that wants a child to read one directory and nothing else, "block" is the only
honest answer, and that is a poor experience for something that should be routine.

## What I tried first, so you don't have to suggest it

I would rather not ask for API surface if a supported path already exists. Each of these was measured
against 0.14.3, not assumed:

**Reading the resolved config by importing your registry.** `package.json` declares
`"pi": { "extensions": ["./src/index.ts"] }`, and the registry is module-level state in
`src/agent-types.ts`, in the same process — sub-agents are in-process `AgentRecord`s, and `child_process`
appears only in `worktree.ts`. So an `import()` of that absolute path ought to hit Node's module cache.

It returns a **different module instance**: `getAvailableTypes()` came back `[]` in a session where
`Agent`, `subagent`, `steer_subagent` and `get_subagent_result` were all present in the tool array. pi's
extension loader evidently does not share Node's ESM cache with a plain import of the same specifier.

**Calling `getToolNamesForType` anyway.** Beyond the instance problem, this is a trap for a governance
caller: unknown names fall back to `general-purpose`, whose `builtinToolNames` is omitted and therefore
means *all available tools*. Every type I asked about returned the full builtin list. A layer that trusted
it would grant everything to a typo. (Not a bug in your API — it is the right fallback for spawning. It is
simply not usable as an authority lookup, which is part of why I am asking for one.)

**The cross-extension RPC.** `subagents:rpc:ping` / `spawn` / `stop`, versioned at `PROTOCOL_VERSION = 2`
and announced by `subagents:ready` — a genuinely good channel, and clearly documented. But there is no
method to ask about a type, and `SpawnOptions` has no `tools` field, so it can start a child without being
able to say what that child may hold.

## One thing you may want to know regardless

While tracing the above I noticed that **`subagents:rpc:spawn` bypasses `tool_call` entirely**: it goes over
the event bus to `manager.spawn()`, so an extension hooking `tool_call` never observes it.

That is correct and probably intentional for your purposes. I mention it only because it means `tool_call`
is not a complete view of sub-agent creation, which may matter to anyone building policy, audit, or
rate-limiting on top of pi-subagents — and it is not something the README calls out.

## Compatibility

Both options are **additive and default-off**. An omitted `tools` is exactly today's behaviour. Intersecting
rather than replacing means a caller can never widen a type beyond what its author declared, so an agent
type stays an upper bound — which I think is the property you would want to preserve anyway.

## What I can offer

I am happy to write the patch and tests if the direction is welcome — say the word and I will open a PR
rather than leave you an issue to implement. I would rather check the direction first than send code you
did not ask for.

---

### Appendix — the evidence, reproducible

Full method, commands and raw output: `docs/probes/g13-subagents-coupling` in my project. The short version:

| Claim | How it was checked |
| :--- | :--- |
| Children are in-process | `grep -rln child_process src/` → `worktree.ts` only |
| Registry unreachable by import | probe extension `import()`s `src/agent-types.ts`, prints `getAvailableTypes()` → `[]` |
| pi-subagents was loaded in that session | second probe records the `before_provider_request` tool array → contains `Agent`, `subagent`, … |
| Unknown types get all tools | `getToolNamesForType("review"\|"plan"\|"general-purpose")` → identical full builtin list |
| No tool override exists | `SpawnOptions` (`src/agent-manager.ts:57`) has no `tools` field |
| RPC cannot describe a type | `registerRpcHandlers` registers `ping`, `spawn`, `stop` only |
