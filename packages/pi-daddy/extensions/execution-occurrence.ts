import { newExecutionId } from "../src/execution-id.ts";
import { childSpawnId } from "../src/fanout.ts";
import type { GrantsSession } from "./session.ts";

/** Readable logical position plus the unique identity used for every lifecycle join. */
export interface ExecutionOccurrenceIds {
  parentId: string;
  childId: string;
  executionId: string;
  parentExecutionId: string | null;
}

export function newDelegationOccurrence(session: GrantsSession, index: number): ExecutionOccurrenceIds {
  return {
    parentId: session.ownSpawnId,
    childId: childSpawnId(session.ownSpawnId, index),
    executionId: newExecutionId(),
    parentExecutionId: session.ownExecutionId ?? null,
  };
}
