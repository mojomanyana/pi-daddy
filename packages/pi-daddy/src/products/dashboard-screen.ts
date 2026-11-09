import type { DashboardAcknowledgment } from "./dashboard-session-client.ts";
import {
  sessionDashboardItems,
  sessionNextLines,
  sessionPanelLines,
  DASHBOARD_DESTINATIONS,
  type DashboardDestination,
} from "./dashboard-panels.ts";
import { activityTaskTitle } from "./dashboard-activity.ts";
import { versionLines } from "./dashboard-components.ts";
import { sessionRecapLines } from "./dashboard-recap.ts";
import { colorSessionLine, previewWidth, sectionHeading } from "./dashboard-layout.ts";
import { visibleSettingKeys, dashboardSettingsLines, type DashboardSettingKey } from "./dashboard-settings.ts";
/** Height-bounded, task-first view. Permission state is always supplied by the owner. */
import type { EcosystemVersionRow } from "./ecosystem-versions.ts";
import type { DashboardProjection } from "./dashboard-projection.ts";
import { ActivityTimelineAliases, activityTaskKey, type ActivityTimeline } from "./activity-timeline.ts";
import { cellWidth, truncate } from "./dashboard-render.ts";
import type { DashboardSessionSnapshot } from "./dashboard-session-client.ts";

export interface DashboardItem {
  key: string;
  label: string;
  status: string;
  elapsed: string;
  updatedAt?: string;
  details: string[];
  briefDetails?: string[];
  reviewSummary?: boolean;
  relatedReviewKey?: string;
  observation?: string;
  taskKey?: string;
  timelinePath?: string;
  approval?: boolean;
  skills?: boolean;
  agent?: boolean;
}
export interface DashboardScreenState {
  view: "main" | "details" | "models" | "help" | "versions" | "version-details" | "settings" | "recap";
  destination?: DashboardDestination;
  expanded?: boolean;
  sourceDetails?: boolean;
  manualScroll?: boolean;
  selections?: Record<string, string>;
  settingKey?: DashboardSettingKey;
  settingKeys?: DashboardSettingKey[];
  versionId?: EcosystemVersionRow["id"];
  versionRows?: EcosystemVersionRow[];
  selectedKey?: string;
  offset: number;
  items: DashboardItem[];
}
export const dashboardScreenState = (): DashboardScreenState => ({ view: "main", offset: 0, items: [] });
export const dashboardText = (value: string) =>
  value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ");
const clean = (value: string) => dashboardText(value).replace(/\s+/g, " ").trim();
export function wrapDashboardLines(lines: string[], width: number): string[] {
  return lines.flatMap((line) => {
    const safe = dashboardText(line);
    if (cellWidth(safe) <= width) return [safe];
    const indent = width >= 12 && (safe.startsWith("> ") || safe.startsWith("  ")) ? safe.slice(0, 2) : "";
    const available = width - indent.length;
    const result: string[] = [];
    let row = "";
    for (const word of safe.slice(indent.length).split(/\s+/)) {
      if (row && cellWidth(row + " " + word) > available) {
        result.push(row);
        row = "";
      }
      if (cellWidth(word) > available) {
        for (const character of word) {
          if (row && cellWidth(row + character) > available) {
            result.push(row);
            row = "";
          }
          row += character;
        }
      } else row += (row ? " " : "") + word;
    }
    result.push(row);
    return result.map((part, i) => (i === 0 ? indent : " ".repeat(indent.length)) + part);
  });
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return seconds >= 3600
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
export const friendlyStatus = (status: string) =>
  ({
    active: "Running",
    running: "Running",
    starting: "Starting",
    authorised: "Authorized",
    observed: "Reported",
    "cancel-requested": "Cancel requested",
    unknown: "Unknown",
    unavailable: "Unavailable",
    "needs-you": "Needs you",
    "approval-wait": "Awaiting decision",
    "dependency-wait": "Waiting on dependency",
    "last-observed": "Last seen",
    settled: "Finished",
    completed: "Finished",
    finished: "Finished",
    failed: "Failed",
    refused: "Blocked",
    incomplete: "Incomplete",
    cancelled: "Canceled",
    historical: "Recorded",
  })[status] ?? status;
const versionStatus = (row: EcosystemVersionRow): string => {
  if (row.state === "reload-required") return row.id === "pi" ? "Restart needed" : "Reload needed";
  if (row.state === "not-reported") return "Loaded version unknown";
  if (row.state === "multiple") return "Multiple sources";
  if (row.state === "current" && row.loadedVersion && row.loadedVersion === row.installedVersion)
    return "Up to date on disk";
  return "Unavailable";
};
const attention = (status: string) => ["failed", "refused", "incomplete"].includes(status);
const active = (status: string) => ["active", "running", "starting", "authorised", "needs-you"].includes(status);
export function ledgerDashboardItems(projection: DashboardProjection): DashboardItem[] {
  return projection.nodes.map((node) => ({
    key: node.executionId,
    label: node.agentName || "Governed execution",
    status: node.state,
    elapsed: elapsed(node.durationMs),
    updatedAt: node.updatedAt,
    agent: true,
    details: [
      `Execution: ${node.executionId}`,
      `State: ${friendlyStatus(node.state)} (observation, not acceptance)`,
      `Grant: ${node.effectiveGrant.join(", ") || "none"}`,
      ...(node.workspace
        ? [`Workspace: ${node.workspace.id} (${node.workspace.access})`, `Root: ${node.workspace.root}`]
        : ["Workspace binding: none recorded"]),
      `Last lifecycle event: ${node.updatedAt}`,
      ...(node.runtime?.herdrPaneId ? [`Pane: ${node.runtime.herdrPaneId}`] : []),
      ...(node.correlation?.phase ? [`Phase: ${node.correlation.phase}`] : []),
      ...(node.executor ? [`Executor: ${node.executor}`] : []),
    ],
  }));
}
export function activityDashboardItems(
  timeline: ActivityTimeline,
  aliases: ActivityTimelineAliases,
  now: Date,
  human = false,
): DashboardItem[] {
  return timeline.tasks.map((task) => ({
    key: activityTaskKey(task.rootId, task.id),
    taskKey: activityTaskKey(task.rootId, task.id),
    label: human
      ? activityTaskTitle(task)
      : `${task.agent || (task.trigger?.type === "custom" ? "Extension turn" : "User turn")} [${aliases.selector(task)}]`,
    status: task.status,
    updatedAt: task.endedAt ?? task.lastEvent?.at ?? task.startedAt,
    elapsed: elapsed(Date.parse(task.endedAt ?? now.toISOString()) - Date.parse(task.startedAt)),
    observation: task.lastEvent
      ? `${task.lastEvent.tool ? `${task.lastEvent.tool} ` : ""}${task.lastEvent.kind.replaceAll("_", " ")} · ${elapsed(Date.parse(now.toISOString()) - Date.parse(task.lastEvent.at))} ago`
      : undefined,
    agent: Boolean(task.agent || task.agents.length),
    skills: task.skills.length > 0,
    details: [
      `Task: ${aliases.selector(task)}`,
      `State: ${friendlyStatus(task.status)} (observation, not acceptance)`,
      ...(task.trigger?.type === "custom" ? [`Trigger: extension message (${task.trigger.customType})`] : []),
      ...(task.cwd ? [`Working directory: ${task.cwd}`] : ["Working directory: not recorded"]),
      ...(task.lastEvent
        ? [
            `Last observed: ${task.lastEvent.kind}${task.lastEvent.tool ? ` (${task.lastEvent.tool})` : ""} at ${task.lastEvent.at}`,
          ]
        : []),
      "Silence is not proof of a stalled process. Finished is not review approval.",
      ...(task.parentTaskId ? [`Parent: ${task.parentTaskId}`] : []),
      ...(task.model ? [`Model: ${task.model}`] : []),
      ...(task.thinking ? [`Thinking: ${task.thinking}`] : []),
      ...task.skills.map(
        (skill) =>
          `Skill ${skill.name}: ${skill.active ? "declared active" : skill.read ? "read" : "available"}${skill.superseded ? ", superseded" : ""}`,
      ),
      ...(task.prompt || task.final ? ["p prompt / f final (retained content only)"] : []),
    ],
  }));
}
export interface DashboardScreenOptions {
  width: number;
  height: number;
  screen: DashboardScreenState;
  items: DashboardItem[];
  session?: DashboardSessionSnapshot;
  history?: boolean;
  filter?: string;
  notice?: string;
  pending?: boolean;
  problem?: string;
  current?: string;
  currentStatus?: string;
  color?: boolean;
  content?: { title: string; text: string };
  command?: string;
  connected?: boolean;
  acknowledgment?: DashboardAcknowledgment;
  now?: Date;
}
const destinationNames: Record<DashboardDestination, string> = {
  now: "Overview",
  work: "Tasks",
  reviews: "Reviews",
  activity: "Activity",
  evidence: "Evidence",
  settings: "Settings",
};
function sessionLocation(screen: DashboardScreenState, width: number): string {
  const destination = screen.destination ?? "now";
  const overlays = {
    details: "Details",
    models: "Models",
    help: "Help",
    versions: "Versions",
    "version-details": "Version details",
    recap: "Session recap",
  };
  const name = destinationNames[destination];
  if (screen.view in overlays) return `${name} / ${overlays[screen.view as keyof typeof overlays]}`;
  const nav = DASHBOARD_DESTINATIONS.map((view, i) =>
    view === destination ? `[${i + 1} ${name}]` : `${i + 1} ${destinationNames[view]}`,
  ).join("  ");
  return cellWidth(nav) <= width
    ? nav
    : `[${DASHBOARD_DESTINATIONS.indexOf(destination) + 1} ${name}]  ·  1–6 views  ·  ? help`;
}

function sessionKeys(screen: DashboardScreenState, selected: DashboardItem | undefined, width: number): string[] {
  const view = screen.view;
  const brief = width < 34;
  if (view === "main") {
    const keys = selected ? (brief ? "↑↓ · Enter details" : "↑↓ select · Enter details") : "1–6 views";
    return [keys + (brief ? " · ?" : " · ? help"), "r recap · q close"];
  }
  if (view === "versions" || view === "settings")
    return [view === "settings" ? "↑↓ select · Enter edit" : "↑↓ select · Enter details", "Esc back · ? help"];
  return [
    brief ? "↑↓ scroll · Esc back" : "↑↓ scroll · Esc back · q close",
    ...(view === "details" && selected?.taskKey ? ["p prompt · f final · ? help"] : []),
    ...(view === "details" && selected?.briefDetails ? [screen.sourceDetails ? "x hide source" : "x show source"] : []),
  ];
}
const permissionDescriptions: Record<string, string> = {
  "tool:bash": "shell access",
  "tool:write": "permission to write files",
  "tool:edit": "permission to edit files",
};
/** Selection follows stable identity through refresh, never an unrelated task at the old row index. */
export function renderDashboardScreen(options: DashboardScreenOptions): string {
  const width = Math.max(1, Math.floor(options.width)),
    height = Math.max(1, Math.floor(options.height));
  const { screen, session } = options,
    pending = session?.pendingApprovals ?? [];
  const modern = Boolean(session?.observation);
  const approvals: DashboardItem[] = (options.connected === false ? [] : pending).map((approval) => ({
    key: `approval:${approval.id}`,
    label: modern
      ? `${clean(approval.subject)} needs ${permissionDescriptions[approval.capability] ?? approval.capability}`
      : `${approval.subject} · ${approval.capability.replace(/^tool:/, "")}`,
    ...(modern
      ? {
          briefDetails: [
            "Open the permission request in your main Pi chat.",
            "Choose whether to grant this access for the task.",
          ],
        }
      : {}),
    status: "needs-you",
    elapsed: "",
    approval: true,
    details: [
      `Approval: ${approval.id}`,
      `Subject: ${approval.subject}`,
      `Capability: ${approval.capability}`,
      "Waiting for Daddy permission in the owner session.",
      "Respond to the permission request in the parent Pi session.",
    ],
  }));
  const allItems = [
    ...(!modern || ["now", "work"].includes(screen.destination ?? "now") ? approvals : []),
    ...(modern ? sessionDashboardItems(options) : options.items),
  ];
  const items = allItems.filter((item) =>
    options.filter === "agents"
      ? item.agent
      : options.filter === "skills"
        ? item.skills
        : options.filter === "needs-you"
          ? ["needs-you", "approval-wait"].includes(item.status)
          : true,
  );
  const live = items.filter((item) => active(item.status)),
    needsAttention = items.filter((item) => attention(item.status)),
    past = items.filter((item) => !active(item.status) && !attention(item.status)).reverse();
  screen.items = modern ? items : [...live, ...needsAttention, ...(options.history ? past : [])];
  if (screen.view === "details" && !screen.items.some((item) => item.key === screen.selectedKey)) {
    const detail = items.find((item) => item.key === screen.selectedKey);
    if (detail) screen.items.push(detail);
  }
  if (
    !screen.items.some((item) => item.key === screen.selectedKey) &&
    !(screen.view === "details" && screen.selectedKey)
  )
    screen.selectedKey = screen.items[0]?.key;
  const selectedIndex = screen.items.findIndex((item) => item.key === screen.selectedKey),
    selected = screen.items[selectedIndex];
  screen.versionRows = session?.versions?.rows ?? [];
  if (!screen.versionRows.some((row) => row.id === screen.versionId)) screen.versionId = screen.versionRows[0]?.id;
  const selectedVersion = screen.versionRows.find((row) => row.id === screen.versionId);
  const mode =
    session && options.connected !== false ? `Auto ${session.auto.enabled ? "ON" : "OFF"}` : "Auto unavailable";
  const header = `PI DADDY | ${mode}${options.pending ? " …" : session && options.connected !== false ? " [a]" : ""}`;
  const footer =
    options.command !== undefined
      ? [`: ${clean(options.command)}`]
      : modern
        ? sessionKeys(screen, selected, width)
        : screen.view === "settings"
          ? ["↑↓ select · Enter toggle/edit · Esc back", "0 default limit · PgUp/PgDn scroll · s settings"]
          : screen.view === "main" || screen.view === "versions"
            ? ["↑↓ select · Enter details · a Auto", "m models · v versions · s settings · ?"]
            : [
                "↑↓ scroll · Esc back · a Auto",
                screen.view === "details" ? "p prompt · f final · : command · ? help" : ": command · ? help",
              ];
  const fixed = [
    modern && options.connected !== false ? `${header} · Connected` : header,
    ...(!modern
      ? [
          session && options.connected !== false
            ? `Permissions connected${pending.length ? ` · ${pending.length} needs you` : ""}`
            : "Permission controls disconnected",
        ]
      : []),
    ...(modern ? [sessionLocation(screen, width)] : []),
  ];
  const disconnected = modern && options.connected === false;
  if (disconnected) fixed.push("Disconnected · showing last known status");
  else if (options.notice || options.problem) fixed.push(`! ${clean(options.notice || options.problem || "")}`);
  const ack = options.acknowledgment;
  if (ack?.state === "unconfirmed") {
    const setting =
      (
        {
          "set-auto": "Auto",
          "set-jev": "JEV",
          "edit-jev": "JEV settings",
          set: "model",
          "set-limit": "limit",
        } as Record<string, string>
      )[ack.action] ?? "setting";
    fixed.push(
      ...wrapDashboardLines([`Unconfirmed ${setting} change. Check the main Pi chat before trying again.`], width),
    );
  } else if (ack && (!disconnected || !modern) && (!modern || screen.view === "settings" || ack.state === "refused")) {
    fixed.push(
      ack.action === "edit-jev" && ack.state === "opened"
        ? "JEV settings · current values below"
        : clean(`${ack.action}: ${ack.state} · ${ack.effect}`),
    );
  }
  if (modern && options.filter && options.filter !== "everything" && screen.view === "main")
    fixed.push(`Filter: ${options.filter} · Tab to change`);
  if (modern && options.height >= 22) fixed.push("");
  if (modern && screen.view === "main" && (screen.destination ?? "now") === "now" && !disconnected) {
    const [heading, action] = sessionNextLines(options);
    const recommendation = action !== "No current next step reported.";
    if (recommendation) {
      const title = heading.includes("[3]") ? "Next step · [3] Reviews" : "Next step";
      fixed.push(sectionHeading(title, width), ...wrapDashboardLines([action], width).slice(0, 2));
    } else if (!allItems.some((i) => i.approval || ["needs-you", "approval-wait"].includes(i.status))) {
      fixed.push("No decision requested from you.");
    }
    if (options.height >= 22) fixed.push("");
  }
  const body: string[] = [];
  if (screen.view === "recap") {
    const recap = sessionRecapLines(options);
    const activity = recap.findIndex(
      (line) => line === "Recent activity · newest first" || line === "No recent session events recorded.",
    );
    const summary = activity < 0 ? recap : recap.slice(0, activity);
    if (summary.length) body.push(sectionHeading("SESSION STATUS", width), ...summary);
    if (activity >= 0)
      body.push(
        sectionHeading("RECENT ACTIVITY", width),
        ...recap.slice(activity + Number(recap[activity] === "Recent activity · newest first")),
      );
  } else if (screen.view === "help")
    body.push(
      "DASHBOARD KEYS",
      "↑/↓ or j/k: select; Enter/d: details",
      "a: toggle Daddy permission Auto",
      "m: session models; v: ecosystem versions; s: settings",
      "1 Overview · what needs you and what Pi is doing",
      "2 Tasks · full session task list, including finished work",
      "3 Reviews · 4 Activity · 5 Evidence · 6 Settings",
      "r: recent session activity and review counts",
      "Wide terminals preview the selected item. x shows more session information.",
      "x in a review detail: show or hide its source and exact reference",
      "No cancellation shortcut: request it in the owning Pi session.",
      "Goals/next steps are owner recommendations, not execution authority.",
      "Reviews apply only to their exact subject; completed is not accepted.",
      "Evidence rows are references; content needs its authorized resolver.",
      "Memory sample covers the parent only; host/child memory is unknown.",
      "h: show/hide finished history",
      "Tab: Everything / Agents / Skills / Needs-you",
      "p/f: selected retained prompt/final",
      ": opens commands (legacy selectors and m edits)",
      "Esc: back; q/Ctrl-C: close dashboard",
      "Auto changes future Daddy permission handling.",
      "OFF does not cancel already admitted work.",
      "Auto does not enable JEV or change LoRA consent.",
      "Finished means observed completion, not acceptance.",
    );
  else if (screen.view === "settings") {
    screen.settingKeys = visibleSettingKeys(session?.settings?.jev);
    if (screen.settingKey && !screen.settingKeys.includes(screen.settingKey)) screen.settingKey = "jev";
    body.push(
      ...(disconnected
        ? [
            sectionHeading("Connection details", width),
            `Last contact: ${session!.observation!.observedAt}`,
            ...(options.notice || options.problem ? [clean(options.notice || options.problem || "")] : []),
            "",
          ]
        : []),
      ...dashboardSettingsLines(
        options.connected === false && session?.settings ? { ...session.settings, editable: false } : session?.settings,
        session?.auto.enabled,
        screen.settingKey ?? "auto",
      ).map((line) => {
        if (modern && (line === "SETTINGS" || line === "SETTINGS · current session"))
          return sectionHeading("SESSION CONTROLS", width);
        if (modern && line.startsWith("STARTUP LIMITS")) return sectionHeading(line, width);
        return line;
      }),
    );
    if (session?.observation)
      body.push(
        sectionHeading("CAPTURE · startup configuration", width),
        `Transcripts: ${session.observation.capture.transcripts ? "configured" : "off"}`,
        `Diagnostics: ${session.observation.capture.diagnostics ? "configured" : "off"}`,
        "Capture changes require a new parent launch.",
        "m models · v versions",
      );
  } else if (screen.view === "versions" || screen.view === "version-details") {
    body.push(modern ? sectionHeading("VERSIONS", width) : "VERSIONS");
    if (!session?.versions) body.push("Owner has not reported versions.");
    else if (screen.view === "versions") {
      body.push(modern ? "Packages in this Pi session" : "Loaded -> on disk");
      for (const row of screen.versionRows)
        if (modern) body.push(...versionLines(row, row.id === screen.versionId, options));
        else
          body.push(
            `${row.id === screen.versionId ? ">" : " "} ${row.label}: ${row.loadedVersion ?? "?"} -> ${row.installedVersion ?? "?"}`,
            `  ${versionStatus(row)}`,
          );
      if (session.versions.note) body.push(session.versions.note);
    } else if (selectedVersion) {
      body.push(
        `${selectedVersion.label}: ${versionStatus(selectedVersion)}`,
        `Loaded: ${selectedVersion.loadedVersion ?? "not reported"}`,
        `Installed: ${selectedVersion.installedVersion ?? "unavailable"}`,
        `Source: ${selectedVersion.source ?? "unavailable"}`,
        `Path: ${selectedVersion.path ?? "unavailable"}`,
        "",
        "MANAGE · run in a terminal",
        ...selectedVersion.commands,
      );
      if (selectedVersion.note) body.push(selectedVersion.note);
      if (session.versions.note) body.push(session.versions.note);
    }
  } else if (screen.view === "models") {
    body.push(modern ? sectionHeading("SESSION MODELS", width) : "SESSION MODELS");
    if (!session) body.push("Connect from /grants dashboard to edit models.");
    for (const row of session?.rows ?? [])
      body.push(`${row.definition}: ${row.model}`, `  ${row.thinking} · ${row.source}`);
    body.push(": m <definition|all> <provider:model> <thinking>");
  } else if (screen.view === "details") {
    const title =
      selected &&
      (selected.key.startsWith("component:") ||
      (selected.status === "approval-wait" && /\bready for review\b/i.test(selected.label))
        ? selected.label
        : selected.status === "last-observed"
          ? `Last seen · ${selected.label}`
          : `${selected.label} · ${friendlyStatus(selected.status)}`);
    body.push(
      title ??
        (screen.selectedKey ? "This item is no longer visible. Press Esc to return to the list." : "No selected task"),
      ...(modern && selected
        ? [
            sectionHeading(
              screen.sourceDetails
                ? "SOURCE RECORD"
                : (selected.briefDetails && selected.status === "approval-wait") || selected.approval
                  ? "NEXT ACTION"
                  : "DETAILS",
              width,
            ),
          ]
        : []),
      ...((screen.sourceDetails ? selected?.details : (selected?.briefDetails ?? selected?.details)) ?? []),
    );
    if (selected && options.content) body.push("", options.content.title, ...options.content.text.split(/\r?\n/));
  } else if (modern) {
    if (!screen.items.length && options.filter && options.filter !== "everything")
      body.push("No items match this filter. Press Tab to change it.");
    else body.push(...sessionPanelLines(options, screen.items, width));
  } else {
    const requestFinished = options.currentStatus && !active(options.currentStatus);
    body.push(
      options.current
        ? requestFinished
          ? `LATEST REQUEST · ${friendlyStatus(options.currentStatus!)}`
          : "CURRENT REQUEST"
        : "CURRENT WORK",
      clean(options.current ?? live.find((item) => !item.approval)?.label ?? "No active work"),
      "",
    );
    const rows: { text: string; key?: string }[] = [];
    let group: string | undefined;
    for (const item of screen.items) {
      const next = item.approval
        ? "NEEDS YOU"
        : attention(item.status)
          ? "NEEDS ATTENTION"
          : active(item.status)
            ? `WORK IN PROGRESS · ${live.filter((value) => !value.approval).length} active`
            : "HISTORY";
      if (next !== group) {
        rows.push({ text: next });
        group = next;
      }
      const tail = `${friendlyStatus(item.status)} ${item.elapsed}`.trim(),
        labelWidth = Math.max(1, width - tail.length - 4);
      if (item.key === screen.selectedKey && item.observation)
        rows.push({ text: `  Observed: ${clean(item.observation)}` });
      rows.push({
        key: item.key,
        text: `${item.key === screen.selectedKey ? ">" : " "} ${truncate(clean(item.label), labelWidth)}  ${tail}`,
      });
    }
    const hidden = !options.history ? past.length : 0;
    const history = hidden ? `${hidden} finished · h shows history` : options.history ? "h hides history" : "";
    const available = Math.max(0, height - fixed.length - footer.length - body.length - (history ? 1 : 0));
    const rowIndex = rows.findIndex((row) => row.key === selected?.key);
    const start = Math.max(0, rowIndex - available + 1);
    body.push(...rows.slice(start, start + available).map((row) => row.text));
    if (!rows.length)
      body.push(options.filter && options.filter !== "everything" ? "No matching active work." : "No work is running.");
    if (history) body.push(history);
  }

  const left =
    modern && screen.view === "main" && selected
      ? previewWidth(screen.destination ?? "now", Boolean(screen.expanded), width)
      : undefined;
  const detailBody =
    !modern && (screen.view === "main" || screen.view === "versions") ? body : wrapDashboardLines(body, left ?? width);
  if (modern && height >= 16 && height - fixed.length - footer.length > detailBody.length)
    footer.unshift("─".repeat(Math.min(width, 100)));
  const bodyRoom = height - fixed.length - footer.length;
  const clipped = modern && bodyRoom >= 2 && detailBody.length > bodyRoom;
  if (clipped) footer.push("");
  const room = Math.max(0, height - fixed.length - footer.length);
  if (screen.view === "versions" && selectedVersion && room > 0) {
    const row = detailBody.findIndex((line) => line.startsWith(">"));
    if (row < screen.offset) screen.offset = row;
    else if (row + 1 >= screen.offset + room) screen.offset = Math.max(0, row + 2 - room);
  }
  if (screen.view === "settings" && room > 0 && !screen.manualScroll) {
    const row = detailBody.findIndex((line) => line.startsWith(">"));
    if (row < screen.offset) screen.offset = Math.max(0, row);
    else if (row >= screen.offset + room) screen.offset = Math.max(0, row - room + 1);
  }
  if (modern && screen.view === "main" && room > 0 && !screen.manualScroll) {
    const selectedRow = detailBody.findIndex((line) => line.startsWith(">"));
    if (selectedRow >= screen.offset + room) screen.offset = selectedRow - room + 1;
    else if (selectedRow >= 0 && selectedRow < screen.offset) screen.offset = selectedRow;
  }
  const offset =
    screen.view === "main" && !modern ? 0 : Math.max(0, Math.min(screen.offset, Math.max(0, detailBody.length - room)));
  screen.offset = offset;
  if (clipped)
    footer[footer.length - 1] =
      `Rows ${offset + 1}–${Math.min(offset + room, detailBody.length)}/${detailBody.length} · PgUp/PgDn`;
  const page = detailBody.slice(offset, offset + room);
  if (left !== undefined && selected) {
    const right = Math.min(width - left - 3, 72);
    const preview = wrapDashboardLines(
      [
        sectionHeading("Selected item", right),
        clean(selected.label),
        "",
        ...(selected.briefDetails ?? [friendlyStatus(selected.status), "Press Enter for details."]),
      ],
      right,
    );
    const count = Math.min(room, Math.max(page.length, preview.length));
    for (let i = 0; i < count; i++) {
      const cell = page[i] ?? "";
      page[i] = cell + " ".repeat(Math.max(0, left - cellWidth(cell))) + " │ " + (preview[i] ?? "");
    }
  }
  const lines = [...fixed, ...page];
  while (lines.length < height - footer.length) lines.push("");
  const output = [...lines, ...footer].slice(0, height);
  return output
    .map((line, index) => {
      const safe = truncate(dashboardText(line), width);
      if (!options.color) return safe;
      if (modern)
        return colorSessionLine(
          safe,
          index === 0 ? "header" : index === 1 ? "navigation" : index >= height - footer.length ? "footer" : "body",
        );
      const section = [
        "NOW",
        "WORK",
        "REVIEWS",
        "ACTIVITY",
        "EVIDENCE",
        "GOAL",
        "NEXT",
        "COMPONENTS",
        "CURRENT REQUEST",
        "LATEST REQUEST",
        "CURRENT WORK",
        "NEEDS YOU",
        "NEEDS ATTENTION",
        "WORK IN PROGRESS",
        "HISTORY",
        "VERSIONS",
        "SETTINGS",
        "STARTUP LIMITS",
        "SESSION MODELS",
        "DASHBOARD KEYS",
        "MANAGE",
      ].some((label) => safe.startsWith(label));
      const code =
        index === 0
          ? "1;36"
          : safe.startsWith("!")
            ? "33"
            : safe.startsWith(">")
              ? "36"
              : section
                ? "1"
                : index === 1 || index >= height - footer.length
                  ? "90"
                  : undefined;
      return code ? `\u001b[${code}m${safe}\u001b[0m` : safe;
    })
    .join("\n");
}
