/** Bind Principal's optional inline-continuation check to this native session and selected task. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DashboardSourceOwner } from "./dashboard-sources.ts";
import type { createTaskDispatchController } from "./task-dispatch-controller.ts";

const EVENT = "pi-daddy:delivery-task:v1";

export function registerDeliveryTaskBridge(
  bus: ExtensionAPI["events"],
  current: () => DashboardSourceOwner | undefined,
  isRoot: () => boolean,
  dispatch: Pick<ReturnType<typeof createTaskDispatchController>, "captureDelivery">,
) {
  return bus?.on?.(EVENT, (raw: unknown) => {
    // Pi can recreate this extension while the process still publishes the previous owner's child depth.
    if (!isRoot()) return;
    const req = raw as { version?: unknown; sessionId?: unknown; cwd?: unknown; reply?: (value: unknown) => void };
    if (
      req?.version !== 1 ||
      typeof req.sessionId !== "string" ||
      typeof req.cwd !== "string" ||
      typeof req.reply !== "function"
    )
      return;
    const owner = current();
    const matches = owner && req.sessionId === owner.sessionId && req.cwd === owner.cwd;
    const binding = matches ? dispatch.captureDelivery() : undefined;
    try {
      req.reply({
        version: 1,
        sessionId: req.sessionId,
        cwd: req.cwd,
        taskId: binding?.taskId,
        async assertMayContinue() {
          if (!isRoot() || !matches || current() !== owner || !binding)
            throw Error("The delivery session changed or is unavailable.");
          await binding.assertMayContinue();
          if (!isRoot() || current() !== owner) throw Error("The delivery session changed.");
        },
      });
    } catch {
      // A failed optional observer cannot affect Pi's active request.
    }
  });
}
