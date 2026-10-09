import { createDispatchOperations } from "./dispatch-operations.ts";
import { connectDispatchOperations } from "./dispatch-operation-client.ts";
/** Root-owned live Auto authority. Descendants receive read/admit access, never mutation access. */
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { createServer, createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AutoModeReader,
  AutoModeRef,
  AutoModeSnapshot,
  AutoModeSource,
  PendingApproval,
} from "../kernel/auto-mode.ts";

const aborted = () => new Error("Auto approval request aborted");
const unavailable = () => new Error("Auto policy owner is unavailable; no automatic permission was granted");
const validPending = (value: unknown): value is PendingApproval => {
  if (!value || typeof value !== "object") return false;
  const v = value as PendingApproval;
  return [v.id, v.subject, v.capability].every((x) => typeof x === "string" && x.length > 0 && x.length <= 256);
};
export interface AutoModeAuthority extends AutoModeReader {
  snapshot(): AutoModeSnapshot;
  set(enabled: boolean, source: AutoModeSource): AutoModeSnapshot;
}

export async function createAutoModeAuthority(initial: {
  enabled: boolean;
  source: AutoModeSource;
}): Promise<AutoModeAuthority> {
  const reference = {
    socketPath: join(tmpdir(), `daddy-auto-${process.pid}-${randomBytes(8).toString("hex")}.sock`),
    token: randomBytes(24).toString("hex"),
    ownerId: randomBytes(16).toString("hex"),
  };
  let enabled = initial.enabled,
    source = initial.source,
    revision = 0,
    closed = false;
  const operations = createDispatchOperations();
  const pending = new Map<string, PendingApproval>();
  const waiters = new Set<() => void>();
  const sockets = new Set<Socket>();
  const assertOpen = () => {
    if (closed) throw unavailable();
  };
  const snapshot = (): AutoModeSnapshot => {
    assertOpen();
    return {
      enabled,
      source,
      revision,
      ownerId: reference.ownerId,
      pendingApprovals: [...pending.values()].map((v) => ({ ...v })),
    };
  };
  const waitEnabled = async (signal: AbortSignal): Promise<void> => {
    assertOpen();
    if (signal.aborted) throw aborted();
    if (enabled) return;
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        waiters.delete(wake);
        signal.removeEventListener("abort", cancel);
      };
      const wake = () => {
        clean();
        closed ? reject(unavailable()) : resolve();
      };
      const cancel = () => {
        clean();
        reject(aborted());
      };
      waiters.add(wake);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  };
  const trackPending = (approval: PendingApproval) => {
    assertOpen();
    if (!validPending(approval)) throw new Error("Invalid pending approval");
    const key = randomUUID();
    pending.set(key, { ...approval });
    return () => {
      pending.delete(key);
    };
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(2000, () => socket.destroy());
    const controller = new AbortController();
    let input = "",
      handled = false,
      untrack: (() => void) | undefined,
      abandonOperation: (() => void) | undefined;
    socket.on("error", () => {});
    socket.once("close", () => {
      sockets.delete(socket);
      controller.abort();
      untrack?.();
      abandonOperation?.();
    });
    const reply = (value: unknown) => {
      if (!socket.destroyed) socket.end(JSON.stringify(value) + "\n");
    };
    socket.on("data", (chunk) => {
      if (handled) {
        socket.destroy();
        return;
      }
      input += chunk;
      if (input.length > 4096) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      handled = true;
      try {
        const request = JSON.parse(input.slice(0, input.indexOf("\n")));
        if (request.token !== reference.token || request.ownerId !== reference.ownerId)
          throw new Error("Unauthorized Auto policy request");
        assertOpen();
        if (request.action === "read") reply({ ok: true, value: snapshot() });
        else if (request.action === "admit") reply({ ok: true, value: enabled });
        else if (request.action === "wait") {
          socket.setTimeout(0);
          void waitEnabled(controller.signal)
            .then(() => reply({ ok: true }))
            .catch((error) => reply({ ok: false, error: String(error) }));
        } else if (request.action === "pending" && validPending(request.approval)) {
          socket.setTimeout(0);
          untrack = trackPending(request.approval);
        } else if (request.action === "operation-claim") {
          const value = operations.claim(request.request);
          if (!value.reused) {
            socket.setTimeout(0);
            abandonOperation = () => operations.abandoned(value.operation.operationId, value.ticket!);
            socket.write(JSON.stringify({ ok: true, value }) + "\n");
          } else reply({ ok: true, value });
        } else if (request.action === "operation-read") {
          reply({ ok: true, value: operations.read(request.operationId) });
        } else if (request.action === "operation-started") {
          operations.started(request.operationId, request.ticket, request.cwd, request.workspaceId);
          reply({ ok: true });
        } else if (request.action === "operation-finish") {
          operations.finish(request.operationId, request.ticket, request.state, request.runtime);
          reply({ ok: true });
        } else throw new Error("Unknown Auto policy action");
      } catch (error) {
        reply({ ok: false, error: String(error) });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(reference.socketPath, resolve);
  });
  try {
    await chmod(reference.socketPath, 0o600);
  } catch (error) {
    server.close();
    await unlink(reference.socketPath).catch(() => {});
    throw error;
  }
  server.unref();
  const exit = () => {
    try {
      unlinkSync(reference.socketPath);
    } catch {}
  };
  process.once("exit", exit);
  const operationAccess = connectDispatchOperations(reference);
  return {
    operations: operationAccess,
    reference,
    snapshot,
    read: async () => snapshot(),
    waitEnabled,
    trackPending,
    admit: async (signal) => {
      assertOpen();
      if (signal?.aborted) throw aborted();
      return enabled;
    },
    set: (next, from) => {
      assertOpen();
      enabled = next;
      source = from;
      revision++;
      if (enabled) for (const wake of [...waiters]) wake();
      return snapshot();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      operationAccess.close();
      enabled = false;
      for (const wake of [...waiters]) wake();
      for (const socket of sockets) socket.destroy();
      pending.clear();
      process.off("exit", exit);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(reference.socketPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}

function request(ref: AutoModeRef, action: "read" | "admit" | "wait", signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const socket = createConnection(ref.socketPath);
    let output = "",
      settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const cancel = () => finish(aborted());
    signal?.addEventListener("abort", cancel, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(2000, () => finish(unavailable()));
    socket.once("error", () => finish(unavailable()));
    socket.once("connect", () => {
      if (action === "wait") socket.setTimeout(0);
      socket.write(JSON.stringify({ ...ref, action }) + "\n");
    });
    socket.on("data", (chunk) => {
      output += chunk;
      if (output.length > 256 * 1024) finish(new Error("Auto policy response too large"));
    });
    socket.once("end", () => {
      try {
        const reply = JSON.parse(output);
        if (reply.ok !== true) throw new Error(reply.error ?? "Auto policy request failed");
        finish(undefined, reply.value);
      } catch (error) {
        finish(error instanceof Error ? error : unavailable());
      }
    });
    socket.once("close", () => {
      if (!settled) finish(unavailable());
    });
  });
}

export function connectAutoMode(reference: AutoModeRef): AutoModeReader {
  const operations = connectDispatchOperations(reference);
  let closed = false;
  const active = new Set<AbortController>();
  const pending = new Set<Socket>();
  const call = async (action: "read" | "admit" | "wait", signal?: AbortSignal) => {
    if (closed) throw unavailable();
    const controller = new AbortController();
    active.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      return await request(reference, action, controller.signal);
    } finally {
      active.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  };
  return {
    reference,
    operations,
    read: async () => {
      const value = (await call("read")) as AutoModeSnapshot;
      if (
        !value ||
        value.ownerId !== reference.ownerId ||
        typeof value.enabled !== "boolean" ||
        !["default", "environment", "session"].includes(value.source) ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        !Array.isArray(value.pendingApprovals) ||
        !value.pendingApprovals.every(validPending)
      )
        throw unavailable();
      return value;
    },
    admit: async (signal) => {
      const value = await call("admit", signal);
      if (typeof value !== "boolean") throw unavailable();
      return value;
    },
    waitEnabled: async (signal) => {
      await call("wait", signal);
    },
    trackPending: (approval) => {
      if (closed) throw unavailable();
      if (!validPending(approval)) throw new Error("Invalid pending approval");
      const socket = createConnection(reference.socketPath);
      pending.add(socket);
      socket.once("error", () => {});
      socket.once("close", () => pending.delete(socket));
      socket.once("connect", () => socket.write(JSON.stringify({ ...reference, action: "pending", approval }) + "\n"));
      return () => {
        pending.delete(socket);
        socket.destroy();
      };
    },
    close: async () => {
      closed = true;
      operations.close();
      for (const controller of active) controller.abort();
      for (const socket of pending) socket.destroy();
    },
  };
}
