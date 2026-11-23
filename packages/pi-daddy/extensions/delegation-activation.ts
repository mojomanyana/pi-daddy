import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GrantsSession } from "./session.ts";

// Keep only `delegate` active by default; secondary delegation tools remain deferred
// (discoverable via Pi's native `tool_search` and `codemode`) to keep Turn-1 schemas lean.
const DELEGATION_TOOL_NAMES = ["delegate"];

function setDelegationActive(pi: ExtensionAPI, enabled: boolean): void {
  const surface = pi as ExtensionAPI & { getActiveTools?: () => string[]; setActiveTools?: (names: string[]) => void };
  if (!surface.getActiveTools || !surface.setActiveTools) return;
  const active = new Set(surface.getActiveTools());
  for (const name of DELEGATION_TOOL_NAMES) enabled ? active.add(name) : active.delete(name);
  surface.setActiveTools([...active]);
}

/** Activate only the delegation tools authorised by the owner-bound session state. */
export function reconcileActiveDelegationTools(pi: ExtensionAPI, session: GrantsSession): void {
  setDelegationActive(pi, session.mayDelegate);
}
