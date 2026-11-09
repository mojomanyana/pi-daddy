import type { DashboardContribution } from "../kernel/dashboard-observation.ts";
import { staleSource } from "./dashboard-panels.ts";
import { truncate } from "./dashboard-render.ts";
import { dashboardText, type DashboardScreenOptions } from "./dashboard-screen.ts";

function eventLine(event: DashboardContribution): string {
  const label = dashboardText(event.label).replace(/\s+/g, " ").trim();
  if (label === "agent_start") return "Parent turn started";
  if (label === "agent_end") return "Parent turn ended";
  const tool = /^(.*): tool (start|end)$/.exec(label);
  const name = truncate(tool?.[1] || label || "Event", 80);
  if (event.state === "failed") return `${name} failed`;
  return tool ? `${name} ${tool[2] === "start" ? "started" : "finished"}` : name;
}

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

  const recent = (observed.activity ?? []).slice(-5).reverse();
  lines.push(
    ...(recent.length
      ? ["Recent activity · newest first", ...recent.map(eventLine)]
      : ["No recent session events recorded."]),
  );
  return lines;
}
