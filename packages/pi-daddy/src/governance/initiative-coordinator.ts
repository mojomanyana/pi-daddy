/** One coordinator per local initiative. Reuses OS-held ownership; ordinary dispatch still owns grants and writer leases. */
import { realpathSync, existsSync } from "node:fs";
import { basename } from "node:path";
import type { OperationArtifactOwner } from "../kernel/operation-artifact.ts";
import type { OperationRequest } from "../kernel/dispatch-operation.ts";
import { validOperationId } from "../kernel/dispatch-operation.ts";
import {
  validInitiativeTask,
  sameEffectTarget,
  type InitiativeTask,
  type InitiativeTaskIdentity,
  type InitiativeRecord,
  type InitiativeObservation,
  type InitiativeEffectReconciliation,
} from "../kernel/initiative.ts";
import {
  effectCurrent,
  assertTaskPriorSettled,
  currentEffectReceipt,
  receiptResolves,
  effectObservation,
  effectIdentity,
  exactEffect,
  settledInitiative,
  type InitiativeResolution,
} from "./initiative-effects.ts";
import { lockRuntimeSettlement } from "./runtime-settlement-lock.ts";
import { publishArtifact } from "./operation-artifact-io.ts";
import { initiativeLocation, initiativeRevision, readInitiativeState, saveInitiative } from "./initiative-state.ts";
export interface InitiativeCoordinatorOptions extends InitiativeResolution {
  assertAuthority(): void | Promise<void>;
  /** Optional read permission for exact owner facts; never substitutes for mutation or task-readiness authority. */
  assertObservationAuthority?(): void | Promise<void>;
}
export interface AcquireInitiative {
  initiativeId: string;
  owner: OperationArtifactOwner;
  expectedRevision: string | null;
  recoveryOnly?: boolean;
}
export async function acquireInitiativeCoordinator(
  directory: string,
  request: AcquireInitiative,
  options: InitiativeCoordinatorOptions,
) {
  directory = realpathSync(directory);
  request = {
    initiativeId: request.initiativeId,
    expectedRevision: request.expectedRevision,
    recoveryOnly: request.recoveryOnly === true,
    owner: { sessionId: request.owner.sessionId, cwd: request.owner.cwd },
  };
  if (
    !request.owner.sessionId ||
    request.owner.sessionId.length > 512 ||
    request.owner.cwd !== realpathSync(request.owner.cwd)
  )
    throw Error("initiative owner identity unavailable");
  await options.assertAuthority();
  const { root, path } = initiativeLocation(directory, request.initiativeId, !request.recoveryOnly);
  const lock = await lockRuntimeSettlement(path + ".lock");
  let closed = false,
    failed = false;
  try {
    await options.assertAuthority();
    const old = readInitiativeState(directory, request.initiativeId);
    if ((old?.revision ?? null) !== request.expectedRevision) throw Error("initiative revision conflict");
    const marker = basename(path) + ".initialized";
    if (!old && existsSync(path + ".initialized")) throw Error("initiative state missing; restore trusted state");
    const settled = (record: InitiativeRecord) => settledInitiative(record, options);
    if (request.recoveryOnly && !old) throw Error("no retained initiative to recover");
    if (!request.recoveryOnly && old && !(await settled(old.record)))
      throw Error("initiative reconciliation required; prior attempt or effects unresolved");
    await options.assertAuthority();
    if (!lock.healthy()) throw Error("initiative ownership lock lost");
    if ((readInitiativeState(directory, request.initiativeId)?.revision ?? null) !== request.expectedRevision)
      throw Error("initiative changed before takeover");
    if (!old)
      publishArtifact(root, marker, JSON.stringify({ version: 1, initiativeId: request.initiativeId }) + "\n", false);
    const record: InitiativeRecord = request.recoveryOnly
      ? structuredClone(old!.record)
      : {
          version: 1,
          initiativeId: request.initiativeId,
          generation: (old?.record.generation ?? 0) + 1,
          owner: { ...request.owner },
          state: "owned",
          tasks: structuredClone(old?.record.tasks ?? []),
        };
    if (!Number.isSafeInteger(record.generation)) throw Error("initiative generation exhausted");
    let revision = initiativeRevision(record);
    if (!request.recoveryOnly) saveInitiative(path, root, record);
    let tail = Promise.resolve();
    const currentGuard = (authority: () => void | Promise<void>) => async () => {
      if (closed || failed || !lock.healthy()) throw Error("initiative coordinator is no longer current");
      await authority();
      if (
        closed ||
        failed ||
        !lock.healthy() ||
        readInitiativeState(directory, request.initiativeId)?.revision !== revision
      )
        throw Error("initiative coordinator generation or state changed");
    };
    const assertCurrent = currentGuard(() => options.assertAuthority());
    const assertObservationCurrent = currentGuard(() =>
      options.assertObservationAuthority ? options.assertObservationAuthority() : options.assertAuthority(),
    );
    const change = <T>(work: () => Promise<T>): Promise<T> => {
      const next = tail.then(work);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };
    const save = () => {
      try {
        saveInitiative(path, root, record);
        revision = initiativeRevision(record);
      } catch (error) {
        failed = true;
        throw error;
      }
    };
    const observeAttempts = async (task: InitiativeRecord["tasks"][number] | undefined) => {
      const states: Awaited<ReturnType<InitiativeResolution["resolveAttempt"]>>[] = [];
      const effects = [],
        receipts = [];
      // Retained attempts are bounded; never fan all historical filesystem checks out at once.
      for (const attempt of task?.attempts ?? []) {
        states.push(await options.resolveAttempt(structuredClone(attempt)));
        const receipt = await currentEffectReceipt(record.initiativeId, task!, attempt, options);
        receipts.push(receipt);
        effects.push(receiptResolves(task!, receipt));
      }
      return { states, effects, receipts };
    };
    const taskAt = (task: InitiativeTask) => {
      if (!validInitiativeTask(task)) throw Error("invalid initiative task");
      const found = record.tasks.find((t) => t.taskId === task.taskId && t.taskRevision === task.taskRevision);
      if (found && (found.effectScope !== task.effectScope || !sameEffectTarget(found.effectTarget, task.effectTarget)))
        throw Error("task effect scope or target changed without revision");
      return found;
    };
    return {
      generation: record.generation,
      recoveryOnly: request.recoveryOnly === true,
      revision: () => revision,
      metadata: () => ({
        initiativeId: record.initiativeId,
        generation: record.generation,
        knownSessions: new Set([
          record.owner.sessionId,
          ...record.tasks.flatMap((t) => t.attempts.map((a) => a.owner.sessionId)),
        ]).size,
        recordedTasks: record.tasks.length,
        recordedAttempts: record.tasks.reduce((n, t) => n + t.attempts.length, 0),
      }),
      assertCurrent,
      assertObservationCurrent,
      claim(task: InitiativeTask) {
        task = structuredClone(task);
        return change(async () => {
          await assertCurrent();
          if (request.recoveryOnly) throw Error("recovery-only owner cannot claim or dispatch");
          if (taskAt(task)?.generation === record.generation) return;
          const prior = record.tasks.filter((t) => t.taskId === task.taskId);
          if (!(await settled({ ...record, tasks: prior }))) throw Error("task prior attempts need reconciliation");
          await assertCurrent();
          const found = taskAt(task);
          if (found) found.generation = record.generation;
          else record.tasks.push({ ...structuredClone(task), generation: record.generation, attempts: [] });
          save();
        });
      },
      begin(task: InitiativeTask, operation: OperationRequest) {
        task = structuredClone(task);
        return change(async () => {
          await assertCurrent();
          if (request.recoveryOnly) throw Error("recovery-only owner cannot claim or dispatch");
          const found = taskAt(task);
          if (!found || found.generation !== record.generation || !validOperationId(operation.operationId))
            throw Error("initiative task is not claimed by current generation");
          await assertTaskPriorSettled(record, task, options);
          await assertCurrent();
          const all = record.tasks.flatMap((t) => t.attempts);
          if (
            all.some(
              (a) =>
                a.owner.sessionId === request.owner.sessionId &&
                a.owner.cwd === request.owner.cwd &&
                a.operationId === operation.operationId,
            )
          )
            throw Error("initiative operation already associated");
          found.attempts.push({
            owner: { ...request.owner },
            operationId: operation.operationId,
            executionId: operation.executionId,
            requestDigest: operation.requestDigest,
            state: "pending",
          });
          save();
        });
      },
      async assertPriorAttemptsSettled(task: InitiativeTask, operation: OperationRequest) {
        task = structuredClone(task);
        operation = { ...operation };
        const captured = revision;
        await assertCurrent();
        const found = taskAt(task);
        const attempt = found?.attempts.find(
          (a) =>
            a.owner.sessionId === request.owner.sessionId &&
            a.owner.cwd === request.owner.cwd &&
            a.operationId === operation.operationId &&
            a.executionId === operation.executionId &&
            a.requestDigest === operation.requestDigest,
        );
        if (
          request.recoveryOnly ||
          !found ||
          found.generation !== record.generation ||
          !attempt ||
          attempt.state === "not-admitted"
        )
          throw Error("exact admitted initiative attempt required before start");
        await assertTaskPriorSettled(record, task, options, attempt);
        await assertCurrent();
        if (revision !== captured) throw Error("initiative changed before start");
      },
      notAdmitted(operation: OperationRequest) {
        return change(async () => {
          await assertCurrent();
          const a = record.tasks
            .flatMap((t) => t.attempts)
            .find(
              (a) =>
                a.owner.sessionId === request.owner.sessionId &&
                a.owner.cwd === request.owner.cwd &&
                a.operationId === operation.operationId &&
                a.executionId === operation.executionId,
            );
          if (!a) throw Error("initiative attempt missing");
          a.state = "not-admitted";
          save();
        });
      },
      async observe(
        input: InitiativeTaskIdentity,
        selectedTask?: InitiativeTask,
      ): Promise<InitiativeObservation | { status: "unavailable" }> {
        input = structuredClone(input);
        selectedTask = selectedTask ? structuredClone(selectedTask) : undefined;
        if (input.initiativeId !== record.initiativeId) return { status: "unavailable" };
        const captured = revision;
        await assertObservationCurrent();
        const task = record.tasks.find((t) => t.taskId === input.taskId && t.taskRevision === input.taskRevision);
        if (!task && !selectedTask && record.tasks.some((t) => t.taskId === input.taskId))
          return { status: "unavailable" };
        if (
          selectedTask &&
          (!validInitiativeTask(selectedTask) ||
            selectedTask.taskId !== input.taskId ||
            selectedTask.taskRevision !== input.taskRevision ||
            (task &&
              (task.effectScope !== selectedTask.effectScope ||
                !sameEffectTarget(task.effectTarget, selectedTask.effectTarget))))
        )
          return { status: "unavailable" };
        const { states, effects, receipts } = await observeAttempts(task);
        const prior = record.tasks.filter((t) => t.taskId === input.taskId && t !== task);
        const priorCurrent = await settled({ ...record, tasks: prior });
        const target = task?.effectTarget ?? selectedTask?.effectTarget;
        const observedEffect = effectObservation(target, task?.attempts.at(-1), states.at(-1), receipts.at(-1));
        await assertObservationCurrent();
        if (captured !== revision) return { status: "unavailable" };
        const unresolved =
          !priorCurrent ||
          states.some((status, i) => status === "unknown" || (status !== "not-started" && !effects[i]));
        return {
          status: "observed",
          ...input,
          ownerGeneration: record.generation,
          claim: unresolved
            ? "uncertain"
            : !task || (!request.recoveryOnly && task.generation !== record.generation && !states.includes("running"))
              ? "unclaimed"
              : !request.recoveryOnly && task.generation === record.generation
                ? "owned"
                : "other-owner",
          execution: states.includes("unknown")
            ? "unknown"
            : states.includes("running")
              ? "running"
              : states.length
                ? "settled"
                : "none",
          reconciliationRequired: unresolved,
          ...(observedEffect ? { effectObservation: observedEffect } : {}),
          async assertCurrent() {
            await assertObservationCurrent();
            const {
              states: currentStates,
              effects: currentEffects,
              receipts: currentReceipts,
            } = await observeAttempts(task);
            const currentEffect = effectObservation(
              target,
              task?.attempts.at(-1),
              currentStates.at(-1),
              currentReceipts.at(-1),
            );
            const priorStillCurrent = await settled({ ...record, tasks: prior });
            await assertObservationCurrent();
            if (
              revision !== captured ||
              priorStillCurrent !== priorCurrent ||
              JSON.stringify(currentStates) !== JSON.stringify(states) ||
              JSON.stringify(currentEffects) !== JSON.stringify(effects) ||
              JSON.stringify(currentEffect) !== JSON.stringify(observedEffect)
            )
              throw Error("initiative observation changed");
          },
        };
      },
      /** Bind a final to the only admitted attempt for this exact selected task revision. */
      async handoffAttempt(identity: InitiativeTaskIdentity, selectedTask: InitiativeTask) {
        if (request.recoveryOnly || identity.initiativeId !== record.initiativeId) return;
        const observation = await this.observe(identity, selectedTask);
        if (
          observation.status !== "observed" ||
          observation.execution !== "settled" ||
          observation.reconciliationRequired
        )
          return;
        const attempts = taskAt(selectedTask)?.attempts.filter((attempt) => attempt.state !== "not-admitted");
        // A task with several admitted operations needs an explicit output choice.
        if (attempts?.length !== 1) return;
        await observation.assertCurrent();
        return { attempt: structuredClone(attempts[0]!), assertCurrent: observation.assertCurrent };
      },
      async pendingEffects() {
        const captured = revision;
        await assertCurrent();
        const pending = [];
        for (const task of record.tasks)
          for (const attempt of task.attempts) {
            if (task.effectScope === "local") continue;
            const execution = await options.resolveAttempt(structuredClone(attempt));
            if (execution !== "not-started" && !(await effectCurrent(record.initiativeId, task, attempt, options)))
              pending.push({
                ...effectIdentity(record.initiativeId, task, attempt),
                execution,
                ...(task.effectTarget ? { effectTarget: structuredClone(task.effectTarget) } : {}),
              });
          }
        await assertCurrent();
        if (captured !== revision) throw Error("initiative observation changed");
        return pending;
      },
      reconcileEffect(input: InitiativeEffectReconciliation) {
        input = structuredClone(input);
        return change(async () => {
          await assertCurrent();
          const { task, attempt } = exactEffect(record, input);
          if (!options.assertEffectReconciled) throw Error("trusted receipt verifier unavailable");
          if ((await options.resolveAttempt(structuredClone(attempt))) !== "settled")
            throw Error("native attempt settlement required");
          await options.assertEffectReconciled({
            ...effectIdentity(record.initiativeId, task, attempt),
            receipt: structuredClone(input.receipt),
          });
          await assertCurrent();
          if ((await options.resolveAttempt(structuredClone(attempt))) !== "settled")
            throw Error("native attempt settlement changed");
          await options.assertEffectReconciled({
            ...effectIdentity(record.initiativeId, task, attempt),
            receipt: structuredClone(input.receipt),
          });
          await assertCurrent();
          attempt.effectReceipt = structuredClone(input.receipt);
          save();
          const observed = effectObservation(task.effectTarget, attempt, "settled", input.receipt);
          return {
            reconciled: receiptResolves(task, input.receipt),
            taskAccepted: false,
            executionAuthorized: false,
            ...(observed ? { effectObservation: observed } : {}),
          };
        });
      },
      release() {
        return change(async () => {
          await assertCurrent();
          if (!(await settled(record))) throw Error("initiative reconciliation required before release");
          await assertCurrent();
          record.state = "released";
          save();
          closed = true;
          await lock.release();
        });
      },
      /** Abandon only cooperative ownership; unresolved attempts remain durable and block takeover. */
      async close() {
        closed = true;
        await lock.release();
      },
    };
  } catch (error) {
    await lock.release();
    throw error;
  }
}
export type InitiativeCoordinator = Awaited<ReturnType<typeof acquireInitiativeCoordinator>>;
