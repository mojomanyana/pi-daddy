/** Trusted in-process optional consumer bridge. No model-callable path or authority argument. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OperationArtifactOwner, OperationArtifactRef } from "../src/kernel/operation-artifact.ts";
import { readOperationArtifact } from "../src/governance/operation-artifacts.ts";
import { openOperationArtifactScan, operationArtifactInstance } from "../src/governance/operation-artifact-scan.ts";
export const OPERATION_ARTIFACTS_EVENT = "pi-daddy:operation-artifacts:v1";
export const OPERATION_ARTIFACT_READY_EVENT = "pi-daddy:operation-artifact-ready:v1";
export interface ArtifactBridgeOwner {
  owner: OperationArtifactOwner;
  agentDirectory: string;
}
export function registerArtifactBridge(pi: ExtensionAPI, current: () => ArtifactBridgeOwner | undefined) {
  let scan: ReturnType<typeof openOperationArtifactScan> | undefined,
    cursor: string | undefined,
    scanOwner: ArtifactBridgeOwner | undefined;
  const reset = () => {
    scan?.close();
    scan = undefined;
    cursor = undefined;
    scanOwner = undefined;
  };
  const unsubscribe = pi.events?.on?.(OPERATION_ARTIFACTS_EVENT, (input: unknown) => {
    const r = input as {
      version?: number;
      requestId?: string;
      sessionId?: string;
      cwd?: string;
      action?: string;
      cursor?: string;
      limit?: number;
      reference?: OperationArtifactRef;
      producerInstance?: string;
      authorize?: () => Promise<void>;
      reply?: (v: unknown) => void;
    };
    if (
      r?.version !== 1 ||
      typeof r.requestId !== "string" ||
      r.requestId.length > 512 ||
      typeof r.reply !== "function" ||
      !["list", "read"].includes(r.action ?? "")
    )
      return;
    void (async () => {
      const selected = current(),
        envelope = { version: 1, requestId: r.requestId, sessionId: r.sessionId, cwd: r.cwd };
      let failure: "owner-unavailable" | "authority" | "source-changed" | "not-found" | "unavailable" = "unavailable";
      const check = () => {
        if (
          !selected ||
          current() !== selected ||
          r.sessionId !== selected.owner.sessionId ||
          r.cwd !== selected.owner.cwd
        ) {
          failure = "owner-unavailable";
          throw Error("owner unavailable");
        }
      };
      try {
        check();
        const producerInstance = operationArtifactInstance(selected!.agentDirectory);
        if (r.action === "list") {
          if (r.cursor) {
            if (r.cursor !== cursor || scanOwner !== selected) throw Error("cursor unavailable");
          } else {
            reset();
            scan = openOperationArtifactScan(selected!.agentDirectory, selected!.owner);
            cursor = randomUUID();
            scanOwner = selected;
          }
          const page = scan!.next(r.limit);
          check();
          const next = page.complete ? undefined : cursor;
          if (page.complete) reset();
          r.reply!({ ...envelope, ok: true, producerInstance, ...page, ...(next ? { cursor: next } : {}) });
          return;
        }
        if (r.action !== "read" || !r.reference) throw Error("invalid request");
        if (r.producerInstance !== undefined && r.producerInstance !== producerInstance) {
          failure = "source-changed";
          throw Error("source instance changed");
        }
        const historical =
          r.reference.owner.sessionId !== selected!.owner.sessionId || r.reference.owner.cwd !== selected!.owner.cwd;
        if (historical && typeof r.authorize !== "function") {
          failure = "authority";
          throw Error("historical authority absent");
        }
        try {
          await r.authorize?.();
        } catch {
          failure = "authority";
          throw Error("authority changed");
        }
        check();
        const value = readOperationArtifact(r.reference, { agentDirectory: selected!.agentDirectory });
        try {
          await r.authorize?.();
        } catch {
          failure = "authority";
          throw Error("authority changed");
        }
        check();
        r.reply!({ ...envelope, ok: true, producerInstance, ...value });
      } catch (error) {
        if (failure === "unavailable" && (error as NodeJS.ErrnoException).code === "ENOENT") failure = "not-found";
        if (
          failure === "unavailable" &&
          error instanceof Error &&
          error.message === "operation artifact content identity mismatch"
        )
          failure = "source-changed";
        r.reply!({
          ...envelope,
          ok: false,
          code: failure,
          reason: "producer reference unavailable or authority changed",
        });
      }
    })().catch(() => undefined);
  });
  return {
    reset,
    close() {
      reset();
      unsubscribe?.();
    },
  };
}
