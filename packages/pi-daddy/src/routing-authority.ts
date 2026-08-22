/**
 * ADR-0035's three routing guards, and why each one is shaped the way it is.
 *
 * Lifted out of `delegate.ts` when it crossed the 400-line ceiling `test/file-size.test.ts` enforces — the
 * same move `grants.ts` made at 398 and `delegate.ts` itself made at 413. It is a real seam rather than a
 * line-count dodge: all three answer one question, *may this caller route this child to this workspace, and
 * is the id even usable as a capability?*, and none of them looks at anything else in a delegation. The
 * alternative was trimming the rationale below to fit, which is how a codebase loses the reasons for its
 * guards.
 *
 * Each returns a refusal DESCRIPTOR rather than a `Delegation`, so the planner keeps sole ownership of
 * assembling records. `denied` is present exactly when the attempt should count as an escalation.
 */

import { mayRouteToWorkspace, isSafeWorkspaceId, workspaceCapability } from "./capabilities.ts";
import { WORKSPACE_WILDCARD, type Capability } from "./resolve.ts";
import { WILDCARD } from "./pi-tools.ts";
import type { RefusalCode } from "./refusals.ts";

export interface RoutingRefusal {
  code: RefusalCode;
  reason: string;
  /**
   * The capability to record in `denied`, when this refusal IS an escalation attempt.
   *
   * Absent for a malformed id, which is a bad request rather than a bid for authority — and seeding `denied`
   * with an id that re-splits into several capabilities would make the one signal `isEscalationAttempt` reads
   * unparseable. Present for an unauthorised route, which is exactly a bid for authority.
   */
  denied?: Capability[];
}

/**
 * May this caller route a child to `boundWorkspaceId`, and is that id usable as a capability id at all?
 *
 * Checked before anything is said about the target, for the reason `maySpawnDefinition` is: it is a
 * governance question about the SESSION. Before ADR-0035 nothing checked it — the registry inherited into
 * every governed child and a child routed to `staging` could route its grandchild to `prod` (R-131, measured
 * in `docs/probes/g36-workspace-attenuation`).
 *
 * **Well-formedness first, because `workspace_id` is a model-facing tool parameter** and the next step turns
 * it into a capability id. `workspace_id: "prod,tool:bash"` produced a `WORKSPACE_NOT_AUTHORIZED` whose
 * `denied` array held `workspace:prod,tool:bash`: no authority minted, since the refusal is terminal, but
 * `denied` is the channel `isEscalationAttempt` and `/grants ledger` count and an id that re-splits makes it
 * unreadable. 0.18.1 is what happens when a comma goes unremarked.
 *
 * **`!== undefined`, not truthiness.** `workspace_id: ""` is falsy, so it skipped BOTH checks and failed
 * closed much later at `resolveWorkspace` with `denied: []` — an unauthorised routing attempt invisible to
 * every audit query. An empty id is a malformed id, not an absent one.
 */
export function checkRoutingAuthority(
  boundWorkspaceId: string | undefined,
  ownGrant: readonly Capability[],
): RoutingRefusal | null {
  if (boundWorkspaceId === undefined) return null;
  const authorising = workspaceCapability(boundWorkspaceId);
  if (!isSafeWorkspaceId(boundWorkspaceId)) {
    return {
      code: "GRANT_ID_MALFORMED",
      reason:
        `workspace id ${JSON.stringify(boundWorkspaceId)} is not usable as a capability id — it would ` +
        `become ${JSON.stringify(authorising)}, and an id must match [A-Za-z0-9][A-Za-z0-9._/-]*. Slashes ` +
        `and dots are fine; spaces, quotes, commas, wildcards, shell metacharacters and non-ASCII are not.`,
    };
  }
  if (mayRouteToWorkspace(ownGrant, boundWorkspaceId)) return null;
  // Filtered by the grammar too: an id that cannot pass `isSafeWorkspaceId` is refused on every
  // attempt, so listing it here points the model at a destination it can never reach.
  const held = ownGrant
    .filter((c) => c.startsWith("workspace:") && isSafeWorkspaceId(c.slice("workspace:".length)))
    .sort();
  return {
    code: "WORKSPACE_NOT_AUTHORIZED",
    // Recorded as a denial rather than a bare refusal, exactly as DEFINITION_NOT_AUTHORIZED is: asking to
    // route somewhere this session was not granted IS an attempt to exceed the grant.
    denied: [authorising],
    reason:
      `cannot route a child to workspace "${boundWorkspaceId}" — this session does not hold ${authorising}. ` +
      (held.length > 0
        ? `It may route to: ${held.join(", ")}.`
        : `It may route to no workspace at all; add ${authorising} to its grant to allow this one.`),
  };
}

/**
 * May `workspace:*` be handed to a child? No — and only its HOLDER gets told so in those words.
 *
 * `workspace:*` is held and never inherited, so a child that "was granted" it would receive an env without
 * it, and the ledger would record an authority the child does not have — the mirror image of R-131 and just
 * as unreadable. `childEnv` strips it from a session's OWN grant because a root legitimately holds it; asking
 * to hand it to a child is a different act and the honest answer is no. `NARROWING_VIOLATED` is the existing
 * code for "this grant would not actually narrow", which is precisely what routing authority over every
 * registered root does.
 *
 * **`tool:*` does NOT reach the same outcome, and an earlier comment claimed it did.** It said
 * `assertNarrowing` produces the equivalent refusal; it does not. `UNIVERSAL_CAPABILITIES` is
 * `["ext:pi-fabric/fabric_exec", "tool:fabric_exec"]`, so `result.universal` is empty for `tool:*` and
 * nothing throws: requesting it for a child is allowed, recorded as granted, and silently stripped from the
 * child env by `inheritableGrant` (R-135). The asymmetry is deliberate — an ungoverned session's own grant IS
 * `tool:*`, so refusing to spawn from one would break governance-is-opt-in, while `workspace:*` only ever
 * appears in `requested` because somebody asked — but it is an asymmetry, not one rule twice.
 *
 * **Only for a holder.** A caller without it is attempting an escalation, and this refusal would tell it the
 * wildcard "is held, never inherited" — false about a session holding nothing of the sort — while leaving
 * `denied` empty, so nothing counted a model probing `tools: ["workspace:*"]`. Returning `null` lets
 * `resolve()` deny it as uncovered, which is what `agent:*` and `tool:*` already do.
 */
export function checkWorkspaceWildcardRequest(
  requested: readonly Capability[],
  ownGrant: readonly Capability[],
): RoutingRefusal | null {
  if (!requested.includes(WORKSPACE_WILDCARD)) return null;
  if (!ownGrant.includes(WORKSPACE_WILDCARD) && !ownGrant.includes(WILDCARD)) return null;
  return {
    code: "NARROWING_VIOLATED",
    reason:
      `cannot grant ${WORKSPACE_WILDCARD} to a child — it is held, never inherited, because a descendant ` +
      `holding it could route anywhere the registry lists and routing would stop attenuating below here. ` +
      `Name the workspaces this child may route to instead (workspace:<id>, one per id).`,
  };
}
