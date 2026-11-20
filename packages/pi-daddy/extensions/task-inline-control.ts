const inlineWorkTools = new Set(["write", "edit", "bash", "apply_patch"]);

type InlineSession = {
  depth: number;
  ownExecutionId?: string;
  taskDispatch?: { captureInline(): (() => Promise<void>) | undefined };
};

/** Check Pi's root tool call, immediately before its built-in effect may start. */
export async function taskInlineControl(toolName: string, session: InlineSession) {
  if (!inlineWorkTools.has(toolName) || session.depth !== 0 || session.ownExecutionId) return;
  try {
    await session.taskDispatch?.captureInline()?.();
  } catch (error) {
    const reason =
      error instanceof Error && error.message === "Task dispatch is stopped. Inspect task controls before resuming."
        ? "This task is paused or cancelled. Open task controls to resume when ready."
        : "The selected task could not be verified. Reopen its history before starting new work.";
    return { block: true, reason };
  }
}
