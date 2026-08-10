# Probe — `g13-subagents-coupling` (can we govern `pi-subagents` from outside it?)

**What it measures.** ADR-0013 chose to govern `@tintinweb/pi-subagents` properly rather than downgrade the
interceptor. That requires reading what a child will actually receive, from the same source of truth the
spawner uses. This probe establishes **whether any local mechanism can do that**.

**Headline result: none can.** Direct import gives a different module instance; the supported RPC has no
config query; nothing anywhere accepts a tool override. Governing this path properly **requires an upstream
change** — which is why `docs/proposals/pi-subagents-tools-parameter.md` exists.

## Environment

pi 0.83.0, Node v24.14.0, `@tintinweb/pi-subagents` **0.14.3** (installed via `~/.pi/agent/settings.json`
`packages`). Date: 2026-08-10.

## 1. Children are in-process — confirmed

`child_process` is imported by exactly **one** file in `src/`: `worktree.ts`, for git. `AgentManager.spawn()`
is a method that builds an in-process `AgentRecord` with an `AbortController` and calls `startAgent`.

```bash
SA=~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents
grep -rln "child_process" "$SA/src"     # -> src/worktree.ts only
```

**Consequence for this package:** `propagation.ts`'s race-freedom argument — that everything published is a
parent-level fact, so there is nothing to race on — assumes a process boundary that exists on the
`delegate` path only. Interceptor children share one `process.env`.

## 2. The live registry is unreachable by import — measured

`package.json` declares `"pi": { "extensions": ["./src/index.ts"] }`, so pi loads the **TypeScript source**,
and the registry (`const agents = new Map()` in `src/agent-types.ts`) is module-level state in the same
process. Importing that same absolute path *should* hit Node's ESM cache and return the live instance.

It does not. A probe extension that `import()`s the path and calls `getAvailableTypes()`:

```
types: []
review tools: ["read","bash","edit","write","grep","find","ls"]
general-purpose tools: ["read","bash","edit","write","grep","find","ls"]
plan tools: ["read","bash","edit","write","grep","find","ls"]
```

**The registry is empty**, while pi-subagents was demonstrably loaded in the same session — a second probe
confirmed `Agent`, `subagent`, `steer_subagent` and `get_subagent_result` were all in the session's tool
array. pi's extension loader therefore does **not** share Node's module cache with a plain `import()` of the
same specifier.

### The landmine in those numbers

Every type returned the identical list, including `review`, which declares a narrower set in its own file.
That is `getToolNamesForType`'s **unknown-type fallback**: unknown names resolve to `general-purpose`, whose
`builtinToolNames` is omitted, which means *"all available tools"*.

**A governance layer reading this API naively would grant the full toolset to a typo.** That is the same
permissive-direction failure as the existing frontmatter-parser bug (A-C2), and it is why ADR-0013's local
work is a *faithful* port of the resolution rules rather than a call into whichever function looks right.

## 3. The supported RPC cannot answer the question

`src/cross-extension-rpc.ts` is a real, documented, versioned channel (`PROTOCOL_VERSION = 2`), announced by
a `subagents:ready` event. Its methods are:

| Method | Purpose |
| :--- | :--- |
| `subagents:rpc:ping` | version handshake |
| `subagents:rpc:spawn` | **spawn a subagent** |
| `subagents:rpc:stop` | abort one |

There is **no method to query an agent type's resolved configuration**. The channel can start a child; it
cannot tell you what that child will hold.

## 4. Nothing accepts a tool override

`SpawnOptions` (`src/agent-manager.ts:57`) carries `description`, `model`, `maxTurns`, `isolated`,
`inheritContext`, `thinkingLevel`, `isBackground`, `bypassQueue`, `isolation`, `cwd`, `invocation`,
`signal`, `onToolActivity` — and **no `tools` field**. Neither the `Agent` tool nor the RPC path can be
handed a narrower set. This is the ceiling on what any local fix can achieve: **refuse or allow, never
narrow.**

## 5. NEW FINDING — RPC spawns bypass the interceptor entirely

`subagents:rpc:spawn` goes over the event bus straight to `manager.spawn()`. It never produces a
`tool_call`, so this package's `tool_call` hook — which is its entire enforcement point on that path —
**never sees it**. Any other loaded extension can spawn a completely ungoverned subagent.

This is broader than review finding A-S9 ("the interceptor governs three hardcoded tool names"): adding more
tool names to `SPAWN_TOOLS` would not catch this, because there is no tool call to catch.

## How to rerun

```bash
mkdir -p /tmp/g13
# probe.ts registers /probe13 and import()s the registry path; probe2.ts records the session tool array.
# Both must run WITHOUT --no-extensions, or pi-subagents will not load and the result is meaningless.
cd /tmp/g13 && { echo '{"type":"prompt","id":"1","message":"/probe13"}'; sleep 12; } \
  | timeout 40 pi --no-session -e /tmp/g13/probe.ts --mode rpc | grep '"method":"notify"'
```

The probe sources are reproduced in ADR-0013; they are a dozen lines each and deliberately not committed as
package code.

## What this probe does *not* establish

- **That a supported coupling is impossible in principle** — only that none exists in 0.14.3. An upstream
  RPC method or a `tools` parameter would change the answer, which is exactly what the proposal asks for.
- **That the module-instance result is inherent.** It may be an artifact of how pi transpiles and loads
  extension TypeScript; a future pi could share the cache. It is recorded as measured behaviour of 0.83.0,
  not as a designed guarantee.
- **Anything about `pi-fabric`**, which is not installed here and was parked in ADR-0009.
