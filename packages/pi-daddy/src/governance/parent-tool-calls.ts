/**
 * Parent-run tool calls on the session owner's socket: who may ask, and how one request is answered.
 *
 * The transport is not new. It is the owner socket every governed descendant already calls for live Auto policy
 * and dispatch operations (`auto-mode-policy.ts`): one authenticated JSON line in, one reply line out, and a held
 * connection whose loss cancels what it asked for. This module adds the one thing that socket did not need
 * before, which is **which child is asking**. Every descendant holds the same owner token, so a request must also
 * present the execution id of a child registered here and the key minted for that one execution.
 *
 * What runs the real tool is handed in (`ParentToolGrant.run`); this layer knows no Pi and no tool. A call lives
 * no longer than the child that asked: closing its registration or its connection cancels it, and the child's
 * own wall-clock bound therefore bounds the call.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import type { AutoModeRef } from "../kernel/auto-mode.ts";
import {
  MAX_PARENT_TOOL_REPLY_CHARS,
  PARENT_TOOL_REFUSALS,
  parseParentToolCall,
  parseParentToolReply,
  type ParentToolCall,
  type ParentToolReply,
} from "../kernel/parent-tools.ts";

/** One running child's permission to ask, registered when it is launched and removed when it settles. */
export interface ParentToolGrant {
  executionId: string;
  /** The tool names the plan delivered to this child. Nothing else can be asked for under this identity. */
  tools: readonly string[];
  /** Re-check the live conditions and run the real tool. The signal ends when the child, or the call, does. */
  run(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ParentToolReply>;
}

export interface ParentToolRegistration {
  /** The secret this execution must present. Travels to the child once, in its launch environment. */
  readonly key: string;
  /** Changes while a call is in flight, so a child waiting on its parent is not mistaken for an idle one. */
  activity(): string;
  /** The child has settled: refuse it from now on and cancel anything it left running. */
  close(): void;
}

export interface ParentToolCalls {
  register(grant: ParentToolGrant): ParentToolRegistration;
  /** Answer one request from the socket. Never rejects; every failure is a refusal. */
  handle(call: unknown, signal: AbortSignal): Promise<ParentToolReply>;
  close(): void;
}

const refused = (reason: string): ParentToolReply => ({ status: "refused", reason });

export function createParentToolCalls(): ParentToolCalls {
  interface Entry {
    grant: ParentToolGrant;
    key: Buffer;
    calls: number;
    inFlight?: AbortController;
  }
  const entries = new Map<string, Entry>();
  let closed = false;
  return {
    register(grant) {
      if (closed) throw new Error("the session owner is closed; no parent-run tool can be registered");
      if (entries.has(grant.executionId))
        throw new Error("a parent-run tool grant is already registered for this execution");
      const key = randomBytes(24).toString("hex");
      const entry: Entry = { grant, key: Buffer.from(key), calls: 0 };
      entries.set(grant.executionId, entry);
      return {
        key,
        activity: () => `${entry.calls}:${entry.inFlight ? Math.floor(Date.now() / 1000) : "idle"}`,
        close: () => {
          if (entries.get(grant.executionId) === entry) entries.delete(grant.executionId);
          entry.inFlight?.abort();
        },
      };
    },
    async handle(call, signal) {
      const request = parseParentToolCall(call);
      if ("refusal" in request) return refused(request.refusal);
      const entry = entries.get(request.executionId);
      const offered = Buffer.from(request.key);
      // One answer for an unknown, finished or impersonated child, so a probe learns nothing from the difference.
      if (!entry || offered.length !== entry.key.length || !timingSafeEqual(offered, entry.key))
        return refused(PARENT_TOOL_REFUSALS.unknownChild);
      if (!entry.grant.tools.includes(request.tool)) return refused(PARENT_TOOL_REFUSALS.notGranted);
      if (entry.inFlight) return refused(PARENT_TOOL_REFUSALS.busy);
      if (signal.aborted) return refused(PARENT_TOOL_REFUSALS.cancelled);
      const controller = new AbortController();
      entry.inFlight = controller;
      const stop = () => controller.abort();
      signal.addEventListener("abort", stop, { once: true });
      try {
        // Raced against cancellation: a tool that ignores its signal must not hold the reply or the slot.
        return await Promise.race([
          entry.grant.run(request.tool, request.arguments, controller.signal),
          new Promise<ParentToolReply>((resolve) =>
            controller.signal.addEventListener("abort", () => resolve(refused(PARENT_TOOL_REFUSALS.cancelled)), {
              once: true,
            }),
          ),
        ]);
      } catch {
        return refused(PARENT_TOOL_REFUSALS.failed);
      } finally {
        signal.removeEventListener("abort", stop);
        if (entry.inFlight === controller) entry.inFlight = undefined;
        entry.calls += 1;
      }
    },
    close() {
      closed = true;
      for (const entry of entries.values()) entry.inFlight?.abort();
      entries.clear();
    },
  };
}

const unavailable = () => new Error("the parent session is unavailable; the parent-run tool was not run");

/**
 * Ask the session owner to run one tool, from the child. The connection is held for the whole call: closing it
 * (the child was cancelled, or exited) is what cancels the call in the parent.
 */
export function callParentTool(
  reference: AutoModeRef,
  call: ParentToolCall,
  signal?: AbortSignal,
): Promise<ParentToolReply> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("parent-run tool call aborted"));
    const socket = createConnection(reference.socketPath);
    let output = "",
      settled = false;
    const finish = (error?: Error, value?: ParentToolReply) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const cancel = () => finish(new Error("parent-run tool call aborted"));
    signal?.addEventListener("abort", cancel, { once: true });
    socket.setEncoding("utf8");
    // Bounds connecting only. Once the request is sent, the call lives as long as the child's own bounds allow.
    socket.setTimeout(2000, () => finish(unavailable()));
    socket.once("error", () => finish(unavailable()));
    socket.once("connect", () => {
      socket.setTimeout(0);
      socket.write(JSON.stringify({ ...reference, action: "parent-tool", call }) + "\n");
    });
    socket.on("data", (chunk) => {
      output += chunk;
      if (output.length > MAX_PARENT_TOOL_REPLY_CHARS) finish(new Error("the parent-run tool reply is too large"));
    });
    socket.once("end", () => {
      let reply: { ok?: unknown; error?: unknown; value?: unknown };
      try {
        reply = JSON.parse(output);
      } catch {
        return finish(unavailable()); // The owner went away mid-reply, or never answered.
      }
      if (reply?.ok !== true)
        return finish(new Error(`the parent session refused the request (${String(reply?.error)})`));
      try {
        finish(undefined, parseParentToolReply(reply.value));
      } catch (error) {
        finish(error as Error);
      }
    });
    socket.once("close", () => finish(unavailable()));
  });
}
