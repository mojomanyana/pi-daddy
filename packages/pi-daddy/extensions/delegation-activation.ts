import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GrantsSession } from "./session.ts";

const ALL_DELEGATION_TOOL_NAMES = [
  "delegate",
  "delegate_all",
  "delegate_chain",
  "delegate_describe",
  "delegate_tournament",
  "quick_review",
];

function setDelegationActive(pi: ExtensionAPI, enabled: boolean): void {
  const surface = pi as ExtensionAPI & {
    getActiveTools?: () => string[];
    setActiveTools?: (names: string[]) => void;
    getAllTools?: () => Array<{ name: string }>;
  };
  if (!surface.getActiveTools || !surface.setActiveTools) return;
  const active = new Set(surface.getActiveTools());
  const registered = surface.getAllTools
    ? new Set(surface.getAllTools().map((t) => t.name))
    : new Set(ALL_DELEGATION_TOOL_NAMES);
  // Expose all eligible delegation tools from Turn 1 in both Standard and Ambitious modes.
  // Set PI_DADDY_LEAN_TOOLS=1 explicitly to opt into lean Turn-1 (only `delegate`).
  const lean = process.env.PI_DADDY_LEAN_TOOLS === "1";
  const target = enabled
    ? lean
      ? ["delegate"]
      : ALL_DELEGATION_TOOL_NAMES.filter((name) => registered.has(name))
    : [];
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
