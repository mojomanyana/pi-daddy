/** Six current-session destinations share stable row identities; contributions are labels, never authority. */
import type { DashboardContribution, DashboardSourceSnapshot } from "../kernel/dashboard-observation.ts";
import type { DashboardItem, DashboardScreenOptions } from "./dashboard-screen.ts";
import { dashboardText, friendlyStatus } from "./dashboard-screen.ts";
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
export function staleSource(source: DashboardSourceSnapshot, options: DashboardScreenOptions): boolean {
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
    const reviews = next.source.items.filter(
      (item) =>
        item.kind === "review" &&
        item.state === "approval-wait" &&
        !(next.source.producer === "bookie" && reviewTotals(item)) &&
        (!next.item.reference || item.reference === next.item.reference),
    );
    if (reviews.length === 1) return { ...next, reviewKey: sourceKey(next.source, reviews[0]!) };
  }
  const general = recommendations.filter(({ item }) => item.state !== "approval-wait" || !item.reference);
  const next =
    general.find(({ item }) => ["dependency-wait", "failed", "unknown", "unavailable"].includes(item.state)) ??
    general[0];
  return next && { ...next, reviewKey: undefined };
}

export function sessionNextLines(options: DashboardScreenOptions): [string, string] {
  if (options.connected === false) return ["NEXT", "Reconnect to the parent Pi session for current work."];
  if (options.session?.pendingApprovals.length)
    return ["NEXT · Permission", "Respond to the permission request in the parent Pi session."];
  const next = sessionNext(options);
  if (!next) {
    const sources = options.session!.observation!.sources;
    if (sources.length && sources.every((source) => staleSource(source, options)))
      return ["NEXT", "Waiting for a current status from Pi."];
  }
  return [
    next?.reviewKey ? "NEXT · [3] Reviews" : "NEXT",
    next ? clean(next.item.label) : "No current next step reported.",
  ];
}
function contributionDetails(item: DashboardContribution, source: string, stale: boolean): string[] {
  const details = item.details ?? [];
  if (!source.startsWith("bookie@") || item.kind !== "review" || item.state !== "approval-wait") return details;
  const open = details.find((line) => line.startsWith("Open /bookie-work review"));
  if (stale)
    return details.filter(
      (line) => !line.startsWith("Open /bookie-work review") && !line.startsWith("Record your review decision"),
    );
  return open ? [open, ...details.filter((line) => line !== open)] : details;
}
const row = (
  item: DashboardContribution,
  key: string,
  source: string,
  stale = false,
  label = item.label,
  taskReview?: DashboardContribution,
): DashboardItem => {
  const details = contributionDetails(item, source, stale);
  const handoff = taskReview ?? item;
  const pendingTask = source.startsWith("bookie@") && item.kind === "work" && item.state === "approval-wait";
  const currentHandoff =
    !stale &&
    source.startsWith("bookie@") &&
    handoff.kind === "review" &&
    handoff.state === "approval-wait" &&
    !reviewTotals(handoff);
  const brief = currentHandoff
    ? contributionDetails(handoff, source, stale).filter(
        (line) =>
          !/^(?:\/|[A-Za-z]:[\\/]|(?:Reference|Source|Observed at):)/i.test(line) &&
          !/\b[a-f0-9]{64}\b/i.test(line) &&
          line !== "Output: handoff",
      )
    : [];
  const openInstruction = brief.indexOf("Open /bookie-work review to read the saved handoff.");
  if (taskReview && openInstruction >= 0) {
    const choice = label === item.label ? label : item.label.split("/").at(-1)!;
    brief.splice(
      openInstruction,
      1,
      "In the parent Pi session, run",
      "/bookie-work review",
      `If prompted, choose the handoff for ${choice}.`,
    );
  }
  if (currentHandoff && !brief.length) brief.push("Awaiting a review decision for this output.");
  if (!currentHandoff && pendingTask)
    brief.push(
      stale
        ? "Last seen awaiting a decision. Check the parent Pi session for current status."
        : "A decision is pending. Check the selected task in the parent Pi session for its review evidence.",
    );
  return {
    key,
    label,
    status: stale ? "last-observed" : item.state,
    elapsed: "",
    agent: item.kind === "work",
    ...(brief.length ? { briefDetails: brief } : {}),
    details: [
      ...(stale ? ["Last recorded details. Current state is unknown."] : []),
      ...details,
      ...(label !== item.label ? [item.label] : []),
      `Observed state: ${item.state}${stale ? " (stale/disconnected)" : ""}`,
      `Source: ${source}`,
      ...(item.reference ? [`Reference: ${item.reference}`] : []),
      ...(taskReview?.reference ? [`Saved handoff reference: ${taskReview.reference}`] : []),
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
  };
};

const reviewTotals = (item: DashboardContribution) =>
  item.kind === "review" && item.id === "reviews" && item.label === "Selected output judgment observations";

// Bookie publishes work with its task revision and the corresponding review with its output digest.
// Only the task ID within this one observation links the two records.
function reviewForTask(item: DashboardContribution, source: DashboardSourceSnapshot, stale: boolean) {
  if (
    stale ||
    source.producer !== "bookie" ||
    item.kind !== "work" ||
    item.state !== "approval-wait" ||
    !item.reference
  )
    return;
  const matches = source.items.filter(
    (candidate) =>
      candidate.id === `review-${item.id}` &&
      candidate.kind === "review" &&
      candidate.state === "approval-wait" &&
      candidate.reference,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

// A Bookie task can publish its canonical document path as its only label.
// Abbreviate unambiguous sibling names while keeping the full path in Details.
function bookieLabel(item: DashboardContribution, source: DashboardSourceSnapshot): string {
  if (reviewTotals(item)) return "Review totals";
  if (item.kind !== "work" || !item.label.startsWith("/")) return item.label;
  const name = (label: string) => label.split("/").at(-1)?.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
  const title = name(item.label);
  if (
    !title ||
    !item.label.endsWith(".md") ||
    source.items.some((other) => other.kind === "work" && other.id !== item.id && name(other.label) === title)
  )
    return item.label;
  return title;
}

function rowText(item: DashboardItem, destination: DashboardDestination, selected: boolean): string {
  const label = clean(item.label);
  const marker = selected ? "> " : "  ";
  if (item.status === "last-observed") return `${marker}Last seen · ${label}`;
  const waitingForReview = destination === "reviews" && item.status === "approval-wait";
  const described = waitingForReview && /^ready for review[:\s]/i.test(label);
  const status = described ? "" : ` · ${waitingForReview ? "Awaiting review" : friendlyStatus(clean(item.status))}`;
  return `${marker}${label}${status}${item.elapsed ? " " + item.elapsed : ""}`;
}
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
          !(
            destination === "reviews" &&
            !options.screen.expanded &&
            source.producer === "bookie" &&
            reviewTotals(item) &&
            source.items.some((other) => other.kind === "review" && other.id !== item.id)
          ) &&
          !(source.producer === "daddy-initiative" && item.id === "scope" && ["now", "work"].includes(destination)),
      )
      .map((item) => {
        const stale = staleSource(source, options);
        return row(
          item,
          sourceKey(source, item),
          `${source.producer}@${source.producerVersion} · seq ${source.sequence} · ${source.observedAt}`,
          stale,
          source.producer === "bookie" ? bookieLabel(item, source) : item.label,
          reviewForTask(item, source, stale),
        );
      }),
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
  const items = [
    ...(observed.turn && !parentShown
      ? [row(observed.turn, `owner:${observed.generation}:${observed.turn.id}`, "Pi owner", staleOwner)]
      : []),
    ...native,
    ...published,
  ];
  if (destination === "now") {
    const priority = (item: DashboardItem) => {
      if (["needs-you", "failed", "refused", "incomplete", "approval-wait", "dependency-wait"].includes(item.status))
        return 0;
      if (["running", "active", "starting", "cancel-requested"].includes(item.status)) return 1;
      return 2;
    };
    items.sort((a, b) => priority(a) - priority(b));
  }
  return items;
}
export function sessionPanelLines(options: DashboardScreenOptions, items: DashboardItem[], width: number): string[] {
  const observation = options.session!.observation!,
    screen = options.screen;
  const destination = screen.destination ?? "now";
  const sourceRows = observation.sources.flatMap((s) => s.items.map((item) => ({ source: s, item })));
  const lines: string[] =
    destination === "now" || destination === "reviews" ? [] : [`${destination.toUpperCase()} · CURRENT SESSION`];
  const initiative = observation.sources.find((source) => source.producer === "daddy-initiative");
  const scope = initiative?.items.find((item) => item.id === "scope");
  if (scope && (destination === "now" || destination === "work")) {
    lines.push(`SELECTED ${scope.label}${staleSource(initiative!, options) ? " (last observed)" : ""}`);
    if (destination === "work" && scope.details?.[1]) lines.push(scope.details[1]);
  }
  if (destination === "now") {
    const goals = sourceRows.filter((x) => x.item.kind === "goal");
    const goal = goals.find((x) => !staleSource(x.source, options)) ?? goals[0];
    if (goal) {
      const name =
        !screen.expanded && goal.source.producer === "bookie"
          ? goal.item.label.replace(/^\/projects\/([^/]+)\/project\.md$/, "$1")
          : goal.item.label;
      lines.push(
        `Goal · ${clean(name)} (${goal.source.producer}${staleSource(goal.source, options) ? "; stale" : ""})`,
      );
    } else if (options.current) lines.push(`Goal · ${clean(options.current)}`);
  }

  if (!items.length)
    lines.push(
      destination === "reviews"
        ? options.connected === false || observation.sources.some((s) => staleSource(s, options))
          ? "Current reviews unknown. Check the parent Pi session."
          : "No reviews reported. [2] Work shows task progress."
        : destination === "evidence"
          ? "No current-session result references observed."
          : "No observations for this view.",
    );
  const selected = items.find((x) => x.key === screen.selectedKey);
  const rows = items.map((x) => rowText(x, destination, x.key === screen.selectedKey));
  const expanded = screen.expanded && width >= 96;
  if (expanded && rows.length) {
    const left = Math.floor(width * 0.45),
      right = width - left - 3;
    const details = [
      selected ? `DETAIL · ${clean(selected.label)}` : "DETAIL",
      ...(selected?.briefDetails ?? selected?.details ?? []),
    ];
    const length = Math.max(rows.length, details.length);
    for (let i = 0; i < length; i++) {
      const a = truncate(clean(rows[i] ?? ""), left);
      lines.push(a + " ".repeat(Math.max(0, left - cellWidth(a))) + " | " + truncate(clean(details[i] ?? ""), right));
    }
  } else {
    lines.push(...rows);
    if (screen.expanded) lines.push("Expanded layout needs 96 columns; same selection retained.");
  }
  if (destination === "now" && screen.expanded) {
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
