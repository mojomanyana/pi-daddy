import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GrantsSession } from "./session.ts";

const ALL_DELEGATION_TOOL_NAMES = ["delegate", "delegate_all", "delegate_chain", "delegate_describe"];

function setDelegationActive(pi: ExtensionAPI, enabled: boolean): void {
  const surface = pi as ExtensionAPI & { getActiveTools?: () => string[]; setActiveTools?: (names: string[]) => void };
  if (!surface.getActiveTools || !surface.setActiveTools) return;
  const active = new Set(surface.getActiveTools());
  const lean = process.env.PI_DADDY_LEAN_TOOLS === "1";
  const target = enabled ? (lean ? ["delegate"] : ALL_DELEGATION_TOOL_NAMES) : [];
  for (const name of ALL_DELEGATION_TOOL_NAMES) {
    if (target.includes(name)) active.add(name);
    else active.delete(name);
  }
  surface.setActiveTools([...active]);
}

/** Activate only the delegation tools authorised by the owner-bound session state. */
export function reconcileActiveDelegationTools(pi: ExtensionAPI, session: GrantsSession): void {
  setDelegationActive(pi, session.mayDelegate);
}
