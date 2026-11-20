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
  return (operationId: string, kind: string, state: string, label: string, evidence?: TaskObservation["evidence"]): void => {
    if (ambiguous || !publisher) return;
    try {
      // The projection is asynchronous. It cannot alter an execution, its returned
      // result or its owner evidence when a consumer is unavailable.
      void Promise.resolve(publisher({ version: 1, owner, kind, operationId, state, label, ...(evidence ? { evidence } : {}) })).catch(() => {});
    } catch { /* A consumer may have revoked its binding. */ }
  };
}
