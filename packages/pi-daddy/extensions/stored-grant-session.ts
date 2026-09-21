import {
  grantStorePath,
  loadStoredGrantStateSync,
  projectLedgerPath,
  type GrantStoreRefusalReason,
  type StoredGrant,
} from "../src/governance/grant-store.ts";
import { WILDCARD } from "../src/kernel/pi-tools.ts";
import { parseList } from "../src/kernel/propagation.ts";
import type { Capability } from "../src/kernel/resolve.ts";

export interface StoredGrantSessionState {
  stored?: StoredGrant;
  refusal?: { reason: GrantStoreRefusalReason; path: string };
  governed: boolean;
  inherited: Capability[];
  defaultLedger?: string;
}

/** Resolve the root-only project store while preserving the environment's absolute precedence. */
export function storedGrantSessionState(grantRaw: string | undefined, cwd: string): StoredGrantSessionState {
  const state = grantRaw === undefined ? loadStoredGrantStateSync(cwd) : { state: "absent" as const };
  const stored = state.state === "valid" ? state.stored : undefined;
  const refusal = state.state === "refuse" ? { reason: state.reason, path: grantStorePath(cwd) } : undefined;
  return {
    ...(stored ? { stored } : {}),
    ...(refusal ? { refusal } : {}),
    governed: grantRaw !== undefined || stored !== undefined || refusal !== undefined,
    inherited: grantRaw !== undefined ? parseList(grantRaw) : (stored?.grant ?? (refusal ? [] : [WILDCARD])),
    // Invalid state authorises only a refusal line at this conventional path; no child can start from it.
    defaultLedger: stored?.projectLedger || refusal ? projectLedgerPath(cwd) : undefined,
  };
}
