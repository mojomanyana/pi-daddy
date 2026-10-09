/** Trusted extension event bridge. Tool calls and model-produced text cannot supply runtime facts. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { openRuntimeSettlement, settlementHash } from "../src/governance/runtime-settlement.ts";
import { reconcileDelegationCapacity } from "./session-capacity.ts";
import { agentDir } from "../src/kernel/project-paths.ts";
import type { GrantsSession } from "./session.ts";
export const OPERATION_STATUS_EVENT = "pi-daddy:operation-status:v1";
export const RUNTIME_SNAPSHOT_EVENT = "pi-daddy:runtime-snapshot:v1";
export function registerRuntimeSnapshot(
  pi: ExtensionAPI,
  session: GrantsSession,
): {
  bind(ctx: ExtensionContext): Promise<void>;
} {
  let bound: { sessionId: string; cwd: string; lifecycle: object } | undefined, problem: string | undefined;
  const generation = {};
  let bindSequence = 0;
  const unsubscribeRuntime = pi.events?.on?.(RUNTIME_SNAPSHOT_EVENT, (input: unknown) => {
    const request = input as {
      version?: number;
      requestId?: string;
      sessionId?: string;
      cwd?: string;
      reply?: (value: unknown) => void;
    };
    if (
      request?.version !== 1 ||
      typeof request.requestId !== "string" ||
      request.requestId.length > 512 ||
      typeof request.reply !== "function"
    )
      return;
    if (bound && session.reloadLifecycle.runtimeSnapshotGeneration !== generation) return;
    void (async () => {
      const current = bound,
        lifecycle = session.reloadLifecycle;
      const unavailable = (reason: string) => ({
        version: 1,
        requestId: request.requestId,
        sessionId: current?.sessionId ?? "",
        cwd: current?.cwd ?? "",
        ownerScope: "",
        ownerId: "",
        backend: session.executor.kind,
        qualified: false,
        state: "unknown",
        evidenceDigest: settlementHash({ reason }),
        settledExecutionIds: [],
        outstandingExecutionIds: [],
        reason,
      });
      if (
        !current ||
        current.lifecycle !== lifecycle ||
        request.sessionId !== current.sessionId ||
        request.cwd !== current.cwd ||
        !lifecycle.runtimeSettlement
      ) {
        request.reply!(unavailable(problem ?? "runtime owner is not ready"));
        return;
      }
      try {
        if (Array.isArray(session.capacity.retainedReservations)) await reconcileDelegationCapacity(session);
        const snapshot = await lifecycle.runtimeSettlement.snapshot();
        if (
          bound !== current ||
          session.reloadLifecycle !== lifecycle ||
          lifecycle.runtimeSnapshotGeneration !== generation
        ) {
          request.reply!(unavailable("runtime owner changed during snapshot"));
          return;
        }
        const qualified = !session.executor.refusal && !session.discoveryCleanupFailure && !session.capacityRefusal;
        request.reply!({
          version: 1,
          requestId: request.requestId,
          sessionId: current.sessionId,
          cwd: current.cwd,
          ...snapshot,
          backend: session.executor.kind,
          qualified,
          state: !qualified
            ? "unknown"
            : session.capacity.reserved > 0 && snapshot.state === "idle"
              ? "busy"
              : snapshot.state,
          ...(problem ? { reason: problem } : {}),
        });
      } catch (error) {
        request.reply!(unavailable(String(error)));
      }
    })().catch(() => undefined);
  });
  const unsubscribeOperations = pi.events?.on?.(OPERATION_STATUS_EVENT, (input: unknown) => {
    const request = input as {
      version?: number;
      requestId?: string;
      sessionId?: string;
      cwd?: string;
      operationId?: string;
      reply?: (value: unknown) => void;
    };
    if (
      request?.version !== 1 ||
      typeof request.requestId !== "string" ||
      request.requestId.length > 512 ||
      typeof request.operationId !== "string" ||
      typeof request.reply !== "function"
    )
      return;
    if (bound && session.reloadLifecycle.runtimeSnapshotGeneration !== generation) return;
    void (async () => {
      const current = bound,
        lifecycle = session.reloadLifecycle;
      const envelope = {
        version: 1,
        requestId: request.requestId,
        sessionId: current?.sessionId ?? "",
        cwd: current?.cwd ?? "",
        operationId: request.operationId,
      };
      if (
        !current ||
        current.lifecycle !== lifecycle ||
        request.sessionId !== current.sessionId ||
        request.cwd !== current.cwd ||
        !session.ownerBound ||
        !session.autoMode?.operations
      ) {
        request.reply!({ ...envelope, qualified: false, operation: null, reason: "operation owner is not ready" });
        return;
      }
      try {
        const operation = await session.autoMode.operations.read(request.operationId!);
        if (
          bound !== current ||
          session.reloadLifecycle !== lifecycle ||
          lifecycle.runtimeSnapshotGeneration !== generation
        )
          throw Error("operation owner changed during read");
        request.reply!({ ...envelope, qualified: true, operation });
      } catch (error) {
        request.reply!({ ...envelope, qualified: false, operation: null, reason: String(error) });
      }
    })().catch(() => undefined);
  });
  const unsubscribe = () => {
    unsubscribeRuntime?.();
    unsubscribeOperations?.();
  };
  return {
    async bind(ctx) {
      const sequence = ++bindSequence,
        lifecycle = session.reloadLifecycle;
      lifecycle.runtimeSettlement = undefined;
      bound = undefined;
      problem = undefined;
      try {
        const sessionId = ctx.sessionManager.getSessionId(),
          cwd = await realpath(ctx.cwd);
        if (sequence !== bindSequence || session.reloadLifecycle !== lifecycle) return;
        if (lifecycle.runtimeSnapshotUnsubscribe !== unsubscribe) lifecycle.runtimeSnapshotUnsubscribe?.();
        lifecycle.runtimeSnapshotUnsubscribe = unsubscribe;
        lifecycle.runtimeSnapshotGeneration = generation;
        lifecycle.runtimeSettlements ??= new Map();
        const key = JSON.stringify([sessionId, cwd]);
        let runtime = lifecycle.runtimeSettlements.get(key);
        if (!runtime) {
          runtime = await openRuntimeSettlement(agentDir(), sessionId, cwd);
          lifecycle.runtimeSettlements.set(key, runtime);
        }
        if (sequence !== bindSequence || session.reloadLifecycle !== lifecycle) return;
        lifecycle.runtimeSettlement = runtime;
        bound = { sessionId, cwd, lifecycle: session.reloadLifecycle };
      } catch (error) {
        if (sequence === bindSequence && session.reloadLifecycle === lifecycle) problem = String(error);
      }
    },
  };
}
