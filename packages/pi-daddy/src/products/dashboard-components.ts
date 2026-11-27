/** Human readouts from observations already held by the parent. Rendering starts no probes. */
import type {
  DashboardContribution,
  DashboardSavedEvidence,
  DashboardSourceSnapshot,
} from "../kernel/dashboard-observation.ts";
import type { DashboardItem, DashboardScreenOptions } from "./dashboard-screen.ts";
import { validChoiceId } from "../kernel/dashboard-choice.ts";
import { isBookieChoice } from "../kernel/dashboard-observation.ts";
import type { EcosystemVersionRow } from "./ecosystem-versions.ts";
import { safeDashboardSummary } from "./activity-summary.ts";
import { inventoryPresentation, observationAge } from "./dashboard-inventory-view.ts";
import { currentDeliveryItem } from "./dashboard-delivery.ts";

const BOOKIE_LIMIT_MESSAGE = "Only a bounded selection of saved open choices could be displayed.";

type KnownSource = "bookie" | "scout-local" | "scout-worker";

export function isComponentObservation(source: DashboardSourceSnapshot, item: DashboardContribution): boolean {
  if (["bookie-memory", "scout-local", "scout-worker"].includes(source.producer) && item.id === "availability")
    return item.kind === "status";
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

function memoryDescription(item: DashboardContribution | undefined, partial: boolean): [string, string] {
  if (item?.state === "observed")
    return ["Ready in this folder", "Bookie can save and recall routine notes for this workspace."];
  return [
    item?.state === "unavailable" ? "Memory unavailable" : partial ? "Notes partially checked" : "Cannot check notes",
    item?.details?.[0] ?? "The current project notes could not be checked. Previous history is not confirmed empty.",
  ];
}

function memoryActive(options: DashboardScreenOptions) {
  return options.session?.workspaceMemoryActive ?? options.session?.auto.enabled;
}

/** Choices are current project observations; a saved question never creates a live input request. */
export function bookieOpenChoices(options: DashboardScreenOptions): DashboardItem[] {
  const source = options.session?.observation?.sources.find((s) => s.producer === "bookie-memory");
  if (
    !options.session ||
    !memoryActive(options) ||
    !source ||
    !current(source, options) ||
    !source.items.some((i) => isComponentObservation(source, i) && i.state === "observed")
  )
    return [];
  const owner = options.session.observation;
  const canAnswer = owner && options.session.choiceControls?.sourceGeneration === source.generation;
  return source.items
    .filter((i) => isBookieChoice(source.producer, i) && i.kind === "work" && i.state === "observed")
    .map((i) => ({
      key: `source:${source.producer}:${source.generation}:${i.id}`,
      label: i.label,
      status: "open-choice",
      ...(canAnswer && options.session?.choiceControls?.reclassify === true ? { reclassifyChoice: true as const } : {}),
      ...(canAnswer && validChoiceId(i.id)
        ? {
            choice: {
              choiceId: i.id,
              sourceGeneration: source.generation,
              expectedOwner: {
                sessionId: owner.sessionId,
                cwd: owner.cwd,
                generation: owner.generation,
              },
            },
          }
        : {}),
      elapsed: "",
      briefDetails: [
        "Saved in this project’s notes.",
        ...(i.details ?? []),
        ...(canAnswer ? [] : ["This Bookie connection offers viewing only."]),
      ],
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
        (s) => s.producer === "bookie-memory" && s.items.some((i) => isComponentObservation(s, i) && i.kind === "work"),
      )
    : undefined;
  const source =
    memory && (current(memory, options) || !workSource || !current(workSource, options)) ? memory : workSource;

  const pkg = options.session?.versions?.rows.find((r) => r.id === (bookie ? "bookie-pi-skills" : "pi-scout-research"));
  if (!source && !(pkg?.source || pkg?.loadedVersion || pkg?.installedVersion || pkg?.state === "multiple")) return;
  const item = source?.items.find((i) => isComponentObservation(source, i) && i.kind === "work");
  const availability = source?.items.find((i) => i.id === "availability" && i.kind === "status");
  let state = "observed",
    status: string,
    explanation: string;
  if (
    options.connected === false ||
    source?.refresh?.state === "failed" ||
    (source && !current(source, options) && !(source.producer === "bookie-memory" && memoryActive(options) === false))
  ) {
    state = "last-observed";
    status =
      options.connected === false
        ? "Disconnected"
        : source?.availability === "closed"
          ? "Status connection ended"
          : source?.refresh?.state === "checking"
            ? "Checking status"
            : source?.refresh?.state === "failed"
              ? "Status check unavailable"
              : "Status update overdue";
    const lastReport =
      source?.producer === "bookie-memory"
        ? memoryDescription(item, source.inventory?.state === "available")[0]
        : item
          ? scoutDescription(worker, item)[0]
          : bookie && source?.items.some((i) => i.kind === "goal" && i.id === "scope")
            ? "Project connected"
            : undefined;
    explanation =
      (lastReport ? `Last report: ${lastReport}. ` : "") +
      (options.connected === false
        ? "Reconnect to Pi to check current availability."
        : source?.availability === "closed"
          ? "The producer's status connection is no longer active."
          : source?.refresh?.state === "checking"
            ? "A fresh status check is in progress."
            : source?.refresh?.state === "failed"
              ? "The producer could not return a current report; a later refresh can try again."
              : "The previous report expired. Current availability has not yet been rechecked.");
  } else if (
    bookie &&
    options.session &&
    !memoryActive(options) &&
    (source?.producer === "bookie-memory" || pkg?.commandAvailable || pkg?.loadedVersion) &&
    !(source?.producer === "bookie" && current(source, options) && source.items.length)
  ) {
    const legacy = options.session.workspaceMemoryActive === undefined;
    status = legacy ? "Automatic memory paused · Auto OFF" : "Workspace memory inactive";
    if (legacy) {
      const origin = {
        session: "Auto was turned off for this session.",
        environment: "Pi started with Auto off.",
        default: "Auto starts off by default.",
      }[options.session.auto.source];
      explanation = `${origin} Turn Auto on for automatic notes or use /bookie-context. A session toggle does not change the startup setting.`;
    } else explanation = "Check Bookie workspace memory in Ecosystem settings and open Pi in a trusted workspace.";
  } else if (source?.producer === "bookie-memory") {
    state = item?.state ?? "unknown";
    [status, explanation] = memoryDescription(item, source.inventory?.state === "available");
  } else if (bookie && source?.items.length) {
    status = "Project connected";
    explanation = "Bookie is sharing the selected project’s work with Pi.";
  } else if (availability) {
    state = availability.state;
    status = availability.label;
    explanation = availability.details?.[0] ?? "Current availability reported by Scout.";
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
    isMemory && state === "observed" && memoryActive(options) && sourceDetails.includes(BOOKIE_LIMIT_MESSAGE);
  const explanationLines = limited
    ? [explanation, "Bookie could only show part of this project’s open choices."]
    : [explanation];
  const canShowInventory = source && current(source, options) && (!bookie || memoryActive(options));
  const showInventory = canShowInventory && source.refresh?.state !== "failed";
  const inventory = inventoryPresentation(showInventory ? source.inventory : undefined);
  const age = observationAge(source, options.now?.getTime() ?? Date.now());
  const briefDetails = [
    ...explanationLines,
    ...(source?.inventory || state === "last-observed" ? [age] : []),
    ...inventory.content,
  ];
  return {
    key: `component:${producer}`,
    label: `${title} · ${status}`,
    status: state,
    elapsed: "",
    briefDetails,
    ...(source?.inventory && showInventory ? { browse: true, previewLines: inventory.preview } : {}),
    details: [
      ...briefDetails,
      age,
      ...inventory.references,
      ...(source
        ? [`Source: ${source.producer} · ${source.producerVersion}`, `Last update: ${source.observedAt}`]
        : []),
      ...sourceDetails.filter((line) => !isMemory || line !== BOOKIE_LIMIT_MESSAGE),
      ...(pkg?.installedVersion ? [`Installed version: ${pkg.installedVersion}`] : []),
      ...(pkg?.loadedVersion ? [`Running version: ${pkg.loadedVersion}`] : []),
    ],
  };
}

/** Task summaries are visible only while the granting Bookie source is current. */
export function currentTaskItem(options: DashboardScreenOptions): DashboardItem | undefined {
  const source = options.session?.observation?.sources.find((s) => s.producer === "bookie-memory");
  const history = source?.taskHistory;
  if (!history) return currentDeliveryItem(options, current);
  if (!source || !current(source, options) || source.refresh?.state === "failed") return;
  const last = history.lastObservation;
  const recent = last ? [`Last recorded · ${last.label}`] : [];
  const progress = history.recentProgress ?? [];
  const checkpoint = history.lastCheckpoint;
  const capture = checkpoint
    ? [
        checkpoint.state === "published"
          ? "Checkpoint saved to private history"
          : "Checkpoint captured · awaiting publication",
      ]
    : [];
  const policy = options.session?.taskDispatch;
  const controls = policy?.taskId === history.taskId && policy.counts ? policy : undefined;
  const dispatch = controls
    ? [
        `Task dispatch · ${controls.state} · ${controls.outstanding} awaiting cleanup`,
        `${controls.admitted} total attempts · ${controls.limit === null ? "no shared cap" : "shared limit " + controls.limit}`,
        ...Object.entries(controls.counts)
          .filter(([owner, c]) => owner === "pi-daddy" || c.admitted || c.limit !== null)
          .map(
            ([owner, c]) =>
              `${owner}: ${c.admitted} admitted · ${c.limit === null ? "no attempt cap" : "limit " + c.limit}`,
          ),
      ]
    : [];
  const details = [
    ...capture,
    ...(checkpoint
      ? [
          `${checkpoint.files} files · ${checkpoint.missing} missing · ${checkpoint.excluded} excluded · captured ${checkpoint.capturedAt}`,
        ]
      : []),
    ...(progress.length
      ? [
          "Recent reported progress",
          ...progress.map((row) => `${row.label} · ${row.state} · ${row.owner} · ${row.recordedAt}`),
        ]
      : []),
    ...dispatch,
    ...(controls?.inherited ? ["Shared with this task’s parent. Select the parent task to change controls."] : []),
    ...(!controls ? ["Task dispatch controls unavailable in this session."] : []),
    ...(controls?.observedAt ? ["Dispatch state checked " + controls.observedAt] : []),
    ...recent,
    ...(last ? [`Reported by ${last.owner} · ${last.recordedAt}`, `Recorded state: ${last.state}`] : []),
    `${history.observations} recorded observation${history.observations === 1 ? "" : "s"} from connected tools.`,
    "History coverage is partial. An owner can finish while Bookie is unavailable.",
    "Open the producing tool’s receipt to verify a delivery.",
  ];
  const task: DashboardItem = {
    ...(controls && !controls.inherited ? { dispatchTaskId: history.taskId } : {}),
    key: `selected-task:${source.generation}:${history.taskId}`,
    label: history.title,
    status: "selected",
    elapsed: "",
    previewLines: [
      ...dispatch.slice(0, 1),
      ...(progress.length
        ? ["Last reported step · " + progress[0]!.label]
        : recent.length
          ? recent
          : ["No owner observations recorded yet."]),
      ...capture,
    ],
    briefDetails: details,
    details: [
      ...details,
      `Task: ${history.taskId}`,
      "In Pi, /bookie-task switch opens other task histories.",
      ...(controls && !controls.inherited
        ? [
            ":task pause stops new task operations. :task cancel also signals participating workers.",
            ":task resume allows new work. :task budget [task|pi-daddy|scout|harness|jev] <attempts|off> sets an owner cap.",
          ]
        : []),
    ],
  };
  return currentDeliveryItem(options, current, history.taskId, task);
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
