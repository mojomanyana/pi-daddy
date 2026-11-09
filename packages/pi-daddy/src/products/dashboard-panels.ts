/** Six current-session destinations share stable row identities; contributions are labels, never authority. */
import type { DashboardContribution, DashboardSourceSnapshot } from "../kernel/dashboard-observation.ts";
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
function staleSource(source: DashboardSourceSnapshot, options: DashboardScreenOptions): boolean {
  return (
    options.connected === false ||
    source.availability === "closed" ||
    (options.now?.getTime() ?? Date.now()) - Date.parse(source.observedAt) > source.staleAfterMs
  );
}

const sourceKey = (source: DashboardSourceSnapshot, item: DashboardContribution) =>
  `source:${source.producer}:${source.generation}:${item.id}`;

/** A current request for review takes precedence over general workflow suggestions. */
function sessionNext(options: DashboardScreenOptions) {
  const current = options.session!.observation!.sources.filter((source) => !staleSource(source, options));
  const recommendations = current.flatMap((source) =>
    source.items.filter((item) => item.kind === "next").map((item) => ({ item, source })),
  );
  for (const next of recommendations) {
    if (next.item.state !== "approval-wait") continue;
    const review = next.source.items.find(
      (item) =>
        item.kind === "review" &&
        item.state === "approval-wait" &&
        (!next.item.reference || item.reference === next.item.reference),
    );
    if (review) return { ...next, reviewKey: sourceKey(next.source, review) };
  }
  const next =
    recommendations.find(({ item }) => ["dependency-wait", "failed", "unknown", "unavailable"].includes(item.state)) ??
    recommendations[0];
  return next && { ...next, reviewKey: undefined };
}

export function sessionNextLines(options: DashboardScreenOptions): [string, string] {
  const next = sessionNext(options);
  return [
    next?.reviewKey ? "NEXT · [3] Reviews" : "NEXT",
    next ? `${clean(next.item.label)} (${next.source.producer})` : "No current next step reported.",
  ];
}
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
    ...(item.kind === "review"
      ? [
          item.state === "approval-wait"
            ? "The reviewer decides on this output."
            : "A reported judgment is not execution authority or overall task acceptance.",
        ]
      : []),
    "Reported observations do not grant execution authority or task approval.",
    ...(stale ? ["Current liveness/applicability unknown; no automatic retry."] : []),
  ],
});
export function sessionDashboardItems(options: DashboardScreenOptions): DashboardItem[] {
  const observed = options.session!.observation!;
  const destination = options.screen.destination ?? "now";
  const staleOwner = options.connected === false;
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
          sourceKey(source, item),
          `${source.producer}@${source.producerVersion} · seq ${source.sequence} · ${source.observedAt}`,
          staleSource(source, options),
        ),
      ),
  );
  if (destination === "reviews") {
    const first = sessionNext(options)?.reviewKey;
    const priority = (item: DashboardItem) => (item.key === first ? 2 : Number(item.status === "approval-wait"));
    return published.sort((a, b) => priority(b) - priority(a));
  }
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
  const initiative = observation.sources.find((source) => source.producer === "daddy-initiative");
  const scope = initiative?.items.find((item) => item.id === "scope");
  if (scope && (destination === "now" || destination === "work")) {
    lines.push(`SELECTED ${scope.label}${staleSource(initiative!, options) ? " (last observed)" : ""}`);
    if (destination === "work" && scope.details?.[1]) lines.push(scope.details[1]);
  }
  if (destination === "now") {
    const goal = sourceRows.find((x) => x.item.kind === "goal");
    lines.push(
      "GOAL",
      goal
        ? `${goal.item.label} (${goal.source.producer}${staleSource(goal.source, options) ? "; stale" : ""})`
        : (options.current ?? "Goal not reported; no inference from a finished step."),
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
      `${x.key === screen.selectedKey ? ">" : " "} ${x.status === "last-observed" ? "Last seen · " : ""}${clean(x.label)} · ${clean(x.status)}${x.elapsed ? " " + x.elapsed : ""}`,
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
      const stale = streams.filter((s) => staleSource(s, options)).length;
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
