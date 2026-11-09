/** Six current-session destinations share stable row identities; contributions are labels, never authority. */
import type { DashboardContribution, DashboardSourceSnapshot } from "../kernel/dashboard-observation.ts";
import type { DashboardItem, DashboardScreenOptions } from "./dashboard-screen.ts";
import { dashboardText, friendlyStatus } from "./dashboard-screen.ts";
import { activityStoryItems } from "./dashboard-activity.ts";
import {
  componentItems,
  isComponentObservation,
  publishedEvidenceItem,
  savedEvidenceItem,
} from "./dashboard-components.ts";
import { previewWidth, sectionHeading } from "./dashboard-layout.ts";
import { activityTaskKey } from "./activity-timeline.ts";
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
  if (openInstruction >= 0) {
    const choice = taskReview && (label === item.label ? label : item.label.split("/").at(-1));
    brief.splice(
      openInstruction,
      1,
      "In your main Pi chat, run",
      "/bookie-work review",
      ...(choice ? [`If asked, select ${choice}.`] : []),
    );
    const decision = brief.indexOf("Record your review decision for this output in the selected project.");
    if (decision >= 0) brief[decision] = "Read the output and record your decision.";
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
    ...(source.startsWith("bookie@") && reviewTotals(item) ? { reviewSummary: true } : {}),
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
  if (item.key.startsWith("component:")) return marker + label;
  if (item.status === "last-observed") return `${marker}Last seen · ${label}`;
  if (item.reviewSummary) return marker + label;
  if (item.key.startsWith("activity:") && item.status === "observed") return marker + label;
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
            : ["work"];
  const published = observed.sources.flatMap((source) =>
    source.items
      .filter(
        (item) =>
          wanted.includes(item.kind) &&
          !isComponentObservation(source, item) &&
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
        const linked = reviewForTask(item, source, stale);
        const display = row(
          item,
          sourceKey(source, item),
          `${source.producer}@${source.producerVersion} · seq ${source.sequence} · ${source.observedAt}`,
          stale,
          source.producer === "bookie" ? bookieLabel(item, source) : item.label,
          linked,
        );
        if (linked) display.relatedReviewKey = sourceKey(source, linked);
        return item.kind === "evidence" ? publishedEvidenceItem(source, item, display) : display;
      }),
  );
  if (destination === "reviews") {
    const first = sessionNext(options)?.reviewKey;
    const priority = (item: DashboardItem) =>
      item.key === first ? 2 : Number(item.status === "approval-wait" && !item.reviewSummary);
    return published.sort((a, b) => priority(b) - priority(a));
  }
  if (destination === "evidence") return [...(observed.artifacts ?? []).map(savedEvidenceItem), ...published];
  if (destination === "activity")
    return [...activityStoryItems(observed.activity ?? [], observed.generation, staleOwner), ...published];
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
  const ownerTurn = observed.turn;
  const tasks = native.map((item) => {
    // A running parent can supply a more recent public tool purpose than its persisted start record.
    if (
      activity &&
      item.taskKey === activityTaskKey(activity.rootId, activity.taskId) &&
      ownerTurn?.state === "running" &&
      !staleOwner &&
      ["running", "active"].includes(item.status)
    )
      return { ...item, label: ownerTurn.label };
    return item;
  });
  const items = [
    ...(ownerTurn && !parentShown
      ? [row(ownerTurn, `owner:${observed.generation}:${ownerTurn.id}`, "Pi owner", staleOwner)]
      : []),
    ...tasks,
    ...published,
  ];
  items.sort((a, b) => {
    const rank = workGroups.indexOf(workGroup(a)) - workGroups.indexOf(workGroup(b));
    return rank || (workGroup(a) === "Recently finished" ? (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") : 0);
  });
  if (destination !== "now") return items;
  // Tasks has the complete queue. Keep the overview navigable even after a long session.
  // A producer may publish a review without a matching task or a recommended next action.
  const represented = new Set(items.map((i) => i.relatedReviewKey).filter(Boolean));
  for (const source of observed.sources) {
    if (staleSource(source, options)) continue;
    for (const review of source.items) {
      const key = sourceKey(source, review);
      if (
        review.kind === "review" &&
        review.state === "approval-wait" &&
        review.reference &&
        !reviewTotals(review) &&
        !represented.has(key)
      )
        items.push(row(review, key, `${source.producer}@${source.producerVersion}`));
    }
  }
  const nextReview = sessionNext(options)?.reviewKey;
  if (nextReview) {
    const index = items.findIndex((i) => i.relatedReviewKey === nextReview || i.key === nextReview);
    // Keep task rows ahead of independent review rows; Reviews opens the exact recommended output.
    if (index > 0 && items[index]?.relatedReviewKey === nextReview) items.unshift(items.splice(index, 1)[0]!);
  }
  const shown = workGroups.flatMap((group) => {
    const matches = items.filter((item) => workGroup(item) === group);
    return matches.slice(0, group === "Recently finished" ? 2 : 3);
  });
  const recent = shown.some((i) => workGroup(i) === "Recently finished")
    ? []
    : activityStoryItems(observed.activity ?? [], observed.generation, staleOwner).slice(0, 2);
  return [...shown, ...recent, ...componentItems(options)];
}

const workGroups = [
  "Needs your permission",
  "Needs your decision",
  "Needs attention",
  "In progress",
  "Other tasks",
  "Recently finished",
  "Last known",
  "Tools",
];
function workGroup(item: DashboardItem): string {
  if (item.key.startsWith("component:")) return "Tools";
  if (item.key.startsWith("activity:")) return "Latest activity";
  if (["last-observed", "historical"].includes(item.status)) return "Last known";
  if (item.approval) return "Needs your permission";
  if (item.status === "approval-wait") return "Needs your decision";
  if (["needs-you", "failed", "refused", "incomplete", "dependency-wait"].includes(item.status))
    return "Needs attention";
  if (["running", "active", "starting", "authorised", "cancel-requested"].includes(item.status)) return "In progress";
  if (["settled", "completed", "finished", "cancelled", "historical", "last-observed"].includes(item.status))
    return "Recently finished";
  return "Other tasks";
}

function listHeading(item: DashboardItem, destination: DashboardDestination) {
  if (destination === "now" || destination === "work")
    return destination === "work" && workGroup(item) === "Recently finished" ? "Finished" : workGroup(item);
  if (destination === "reviews")
    return item.status === "approval-wait" && !item.reviewSummary ? "Waiting for your review" : "Review records";
  return destination === "evidence"
    ? "Saved results"
    : item.key.startsWith("source:")
      ? "Current reports"
      : "What happened";
}
export function sessionPanelLines(options: DashboardScreenOptions, items: DashboardItem[], width: number): string[] {
  const observation = options.session!.observation!,
    screen = options.screen;
  const destination = screen.destination ?? "now";
  const sourceRows = observation.sources.flatMap((s) => s.items.map((item) => ({ source: s, item })));
  const lines: string[] = [];
  const initiative = observation.sources.find((source) => source.producer === "daddy-initiative");
  const scope = initiative?.items.find((item) => item.id === "scope");
  const roomy = options.height >= 22;
  if (destination === "work") {
    lines.push("All session tasks, grouped by status.");
    if (scope) {
      lines.push(`Selected ${clean(scope.label)}${staleSource(initiative!, options) ? " (last known)" : ""}`);
      if (scope.details?.[1]) lines.push(scope.details[1]);
    }
  }
  if (destination === "now") {
    const goals = sourceRows.filter((x) => x.item.kind === "goal");
    const goal = goals.find((x) => !staleSource(x.source, options)) ?? goals[0];
    if (goal) {
      const project = goal.source.producer === "bookie" && /^\/projects\/([^/]+)\/project\.md$/.exec(goal.item.label);
      lines.push(project ? `Project · ${clean(project[1]!)}` : `Goal · ${clean(goal.item.label)}`);
      if (staleSource(goal.source, options)) lines[lines.length - 1] += " (last known)";
    }
  }
  if (!items.length) {
    const fallback =
      destination === "reviews"
        ? options.connected === false || observation.sources.some((s) => staleSource(s, options))
          ? "Current reviews unknown. Check the main Pi chat."
          : "No reviews waiting. Open [2] Tasks to see progress."
        : destination === "evidence"
          ? "No saved results reported to this dashboard."
          : destination === "activity"
            ? "No activity has been recorded in this session yet."
            : "No tasks reported for this session yet.";
    lines.push(fallback);
  }
  const left = previewWidth(destination, Boolean(screen.expanded), width);
  const rows: string[] = [];
  for (let start = 0; start < items.length;) {
    const group = listHeading(items[start]!, destination);
    let end = start + 1;
    while (end < items.length && listHeading(items[end]!, destination) === group) end++;
    if (roomy && (rows.length || lines.length)) rows.push("");
    const count = destination === "now" ? "" : ` · ${end - start}`;
    rows.push(sectionHeading(group + count, left ?? width));
    for (const item of items.slice(start, end)) rows.push(rowText(item, destination, item.key === screen.selectedKey));
    start = end;
  }
  lines.push(...rows);
  if (destination === "now" && options.height >= 18 && items.some((i) => !i.key.startsWith("component:"))) {
    if (roomy) lines.push("");
    lines.push("[2] Tasks · See the full task list");
  }
  if (screen.expanded && left === undefined)
    lines.push("Side-by-side layout needs 82 columns; same selection retained.");
  if (destination === "now" && screen.expanded) {
    lines.push(sectionHeading("Resource details", width));
    const resource = observation.resources;
    lines.push(`Parent RSS: ${(resource.rssBytes / 1024 / 1024).toFixed(1)} MiB`, "Host and child memory: unknown");
  }
  return lines;
}
