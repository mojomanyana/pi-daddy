/**
 * The tripwire's vocabulary — which tool names count as a foreign spawner, and what to say when one appears.
 *
 * Lifted out of `extensions/grants.ts` so the *message* can be tested without loading pi. That is not
 * fastidiousness: the message is the whole product of this control. A refusal nothing verifies is a refusal
 * whose wording drifts, and the wording is what a model acts on.
 *
 * The hook that uses these stays in `grants.ts`, because it also writes a ledger record and that needs the
 * session.
 */

/**
 * Tool names that create sub-agents this package did not provision.
 *
 * `subagent` is the one seen in the wild — a directory drop-in at `~/.pi/agent/extensions/subagent/`, which pi
 * auto-loads in **every** session on a machine regardless of `settings.json`. `Agent` and `spawn_agent` are the
 * other plausible names. **Deliberately a name check and nothing more**: `subagents:rpc:spawn` reaches a
 * manager over the event bus and never produces a `tool_call` at all (ADR-0013 Finding 6), so this catches the
 * ordinary case loudly and is not a boundary.
 */
export const SPAWN_TOOLS: ReadonlySet<string> = new Set(["Agent", "subagent", "spawn_agent"]);

/**
 * Why a foreign spawn tool is refused, and what to use instead.
 *
 * **Both governed tools are named, and this is the fix rather than a flourish.** The text said only *"Use
 * `delegate` instead"*. On 2026-08-17 an operator asked for parallel work, `subagent` was refused, and the model
 * then planned a single sequential `delegate` — a reasonable reading of the only instruction it was given, and
 * the wrong shape for the request. `delegate_all` existed the whole time.
 *
 * A refusal that points at the wrong replacement is a refusal that gets obeyed badly. And it names what is
 * *lost* rather than only what is forbidden, because a control an operator cannot evaluate is one they route
 * around — the escape hatch is one unset variable away, so it should be an informed choice.
 */
export function tripwireReason(toolName: string): string {
  return (
    `grants: "${toolName}" spawns sub-agents outside this session's governance — refused. ` +
    `This session grants capabilities by spawning them itself, so a child created by another extension would ` +
    `hold whatever that extension decided, with no grant, no depth bound and no ledger entry. ` +
    `Use \`delegate\` for a single sub-agent, or \`delegate_all\` to run several CONCURRENTLY — that is the ` +
    `governed equivalent of a parallel or chained spawn, and it is what to reach for when independent tasks ` +
    `can proceed at the same time. If you meant to run ungoverned, unset PI_GRANTS_GRANT.`
  );
}
