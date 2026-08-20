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
