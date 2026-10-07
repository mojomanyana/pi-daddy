import { createCapacityAllocator, type CapacityAllocator, type CapacityReservation } from "../src/kernel/capacity.ts";
import { budgetFromEnv } from "../src/kernel/fanout.ts";
import { GovernanceRefusal, refusal, type StructuredRefusal } from "../src/kernel/refusals.ts";
import type { ReloadLifecycle } from "./reload-environment.ts";
import type { GrantsSession } from "./session.ts";

/** Live reservations belong to the real owner, not to replaceable extension/configuration objects. */
export interface OwnerCapacity {
  allocator: CapacityAllocator;
  refusal?: StructuredRefusal;
}
export function capacityForLifecycle(lifecycle: ReloadLifecycle, raw: string | undefined): OwnerCapacity {
  let configured: number;
  try {
    configured = budgetFromEnv(raw);
  } catch (error) {
    const rejected = refusal("FANOUT_EXCEEDED", `PI_DADDY_FANOUT refuses delegation: ${String(error)}`);
    lifecycle.capacity ??= { allocator: createCapacityAllocator(0), refusal: rejected };
    return { allocator: lifecycle.capacity.allocator, refusal: rejected };
  }
  lifecycle.capacity ??= { allocator: createCapacityAllocator(configured) };
  if (lifecycle.capacity.refusal) return lifecycle.capacity;
  if (configured !== lifecycle.capacity.allocator.total)
    return {
      allocator: lifecycle.capacity.allocator,
      refusal: refusal(
        "FANOUT_EXCEEDED",
        "PI_DADDY_FANOUT changed for an existing owner; start a new session to change capacity without replacing live reservations",
      ),
    };
  return lifecycle.capacity;
}
export function reserveDelegationCapacity(
  session: GrantsSession,
  executionId: string,
  childAllowance?: number,
): CapacityReservation {
  if (session.capacityRefusal) throw new GovernanceRefusal(session.capacityRefusal);
  const result = session.capacity.reserve(executionId, childAllowance ?? Math.max(0, session.capacity.available - 1));
  if (!result.ok) throw new GovernanceRefusal(refusal("FANOUT_EXCEEDED", result.reason));
  return result.reservation;
}
