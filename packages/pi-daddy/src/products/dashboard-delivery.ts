/** Render the selected delivery from Principal's bounded, current observation. */
import { DASHBOARD_DELIVERY_PRODUCER } from "../kernel/dashboard-delivery.ts";
import type { DashboardSourceSnapshot } from "../kernel/dashboard-observation.ts";
import { activityStoryItems } from "./dashboard-activity.ts";
import type { DashboardItem, DashboardScreenOptions } from "./dashboard-screen.ts";

export function currentDeliveryItem(
  options: DashboardScreenOptions,
  current: (source: DashboardSourceSnapshot, options: DashboardScreenOptions) => boolean,
  selectedTaskId?: string,
  task?: DashboardItem,
): DashboardItem | undefined {
  const observation = options.session?.observation;
  const source = observation?.sources.find((candidate) => candidate.producer === DASHBOARD_DELIVERY_PRODUCER);
  const delivery = source?.taskDelivery;
  if (!observation || !source || !delivery || !current(source, options) || delivery.taskId !== selectedTaskId)
    return task;
  const state = {
    open: "Delivery open",
    verified: "Delivery verified",
    partial: "Partial delivery",
  }[delivery.state];
  const preview = [
    ...(delivery.outstanding ? [`Outstanding · ${delivery.outstanding}`] : []),
    ...(delivery.nextAction ? [`Next · ${delivery.nextAction}`] : []),
  ];
  const activity = source.taskDeliveryTurnId
    ? (observation.activity ?? []).filter(
        (item) => item.turnId === source.taskDeliveryTurnId && item.taskId === delivery.taskId,
      )
    : [];
  const actions = activityStoryItems(activity, observation.generation, false).slice(0, 4);
  const handoff =
    delivery.handoff === "fallback"
      ? "Fallback handoff recorded in Pi."
      : delivery.handoff === "assistant"
        ? "Assistant handoff observed in Pi."
        : "Handoff has not been reported.";
  const brief = [
    ...preview,
    handoff,
    ...(delivery.evidence?.length ? ["Evidence reported by Principal", ...delivery.evidence] : []),
    ...(actions.length
      ? ["Observed actions in that Pi turn", ...actions.map((action) => `${action.label} · ${action.status}`)]
      : []),
  ];
  return {
    key: `selected-task:delivery:${source.generation}:${delivery.deliveryId}`,
    status: "selected",
    elapsed: "",
    ...task,
    label: `${state} · ${delivery.outcome}`,
    previewLines: preview,
    previewDetails: [handoff],
    briefDetails: [...brief, ...(task?.briefDetails ?? [])],
    details: [
      ...brief,
      ...(task ? [`Task history · ${task.label}`, ...task.details] : []),
      `Principal delivery ${delivery.deliveryId} · revision ${delivery.revision}`,
      `Observed ${source.observedAt}`,
    ],
  };
}
