# Probe — `approval-ux` (live verification of gated-capability approval against real pi)

**What it measures.** Whether `packages/pi-agent-grants` 0.4.0's human-approval feature behaves against a
real `pi` process the way ADR-0010 and the package README say it does. The eight scenarios cover the three
approval scopes, the three flavours of *no*, persistence, revocation, and the three ways a persisted
approval stops meaning what the human meant (`expired` is not exercised; `foreign-cwd` and `type-changed`
are).

**Why it exists.** The eight preceding implementation tasks were unit-tested and typechecked. That is not
the same as working. Every claim below was read out of pi's own JSON event stream or out of a file on
disk — never inferred from the fact that a code path exists.

**Headline result: 7 of 8 scenarios behave as specified; scenario 6 exposes a real ledger defect** (an
inherited approval on the `delegate` path is applied but never recorded), and a second, pre-existing
defect in `delegate`'s default model resolution was found on the way. Both are described under
*Defects found*.

> ## Resolution — 2026-08-09, after this run
>
> **Everything below records the run as it happened and has deliberately not been edited.** What changed
> afterwards, so a later reader does not act on a defect that no longer exists:
>
> - **Defect 1** (inherited approvals unrecorded on the `delegate` path) — **fixed.** The pre-filled
>   `approved` argument was removed from `delegate.execute`'s first `planDelegation` call, so both paths now
>   resolve approvals the same way and both record `approvalSource: "inherited"`. Re-verified live at two
>   hops (`GRANDCHILD_OK` with a depth-2 `approvalSource` line, which the old code could not produce).
> - **Defect 2** (bare default model) — **fixed.** The default is now
>   `` `${ctx.model.provider}/${ctx.model.id}` ``, and `delegate`'s `model` parameter documents the
>   `provider/id` form. Re-verified live: a `delegate` call with no `model` starts its child and returns
>   `exitCode: 0`.
> - Two of the three *Minor observations* were also addressed: the interceptor path now passes
>   `event.input.prompt` as the dialog's task (and as `taskAtApproval`) together with `ctx.signal`, and
>   `/grants approvals` now prints the ignored count alongside the valid one.
> - A later whole-branch review found a further defect this probe's caveat 4 correctly flagged as untested:
>   the single-flight queue was **inert in production**, because the wiring built a fresh gate — and
>   therefore a fresh empty queue — on every call. Fixed by a shared gate provider, and covered by a test
>   that exercises the caller's shape rather than a reused gate.
>
> Details and current behaviour: `packages/pi-agent-grants/README.md` (*Verified live*).

## Environment

pi 0.83.0 (`/home/alavanja/.nvm/versions/node/v24.14.0/bin/pi`), Node v24.14.0, provider `openai-codex`,
model `gpt-5.6-sol`, `@tintinweb/pi-subagents` (installed via `~/.pi/agent/settings.json` `packages`, and
the source of the `Agent` tool the interceptor hooks). Extension under test:
`packages/pi-agent-grants/extensions/grants.ts`. Unit suite at the time of the run: **134 passing, 0
failing**. Date: 2026-08-09.

## How to rerun

### Fixture

```bash
PROJ=/tmp/approval-ux/proj                       # throwaway; never inside the repo
mkdir -p "$PROJ/.pi/agents"
cat > "$PROJ/.pi/agents/docs-writer.md" <<'EOF'
---
name: docs-writer
tools: read, write
---
Fix documentation typos.
EOF
```

### The two harnesses

`ctx.ui.notify` and `ctx.ui.select` are **invisible through `--print`** (established in task 8: print mode
installs a no-op UI context). Both harnesses therefore use `pi --mode rpc`, where every `ctx.ui.*` call is
emitted on stdout as an `extension_ui_request` JSON line and a `select` blocks until an
`extension_ui_response` line is written back on stdin.

1. **Command-only harness** — one shell pipeline, no model tokens, for `/grants …`:

   ```bash
   cd "$PROJ" && { echo '{"type":"prompt","id":"1","message":"/grants approvals"}'; sleep 8; } \
     | timeout 30 env PI_GRANTS_GRANT="tool:read,tool:write" PI_GRANTS_GATED="tool:write" \
       pi --no-session -e <repo>/packages/pi-agent-grants/extensions/grants.ts --mode rpc \
     | grep '"method":"notify"'
   ```

2. **Dialog driver** — [`drive.mjs`](./drive.mjs) in this directory. It spawns `pi --mode rpc`, sends one
   prompt, prints every `notify`/`select` verbatim, and answers a `select` with `--answer <label>`:

   ```bash
   PI_GRANTS_GRANT="tool:read,tool:write" PI_GRANTS_GATED="tool:write" \
   PI_GRANTS_LEDGER="$PROJ/.pi/grants.jsonl" \
   node docs/probes/approval-ux/drive.mjs --cwd "$PROJ" --answer "Allow once" \
     --msg 'Call the Agent tool exactly once with subagent_type set to "docs-writer", description "fix typos", and prompt "Reply with exactly DOCS_OK and nothing else.". Do not use any other tool. Then report verbatim whatever the tool returned.'
   ```

> **What the driver does and does not prove.** In rpc mode `ctx.ui.select` reaches the rpc bridge instead of
> the terminal, so this exercises the **same extension-facing call the TUI dialog serves**, with the real
> title, the real option list, and the real blocking round-trip. It does **not** exercise the TUI's
> rendering or key handling. Every "the dialog appeared / did not appear" claim below means "pi emitted /
> did not emit an `extension_ui_request` with `method: "select"`".
>
> A second, deliberate control makes "no prompt" falsifiable rather than merely unobserved: in every
> scenario that expects **no** dialog, the driver is armed with `--answer "Deny"`. Had a dialog appeared,
> the spawn would have been blocked and the ledger would say `humanDenied: true`. It did not.

## Results (2026-08-09)

| # | Scenario | Verdict | What was observed |
| :--- | :--- | :--- | :--- |
| 1 | Dialog, **Allow once** | ✅ **PASS** | dialog shown, spawn proceeded, ledger `approvalSource:"prompt"`, `approvalScope:"once"`, **no** approvals file written |
| 2 | Dialog, **Deny** | ✅ **PASS** | spawn blocked; ledger `humanDenied:true`, `denied:[]` |
| 3 | `--print`, no human | ✅ **PASS** | refused naming `mode: print` and the fix; nothing written to `.pi/grants-approvals.json` |
| 4 | **Always allow**, then a fresh process | ✅ **PASS** | entry persisted with `grantAtApproval`; second process asked nobody, ledger `approvalSource:"persisted"` |
| 5 | `/grants revoke <key>`, spawn again | ✅ **PASS** | file emptied; the next spawn prompted again |
| 6 | Inherited approval lets a child re-delegate | ⚠️ **PARTIAL — defect** | grandchild at depth 2 **was** allowed under the inherited approval, but its ledger line records **no** `approved`/`approvalSource`. See *Defect 1* |
| 6b | Same mechanism on the **interceptor** path (`PI_GRANTS_APPROVED` seeded, as a child receives it) | ✅ **PASS** | depth-2 line: `approved:["tool:write"], approvalSource:"inherited"` |
| 7 | Approvals file copied to another directory | ✅ **PASS** | `(ignored) tool:write@docs-writer — foreign-cwd`; the same bytes remain valid in the original directory |
| 8 | Agent type's `tools:` line changed after approval | ✅ **PASS** | `(ignored) tool:write@docs-writer — type-changed`; the next spawn prompted again |

Nothing was NOT RUN. Scenarios 1, 2, 4, 5, 8 were driven through pi's rpc UI channel rather than a rendered
TUI — see the caveat above; that is the only respect in which any row is narrower than the brief's wording.

---

### 1 — Allow once

**Ran** (driver, `--answer "Allow once"`, `PI_GRANTS_GRANT="tool:read,tool:write"`,
`PI_GRANTS_GATED="tool:write"`), starting from no approvals file.

**Observed**

```
NOTIFY[info] grants: depth 0/2, holding [tool:read, tool:write]
ASSISTANT ["TOOLCALL Agent {\"subagent_type\":\"docs-writer\",…}"]
SELECT title="grants: approve tool:write for docs-writer?"
SELECT options=["Deny","Allow once","Allow for this session","Always allow in this project (30 days)"] timeout=120000
ANSWER "Allow once"
TOOLRESULT … "Agent completed in 3.7s (0 tool uses, 3.0k token).\n\nDOCS_OK"
```

**Ledger**

```json
{"ts":"2026-08-09T15:11:02.041Z","parentId":"d0","childId":"docs-writer@d1","depth":1,
 "agentType":"docs-writer","requested":["tool:read","tool:write"],"parentGrant":["tool:read","tool:write"],
 "effective":["tool:read","tool:write"],"denied":[],"clipped":[],"gatedBlocked":[],"blocked":false,
 "approved":["tool:write"],"approvalSource":"prompt","approvalScope":"once"}
```

`.pi/grants-approvals.json` **did not exist** afterwards — correct for `once`. The sub-agent really ran
(`DOCS_OK` came back through the `Agent` tool), so this is a spawn that proceeded, not merely a decision
that said it would.

### 2 — Deny

Same command, `--answer "Deny"`.

```
SELECT title="grants: approve tool:write for docs-writer?"
ANSWER "Deny"
NOTIFY[warning] grants: blocked spawn — tool:write was denied by a human
TOOLRESULT … {"text":"grants: tool:write was denied by a human"} isError:true
```

```json
{…,"effective":["tool:read"],"denied":[],"clipped":[],"gatedBlocked":["tool:write"],"blocked":true,
 "reason":"tool:write was denied by a human","humanDenied":true}
```

`humanDenied:true` with `denied:[]` — the "a person said no" flavour, distinct from an escalation attempt.
No approvals file was written.

### 3 — `--print` has nobody to ask

**Ran** (no rpc; this path needs no dialog):

```bash
cd "$PROJ" && PI_GRANTS_GRANT="tool:read,tool:write" PI_GRANTS_GATED="tool:write" \
  PI_GRANTS_LEDGER="$PROJ/.pi/grants.jsonl" \
  pi --print --no-session -e <repo>/packages/pi-agent-grants/extensions/grants.ts \
  'Call the Agent tool exactly once with subagent_type set to "docs-writer" …'
```

**Observed** (stdout, exit code 1):

```
grants: tool:write requires approval and this session has no interactive user (mode: print).
Pre-approve it in an interactive session, or drop it from the request.
```

**Ledger**

```json
{…,"gatedBlocked":["tool:write"],"blocked":true,
 "reason":"tool:write requires approval and this session has no interactive user (mode: print). Pre-approve it in an interactive session, or drop it from the request."}
```

No `approved`, no `approvalSource`, **no `humanDenied`** — the third flavour of no ("nobody was there to
ask"), which is the point of the field. `ls .pi/` afterwards showed only `agents/` and `grants.jsonl`: no
`grants-approvals.json` was created.

### 4 — Always allow, then a fresh process

**Run A**, `--answer "Always allow in this project (30 days)"` — ledger
`"approvalSource":"prompt","approvalScope":"always"`, and `.pi/grants-approvals.json` appeared:

```json
{
  "version": 1,
  "approvals": {
    "tool:write@docs-writer": {
      "approvedAt": "2026-08-09T15:11:25.546Z",
      "expiresAt": "2026-09-08T15:11:25.546Z",
      "cwd": "…/live/proj",
      "grantAtApproval": ["tool:read", "tool:write"]
    }
  }
}
```

(30-day expiry and `grantAtApproval` = the type's ceiling at approval time, exactly as ADR-0010 specifies.
`taskAtApproval` is absent because the interceptor call site passes no task — see *Minor observations*.)

**Run B** — a genuinely new `pi` process, same directory, ledger truncated first, driver armed with
`--answer "Deny"`. **No `SELECT` line was emitted**; the spawn ran and returned `DOCS_OK`:

```json
{"ts":"2026-08-09T15:12:00.378Z",…,"depth":1,"blocked":false,
 "approved":["tool:write"],"approvalSource":"persisted"}
```

No `approvalScope` — correct, since no prompt happened this time.

`/grants approvals` in that directory:

```
grants: 1 persisted approval
  tool:write@docs-writer
    approved 2026-08-09T15:11:25.546Z, expires 2026-09-08T15:11:25.546Z
```

### 5 — Revoke, then spawn again

```
/grants revoke tool:write@docs-writer
→ NOTIFY[info] grants: revoked tool:write@docs-writer
```

`.pi/grants-approvals.json` became `{"version": 1, "approvals": {}}`. The next spawn (fresh process,
`--answer "Deny"`) **did** raise the dialog again and was therefore blocked:

```json
{"ts":"2026-08-09T15:12:50.193Z",…,"gatedBlocked":["tool:write"],"blocked":true,
 "reason":"tool:write was denied by a human","humanDenied":true}
```

Revocation is read-on-demand, so this took effect for the very next process with no restart of anything
else.

### 6 — Inheritance down two levels (`delegate` path) — **PARTIAL, see Defect 1**

**Ran** — root holds `tool:read,tool:write,tool:delegate`, `PI_GRANTS_GATED="tool:write"`, driver
`--answer "Allow for this session"`, and the root was told to `delegate` a task which itself instructs the
child to `delegate` `["write"]` to a grandchild.

**Observed** — the dialog on the `delegate` path, with the task shown for context and **only three
options** (`always` is not offered when the subject is `<delegate>`, per ADR-0010):

```
SELECT title="grants: approve tool:write for <delegate>?\n  task: You have a delegate tool. Call the delegate tool exactly once with tools set to [\"write\"] …"
SELECT options=["Deny","Allow once","Allow for this session"] timeout=120000
ANSWER "Allow for this session"
TOOLRESULT {"text":"GRANDCHILD_OK"} details:{"granted":["tool:delegate","tool:read","tool:write"],"depth":1,"exitCode":0}
```

**Ledger — both levels**

```json
{"ts":"2026-08-09T15:15:57.827Z","parentId":"d0","childId":"delegate@d1","depth":1,…,
 "approved":["tool:write"],"approvalSource":"prompt","approvalScope":"session"}
{"ts":"2026-08-09T15:16:01.366Z","parentId":"d1","childId":"delegate@d2","depth":2,
 "requested":["tool:write"],"parentGrant":["tool:delegate","tool:read","tool:write"],
 "effective":["tool:write"],"denied":[],"clipped":[],"gatedBlocked":[],"blocked":false}
```

**The functional half passes.** The depth-2 line proves the approval really was inherited: the child ran
`--print` (no interactive user) with `PI_GRANTS_GATED=tool:write` propagated, so without an inherited
approval `resolve()` would have produced `gatedBlocked:["tool:write"]` and the grandchild would have been
refused. Instead `gatedBlocked` is empty and `GRANDCHILD_OK` came back. `approved ⊆ grant` held at every
hop.

**The audit half fails.** That depth-2 line carries **no `approved` and no `approvalSource:"inherited"`** —
see *Defect 1*.

### 6b — The same inheritance on the interceptor path

Because `PI_GRANTS_APPROVED` is exactly the channel a child receives an approval on, seeding it directly is
the real mechanism, not a stand-in for it. Run with `PI_GRANTS_APPROVED="tool:write"`,
`PI_GRANTS_DEPTH=1`, driver armed `--answer "Deny"`:

```
NOTIFY[info] grants: depth 1/2, holding [tool:read, tool:write]
ASSISTANT ["TOOLCALL Agent {…docs-writer…}"]      ← no SELECT emitted
ASSISTANT ["TEXT DOCS_OK"]
```

```json
{"ts":"2026-08-09T15:16:53.295Z","parentId":"d1","childId":"docs-writer@d2","depth":2,…,
 "blocked":false,"approved":["tool:write"],"approvalSource":"inherited"}
```

**What this proves and what it does not.** It proves the inherited-approval *recording* machinery
(`resolveApprovals` → `sources` → ledger) works end to end at depth 2, and that a session inheriting an
approval asks nobody. It does **not** prove that the `delegate` path reaches that machinery — scenario 6
shows it does not.

### 7 — A copied approvals file authorises nothing (R-27)

The file produced by scenario 4 was restored verbatim into `proj/` and **copied** into a second directory
`proj2/` holding an identical `docs-writer.md`.

```
proj2  /grants approvals → grants: 0 persisted approvals
                            (ignored) tool:write@docs-writer — foreign-cwd
proj2  /grants           → approvals  0 this session, 0 persisted
                            BLOCK  docs-writer — agent type "docs-writer" requires approval for tool:write
proj   /grants approvals → grants: 1 persisted approval
                            tool:write@docs-writer …
```

Same bytes, two directories, opposite verdicts. The copy is not silently dropped — it is listed with its
reason, which is the difference between "ignored" and "invisible".

> **Simulated step, stated plainly.** The approvals file in `proj/` was rewritten by hand at this point
> (byte-identical to the one the scenario-4 dialog wrote, whose full contents are quoted above) because
> scenario 5 had already emptied it. What this verifies is that a **file** with a foreign `cwd`
> authorises nothing; it does not re-verify that the dialog writes such a file — scenario 4 does that.

### 8 — Changing the agent type's `tools:` line voids the approval

With the valid approval in place, `docs-writer.md`'s frontmatter was edited from `tools: read, write` to
`tools: read, write, bash`.

```
/grants approvals → grants: 0 persisted approvals
                      (ignored) tool:write@docs-writer — type-changed
```

Then a spawn with the parent grant widened to `tool:read,tool:write,tool:bash` (so the change itself is not
an escalation and the run reaches the gate rather than the escalation check), driver `--answer "Deny"`:

```
SELECT title="grants: approve tool:write for docs-writer?"     ← prompted again
ANSWER "Deny"
```

```json
{"ts":"2026-08-09T15:14:15.388Z",…,"requested":["tool:bash","tool:read","tool:write"],
 "gatedBlocked":["tool:write"],"blocked":true,"humanDenied":true}
```

The confused-deputy fix holds: an entry whose key still matches but whose subject has changed underneath it
is dropped, with a distinct reason, and the human is asked again.

---

## Defects found

### Defect 1 — an inherited approval on the `delegate` path is applied but never recorded (**ledger gap**)

**Observed:** scenario 6's depth-2 ledger line has no `approved` and no `approvalSource:"inherited"`,
although the grandchild was allowed precisely because `tool:write` had been approved by a human one level
up. Scenario 6b shows the interceptor path records it correctly, so this is specific to `delegate`.

**Root cause** (read, not guessed) — the two call sites in `extensions/grants.ts` differ:

- interceptor (`extensions/grants.ts:256`) calls `decideSpawn(…, { parentGrant, depth, maxDepth, types,
  gated })` — **without** `approved`. So a gated capability always lands in `gatedBlocked` on the first
  pass, `obtainApprovals` runs, `resolveApprovals` classifies the hit as `"inherited"`, and the ledger gets
  it.
- delegate (`extensions/grants.ts:352-355`) calls `planDelegation(…, { …, approved: inheritedApprovals })`
  — **with** `approved` pre-filled. `resolve()` therefore returns `gatedBlocked: []`, `plan.ok` is true,
  the `if (!plan.ok && …gatedBlocked.length > 0)` block never runs, `approvalOutcome` stays `undefined`,
  and `buildRecord` is handed `approved: undefined, approvalSource: undefined`.

**Why it matters.** ADR-0010 lists "recorded per level in the ledger as `approvalSource: "inherited"`" as
the *compensating control* for the cost "a yes reaches the whole subtree", and its revisit trigger is
literally "a ledger entry showing `approvalSource: "inherited"` at a depth where the approving human could
not plausibly have known the descendant would exist". On the `delegate` path that entry is never written,
so the control is absent and the trigger can never fire — and `delegate` is the *multi-level* path, since
the interceptor can only enforce, not provision. An auditor reading the depth-2 line sees
`gatedBlocked: []` and cannot tell that a gated capability was involved at all.

**Not a security hole.** `approved ⊆ grant` still holds at every hop and no capability was conjured; the
child's `PI_GRANTS_APPROVED` is already clamped to its effective grant by `inheritApprovals`. This is an
auditability defect, not an escalation.

**Reproduce:** scenario 6 above, then inspect the `depth: 2` line of `$PROJ/.pi/grants.jsonl`.

### Defect 2 — `delegate`'s default model is a bare model id, which can resolve to a provider the user is not authenticated for (**pre-existing, not part of this feature**)

**Observed:** the first scenario-6 run passed the gate, spawned the child, and the child died immediately:

```
TOOLRESULT {"text":"No API key found for azure-openai-responses.\n\nUse /login to log into a provider …"}
           details:{"granted":["tool:delegate","tool:read","tool:write"],"depth":1,"exitCode":1}
```

**Root cause:** `extensions/grants.ts` passes `model: params.model ?? ctx.model?.id` and `planSpawn`
emits `--model <id>` with **no `--provider`**. `ctx.model.id` is the bare id (`gpt-5.6-sol`), and pi
resolves a bare id across all known providers.

**Confirmed independently of this package:**

```
pi --print --no-session --model gpt-5.6-sol            --no-tools "reply with exactly OK"
→ No API key found for azure-openai-responses.
pi --print --no-session --model openai-codex/gpt-5.6-sol --no-tools "reply with exactly OK"
→ OK
```

**Effect:** with the session's own provider ambiguous, *every* default `delegate` call spawns a child that
cannot start — governance decides correctly and the work still fails. Scenario 6 was completed by having
the model pass `model: "openai-codex/gpt-5.6-sol"` explicitly, which is disclosed here rather than hidden.

**Suggested fix (not applied — no source file was modified by this probe):** carry the provider too, e.g.
pass `provider: ctx.model?.provider` into `planDelegation`/`planSpawn` (both already accept a `provider`
field), or qualify the default as `provider/id`.

## Minor observations (not defects)

- **The interceptor-path dialog shows no task line.** `obtainApprovals` is called from the `tool_call`
  handler without a `task` argument, so the title is just `grants: approve tool:write for docs-writer?` and
  the persisted entry has no `taskAtApproval`. The `delegate` path does pass the task and does show it. The
  spawn prompt is available in `event.input.prompt` at the interceptor call site if this is ever wanted.
- **The dialog timeout observed on the wire is `120000` ms**, matching `DEFAULT_TIMEOUT_MS`.
  `PI_GRANTS_APPROVAL_TIMEOUT` was not exercised.
- **`/grants approvals` reports "0 persisted approvals" *and then* lists the ignored entries.** The count
  refers to valid entries only; the ignored lines follow. Accurate, but a reader skimming the first line
  could conclude the file is empty.

## Caveats

1. One provider/model (`openai-codex` / `gpt-5.6-sol`), one pi version (0.83.0), one platform (WSL2). The
   approval logic is model-independent, but the *scenarios* depend on the model choosing to call `Agent` /
   `delegate` as instructed; each run above was checked for the actual tool call in the event stream.
2. Dialogs were driven through `pi --mode rpc`, not through the rendered TUI. See the caveat under *How to
   rerun*.
3. `expired` was not exercised — only `foreign-cwd` and `type-changed`. Expiry is 30 days and is covered by
   unit tests; forcing it live would require a hand-edited `expiresAt`, i.e. the same pre-seeding this
   probe used for scenario 7.
4. Concurrency was not exercised: the `inFlight` de-duplication in `createApprovalGate` (two simultaneous
   delegations hitting the same gate) has no live scenario here.
5. The scratch project directories (`.pi/agents/docs-writer.md`, ledgers, approvals files) lived entirely
   under `/tmp`; nothing was written into this repository except this directory.
