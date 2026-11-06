/** Six current-session destinations share stable row identities; contributions are labels, never authority. */
import type { DashboardContribution } from "../kernel/dashboard-observation.ts";
import type { DashboardItem, DashboardScreenOptions } from "./dashboard-screen.ts";
import { dashboardText } from "./dashboard-screen.ts";
import { activityTaskKey } from "./activity-timeline.ts";
import { truncate, cellWidth } from "./dashboard-render.ts";
export type DashboardDestination = "now" | "work" | "reviews" | "activity" | "evidence" | "settings";
export const DASHBOARD_DESTINATIONS: DashboardDestination[] = [
  "now",
  "work",
  "reviews",
  "activity",
  "evidence",
  "settings",
];
const clean = (s: string) => dashboardText(s).replace(/\s+/g, " ").trim();
const row = (item: DashboardContribution, key: string, source: string, stale = false): DashboardItem => ({
  key,
  label: item.label,
  status: stale ? "last-observed" : item.state,
  elapsed: "",
  agent: item.kind === "work",
  details: [
    `Source: ${source}`,
    `Observed state: ${item.state}${stale ? " (stale/disconnected)" : ""}`,
    ...(item.details ?? []),
    ...(item.reference ? [`Reference: ${item.reference}`] : []),
    ...(item.kind === "review" ? ["A reported judgment is not execution authority or overall task acceptance."] : []),
    "Reported observations do not grant execution authority or task approval.",
    ...(stale ? ["Current liveness/applicability unknown; no automatic retry."] : []),
  ],
});
export function sessionDashboardItems(options: DashboardScreenOptions): DashboardItem[] {
  const observed = options.session!.observation!;
  const destination = options.screen.destination ?? "now";
  const staleOwner = options.connected === false;
  const now = options.now?.getTime() ?? Date.now();
  const wanted =
    destination === "work"
      ? ["work"]
      : destination === "reviews"
        ? ["review"]
        : destination === "evidence"
          ? ["evidence"]
          : destination === "activity"
            ? ["status"]
            : ["work", "status"];
  const published = observed.sources.flatMap((source) =>
    source.items
      .filter(
        (item) =>
          wanted.includes(item.kind) &&
          !(source.producer === "daddy-initiative" && item.id === "scope" && ["now", "work"].includes(destination)),
      )
      .map((item) =>
        row(
          item,
          `source:${source.producer}:${source.generation}:${item.id}`,
          `${source.producer}@${source.producerVersion} · seq ${source.sequence} · ${source.observedAt}`,
          staleOwner || source.availability === "closed" || now - Date.parse(source.observedAt) > source.staleAfterMs,
        ),
      ),
  );
  if (destination === "reviews") return published;
  if (destination === "evidence")
    return [
      ...(observed.artifacts ?? []).map((a) => ({
        key: `artifact:${a.executionId}`,
        label: a.operationId,
        status: "retained",
        elapsed: "",
        details: [
          `Producer: pi-daddy`,
          `Execution: ${a.executionId}`,
          `Manifest SHA-256: ${a.sha256}`,
          "Producer reference observed in this session; payload not loaded by the dashboard.",
          "Retained is not reviewed, applicable or approved. Use the authorized artifact resolver for content.",
        ],
      })),
      ...published,
    ];
  if (destination === "activity")
    return [
      ...(observed.activity ?? [])
        .slice()
        .reverse()
        .map((item) =>
          row(item, `activity:${observed.generation}:${item.id}`, `Pi owner · ${observed.sessionId}`, staleOwner),
        ),
      ...published,
    ];
  const native = options.items.map((item) =>
    staleOwner
      ? {
          ...item,
          status: "last-observed",
          details: [...item.details, "Owner disconnected; current child liveness is unknown."],
        }
      : item,
  );
  const activity = options.session?.activity;
  const parentShown =
    activity && native.some((item) => item.taskKey === activityTaskKey(activity.rootId, activity.taskId));
  return [
    ...(observed.turn && !parentShown
      ? [row(observed.turn, `owner:${observed.generation}:${observed.turn.id}`, "Pi owner", staleOwner)]
      : []),
    ...native,
    ...published,
  ];
}
export function sessionPanelLines(options: DashboardScreenOptions, items: DashboardItem[], width: number): string[] {
  const observation = options.session!.observation!,
    screen = options.screen;
  const destination = screen.destination ?? "now";
  const sourceRows = observation.sources.flatMap((s) => s.items.map((item) => ({ source: s, item })));
  const lines: string[] = [`${destination.toUpperCase()} · CURRENT SESSION`];
  const staleSource = (source: (typeof observation.sources)[number]) =>
    options.connected === false ||
    source.availability === "closed" ||
    (options.now?.getTime() ?? Date.now()) - Date.parse(source.observedAt) > source.staleAfterMs;
  const initiative = observation.sources.find((source) => source.producer === "daddy-initiative");
  const scope = initiative?.items.find((item) => item.id === "scope");
  if (scope && (destination === "now" || destination === "work")) {
    lines.push(`SELECTED ${scope.label}${staleSource(initiative!) ? " (last observed)" : ""}`);
    if (destination === "work" && scope.details?.[1]) lines.push(scope.details[1]);
  }
  if (destination === "now") {
    const goal = sourceRows.find((x) => x.item.kind === "goal");
    lines.push(
      "GOAL",
      goal
        ? `${goal.item.label} (${goal.source.producer}${staleSource(goal.source) ? "; stale" : ""})`
        : (options.current ?? "Goal not reported; no inference from a finished step."),
    );
    const next = sourceRows.find((x) => x.item.kind === "next");
    const nextStale =
      next &&
      (options.connected === false ||
        next.source.availability === "closed" ||
        (options.now?.getTime() ?? Date.now()) - Date.parse(next.source.observedAt) > next.source.staleAfterMs);
    lines.push(
      "NEXT",
      next
        ? `${next.item.label} (${next.source.producer}${nextStale ? "; stale" : ""})`
        : "No coordinator recommendation reported.",
    );
    const attention = items.filter((x) =>
      [
        "failed",
        "refused",
        "incomplete",
        "unknown",
        "unavailable",
        "needs-you",
        "approval-wait",
        "dependency-wait",
        "cancel-requested",
      ].includes(x.status),
    );
    if (attention.length) {
      lines.push(`ATTENTION · ${attention.length}`);
      for (const item of attention.slice(0, 3)) lines.push(`${item.label} · ${item.status}`);
    }
    const result = [...items].reverse().find((x) => ["settled", "finished", "completed"].includes(x.status));
    if (result) lines.push(`LATEST UPDATE · ${result.label} (${result.status})`);
  }

  if (!items.length)
    lines.push(
      destination === "reviews"
        ? "No review producer observations available."
        : destination === "evidence"
          ? "No current-session result references observed."
          : "No observations for this view.",
    );
  const selected = items.find((x) => x.key === screen.selectedKey);
  const rows = items.map(
    (x) =>
      `${x.key === screen.selectedKey ? ">" : " "} ${clean(x.label)} · ${clean(x.status)}${x.elapsed ? " " + x.elapsed : ""}`,
  );
  const expanded = screen.expanded && width >= 96;
  if (expanded && rows.length) {
    const left = Math.floor(width * 0.45),
      right = width - left - 3;
    const details = [selected ? `DETAIL · ${clean(selected.label)}` : "DETAIL", ...(selected?.details ?? [])];
    const length = Math.max(rows.length, details.length);
    for (let i = 0; i < length; i++) {
      const a = truncate(clean(rows[i] ?? ""), left);
      lines.push(a + " ".repeat(Math.max(0, left - cellWidth(a))) + " | " + truncate(clean(details[i] ?? ""), right));
    }
  } else {
    lines.push(...rows);
    if (screen.expanded) lines.push("Expanded layout needs 96 columns; same selection retained.");
  }
  if (destination === "now") {
    lines.push("COMPONENTS");
    for (const producer of ["principal", "bookie", "scout", "skill-harness"]) {
      const streams = observation.sources.filter(
        (x) => x.producer === producer || (producer === "scout" && x.producer.startsWith("scout-")),
      );
      const stale = streams.filter(
        (s) =>
          options.connected === false ||
          s.availability === "closed" ||
          (options.now?.getTime() ?? Date.now()) - Date.parse(s.observedAt) > s.staleAfterMs,
      ).length;
      const status = !streams.length
        ? "status adapter unavailable"
        : `${streams.length - stale} observed${stale ? `; ${stale} last observed / stale` : ""}`;
      lines.push(`${producer}: ${status}`);
    }
    const resource = observation.resources;
    lines.push(`Parent RSS: ${(resource.rssBytes / 1024 / 1024).toFixed(1)} MiB`, "Host and child memory: unknown");
  }
  return lines;
}
