/** Install LAST: observe final extension-transformed Pi events through the private inherited pipe. */
import { fstatSync } from "node:fs";
import { Socket } from "node:net";
import { getAgentDir, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

import { OWNED_PI_VIEW_READY, failOwnedPiUi as fail } from "./owned-pi-view.ts";

const EVENT_FD = 6;

export default function ownedPiUi(pi: ExtensionAPI): void {
  try {
    const channel = fstatSync(EVENT_FD);
    if (!channel.isFIFO() && !channel.isSocket()) throw Error("fd 6 is not an inherited event pipe");
    const output = new Socket({ fd: EVENT_FD, readable: false, writable: true });
    output.on("error", fail);
    let pending = Promise.resolve();
    const send = (event: unknown): Promise<void> => {
      let record: string;
      try {
        record = JSON.stringify(event) + "\n";
      } catch (error) {
        return fail(error);
      }
      pending = pending
        .then(
          () =>
            new Promise<void>((resolve) => {
              output.write(record, (error) => (error ? fail(error) : resolve()));
            }),
        )
        .catch(fail);
      return pending;
    };
    // Keep the previous noninteractive trust policy; native UI must not introduce a blocking trust dialog.
    pi.on("project_trust", (event) => {
      try {
        const agentDir = getAgentDir();
        const remembered = new ProjectTrustStore(agentDir).get(event.cwd);
        const trusted =
          remembered ??
          SettingsManager.create(event.cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always";
        return { trusted: trusted ? "yes" : "no", remember: false };
      } catch (error) {
        return fail(error);
      }
    });
    let guardedSession: { sessionManager: unknown; sessionId: unknown } | undefined;
    pi.events.on(OWNED_PI_VIEW_READY, (ready) => {
      if (ready && typeof ready === "object" && "sessionManager" in ready && "sessionId" in ready)
        guardedSession = { sessionManager: ready.sessionManager, sessionId: ready.sessionId };
    });
    let started = false;
    pi.on("session_start", (_event, ctx) => {
      try {
        if (started) throw Error("the owned session cannot be replaced");
        if (
          ctx.mode !== "tui" ||
          guardedSession?.sessionManager !== ctx.sessionManager ||
          guardedSession.sessionId !== ctx.sessionManager.getSessionId()
        )
          throw Error("the native Pi view guard is not ready for this session");
        const header = ctx.sessionManager.getHeader();
        if (
          !header ||
          header.type !== "session" ||
          header.version !== 3 ||
          header.id !== ctx.sessionManager.getSessionId()
        )
          throw Error("missing or mismatched actual Pi session header");
        started = true;
        return send(header);
      } catch (error) {
        return fail(error);
      }
    });
    const forward = (event: unknown): Promise<void> => {
      if (!started) fail("Pi event arrived before the guarded session");
      return send(event);
    };
    pi.on("agent_start", forward);
    pi.on("agent_end", forward);
    pi.on("turn_start", forward);
    pi.on("turn_end", forward);
    pi.on("message_start", forward);
    pi.on("message_end", forward);
    pi.on("tool_execution_start", forward);
    pi.on("tool_execution_update", forward);
    pi.on("tool_execution_end", forward);
    pi.on("message_update", (event: MessageUpdateEvent) => {
      // Match Pi's JSON delta projection without copying growing partial-message snapshots.
      if (event.message.role !== "assistant") fail("message_update is not an assistant message");
      const usage = event.message.usage,
        update = event.assistantMessageEvent;
      if (!("partial" in update)) return forward({ type: event.type, usage, assistantMessageEvent: update });
      const { partial, ...delta } = update;
      if (update.type === "toolcall_start") {
        const tool = partial.content[update.contentIndex];
        if (tool?.type !== "toolCall") fail("toolcall_start lacks its actual tool call");
        return forward({
          type: event.type,
          usage,
          assistantMessageEvent: { ...delta, id: tool.id, toolName: tool.name },
        });
      }
      return forward({ type: event.type, usage, assistantMessageEvent: delta });
    });
    pi.on("agent_settled", async (event, ctx) => {
      await forward(event);
      // The pipe has flushed before orderly shutdown; native receipt/session checks remain authoritative.
      ctx.shutdown();
    });
  } catch (error) {
    fail(error);
  }
}
