/** Bounded exact reconciliation helpers; receipt authority is supplied by the selected owner, not a model. */
import {
  validEffectReceipt,
  sameEffectTarget,
  type InitiativeEffectReceipt,
  type InitiativeEffectTarget,
  type InitiativeEffectObservation,
  type InitiativeTask,
  type InitiativeTaskRecord,
  type InitiativeAttempt,
  type InitiativeRecord,
  type InitiativeEffectIdentity,
  type InitiativeEffectReconciliation,
} from "../kernel/initiative.ts";
export interface InitiativeResolution {
  resolveAttempt(attempt: InitiativeAttempt): Promise<"settled" | "not-started" | "running" | "unknown">;
  assertEffectReconciled?(input: InitiativeEffectReconciliation): void | Promise<void>;
}
export function effectIdentity(
  initiativeId: string,
  task: InitiativeTaskRecord,
  attempt: InitiativeAttempt,
): InitiativeEffectIdentity {
  return {
    initiativeId,
    taskId: task.taskId,
    taskRevision: task.taskRevision,
    effectScope: task.effectScope,
    owner: { ...attempt.owner },
    operationId: attempt.operationId,
    executionId: attempt.executionId,
  };
}
export async function currentEffectReceipt(
  initiativeId: string,
  task: InitiativeTaskRecord,
  attempt: InitiativeAttempt,
  options: InitiativeResolution,
): Promise<InitiativeEffectReceipt | undefined> {
  if (!attempt.effectReceipt || !options.assertEffectReconciled) return undefined;
  if (
    attempt.effectReceipt.observation &&
    !sameEffectTarget(task.effectTarget, attempt.effectReceipt.observation.target)
  )
    return undefined;
  try {
    await options.assertEffectReconciled({
      ...effectIdentity(initiativeId, task, attempt),
      receipt: structuredClone(attempt.effectReceipt),
    });
    return structuredClone(attempt.effectReceipt);
  } catch {
    return undefined;
  }
}
export function receiptResolves(task: InitiativeTaskRecord, receipt?: InitiativeEffectReceipt) {
  if (receipt?.observation?.outcome === "unknown") return false;
  return task.effectScope === "local" || (!!receipt && (!task.effectTarget || !!receipt.observation));
}
export async function effectCurrent(
  initiativeId: string,
  task: InitiativeTaskRecord,
  attempt: InitiativeAttempt,
  options: InitiativeResolution,
) {
  return receiptResolves(task, await currentEffectReceipt(initiativeId, task, attempt, options));
}
/** Last exact attempt for the selected target; unknown evidence is never promoted to an applied effect. */
export function effectObservation(
  target: InitiativeEffectTarget | undefined,
  attempt: InitiativeAttempt | undefined,
  execution: "settled" | "not-started" | "running" | "unknown" | undefined,
  receipt?: InitiativeEffectReceipt,
): InitiativeEffectObservation | undefined {
  if (!target) return undefined;
  const identity = attempt
    ? { owner: { ...attempt.owner }, operationId: attempt.operationId, executionId: attempt.executionId }
    : undefined;
  if (!attempt || execution === "not-started")
    return {
      target: structuredClone(target),
      outcome: "pending",
      provenance: "not-observed",
      ...(identity ? { attempt: identity } : {}),
    };
  if (execution === "settled" && receipt?.observation && sameEffectTarget(target, receipt.observation.target))
    return {
      ...structuredClone(receipt.observation),
      receipt: { reference: receipt.reference, sha256: receipt.sha256 },
      attempt: identity,
    };
  return { target: structuredClone(target), outcome: "unknown", provenance: "not-observed", attempt: identity };
}
export async function settledInitiative(record: InitiativeRecord, options: InitiativeResolution) {
  for (const task of record.tasks)
    for (const attempt of task.attempts) {
      const status = await options.resolveAttempt(structuredClone(attempt));
      if (status === "not-started") continue;
      if (status !== "settled" || !(await effectCurrent(record.initiativeId, task, attempt, options))) return false;
    }
  return true;
}
/** A changed task revision cannot silently repeat an already-applied exact target. */
export async function assertTaskPriorSettled(
  record: InitiativeRecord,
  task: InitiativeTask,
  options: InitiativeResolution,
  exclude?: InitiativeAttempt,
) {
  for (const previous of record.tasks.filter((t) => t.taskId === task.taskId))
    for (const attempt of previous.attempts) {
      if (attempt === exclude) continue;
      const status = await options.resolveAttempt(structuredClone(attempt));
      if (status === "not-started") continue;
      if (status !== "settled") throw Error("task already has unresolved attempts");
      const receipt = await currentEffectReceipt(record.initiativeId, previous, attempt, options);
      if (!receiptResolves(previous, receipt)) throw Error("task prior attempts need reconciliation before start");
      if (
        task.effectTarget &&
        sameEffectTarget(task.effectTarget, previous.effectTarget) &&
        receipt?.observation?.outcome === "applied"
      )
        throw Error("exact task target is already applied; an amended task revision does not authorize repeating it");
    }
}
export function exactEffect(record: InitiativeRecord, input: InitiativeEffectReconciliation) {
  if (input.initiativeId !== record.initiativeId || !validEffectReceipt(input.receipt))
    throw Error("invalid effect receipt identity");
  const task = record.tasks.find(
    (t) => t.taskId === input.taskId && t.taskRevision === input.taskRevision && t.effectScope === input.effectScope,
  );
  const attempt = task?.attempts.find(
    (a) =>
      a.owner.sessionId === input.owner?.sessionId &&
      a.owner.cwd === input.owner?.cwd &&
      a.operationId === input.operationId &&
      a.executionId === input.executionId,
  );
  if (!task || !attempt || task.effectScope === "local")
    throw Error("effect attempt is outside the exact retained task");
  if (input.receipt.observation && !sameEffectTarget(task.effectTarget, input.receipt.observation.target))
    throw Error("effect observation target differs from selected task");
  if (task.effectTarget && !input.receipt.observation)
    throw Error("selected effect target requires an explicit outcome observation");
  return { task, attempt };
}
