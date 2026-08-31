import { randomUUID } from "node:crypto";

/** Unique identity for one governed execution occurrence. Logical child ids remain readable positions. */
export type ExecutionId = `exec:${string}`;

const EXECUTION_ID_RE = /^exec:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isExecutionId(value: unknown): value is ExecutionId {
  return typeof value === "string" && EXECUTION_ID_RE.test(value);
}

export function newExecutionId(): ExecutionId {
  return `exec:${randomUUID()}`;
}

export function assertExecutionId(value: unknown, field = "executionId"): asserts value is ExecutionId {
  if (!isExecutionId(value)) throw new TypeError(`${field} must be a pi-daddy execution id`);
}
