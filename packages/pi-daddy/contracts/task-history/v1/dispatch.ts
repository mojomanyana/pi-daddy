/** Request admission only for new work. An installed host can refuse this
 * dispatch. Stored observations and reused answers never consume an allowance. */
export type DispatchOwner = "scout" | "harness" | "jev";
export type CleanupState = "settled" | "not-started" | "unknown";
export interface DispatchReceipt {
  signal: AbortSignal;
  finish(cleanup: CleanupState): void | Promise<void>;
}
type Admit = (request: {operationId: string}) => Promise<DispatchReceipt>;
type DispatchBus = { emit?(channel: string, payload: unknown): void };
type DispatchContext = { cwd: string; sessionManager?: {getSessionId(): string} };

export function bindTaskDispatch(bus: DispatchBus | undefined, owner: DispatchOwner, ctx: DispatchContext): Admit | undefined {
  const sessionId = ctx.sessionManager?.getSessionId();
  if (!bus?.emit || !sessionId) return;
  let admitted: Admit | undefined, closed = false, conflict = false;
  try {
    bus.emit("pi.task-dispatch.v1.bind", {
      version: 1, owner, cwd: ctx.cwd, sessionId,
      accept(candidate: Admit) {
        if (closed) return;
        if (admitted || typeof candidate !== "function") conflict = true;
        else admitted = candidate;
      },
    });
  } finally {
    closed = true;
  }
  if (conflict) throw Error("Task dispatch ownership is ambiguous. Check the current task.");
  return admitted;
}

/** Finishing records the confirmed extent of local cleanup. A broken or revoked
 * host cannot replace the native result or turn an unknown cleanup into success. */
export async function finishTaskDispatch(receipt: DispatchReceipt | undefined, state: CleanupState) {
  if (!receipt) return;
  try { await receipt.finish(state); } catch { /* Owner retains its result. */ }
}
