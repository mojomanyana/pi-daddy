/** Trusted exact historical observation; the current requester never adopts the original operation owner. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readOperationHistory } from "../src/governance/operation-artifacts.ts";
import { validOperationId } from "../src/kernel/dispatch-operation.ts";
import { readOperationRecovery, type OperationRecoverySource } from "../src/governance/operation-recovery.ts";
import type { ArtifactBridgeOwner } from "./artifact-bridge.ts";

export const OPERATION_RECOVERY_EVENT = "pi-daddy:operation-recovery:v1";
export function registerOperationRecoveryBridge(pi: ExtensionAPI, current: () => ArtifactBridgeOwner | undefined) {
  let closed = false;
  const unsubscribe = pi.events?.on?.(OPERATION_RECOVERY_EVENT, (input: unknown) => {
    const r = input as {
      version?: number;
      requestId?: string;
      sessionId?: string;
      cwd?: string;
      source?: OperationRecoverySource;
      authorize?: () => Promise<void | boolean>;
      reply?: (value: unknown) => void;
    };
    if (
      r?.version !== 1 ||
      typeof r.requestId !== "string" ||
      r.requestId.length > 512 ||
      typeof r.reply !== "function"
    )
      return;
    const reply = r.reply;
    const envelope = { version: 1, requestId: r.requestId, sessionId: r.sessionId, cwd: r.cwd };
    void (async () => {
      const selected = current();
      let code: "owner-unavailable" | "invalid-source" | "authority" | "source-changed" = "owner-unavailable";
      let source: OperationRecoverySource | undefined;
      const check = () => {
        code = "owner-unavailable";
        if (
          closed ||
          !selected ||
          current() !== selected ||
          r.sessionId !== selected.owner.sessionId ||
          r.cwd !== selected.owner.cwd
        )
          throw Error("current owner unavailable");
      };
      try {
        check();
        code = "invalid-source";
        if (
          !r.source ||
          !validOperationId(r.source.operationId) ||
          typeof r.source.owner?.sessionId !== "string" ||
          !r.source.owner.sessionId ||
          r.source.owner.sessionId.length > 512 ||
          r.source.owner.cwd !== selected!.owner.cwd
        )
          throw Error("exact original owner in the selected workspace required");
        source = {
          owner: { sessionId: r.source.owner.sessionId, cwd: r.source.owner.cwd },
          operationId: r.source.operationId,
        };
        const authorize = r.authorize;
        const assertAuthority = async () => {
          code = "authority";
          if (typeof authorize !== "function" || (await authorize()) === false)
            throw Error("trusted current authority absent or changed");
          check();
        };
        await assertAuthority();
        code = "source-changed";
        const before = JSON.stringify(readOperationHistory(selected!.agentDirectory, source.owner, source.operationId));
        const observation = await readOperationRecovery(selected!.agentDirectory, source);
        if (observation.operation && observation.operation.cwd !== selected!.owner.cwd) {
          code = "invalid-source";
          throw Error("historical execution is outside the selected workspace");
        }
        await assertAuthority();
        code = "source-changed";
        if (JSON.stringify(readOperationHistory(selected!.agentDirectory, source.owner, source.operationId)) !== before)
          throw Error("historical source changed before disclosure");
        check();
        reply({ ...envelope, source, qualified: true, observation });
      } catch {
        reply({
          ...envelope,
          ...(source ? { source } : {}),
          qualified: false,
          code,
          reason:
            "Historical operation evidence is unavailable or current access changed; this inspection started no work.",
        });
      }
    })().catch(() => undefined);
  });
  return {
    close() {
      closed = true;
      unsubscribe?.();
    },
  };
}
