import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GrantsSession } from "./session.ts";

const DELEGATION_TOOL_NAMES = ["delegate", "delegate_all", "delegate_chain"];

/** Activate only the delegation tools authorised by the owner-bound session state. */
export function reconcileActiveDelegationTools(pi: ExtensionAPI, session: GrantsSession): void {
  // Definitions are registered provisionally so a reload that momentarily observes a narrower foreign
  // environment can still restore its owner's tools. Only this owner-bound start boundary activates them.
  const surface = pi as ExtensionAPI & { getActiveTools?: () => string[]; setActiveTools?: (names: string[]) => void };
  if (!surface.getActiveTools || !surface.setActiveTools) return;
  const active = new Set(surface.getActiveTools());
  for (const name of DELEGATION_TOOL_NAMES) session.mayDelegate ? active.add(name) : active.delete(name);
  surface.setActiveTools([...active]);
}
