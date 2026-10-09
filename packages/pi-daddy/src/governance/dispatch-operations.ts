/** Atomic leader election at the tree owner. No task text, execution permission or cached output. */
import { randomBytes } from "node:crypto";
import type { OperationReference, OperationRequest } from "../kernel/dispatch-operation.ts";
import { validOperationId } from "../kernel/dispatch-operation.ts";

export function createDispatchOperations() {
  const records = new Map<string, { digest: string; ticket: string; value: OperationReference }>();
  const copy = (value: OperationReference) => structuredClone(value);
  const requireTicket = (id: string, ticket: string) => {
    const row = records.get(id);
    if (!row || typeof ticket !== "string" || row.ticket !== ticket) throw Error("Operation owner mismatch");
    return row;
  };
  return {
    claim(request: OperationRequest) {
      if (
        !request ||
        !validOperationId(request.operationId) ||
        typeof request.requestDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(request.requestDigest) ||
        typeof request.executionId !== "string" ||
        !request.executionId.startsWith("exec:") ||
        request.executionId.length > 128 ||
        typeof request.cwd !== "string" ||
        !request.cwd.startsWith("/") ||
        request.cwd.length > 4096 ||
        !(request.workspaceId === null || typeof request.workspaceId === "string")
      )
        throw Error("Invalid dispatch operation request");
      const old = records.get(request.operationId);
      if (old) {
        if (old.digest !== request.requestDigest)
          throw Error("Operation identity conflict; inspect the original request before choosing a new operation_id");
        return { reused: true, operation: copy(old.value) };
      }
      // Never evict a terminal ID and accidentally permit a mutation to run twice.
      if (records.size >= 4096) throw Error("Session operation registry is full; no dispatch was admitted");
      const now = new Date().toISOString(),
        ticket = randomBytes(24).toString("hex");
      const value: OperationReference = {
        operationId: request.operationId,
        executionId: request.executionId,
        cwd: request.cwd,
        workspaceId: request.workspaceId,
        state: "admitting",
        startedAt: now,
        updatedAt: now,
      };
      records.set(request.operationId, { digest: request.requestDigest, ticket, value });
      return { reused: false, operation: copy(value), ticket };
    },
    read(id: string) {
      if (!validOperationId(id)) throw Error("Invalid operation_id");
      const value = records.get(id)?.value;
      return value ? copy(value) : null;
    },
    started(id: string, ticket: string, cwd: string, workspaceId: string | null) {
      const row = requireTicket(id, ticket);
      if (row.value.state !== "admitting") throw Error("Operation is no longer admitting");
      if (
        typeof cwd !== "string" ||
        !cwd.startsWith("/") ||
        cwd.length > 4096 ||
        !(workspaceId === null || typeof workspaceId === "string")
      )
        throw Error("Invalid operation workspace");
      row.value = { ...row.value, state: "running", cwd, workspaceId, updatedAt: new Date().toISOString() };
    },
    finish(id: string, ticket: string, state: OperationReference["state"], runtime?: OperationReference["runtime"]) {
      const row = requireTicket(id, ticket);
      if (!["settled", "not-started", "uncertain"].includes(state)) throw Error("Invalid operation terminal state");
      if (!["admitting", "running"].includes(row.value.state)) throw Error("Operation already ended");
      row.value = { ...row.value, state, ...(runtime ? { runtime } : {}), updatedAt: new Date().toISOString() };
    },
    abandoned(id: string, ticket: string) {
      const row = requireTicket(id, ticket);
      if (["admitting", "running"].includes(row.value.state))
        row.value = { ...row.value, state: "uncertain", updatedAt: new Date().toISOString() };
    },
  };
}
