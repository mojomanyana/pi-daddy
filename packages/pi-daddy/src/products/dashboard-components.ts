/** Human readouts from observations already held by the parent. Rendering starts no probes. */
import type {
  DashboardContribution,
  DashboardSavedEvidence,
  DashboardSourceSnapshot,
} from "../kernel/dashboard-observation.ts";
import type { DashboardItem, DashboardScreenOptions } from "./dashboard-screen.ts";
import { isBookieChoice } from "../kernel/dashboard-observation.ts";
import type { EcosystemVersionRow } from "./ecosystem-versions.ts";
import { safeDashboardSummary } from "./activity-summary.ts";

const BOOKIE_LIMIT_MESSAGE = "Only a bounded selection of saved open choices could be displayed.";

type KnownSource = "bookie" | "scout-local" | "scout-worker";

export function isComponentObservation(source: DashboardSourceSnapshot, item: DashboardContribution): boolean {
  if (source.producer === "bookie-memory") return item.id === "project-memory" && item.kind === "work";
  return (
    (source.producer === "scout-local" || source.producer === "scout-worker") &&
    item.id === "research" &&
    item.kind === "work"
  );
}

function current(source: DashboardSourceSnapshot, options: DashboardScreenOptions): boolean {
  const age = (options.now?.getTime() ?? Date.now()) - Date.parse(source.observedAt);
  return (
    options.connected !== false &&
    source.availability === "observed" &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= source.staleAfterMs
  );
}

function scoutDescription(worker: boolean, item: DashboardContribution): [string, string] {
  switch (item.state) {
    case "observed":
      return worker
        ? ["Docker untested", "Pi has loaded the research worker. No Docker or internet check was reported."]
        : ["Available", "Pi has loaded the local research tools. Source availability depends on the selected catalog."];
    case "running":
      return worker
        ? ["Preparing research", "Scout is preparing or running a research worker. A result is still pending."]
        : ["Research in progress", "Scout is working with the selected sources."];
    case "settled":
      return [
        "Brief saved",
        worker
          ? "Scout saved the brief and confirmed worker cleanup. The report does not identify whether it used the internet."
          : "Scout saved a local brief. Open Saved results to inspect the source record.",
      ];
    case "failed":
      return ["Last attempt failed", "Open the Scout tool result in the main Pi chat for the reason."];
    case "unknown":
      return [
        "Outcome unknown",
        worker
          ? "Check the last Scout tool result and Docker cleanup before starting more research."
          : "Check the last Scout tool result in the main Pi chat.",
      ];
    case "unavailable":
      return ["Unavailable", "Open the Scout tool result in the main Pi chat for the reported issue."];
    case "dependency-wait":
      return ["Waiting on a dependency", "Scout is waiting for a required part of the task."];
    case "approval-wait":
      return ["Waiting for you", "Check the request in the main Pi chat."];
    case "cancel-requested":
      return ["Stopping", "Scout has received a cancellation request. Cleanup is still pending."];
  }
}

/** Choices are current project observations; a saved question never creates a live input request. */
export function bookieOpenChoices(options: DashboardScreenOptions): DashboardItem[] {
  const source = options.session?.observation?.sources.find((s) => s.producer === "bookie-memory");
  if (
    !options.session?.auto.enabled ||
    !source ||
    !current(source, options) ||
    !source.items.some((i) => isComponentObservation(source, i) && i.state === "observed")
  )
    return [];
  return source.items
    .filter((i) => isBookieChoice(source.producer, i) && i.kind === "work" && i.state === "observed")
    .map((i) => ({
      key: `source:${source.producer}:${source.generation}:${i.id}`,
      label: i.label,
      status: "open-choice",
      elapsed: "",
      briefDetails: ["Saved in this project’s notes.", ...(i.details ?? [])],
      details: [
        ...(i.details ?? []),
        `Source: Bookie ${source.producerVersion}`,
        `Observed at: ${source.observedAt}`,
        ...(i.reference ? [`Reference: ${i.reference}`] : []),
      ],
    }));
}

function componentItem(producer: KnownSource, options: DashboardScreenOptions): DashboardItem | undefined {
  const bookie = producer === "bookie";
  const worker = producer === "scout-worker";
  const title = bookie ? "Bookie memory" : worker ? "Scout research worker" : "Scout local sources";
  const sources = options.session?.observation?.sources;
  const workSource = sources?.find((s) => s.producer === producer);
  const memory = bookie
    ? sources?.find(
        (s) =>
          s.producer === "bookie-memory" && s.items.some((i) => isComponentObservation(s, i) && i.state === "observed"),
      )
    : undefined;
  const source =
    memory && (current(memory, options) || !workSource || !current(workSource, options)) ? memory : workSource;

  const pkg = options.session?.versions?.rows.find((r) => r.id === (bookie ? "bookie-pi-skills" : "pi-scout-research"));
  if (!source && !(pkg?.source || pkg?.loadedVersion || pkg?.installedVersion || pkg?.state === "multiple")) return;
  const item = source?.items.find((i) => isComponentObservation(source, i));
  let state = "observed",
    status: string,
    explanation: string;
  if (options.connected === false || (source && !current(source, options))) {
    state = "last-observed";
    status = "Live status unknown";
    const lastReport =
      source?.producer === "bookie-memory"
        ? "Ready in this folder"
        : item
          ? scoutDescription(worker, item)[0]
          : bookie && source?.items.some((i) => i.kind === "goal" && i.id === "scope")
            ? "Project connected"
            : undefined;
    explanation = (lastReport ? `Last report: ${lastReport}. ` : "") + "Check the main Pi chat for current status.";
  } else if (source?.producer === "bookie-memory") {
    status = "Ready in this folder";
    explanation = "Bookie can save and recall routine notes for this workspace.";
  } else if (bookie && source?.items.length) {
    status = "Project connected";
    explanation = "Bookie is sharing the selected project’s work with Pi.";
  } else if (item) {
    state = item.state;
    [status, explanation] = scoutDescription(worker, item);
  } else if (bookie && (pkg?.commandAvailable || pkg?.loadedVersion)) {
    status = "Available · no project reported";
    explanation = "Use /bookie-context for manual memory or /bookie-work to select a project and plan.";
  } else {
    status =
      pkg?.state === "multiple"
        ? "Multiple installations"
        : pkg?.installedVersion
          ? "Installed · no live report"
          : "No live report";
    explanation = bookie
      ? "Check for /bookie-work in the main Pi chat and select a project. Open Versions for installation details."
      : "Check the loaded Scout extension in the main Pi chat. Research readiness has not been reported.";
  }
  const sourceDetails = item?.details ?? [];
  const isMemory = source?.producer === "bookie-memory";
  const limited =
    isMemory && state === "observed" && options.session?.auto.enabled && sourceDetails.includes(BOOKIE_LIMIT_MESSAGE);
  const briefDetails = limited
    ? [explanation, "Bookie could only show part of this project’s open choices."]
    : [explanation];
  return {
    key: `component:${producer}`,
    label: `${title} · ${status}`,
    status: state,
    elapsed: "",
    briefDetails,
    details: [
      ...briefDetails,
      ...(source
        ? [`Source: ${source.producer} · ${source.producerVersion}`, `Last update: ${source.observedAt}`]
        : []),
      ...sourceDetails.filter((line) => !isMemory || line !== BOOKIE_LIMIT_MESSAGE),
      ...(pkg?.installedVersion ? [`Installed version: ${pkg.installedVersion}`] : []),
      ...(pkg?.loadedVersion ? [`Running version: ${pkg.loadedVersion}`] : []),
    ],
  };
}

export function componentItems(options: DashboardScreenOptions): DashboardItem[] {
  return (["bookie", "scout-local", "scout-worker"] as const)
    .map((id) => componentItem(id, options))
    .filter((item): item is DashboardItem => item !== undefined);
}

export function versionLines(row: EcosystemVersionRow, selected: boolean, options: DashboardScreenOptions): string[] {
  const prefix = selected ? "> " : "  ";
  const bookieSource =
    row.id === "bookie-pi-skills" &&
    options.session?.observation?.sources.some(
      (s) => (s.producer === "bookie" || s.producer === "bookie-memory") && current(s, options),
    );
  let detail: string;
  if (options.connected === false) detail = "Last seen. Reconnect for the running version.";
  else if (row.state === "multiple") detail = "Multiple installations. Open details to check the sources.";
  else if (row.loadedVersion && row.installedVersion && row.loadedVersion !== row.installedVersion)
    detail = `Running ${row.loadedVersion}. ${row.id === "pi" ? "Restart" : "Reload"} Pi to use the installed version.`;
  else if (row.loadedVersion) detail = `Running ${row.loadedVersion}`;
  else if (row.commandAvailable || bookieSource) detail = "Active in Pi. Running version unreported.";
  else detail = row.installedVersion ? "Pi has not reported a running version." : "No running version reported.";
  return [
    prefix +
      row.label +
      (row.installedVersion ? ` · Installed ${row.installedVersion}` : " · Installation unconfirmed"),
    "  " + detail,
  ];
}

export function savedEvidenceItem(artifact: DashboardSavedEvidence, index: number): DashboardItem {
  const result = artifact.description;
  const role = result?.agent?.replace(/[-_]/g, " ");
  const who = role ? role.charAt(0).toUpperCase() + role.slice(1) : "Agent";
  const kind =
    result?.content === "answer" ? "answer" : result?.content === "partial" ? "partial output" : "run record";
  const label = result?.summary ? `${who} · ${result.summary}` : result ? `${who} ${kind}` : `Run record ${index + 1}`;
  const status =
    result?.state === "not-started"
      ? "Did not start"
      : result?.state === "uncertain"
        ? "Outcome uncertain"
        : result?.state === "failed"
          ? "Run failed"
          : result?.content === "partial"
            ? "Partial output saved"
            : "Saved";
  const brief =
    result?.content === "answer"
      ? `Pi saved the final answer from this ${role ?? "agent"} run.`
      : result?.content === "partial"
        ? "Pi saved partial output from this run."
        : "Pi saved a record of this run. Open source details for its exact reference.";
  return {
    key: `artifact:${artifact.executionId}`,
    label,
    status,
    elapsed: "",
    briefDetails: [brief, ...(result?.observedAt ? [`Recorded: ${result.observedAt}`] : [])],
    details: [
      `Operation: ${artifact.operationId}`,
      `Execution: ${artifact.executionId}`,
      `Manifest SHA-256: ${artifact.sha256}`,
      "Producer: pi-daddy",
      "A saved record alone gives no review or approval verdict.",
    ],
  };
}

export function publishedEvidenceItem(
  source: DashboardSourceSnapshot,
  evidence: DashboardContribution,
  display: DashboardItem,
): DashboardItem {
  const scout = source.producer === "scout-worker" || source.producer === "scout-local";
  const author = scout ? "Scout" : source.producer === "bookie" ? "Bookie" : "A connected tool";
  const readable = safeDashboardSummary(evidence.label);
  const title =
    scout && evidence.id === "brief"
      ? source.producer === "scout-worker"
        ? "Scout research brief"
        : "Scout local brief"
      : readable && !/\S[/\\]\S|\b(?:sha\d*|principal):/i.test(readable)
        ? readable
        : `${author === "A connected tool" ? "Tool" : author} evidence record`;
  return {
    ...display,
    label: title,
    status: display.status === "observed" ? (evidence.reference ? "Reference saved" : "Recorded") : display.status,
    briefDetails: [
      `${author} reported this ${scout && evidence.id === "brief" ? "research brief" : "result"} in this session.`,
      ...(evidence.reference ? ["Open source details for the exact reference."] : []),
    ],
    details: [...display.details, ...(title !== evidence.label ? [`Original label: ${evidence.label}`] : [])],
  };
}
