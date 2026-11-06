import { initiativeDashboard } from "./initiative-dashboard.ts";
/** Trusted selected-work-map connector. A selection permits association only, never dispatch or tool authority. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { agentDir } from "../src/kernel/project-paths.ts";
import { validOperationId, type OperationRequest } from "../src/kernel/dispatch-operation.ts";
import {
  validInitiativeTask,
  type InitiativeTask,
  type InitiativeTaskIdentity,
  type InitiativeEffectReconciliation,
} from "../src/kernel/initiative.ts";
import { readInitiativeState } from "../src/governance/initiative-state.ts";
import { acquireInitiativeCoordinator, type InitiativeCoordinator } from "../src/governance/initiative-coordinator.ts";
import { openOperationArtifacts } from "../src/governance/operation-artifacts.ts";
import { readRuntimeExecutionSettlement } from "../src/governance/runtime-settlement.ts";
import type { GrantsSession } from "./session.ts";
export const INITIATIVE_EVENT = "pi-daddy:initiative:v1";
export interface InitiativeOperationBinding {
  capture(request: OperationRequest):
    | {
        begin(): Promise<void>;
        assertCurrent(scope?: { cwd: string; workspaceId: string | null }): Promise<void>;
        notAdmitted(): Promise<void>;
      }
    | undefined;
}
type Owner = { sessionId: string; cwd: string; lifecycle: object };
export function registerInitiativeRuntime(
  pi: ExtensionAPI,
  session: GrantsSession,
  currentOwner: () => Owner | undefined,
) {
  // Optional composition is unavailable on minimal/legacy hosts; ordinary Daddy startup remains valid.
  if (typeof pi.events?.on !== "function") return { async reset() {}, async close() {} };
  let selected:
    | {
        initiativeId: string;
        owner: Owner;
        coordinator: InitiativeCoordinator;
        tasks: InitiativeTask[];
        dashboard: ReturnType<typeof initiativeDashboard>;
        associations: Map<string, InitiativeTask>;
        assertSelection(): void | Promise<void>;
        assertTaskReady(task: { taskId: string; taskRevision: string }): void | Promise<void>;
        assertExecutionScope?: (scope: {
          taskId: string;
          taskRevision: string;
          cwd: string;
          workspaceId: string | null;
        }) => void | Promise<void>;
      }
    | undefined;
  let selectionEpoch = 0;
  let lastDisplay: { owner: Owner; dashboard: ReturnType<typeof initiativeDashboard> } | undefined;
  session.dashboardInitiative = () =>
    currentOwner() === lastDisplay?.owner ? lastDisplay?.dashboard.snapshot() : undefined;
  session.refreshInitiative = () => {
    selected?.dashboard.invalidate();
    void selected?.dashboard.refresh().catch(() => undefined);
  };
  const stillSelected = async (s: NonNullable<typeof selected>) => {
    if (selected !== s || currentOwner() !== s.owner) throw Error("initiative selection changed");
    try {
      // The coordinator invokes this selection's same bound assertAuthority callback, with generation checks.
      await s.coordinator.assertCurrent();
    } catch (error) {
      s.dashboard.invalidate();
      throw error;
    }
    if (selected !== s || currentOwner() !== s.owner) throw Error("initiative selection changed");
  };
  const stillObserved = async (s: NonNullable<typeof selected>) => {
    if (selected !== s || currentOwner() !== s.owner) throw Error("initiative selection changed");
    try {
      await s.coordinator.assertObservationCurrent();
    } catch (error) {
      s.dashboard.invalidate();
      throw error;
    }
    if (selected !== s || currentOwner() !== s.owner) throw Error("initiative selection changed");
  };
  const associate = async (
    s: NonNullable<typeof selected>,
    input: InitiativeTaskIdentity & { operationId: string },
  ) => {
    await stillSelected(s);
    if (s.coordinator.recoveryOnly)
      throw Error("Recovery-only owner cannot associate or dispatch; reconcile then release and acquire.");
    const task = s.tasks.find((t) => t.taskId === input.taskId && t.taskRevision === input.taskRevision);
    if (input.initiativeId !== s.initiativeId || !task || !validOperationId(input.operationId))
      throw Error("task is outside the selected work map");
    await s.assertTaskReady({ taskId: task.taskId, taskRevision: task.taskRevision });
    await stillSelected(s);
    const previous = s.associations.get(input.operationId);
    if (previous && (previous.taskId !== task.taskId || previous.taskRevision !== task.taskRevision))
      throw Error("operation is already associated with another task");
    await s.coordinator.claim(task);
    await stillSelected(s);
    if (s.associations.size >= 1024 && !previous) throw Error("initiative association bound reached");
    const currentAssociation = s.associations.get(input.operationId);
    if (
      currentAssociation &&
      (currentAssociation.taskId !== task.taskId || currentAssociation.taskRevision !== task.taskRevision)
    )
      throw Error("operation association changed concurrently");
    s.associations.set(input.operationId, task);
    await s.dashboard.refresh();
    return {
      associated: true,
      ownerGeneration: s.coordinator.generation,
      operationId: input.operationId,
      taskId: task.taskId,
      taskRevision: task.taskRevision,
      dispatchStarted: false,
      executionAuthorized: false,
    };
  };
  const binding: InitiativeOperationBinding = {
    capture(request) {
      const s = selected,
        task = s?.associations.get(request.operationId);
      if (!s || !task) return undefined;
      return {
        async begin() {
          await stillSelected(s);
          await s.assertTaskReady({ taskId: task.taskId, taskRevision: task.taskRevision });
          await stillSelected(s);
          await s.coordinator.begin(task, request);
          await stillSelected(s);
        },
        async assertCurrent(scope) {
          await stillSelected(s);
          await s.assertTaskReady({ taskId: task.taskId, taskRevision: task.taskRevision });
          await stillSelected(s);
          if (scope) {
            if (!s.assertExecutionScope) throw Error("trusted execution scope unavailable");
            await s.assertExecutionScope({ taskId: task.taskId, taskRevision: task.taskRevision, ...scope });
            await stillSelected(s);
            await s.coordinator.assertPriorAttemptsSettled(task, request);
            await stillSelected(s);
          }
        },
        notAdmitted: () => s.coordinator.notAdmitted(request),
      };
    },
  };
  session.initiativeOperations = binding;
  const off = pi.events.on(INITIATIVE_EVENT, (value: unknown) => {
    const r = value as {
      version?: number;
      requestId?: string;
      action?: string;
      sessionId?: string;
      cwd?: string;
      initiativeId?: string;
      expectedRevision?: string | null;
      tasks?: InitiativeTask[];
      assertSelection?: () => void | Promise<void>;
      assertObservationAuthority?: () => void | Promise<void>;
      assertExecutionScope?: (scope: {
        taskId: string;
        taskRevision: string;
        cwd: string;
        workspaceId: string | null;
      }) => void | Promise<void>;
      assertEffectReconciled?: (input: InitiativeEffectReconciliation) => void | Promise<void>;
      assertTaskReady?: (task: { taskId: string; taskRevision: string }) => void | Promise<void>;
      reply?: (value: unknown) => void;
    };
    if (
      r?.version !== 1 ||
      typeof r.requestId !== "string" ||
      r.requestId.length > 512 ||
      typeof r.reply !== "function"
    )
      return;
    void (async () => {
      const owner = currentOwner();
      if (!owner || r.sessionId !== owner.sessionId || r.cwd !== owner.cwd) throw Error("initiative owner unavailable");
      const envelope = {
        version: 1,
        requestId: r.requestId,
        sessionId: owner.sessionId,
        cwd: owner.cwd,
        initiativeId: r.initiativeId,
      };
      if (r.action === "status") {
        const snapshot = readInitiativeState(agentDir(), r.initiativeId!);
        r.reply!({
          ...envelope,
          ok: true,
          revision: snapshot?.revision ?? null,
          generation: snapshot?.record.generation ?? null,
          state: snapshot?.record.state ?? "absent",
        });
        return;
      }
      if (
        !["acquire", "recover"].includes(r.action ?? "") ||
        typeof r.assertSelection !== "function" ||
        typeof r.assertTaskReady !== "function" ||
        (r.assertObservationAuthority !== undefined && typeof r.assertObservationAuthority !== "function") ||
        (r.action === "acquire" && typeof r.assertExecutionScope !== "function") ||
        !Array.isArray(r.tasks) ||
        !r.tasks.length ||
        r.tasks.length > 256 ||
        !r.tasks.every(validInitiativeTask) ||
        new Set(r.tasks.map((t) => t.taskId)).size !== r.tasks.length ||
        !(r.expectedRevision === null || typeof r.expectedRevision === "string")
      )
        throw Error("invalid selected initiative request");
      if (selected) throw Error("release the current initiative before selecting another");
      const epoch = ++selectionEpoch,
        assertSelection = r.assertSelection;
      const assertAuthority = async () => {
        if (selectionEpoch !== epoch || currentOwner() !== owner) throw Error("initiative owner changed");
        await assertSelection();
        if (selectionEpoch !== epoch || currentOwner() !== owner) throw Error("initiative owner changed");
      };
      const observeAuthority = r.assertObservationAuthority ?? assertSelection;
      const assertObservationAuthority = async () => {
        if (selectionEpoch !== epoch || currentOwner() !== owner) throw Error("initiative owner changed");
        await observeAuthority();
        if (selectionEpoch !== epoch || currentOwner() !== owner) throw Error("initiative owner changed");
      };
      const coordinator = await acquireInitiativeCoordinator(
        agentDir(),
        {
          initiativeId: r.initiativeId!,
          owner,
          expectedRevision: r.expectedRevision,
          recoveryOnly: r.action === "recover",
        },
        {
          assertAuthority,
          assertObservationAuthority,
          assertEffectReconciled:
            typeof r.assertEffectReconciled === "function"
              ? async (input) => {
                  await assertObservationAuthority();
                  await r.assertEffectReconciled!(structuredClone(input));
                  await assertObservationAuthority();
                }
              : undefined,
          async resolveAttempt(attempt) {
            const original = openOperationArtifacts(agentDir(), attempt.owner).history(attempt.operationId, false);
            if (!original) return attempt.state === "not-admitted" ? "not-started" : "unknown";
            if (
              original.operation.executionId !== attempt.executionId ||
              original.requestDigest !== attempt.requestDigest
            )
              return "unknown";
            if (
              original.operation.state === "not-started" &&
              original.operation.runtime?.cleanup?.state === "not-started"
            )
              return "not-started";
            const live =
              attempt.owner.sessionId === owner.sessionId && attempt.owner.cwd === owner.cwd
                ? await session.autoMode?.operations?.read(attempt.operationId)
                : undefined;
            if (live?.executionId === attempt.executionId && ["admitting", "running"].includes(live.state))
              return "running";
            try {
              return await readRuntimeExecutionSettlement(
                agentDir(),
                attempt.owner.sessionId,
                attempt.owner.cwd,
                attempt.executionId,
              );
            } catch {
              return "unknown";
            }
          },
        },
      );
      try {
        await assertAuthority();
      } catch (error) {
        await coordinator.close();
        throw error;
      }
      const s = {
        initiativeId: r.initiativeId!,
        owner,
        coordinator,
        tasks: structuredClone(r.tasks),
        dashboard: initiativeDashboard(coordinator, structuredClone(r.tasks)),
        associations: new Map<string, InitiativeTask>(),
        assertSelection,
        assertTaskReady: r.assertTaskReady!,
        assertExecutionScope: r.assertExecutionScope,
      };
      selected = s;
      lastDisplay = { owner, dashboard: s.dashboard };
      try {
        await s.dashboard.refresh();
        await stillSelected(s);
        r.reply!({
          ...envelope,
          ok: true,
          generation: coordinator.generation,
          recoveryOnly: coordinator.recoveryOnly,
          revision: coordinator.revision(),
          handle: {
            recoveryOnly: coordinator.recoveryOnly,
            pendingEffects: async () => {
              await stillSelected(s);
              return coordinator.pendingEffects();
            },
            reconcileEffect: async (input: InitiativeEffectReconciliation) => {
              await stillSelected(s);
              const result = await coordinator.reconcileEffect(input);
              await s.dashboard.refresh();
              return result;
            },
            associate: (input: InitiativeTaskIdentity & { operationId: string }) => associate(s, input),
            observe: async (input: InitiativeTaskIdentity) => {
              await stillObserved(s);
              const task = s.tasks.find((t) => t.taskId === input.taskId && t.taskRevision === input.taskRevision);
              if (!task) return { status: "unavailable" };
              const revision = coordinator.revision();
              try {
                const observed = await coordinator.observe(input, task);
                if (selected !== s || currentOwner() !== s.owner) throw Error("initiative selection changed");
                s.dashboard.record(input, observed, revision);
                await s.dashboard.refresh();
                return observed;
              } catch (error) {
                s.dashboard.invalidate(input);
                throw error;
              }
            },
            async release() {
              await stillSelected(s);
              await coordinator.release();
              if (selected === s) selected = undefined;
              s.dashboard.close();
            },
            async close() {
              s.dashboard.close();
              if (selected === s) {
                selected = undefined;
                ++selectionEpoch;
              }
              await coordinator.close();
            },
          },
        });
      } catch (error) {
        s.dashboard.close();
        if (selected === s) selected = undefined;
        await coordinator.close();
        throw error;
      }
    })().catch(() => {
      try {
        r.reply!({
          version: 1,
          requestId: r.requestId,
          sessionId: r.sessionId,
          cwd: r.cwd,
          initiativeId: r.initiativeId,
          ok: false,
          reason: "initiative unavailable, conflicted, or reconciliation required",
        });
      } catch {}
    });
  });
  if (session.mayDelegate)
    pi.registerTool?.({
      name: "initiative_task",
      label: "Associate initiative task",
      description:
        "Associate one exact task from the human-selected work map with a planned operation_id. Does not dispatch or grant permissions.",
      parameters: Type.Object({
        taskId: Type.String({ maxLength: 256 }),
        taskRevision: Type.String({ maxLength: 71 }),
        operationId: Type.String({ maxLength: 160 }),
      }),
      async execute(_id, args) {
        const s = selected;
        if (!s) throw Error("No trusted initiative selected. Select it with the work-map owner first.");
        const result = await associate(s, { ...args, initiativeId: s.initiativeId });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      },
    });
  return {
    async reset() {
      ++selectionEpoch;
      const old = selected;
      selected = undefined;
      old?.dashboard.close();
      await old?.coordinator.close();
    },
    async close() {
      off?.();
      ++selectionEpoch;
      const old = selected;
      selected = undefined;
      old?.dashboard.close();
      await old?.coordinator.close();
    },
  };
}
