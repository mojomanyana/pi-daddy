/** A held claim connection makes caller loss uncertain; another caller never inherits execution. */
import { createConnection, type Socket } from "node:net";
import type { AutoModeRef } from "../kernel/auto-mode.ts";
import type {
  OperationAccess,
  OperationClaim,
  OperationReference,
  OperationRequest,
} from "../kernel/dispatch-operation.ts";

export function connectDispatchOperations(reference: AutoModeRef): OperationAccess {
  const sockets = new Set<Socket>();
  let closed = false;
  const request = (
    action: string,
    input: object,
    signal?: AbortSignal,
    hold = false,
  ): Promise<{ value: any; socket: Socket }> =>
    new Promise((resolve, reject) => {
      if (closed || signal?.aborted) return reject(Error("Operation owner unavailable or request aborted"));
      const socket = createConnection(reference.socketPath);
      sockets.add(socket);
      let output = "",
        answered = false;
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const fail = (error: Error) => {
        cleanup();
        socket.destroy();
        if (!answered) {
          answered = true;
          reject(error);
        }
      };
      const abort = () => fail(Error("Operation request aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      socket.setEncoding("utf8");
      socket.setTimeout(2000, () => fail(Error("Operation owner unavailable")));
      socket.once("error", () => fail(Error("Operation owner unavailable")));
      socket.once("connect", () => socket.write(JSON.stringify({ ...reference, action, ...input }) + "\n"));
      socket.once("close", () => {
        sockets.delete(socket);
        cleanup();
        if (!answered) fail(Error("Operation owner disconnected"));
      });
      socket.on("data", (chunk) => {
        if (answered) return;
        output += chunk;
        if (output.length > 65536) return fail(Error("Operation response too large"));
        const end = output.indexOf("\n");
        if (end < 0) return;
        try {
          const reply = JSON.parse(output.slice(0, end));
          if (reply.ok !== true) throw Error(reply.error ?? "Operation request failed");
          answered = true;
          cleanup();
          socket.setTimeout(0);
          if (!hold || reply.value?.reused) socket.destroy();
          resolve({ value: reply.value, socket });
        } catch (error) {
          fail(error instanceof Error ? error : Error(String(error)));
        }
      });
    });
  return {
    claim: async (input: OperationRequest, signal?: AbortSignal): Promise<OperationClaim> => {
      const { value, socket } = await request("operation-claim", { request: input }, signal, true);
      if (value.reused) return { operation: value.operation, reused: true };
      const update = async (action: string, data: object) => {
        if (socket.destroyed) throw Error("Operation claim owner disconnected; settlement is uncertain");
        return request(action, { operationId: input.operationId, ticket: value.ticket, ...data });
      };
      return {
        operation: value.operation,
        reused: false,
        started: async (cwd, workspaceId) => {
          await update("operation-started", { cwd, workspaceId });
        },
        finish: async (state, runtime) => {
          try {
            await update("operation-finish", { state, runtime });
            Object.assign(value.operation, (await request("operation-read", { operationId: input.operationId })).value);
          } finally {
            socket.destroy();
          }
        },
      };
    },
    read: async (operationId: string) =>
      (await request("operation-read", { operationId })).value as OperationReference | null,
    close: () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
    },
  };
}
