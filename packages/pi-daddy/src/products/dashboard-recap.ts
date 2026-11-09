import { activityStoryItems } from "./dashboard-activity.ts";
import { staleSource } from "./dashboard-panels.ts";
import type { DashboardScreenOptions } from "./dashboard-screen.ts";

/** Current owner hook events, newest first. Producer snapshots can describe current state only. */
export function sessionRecapLines(options: DashboardScreenOptions): string[] {
  const session = options.session;
  const observed = session?.observation;
  if (!session || !observed)
    return [
      options.connected === false
        ? "Disconnected · no observed session activity."
        : "No session activity has been observed.",
    ];

  const lines: string[] = [];
  if (options.connected === false) {
    lines.push("Disconnected · last observed activity");
  } else {
    const work = observed.sources.find((source) => source.producer === "bookie" && !staleSource(source, options));
    const ready = work?.items.filter(
      (item) => item.kind === "review" && item.id !== "reviews" && item.state === "approval-wait" && item.reference,
    ).length;
    const waiting = work?.items.filter((item) => item.kind === "work" && item.state === "dependency-wait").length;
    if (session.pendingApprovals.length) lines.push(`Pending permissions: ${session.pendingApprovals.length}`);
    if (ready) lines.push(`Ready for review · ${ready} shown by Bookie`);
    if (waiting) lines.push(`Waiting on a dependency · ${waiting} shown by Bookie`);
  }

  const recent = activityStoryItems(observed.activity ?? [], observed.generation, false).slice(0, 5);
  lines.push(
    ...(recent.length
      ? [
          "Recent activity · newest first",
          ...recent.map((item) =>
            item.status === "failed"
              ? `Failed · ${item.label}`
              : item.status === "finished"
                ? `Finished · ${item.label}`
                : item.status === "Started"
                  ? `Started · ${item.label}`
                  : item.label,
          ),
        ]
      : ["No recent session events recorded."]),
  );
  return lines;
}
