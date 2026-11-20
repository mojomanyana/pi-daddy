/** Optional v1 task-history projection. The execution owner keeps its own receipt. */
type HistoryOwner = "principal" | "scout" | "harness" | "pi-daddy";

export interface TaskObservation {
  version: 1;
  owner: HistoryOwner;
  kind: string;
  operationId: string;
  state: string;
  label: string;
  evidence?: { type: "brief" | "operation" | "evaluation"; id: string };
}

type Publish = (observation: TaskObservation) => void | Promise<void>;
type EventBus = { emit?(channel: string, payload: unknown): void };
type Context = { cwd: string; sessionManager?: { getSessionId(): string } };

/** Capture the optional binding *before* asynchronous work. A late result must
 * never be recorded against the task that happens to be open when it finishes. */
export function bindTaskHistory(bus: EventBus | undefined, owner: HistoryOwner, ctx: Context) {
  let publisher: Publish | undefined;
  let accepting = true, ambiguous = false;
  try {
    bus?.emit?.("pi.task-history.v1.bind", {
      version: 1, owner, cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId(),
      accept(candidate: Publish) {
        if (!accepting) return;
        if (publisher || typeof candidate !== "function") ambiguous = true;
        else publisher = candidate;
      },
    });
  } catch {
    publisher = undefined;
  } finally {
    accepting = false;
  }
  return async (operationId: string, kind: string, state: string, label: string, evidence?: TaskObservation["evidence"]): Promise<void> => {
    if (ambiguous || !publisher) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const write = publisher({ version: 1, owner, kind, operationId, state, label, ...(evidence ? { evidence } : {}) });
      // The owner keeps its native receipt. A slow optional observer cannot
      // stall the native operation. A late write remains pinned to its origin.
      if (write) await Promise.race([write, new Promise<void>(resolve => { timer = setTimeout(resolve, 250); })]);
    } catch { /* A consumer may have revoked its binding. */ }
    finally { if (timer) clearTimeout(timer); }
  };
}
