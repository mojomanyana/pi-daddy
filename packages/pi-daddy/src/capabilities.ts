/**
 * Capability ids: their grammar, and the two authority predicates over them.
 *
 * Split out of `delegate.ts` when ADR-0024 pushed that file past the 400-line ceiling and
 * `test/file-size.test.ts` refused it — for the second time, and answered the same way as the first: split
 * the file the way the failure message says rather than raise the cap on the guard.
 *
 * The seam is not arbitrary. Three modules outside `delegate.ts` already imported these
 * (`extensions/session.ts` for `DELEGATE_CAPABILITY`, `extensions/delegation.ts` and
 * `extensions/run-delegation.ts` for `maySpawnDefinition`), which is the evidence that they were a separate
 * concern living in the wrong file: *what an id means and who may use it* is a different question from
 * *what one delegation does*.
 */

import { AGENT_WILDCARD, WORKSPACE_WILDCARD, type Capability } from "./resolve.ts";
import { WILDCARD } from "./pi-tools.ts";
import { GovernanceRefusal, refusal } from "./refusals.ts";

/** The capability that authorises spawning a definition (ADR-0017). `tool:*` satisfies any of them. */
export const agentCapability = (name: string): Capability => `agent:${name}`;

/**
 * May this grant spawn that definition? (ADR-0017.)
 *
 * `resolve()` is exact-match plus subsumption and has no wildcard rule — a wildcard session works only
 * because `deriveOwnGrant` *enumerates* its observed tools alongside `tool:*`. Definitions are not tools,
 * so nothing enumerates them, and the wildcard has to be honoured here explicitly. Without that an
 * UNGOVERNED session would stop being able to spawn, and "governance is opt-in" is the one rule this
 * package must never break by accident.
 */
export function maySpawnDefinition(ownGrant: Capability[], name: string): boolean {
  // ADR-0023 adds the middle case. `tool:*` is authority to grant every tool and satisfies this too;
  // `agent:*` is authority to spawn any definition and grants no tools at all, which is the configuration
  // an operator wanting "any of our definitions, narrow tools" previously had to fake with `tool:*`.
  return (
    ownGrant.includes(WILDCARD) ||
    ownGrant.includes(AGENT_WILDCARD) ||
    ownGrant.includes(agentCapability(name))
  );
}

/** The tool name that confers the ability to delegate further. */
export const DELEGATE_CAPABILITY: Capability = "tool:delegate";

/** Accept `read` or `tool:read` or `ext:pkg/tool` and normalise to a capability id. */
export function normaliseCapability(raw: string): Capability {
  const value = raw.trim();
  if (
    value.startsWith("tool:") || value.startsWith("ext:") || value.startsWith("skill:")
    || value.startsWith("agent:") || value.startsWith("workspace:")
  ) {
    return value;
  }
  return `tool:${value}`;
}

/** The capability that authorises routing a child to one registered workspace (ADR-0035). */
export function workspaceCapability(workspaceId: string): Capability {
  return `workspace:${workspaceId}`;
}

/**
 * May this session route a child to workspace `id`?
 *
 * Mirrors `maySpawnDefinition` deliberately — same shape, same wildcard handling, same reason. Routing was
 * the one governance dimension that did not attenuate (R-131, measured in
 * `docs/probes/g36-workspace-attenuation`): the registry inherited into every child and nothing checked the
 * caller's authority, so a child routed to `staging` could route its grandchild to `prod`.
 *
 * `tool:*` satisfies it because governance is opt-in — an ungoverned session holds the wildcard and must
 * keep working exactly as before.
 */
export function mayRouteToWorkspace(ownGrant: readonly Capability[], workspaceId: string): boolean {
  const held = new Set(ownGrant);
  return held.has(WILDCARD)
    || held.has(WORKSPACE_WILDCARD)
    || held.has(workspaceCapability(workspaceId));
}

/**
 * Characters that make a capability id mean something OTHER than one capability.
 *
 * A capability id is never a list. `PI_GRANTS_GRANT` is comma-separated and `parseList` trims and splits
 * it, so a comma inside a single id means the child reads it as several — including ones nothing granted.
 * Newlines are here for the same reason one level out: the grant travels through an environment variable
 * and, via `assertGrantIsWritable`, a shell-sourced file.
 *
 * **Measured, on the published 0.18.0.** A root holding `agent:*` (or `tool:*`) that requested
 * `agent:x,tool:bash` had it admitted by the wildcard's prefix rule, written verbatim into the child's
 * grant, and split by the child into `agent:x` + `tool:bash` — minting a capability the root never held,
 * with `denied: []` so nothing recorded an escalation and the ledger line looked clean.
 *
 * Deliberately a blocklist of structurally dangerous characters rather than the full grammar whitelist in
 * `isSafeCapability`. That whitelist is right where it lives — the boundary that GENERATES a grant — but
 * this is the enforcement path, which must keep accepting whatever ids operators already have. A security
 * patch to a released version should close the hole without inventing a new way to refuse a legitimate
 * setup. `grant-env.ts` predicted this channel: "the third channel — whatever it turns out to be — should
 * cost a refusal rather than an injection."
 */
const CAPABILITY_ID_SEPARATORS = /[,\r\n\0]/;

/** False when an id would be read as more than one capability by any channel that carries it. */
export function isWellFormedCapability(id: string): boolean {
  return id.length > 0 && !CAPABILITY_ID_SEPARATORS.test(id) && id.trim() === id;
}

/**
 * The write-side backstop, for every channel that joins capabilities into one string.
 *
 * `covered()` already refuses to GRANT a malformed id, so this should be unreachable — which is exactly
 * why it exists. `grant-env.ts` says it better than I can: "the third channel — whatever it turns out to
 * be — should cost a refusal rather than an injection. A guard that depends on my enumeration being
 * complete is not a guard." The propagation channel turned out to be that third channel, and it had no
 * backstop while the file-writing channel did.
 *
 * Loud rather than silently filtered: a malformed id here means something upstream admitted one, and
 * dropping it quietly would hide the defect that produced it.
 */
export function assertCapabilitiesArePropagatable(grant: readonly Capability[]): void {
  const malformed = grant.filter((c) => !isWellFormedCapability(c));
  if (malformed.length === 0) return;
  throw new GovernanceRefusal(refusal(
    "GRANT_ID_MALFORMED",
    `refusing to build a child environment: ${JSON.stringify(malformed)} contain characters that are not ` +
    `part of a capability id. The grant is comma-separated, so a child would read these as several ` +
    `capabilities — including ones nothing granted. Report this: a malformed id reached propagation, ` +
    `which means a guard upstream admitted it.`,
    { malformed: malformed.join(" ") },
  ));
}
