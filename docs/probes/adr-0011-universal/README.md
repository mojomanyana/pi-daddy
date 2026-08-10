# Probe — `adr-0011-universal` (live verification of ADR-0011 against real pi)

**What it measures.** Whether the three changes ADR-0011 decided actually hold against a real `pi`
process, with real agent-type files on disk — not just in the unit suite. ADR-0011 is a **breaking**
change (0.4.0 → 0.5.0): spawns that succeeded before now fail, so "the tests pass" is not enough. The
preceding feature was also unit-clean and its live run still found two real defects.

**Headline result: all three decided behaviours confirmed live.** One **new finding**, not a regression
and not a security hole, but a real incoherence introduced by this change: on the wildcard branch a gated
capability now produces a message saying *"requires approval"* while **no approval dialog is ever
offered**, so there is no way to give the approval it names. See *Finding 1*.

## Environment

pi 0.83.0 (`/home/alavanja/.nvm/versions/node/v24.14.0/bin/pi`), Node v24.14.0, provider `openai-codex`,
model `gpt-5.6-sol`, `@tintinweb/pi-subagents` (from `~/.pi/agent/settings.json` `packages`, the source of
the `Agent` tool the interceptor hooks). Extension under test:
`packages/pi-agent-grants/extensions/grants.ts` at 0.5.0. Unit suite at the time of the run: **155
passing, 0 failing**. Date: 2026-08-10.

**`pi-fabric` is not installed here.** That constrains what scenario 2 can reach — see its caveat.

## How to rerun

### Fixture

```bash
PROJ=/tmp/adr0011/proj                           # throwaway; never inside the repo
rm -rf /tmp/adr0011 && mkdir -p "$PROJ/.pi/agents"
cat > "$PROJ/.pi/agents/fabric-agent.md" <<'EOF'
---
name: fabric-agent
tools: read, write, fabric_exec
---
An agent type that declares a universal capability alongside ordinary ones.
EOF
cat > "$PROJ/.pi/agents/docs-writer.md" <<'EOF'
---
name: docs-writer
tools: read, write
---
Fix documentation typos.
EOF
```

### The two harnesses

Both are reused unchanged from [`../approval-ux`](../approval-ux/README.md), which explains why rpc mode
is the right channel (`ctx.ui.*` is invisible through `--print`; in rpc mode every call is emitted as an
`extension_ui_request` JSON line and a `select` blocks until a response is written back on stdin).

1. **Command-only harness** — one shell pipeline, no model tokens. `/grants` runs `decideSpawn` over every
   known agent type and prints `allow`/`BLOCK` with the reason, so it reads the decision function's real
   output inside a real pi process:

   ```bash
   cd "$PROJ" && { echo '{"type":"prompt","id":"1","message":"/grants"}'; sleep 10; } \
     | timeout 40 env PI_GRANTS_GRANT="tool:read,tool:write,tool:fabric_exec" PI_GRANTS_GATED="tool:write" \
       pi --no-session -e <repo>/packages/pi-agent-grants/extensions/grants.ts --mode rpc \
     | grep '"method":"notify"'
   ```

2. **Dialog driver** — [`../approval-ux/drive.mjs`](../approval-ux/drive.mjs), for real model-driven spawns:

   ```bash
   PI_GRANTS_GRANT="tool:*" PI_GRANTS_GATED="tool:write" PI_GRANTS_LEDGER="$PROJ/.pi/grants.jsonl" \
   node docs/probes/approval-ux/drive.mjs --cwd "$PROJ" --answer "Allow once" --timeout 150 \
     --msg 'Call the Agent tool exactly once with subagent_type set to "docs-writer", description "fix typos", and prompt "Reply with exactly DOCS_OK and nothing else.". Do not use any other tool. Then report verbatim whatever the tool returned.'
   ```

> **The control that makes "no dialog" falsifiable.** Every scenario expecting **no** prompt is run with
> the driver armed with `--answer "Allow once"` — the *permissive* answer. Had a dialog appeared, the
> driver would have approved it and the spawn would have proceeded. Every "no dialog" below therefore
> means "pi emitted no `extension_ui_request` with `method: "select"`, while a waiting answer would have
> let the spawn through".

## Results (2026-08-10)

| # | Scenario | Decided by | Verdict | What was observed |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Wildcard delegator, agent type declares `fabric_exec` | ADR-0011 §1 | ✅ **PASS** | `BLOCK fabric-agent — declares tool:fabric_exec, which transitively confers the whole catalog … so holding tool:* does not authorise it`. **Allowed in 0.4.0** |
| 2 | Enumerated grant *holding* `fabric_exec`, same type | ADR-0011 §1 | ✅ **PASS** (see caveat) | `BLOCK fabric-agent — would retain tool:fabric_exec, which transitively confers the whole catalog — the grant would not narrow anything`. **Silently passed through and allowed in 0.4.0** |
| 3 | Wildcard delegator, gated capability, real spawn | in-scope expansion | ✅ **PASS** | spawn blocked, `Agent` returned `isError`, ledger `blocked:true`, `gatedBlocked:["tool:write"]`. **Silently allowed in 0.4.0 — the gate did nothing** |
| 4 | No approval dialog for a doomed spawn | ADR-0011 §2 | ✅ **PASS** | armed with `Allow once`; **no `SELECT` emitted** in any scenario, and no `humanDenied` / `approvalSource` field in any ledger line |

### Scenario 2's caveat — read this before trusting the row

The enumerated-path universal branch was confirmed through harness 1, **not** through a model-driven
spawn. Attempting the latter blocked with a *different* reason:

```
BLOCK fabric-agent — requires tool:fabric_exec, which this session does not hold (capability escalation blocked)
```

**This is correct behaviour, not a failure.** `deriveOwnGrant` tightens the session's grant to the tool
surface it actually observed in its first provider request, and `fabric_exec` is not in it because
`pi-fabric` is not installed here. So the escalation check fires first and the universal check is never
reached. The enumerated-path universal branch is only reachable when a session **genuinely holds**
`fabric_exec` — which is exactly the case ADR-0011 was written for, and exactly the case this machine
cannot stage without installing `pi-fabric` globally.

That is defence in depth working as designed, but it means **row 2's live evidence is the decision
function's output inside a real pi process, not a completed spawn**. Reaching it end-to-end requires
`npm:pi-fabric` in `~/.pi/agent/settings.json`.

### Ledger, verbatim

Both blocked spawns recorded. Note the absent `approved` / `approvalSource` / `humanDenied` fields —
independent confirmation that no approval flow ran:

```json
{"childId":"docs-writer@d1","agentType":"docs-writer","requested":["tool:read","tool:write"],
 "effective":["tool:read"],"denied":[],"gatedBlocked":["tool:write"],"blocked":true,
 "reason":"agent type \"docs-writer\" requires approval for tool:write"}
{"childId":"fabric-agent@d1","agentType":"fabric-agent","requested":["tool:fabric_exec","tool:read","tool:write"],
 "effective":["tool:read"],"denied":["tool:fabric_exec"],"gatedBlocked":["tool:write"],"blocked":true,
 "reason":"agent type \"fabric-agent\" requires tool:fabric_exec, which this session does not hold (capability escalation blocked)"}
```

## Finding 1 — a wildcard delegator can be told to get an approval it cannot get

**Severity: not a security hole. It fails closed.** But the message is actively misleading and the state
is unreachable-by-design in a way nobody decided.

**What happens.** With `PI_GRANTS_GRANT="tool:*"` and `PI_GRANTS_GATED="tool:write"`, spawning
`docs-writer` (which declares `tools: read, write`) blocks with:

```
grants: blocked spawn — agent type "docs-writer" requires approval for tool:write
```

and **no dialog is offered**, verified with the driver armed to approve. The operator is told to find a
human, and no human can help: there is no code path from this state to an approval.

**Why.** The new gated check lives in `decideSpawn`'s **wildcard branch**, which returns early and carries
no `ResolveResult` (`Decision.result` is `undefined` there — the branch never calls `resolve()`). The
extension guards its approval flow with `shouldSeekApproval(decision.result)`, and that function returns
`false` for `undefined` on its first line. So `obtainApprovals` is never invoked on this path.

**Why it did not exist before ADR-0011.** Before this change the wildcard branch returned `allow: true`
without consulting `ctx.gated` at all — the bug this expansion fixed. Closing it moved the operator from
*"the gate silently did nothing"* to *"the gate refuses and names an approval you cannot give"*. The
second state is strictly safer and strictly more confusing.

**Note the symmetry with what ADR-0011 deliberately fixed elsewhere.** The same ADR reordered
`planDelegation` so it would stop reporting *"requires explicit approval"* for a delegation that could
never be approved — with the commit comment *"telling the operator to go and find a human who cannot
help"*. That is precisely what the wildcard branch now does. The principle was applied on one path and
introduced on another in the same change.

**Not fixed here, deliberately.** Both plausible fixes are design decisions rather than repairs:

- **Prompt on this path too** — have the wildcard branch produce a `ResolveResult` so the existing
  approval flow engages. Most useful, largest behaviour change, and it means a wildcard holder can widen
  its own children past an operator's gate with one dialog.
- **Make the message honest** — say the gate cannot be satisfied under a wildcard grant and name
  `PI_GRANTS_GRANT` as the fix. Smallest change, keeps the refusal, fixes only the lie.

Recorded for a decision rather than patched around, and added as a revisit trigger on ADR-0011.

## What this probe does *not* establish

1. **Nothing about the TUI.** rpc mode exercises the same extension-facing `ctx.ui.select` call the TUI
   dialog serves, not its rendering or key handling.
2. **Scenario 2 end-to-end**, per its caveat — no `pi-fabric` on this machine.
3. **Nothing about `delegate`'s** universal refusal, which was already covered before ADR-0011
   (`assertNarrowing` has always been called there) and is unchanged by it apart from the reordering.
4. **Nothing about depth ≥ 2** for the new refusals. The unit suite covers the resolver transitively;
   these runs are all depth 0 → 1.
