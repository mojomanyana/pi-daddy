import type { DashboardContribution } from "../kernel/dashboard-observation.ts";
import type { TimelineTask } from "./activity-timeline.ts";
import { safeDashboardSummary, toolPurpose } from "./activity-summary.ts";
import type { DashboardItem } from "./dashboard-screen.ts";

const clean = (value: string) =>
  value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim();

export function activityTaskTitle(task: TimelineTask): string {
  const lastAction = task.lastEvent?.kind === "tool_started" || task.status !== "active";
  const observed = lastAction
    ? (safeDashboardSummary(task.lastPurpose) ?? (task.lastEvent?.tool ? toolPurpose(task.lastEvent.tool) : undefined))
    : undefined;
  const purpose = safeDashboardSummary(task.dashboardSummary) ?? observed;
  if (purpose) return task.agent ? `${purpose} · ${clean(task.agent)}` : purpose;
  if (task.agent) return `${clean(task.agent)} task`;
  if (task.trigger?.type === "custom") return "Handle an extension request";
  if (task.status === "finished") return "Pi finished its turn";
  return task.status === "active" ? "Pi is working on your request" : "Pi handled your request";
}

/** Ledger entries retain authoritative state and identity. Only the same owner's matching execution may add a title. */
export function applyOwnerTaskTitles(items: DashboardItem[], tasks: TimelineTask[], rootId: string): DashboardItem[] {
  const known = new Map(tasks.filter((task) => task.rootId === rootId && task.agent).map((task) => [task.id, task]));
  return items.map((item) => {
    const task = known.get(item.key);
    return task && (task.dashboardSummary || task.lastPurpose) ? { ...item, label: activityTaskTitle(task) } : item;
  });
}

interface Story {
  events: DashboardContribution[];
  label: string;
  status: string;
  group?: string;
  calls: number;
  legacy?: boolean;
}

/** Group only matching tool observations within a turn. Preserve failures, interleaving, and original records in Details. */
export function activityStoryItems(
  events: DashboardContribution[],
  generation: string,
  disconnected: boolean,
): DashboardItem[] {
  const stories: Story[] = [];
  const starts = new Map<string, Story>();
  for (const event of events) {
    const raw = clean(event.label);
    const toolEvent = /^(.+): tool (start|end)$/.exec(raw);
    if (!toolEvent) {
      if (raw === "agent_start" || raw === "agent_end") starts.clear();
      stories.push({
        events: [event],
        label: raw === "agent_start" ? "Pi started a turn" : raw === "agent_end" ? "Pi finished its turn" : raw,
        status: "observed",
        calls: 1,
      });
      continue;
    }
    const [, name, phase] = toolEvent;
    const call = event.details?.find((line) => /^Call: \d+$/.test(line));
    const key = call && `${name}:${call}`;
    let story = phase === "end" && key ? starts.get(key) : undefined;
    if (story) {
      starts.delete(key!);
      // A call finishing after a different action belongs at the time its result arrived.
      stories.splice(stories.indexOf(story), 1);
      story.events.push(event);
    } else {
      const purpose = event.details?.find((line) => line.startsWith("Purpose: "))?.slice(9);
      story = {
        events: [event],
        label: safeDashboardSummary(purpose) ?? toolPurpose(name!),
        status: "observed",
        group: name,
        calls: 1,
        legacy: !key,
      };
    }
    if (phase === "start" && key) starts.set(key, story);
    story.status = event.state === "failed" ? "failed" : phase === "end" ? "finished" : "Started";
    stories.push(story);
  }
  const grouped: Story[] = [];
  for (const story of stories) {
    const last = grouped.at(-1);
    if (
      last &&
      story.legacy &&
      last.legacy &&
      story.group === last.group &&
      story.label === last.label &&
      story.status !== "failed" &&
      last.status !== "failed"
    ) {
      // Older Pi observations have no call identity. Count raw records, never inferred commands.
      last.events.push(...story.events);
      last.status = "observed";
    } else if (
      last &&
      !story.legacy &&
      !last.legacy &&
      story.group &&
      story.group === last.group &&
      story.status === "finished" &&
      last.status === story.status &&
      story.label === last.label
    ) {
      last.events.push(...story.events);
      last.calls++;
    } else grouped.push(story);
  }
  return grouped.reverse().map(({ events: raw, label, calls, status, legacy }) => ({
    key: `activity:${generation}:${raw[0]!.id}`,
    label: legacy && raw.length > 1 ? `${label} (${raw.length} events)` : calls > 1 ? `${label} (×${calls})` : label,
    status: disconnected ? "last-observed" : status,
    elapsed: "",
    briefDetails: [
      label,
      ...(disconnected ? ["Last seen before the dashboard disconnected."] : []),
      ...(status === "failed"
        ? ["Pi reported an error."]
        : status === "Started"
          ? ["Pi reported starting this action. No finish is in these recent events."]
          : []),
    ],
    details: raw.map(
      (event) =>
        `${event.details?.find((line) => line.startsWith("Observed: "))?.slice(10) ?? "Time unavailable"} · ${clean(event.label)}${event.state === "failed" ? " · error" : ""}`,
    ),
  }));
}
