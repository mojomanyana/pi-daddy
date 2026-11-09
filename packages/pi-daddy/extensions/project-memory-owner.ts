/** In-process root Auto observation for Bookie's automatic workspace memory. No tools, vault paths or provider data. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { GrantsSession } from "./session.ts";

export const PROJECT_MEMORY_OWNER_EVENT = "pi-daddy:project-memory-owner-v1";
export const PROJECT_MEMORY_OWNER_REQUEST = "pi-daddy:request-project-memory-owner-v1";
export interface ProjectMemoryOwner {
  readonly version: 1;
  readonly sessionId: string;
  readonly cwd: string;
  isCurrent(): boolean;
}
export function registerProjectMemoryOwner(pi: Pick<ExtensionAPI, "events">, session: GrantsSession) {
  let lease: ProjectMemoryOwner | undefined;
  let generation: object | undefined;

  function publish(value: ProjectMemoryOwner) {
    try {
      pi.events?.emit?.(PROJECT_MEMORY_OWNER_EVENT, value);
    } catch {
      // Optional receivers must not prevent an Auto change or session shutdown.
    }
  }
  function withdraw() {
    const previous = lease;
    lease = undefined;
    if (previous) publish(previous);
  }
  function retire() {
    generation = undefined;
    withdraw();
  }
  const subscribe = () =>
    pi.events?.on?.(PROJECT_MEMORY_OWNER_REQUEST, (input: unknown) => {
      const request = input as Partial<Pick<ProjectMemoryOwner, "version" | "sessionId" | "cwd">> & {
        reply?: (value: ProjectMemoryOwner) => void;
      };
      if (
        lease?.isCurrent() &&
        request?.version === 1 &&
        request.sessionId === lease.sessionId &&
        request.cwd === lease.cwd &&
        typeof request.reply === "function"
      )
        request.reply(lease);
    });

  let unsubscribe: (() => void) | undefined = subscribe();
  return {
    begin(ctx: ExtensionContext) {
      unsubscribe ??= subscribe();
      const lifecycle = session.reloadLifecycle;
      retire();
      lifecycle.projectMemoryOwner?.retire();
      const token = {};
      generation = token;
      let ready = false;
      let sessionId: string | undefined;
      try {
        sessionId = ctx.sessionManager?.getSessionId?.();
      } catch {
        /* No verifiable native identity. */
      }
      const cwd = ctx.cwd;
      let workspace: { path: string; dev: bigint; ino: bigint; created: bigint } | undefined;
      function revision() {
        const state = lifecycle.autoMode;
        try {
          if (
            !ready ||
            generation !== token ||
            lifecycle.projectMemoryOwner?.retire !== retire ||
            session.reloadLifecycle !== lifecycle ||
            !session.ownerBound ||
            session.autoModeFailure ||
            session.depth !== 0 ||
            session.ownExecutionId ||
            session.malformedBounds.length ||
            ctx.mode !== "tui" ||
            !ctx.hasUI ||
            ctx.isProjectTrusted?.() !== true ||
            !sessionId ||
            ctx.sessionManager.getSessionId() !== sessionId ||
            session.cwd !== cwd ||
            ctx.cwd !== cwd ||
            !isAbsolute(cwd) ||
            !state?.authority ||
            state.nativeSessionId !== sessionId ||
            state.reader !== session.autoMode
          )
            return;
          const resolvedCwd = realpathSync.native(cwd);
          const identity = statSync(resolvedCwd, { bigint: true });
          if (!identity.isDirectory()) return;
          workspace ??= { path: resolvedCwd, dev: identity.dev, ino: identity.ino, created: identity.birthtimeNs };
          if (
            workspace.path !== resolvedCwd ||
            workspace.dev !== identity.dev ||
            workspace.ino !== identity.ino ||
            workspace.created !== identity.birthtimeNs
          )
            return;
          const snapshot = state.authority.snapshot();
          return snapshot.enabled ? snapshot.revision : undefined;
        } catch {
          return;
        }
      }
      function refresh() {
        if (generation !== token || lease?.isCurrent()) return;
        withdraw();
        const boundRevision = revision();
        if (boundRevision === undefined || !sessionId) return;
        const boundPolicy = lifecycle.autoMode;
        let expired = false;
        const next: ProjectMemoryOwner = Object.freeze({
          version: 1,
          sessionId,
          cwd,
          isCurrent: () => {
            if (lease !== next || lifecycle.autoMode !== boundPolicy || revision() !== boundRevision) expired = true;
            return !expired;
          },
        });
        lease = next;
        publish(next);
      }
      lifecycle.projectMemoryOwner = { retire, refresh };
      return () => {
        ready = true;
        refresh();
      };
    },
    close() {
      retire();
      if (session.reloadLifecycle.projectMemoryOwner?.retire === retire)
        delete session.reloadLifecycle.projectMemoryOwner;
      if (typeof unsubscribe === "function") unsubscribe();
      unsubscribe = undefined;
    },
  };
}
