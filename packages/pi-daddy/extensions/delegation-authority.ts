import { GovernanceRefusal, refusal } from "../src/refusals.ts";
import type { GrantsSession } from "./session.ts";

/** Tool definitions may be inspected directly; execution still requires an owner-bound delegation grant. */
export function assertDelegationAuthority(session: GrantsSession): void {
  if (!session.ownerBound) {
    throw new GovernanceRefusal(refusal("CAPABILITY_ESCALATION", "delegation refused: session ownership is not bound yet"));
  }
  if (!session.mayDelegate) {
    throw new GovernanceRefusal(refusal("CAPABILITY_ESCALATION", "delegation refused: this session does not hold tool:delegate"));
  }
}
