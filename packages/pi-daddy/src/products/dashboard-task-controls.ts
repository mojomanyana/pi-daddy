import type { DispatchEdit, DispatchOwner } from "../governance/task-dispatch.ts";
import type { DashboardSessionAction, DashboardSessionSnapshot } from "./dashboard-session-client.ts";

/** Use the selection captured when the user opened the command. */
export function taskControlRequest(
  target: DashboardSessionSnapshot | undefined,
  text: string,
): Extract<DashboardSessionAction, { action: "task-dispatch" }> | string {
  const task = target?.taskDispatch,
    owner = target?.observation;
  if (!task || !owner) return "Select a task in Bookie to control its operations.";
  const match = /^task (pause|cancel|resume|budget)(?: (task|pi-daddy|scout|harness|jev))?(?: (off|[0-9]+))?$/.exec(
    text,
  );
  if (!match || (match[1] === "budget" ? !match[3] : match[2] || match[3]))
    return "Use task pause, task cancel, task resume, or task budget [owner] <attempts|off>.";
  const { projectId, taskId, revision, selectionRevision } = task;
  const expected = { projectId, taskId, revision, selectionRevision };
  const edit: DispatchEdit =
    match[1] === "budget"
      ? {
          action: "budget",
          limit: match[3] === "off" ? null : Number(match[3]),
          owner: (match[2] ?? "task") as DispatchOwner | "task",
          expected,
        }
      : { action: match[1] as "pause" | "cancel" | "resume", expected };
  return {
    action: "task-dispatch",
    edit,
    expectedOwner: { cwd: owner.cwd, sessionId: owner.sessionId, generation: owner.generation },
  };
}
