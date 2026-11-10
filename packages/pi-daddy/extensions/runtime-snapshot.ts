import { registerDashboardPrompts } from "./dashboard-ui-prompts.ts";
import { registerInitiativeRuntime } from "./initiative-runtime.ts";
import { registerDashboardLive } from "./dashboard-live.ts";
import { registerDashboardSources } from "./dashboard-sources.ts";
import { registerArtifactBridge, OPERATION_ARTIFACT_READY_EVENT, type ArtifactBridgeOwner } from "./artifact-bridge.ts";
import { operationHistory, operationArtifactReference } from "./delegation-artifacts.ts";
/** Trusted extension event bridge. Tool calls and model-produced text cannot supply runtime facts. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { openRuntimeSettlement, settlementHash } from "../src/governance/runtime-settlement.ts";
import { reconcileDelegationCapacity } from "./session-capacity.ts";
import { agentDir } from "../src/kernel/project-paths.ts";
import type { GrantsSession } from "./session.ts";
import { bindOperationFinals, operationFinal } from "./delegation-operations.ts";
export const OPERATION_HISTORY_EVENT = "pi-daddy:operation-history:v1";
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
  let artifactOwner: ArtifactBridgeOwner | undefined;
  const initiative = registerInitiativeRuntime(pi, session, () =>
    bound?.lifecycle === session.reloadLifecycle && session.reloadLifecycle.runtimeSnapshotGeneration === generation
      ? bound
      : undefined,
  );
  const dashboardSources = registerDashboardSources(pi, () =>
    bound?.lifecycle === session.reloadLifecycle && session.reloadLifecycle.runtimeSnapshotGeneration === generation
      ? bound
      : undefined,
  );
  session.dashboardObservations = () => dashboardSources.snapshot();
  session.dashboardChoices = dashboardSources.choices;
  session.dashboardLive = registerDashboardLive(pi, () =>
    bound?.lifecycle === session.reloadLifecycle && session.reloadLifecycle.runtimeSnapshotGeneration === generation
      ? bound
      : undefined,
  );
  const prompts = registerDashboardPrompts(pi, () =>
    bound?.lifecycle === session.reloadLifecycle && session.reloadLifecycle.runtimeSnapshotGeneration === generation
      ? bound
      : undefined,
  );
  session.dashboardPrompt = prompts.snapshot;
  session.dashboardArtifacts = [];

  const artifactBridge = registerArtifactBridge(pi, () =>
    artifactOwner &&
    bound?.lifecycle === session.reloadLifecycle &&
    session.reloadLifecycle.runtimeSnapshotGeneration === generation
      ? artifactOwner
      : undefined,
  );
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
      includeFinal?: boolean;
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
        const artifact = operation ? operationArtifactReference(session, operation) : undefined;
        request.reply!({
          ...envelope,
          qualified: true,
          operation: operation ? { ...operation, ...(artifact ? { artifact } : {}) } : null,
          ...(!operation
            ? { reason: "operation record is absent; this does not prove the dispatch was not started" }
            : {}),
          ...(request.includeFinal === true && operation ? { final: operationFinal(session, operation) } : {}),
        });
      } catch (error) {
        request.reply!({ ...envelope, qualified: false, operation: null, reason: String(error) });
      }
    })().catch(() => undefined);
  });
  const unsubscribeHistory = pi.events?.on?.(OPERATION_HISTORY_EVENT, (input: unknown) => {
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
    const current = bound;
    if (current && session.reloadLifecycle.runtimeSnapshotGeneration !== generation) return;
    const envelope = {
      version: 1,
      requestId: request.requestId,
      sessionId: current?.sessionId ?? "",
      cwd: current?.cwd ?? "",
      operationId: request.operationId,
      history: true,
    };
    if (
      !current ||
      current.lifecycle !== session.reloadLifecycle ||
      request.sessionId !== current.sessionId ||
      request.cwd !== current.cwd
    ) {
      request.reply({ ...envelope, operation: null, reason: "historical owner is not bound" });
      return;
    }
    try {
      const retained = operationHistory(session, request.operationId);
      request.reply({
        ...envelope,
        ...(retained ?? { operation: null, reason: "no retained operation; absence is not no-start proof" }),
      });
    } catch (error) {
      request.reply({ ...envelope, operation: null, reason: String(error) });
    }
  });
  const unsubscribe = () => {
    unsubscribeRuntime?.();
    unsubscribeOperations?.();
    unsubscribeHistory?.();
    artifactBridge.close();
    void initiative.close().catch(() => undefined);
    dashboardSources.close();
    prompts.close();
  };
  return {
    async bind(ctx) {
      prompts.reset();
      const sequence = ++bindSequence,
        lifecycle = session.reloadLifecycle;
      lifecycle.runtimeSettlement = undefined;
      bound = undefined;
      artifactOwner = undefined;
      artifactBridge.reset();
      await initiative.reset();
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
        bindOperationFinals(session, sessionId, cwd, (reference, description) => {
          if (
            bound?.sessionId === sessionId &&
            bound.cwd === cwd &&
            bound.lifecycle === lifecycle &&
            lifecycle.runtimeSnapshotGeneration === generation
          ) {
            session.refreshInitiative?.();
            session.dashboardArtifacts ??= [];
            if (
              !session.dashboardArtifacts.some(
                (item) => item.executionId === reference.executionId && item.sha256 === reference.manifest.sha256,
              )
            )
              session.dashboardArtifacts.push({
                operationId: reference.operationId,
                executionId: reference.executionId,
                sha256: reference.manifest.sha256,
                ...(description ? { description } : {}),
              });
            if (session.dashboardArtifacts.length > 16) session.dashboardArtifacts.shift();
            try {
              pi.appendEntry?.("pi-daddy:operation-artifact:v1", reference);
            } catch {
              /* recover from producer enumeration */
            }
            try {
              pi.events?.emit?.(OPERATION_ARTIFACT_READY_EVENT, { version: 1, reference });
            } catch {
              /* optional consumer cannot alter settled result */
            }
          }
        });
        session.dashboardArtifacts = [];
        bound = { sessionId, cwd, lifecycle: session.reloadLifecycle };
        artifactOwner = { owner: { sessionId, cwd }, agentDirectory: agentDir() };
      } catch (error) {
        if (sequence === bindSequence && session.reloadLifecycle === lifecycle) problem = String(error);
      }
    },
  };
}
