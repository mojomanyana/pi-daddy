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
  details: string[];
  observation?: string;
  taskKey?: string;
  timelinePath?: string;
  approval?: boolean;
  skills?: boolean;
  agent?: boolean;
}
export interface DashboardScreenState {
  view: "main" | "details" | "models" | "help" | "versions" | "version-details";
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
function wrapped(lines: string[], width: number): string[] {
  return lines.flatMap((line) => {
    const result: string[] = [];
    let row = "";
    for (const character of dashboardText(line)) {
      if (row && cellWidth(row + character) > width) {
        result.push(row);
        row = "";
      }
      row += character;
    }
    result.push(row);
    return result;
  });
}
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return seconds >= 3600
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
const friendlyStatus = (status: string) =>
  ({
    active: "Running",
    running: "Running",
    starting: "Starting",
    authorised: "Approved",
    "needs-you": "Needs you",
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
): DashboardItem[] {
  return timeline.tasks.map((task) => ({
    key: activityTaskKey(task.rootId, task.id),
    taskKey: activityTaskKey(task.rootId, task.id),
    label: `${task.agent || "User turn"} [${aliases.selector(task)}]`,
    status: task.status,
    elapsed: elapsed(Date.parse(task.endedAt ?? now.toISOString()) - Date.parse(task.startedAt)),
    observation: task.lastEvent
      ? `${task.lastEvent.tool ? `${task.lastEvent.tool} ` : ""}${task.lastEvent.kind.replaceAll("_", " ")} · ${elapsed(Date.parse(now.toISOString()) - Date.parse(task.lastEvent.at))} ago`
      : undefined,
    agent: Boolean(task.agent || task.agents.length),
    skills: task.skills.length > 0,
    details: [
      `Task: ${aliases.selector(task)}`,
      `State: ${friendlyStatus(task.status)} (observation, not acceptance)`,
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
}
/** Selection follows stable identity through refresh, never an unrelated task at the old row index. */
export function renderDashboardScreen(options: DashboardScreenOptions): string {
  const width = Math.max(1, Math.floor(options.width)),
    height = Math.max(1, Math.floor(options.height));
  const { screen, session } = options,
    pending = session?.pendingApprovals ?? [];
  const approvals: DashboardItem[] = pending.map((approval) => ({
    key: `approval:${approval.id}`,
    label: `${approval.subject} · ${approval.capability.replace(/^tool:/, "")}`,
    status: "needs-you",
    elapsed: "",
    approval: true,
    details: [
      `Approval: ${approval.id}`,
      `Subject: ${approval.subject}`,
      `Capability: ${approval.capability}`,
      "Waiting for Daddy permission in the owner session.",
      "Use the owner's prompt, or a to enable Auto.",
    ],
  }));
  const allItems = [...approvals, ...options.items];
  const items = allItems.filter((item) =>
    options.filter === "agents"
      ? item.agent
      : options.filter === "skills"
        ? item.skills
        : options.filter === "needs-you"
          ? item.status === "needs-you"
          : true,
  );
  const live = items.filter((item) => active(item.status)),
    needsAttention = items.filter((item) => attention(item.status)),
    past = items.filter((item) => !active(item.status) && !attention(item.status)).reverse();
  screen.items = [...live, ...needsAttention, ...(options.history ? past : [])];
  if (screen.view === "details" && !screen.items.some((item) => item.key === screen.selectedKey)) {
    const detail = items.find((item) => item.key === screen.selectedKey);
    if (detail) screen.items.push(detail);
  }
  if (!screen.items.some((item) => item.key === screen.selectedKey)) screen.selectedKey = screen.items[0]?.key;
  const selectedIndex = screen.items.findIndex((item) => item.key === screen.selectedKey),
    selected = screen.items[selectedIndex];
  screen.versionRows = session?.versions?.rows ?? [];
  if (!screen.versionRows.some((row) => row.id === screen.versionId)) screen.versionId = screen.versionRows[0]?.id;
  const selectedVersion = screen.versionRows.find((row) => row.id === screen.versionId);
  const mode = session ? `Auto ${session.auto.enabled ? "ON" : "OFF"}` : "Auto unavailable";
  const header = `PI DADDY | ${mode}${options.pending ? " …" : session ? " [a]" : ""}`;
  const footer =
    options.command !== undefined
      ? [`: ${clean(options.command)}`]
      : screen.view === "main" || screen.view === "versions"
        ? ["↑↓ select · Enter details · a Auto", "m models · v versions · Tab filter · ?"]
        : [
            "↑↓ scroll · Esc back · a Auto",
            screen.view === "details" ? "p prompt · f final · : command · ? help" : ": command · ? help",
          ];
  const fixed = [
    header,
    session
      ? `Permissions connected${pending.length ? ` · ${pending.length} needs you` : ""}`
      : "Permission controls disconnected",
  ];
  if (options.notice || options.problem) fixed.push(`! ${clean(options.notice || options.problem || "")}`);
  const body: string[] = [];
  if (screen.view === "help")
    body.push(
      "DASHBOARD KEYS",
      "↑/↓ or j/k: select; Enter/d: details",
      "a: toggle Daddy permission Auto",
      "m: session models; v: ecosystem versions",
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
  else if (screen.view === "versions" || screen.view === "version-details") {
    body.push("VERSIONS");
    if (!session?.versions) body.push("Owner has not reported versions.");
    else if (screen.view === "versions") {
      body.push("Loaded -> on disk");
      for (const row of screen.versionRows)
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
    body.push("SESSION MODELS");
    if (!session) body.push("Connect from /grants dashboard to edit models.");
    for (const row of session?.rows ?? [])
      body.push(`${row.definition}: ${row.model}`, `  ${row.thinking} · ${row.source}`);
    body.push(": m <definition|all> <provider:model> <thinking>");
  } else if (screen.view === "details") {
    body.push(
      selected ? `${selected.label} · ${friendlyStatus(selected.status)}` : "No selected task",
      ...(selected?.details ?? []),
    );
    if (options.content) body.push("", options.content.title, ...options.content.text.split(/\r?\n/));
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

  const detailBody = screen.view === "main" || screen.view === "versions" ? body : wrapped(body, width);
  const room = Math.max(0, height - fixed.length - footer.length);
  if (screen.view === "versions" && selectedVersion && room > 0) {
    const row = 2 + screen.versionRows.findIndex((value) => value.id === screen.versionId) * 2;
    if (row < screen.offset) screen.offset = row;
    else if (row + 1 >= screen.offset + room) screen.offset = Math.max(0, row + 2 - room);
  }
  const offset =
    screen.view === "main" ? 0 : Math.max(0, Math.min(screen.offset, Math.max(0, detailBody.length - room)));
  screen.offset = offset;
  const lines = [...fixed, ...detailBody.slice(offset, offset + room)];
  while (lines.length < height - footer.length) lines.push("");
  const output =
    height < fixed.length + footer.length
      ? fixed.slice(0, height)
      : [...lines.slice(0, Math.max(0, height - footer.length)), ...footer].slice(0, height);
  return output
    .map((line, index) => {
      const safe = truncate(dashboardText(line), width);
      if (!options.color) return safe;
      const section =
        /^(CURRENT REQUEST|LATEST REQUEST|CURRENT WORK|NEEDS YOU|NEEDS ATTENTION|WORK IN PROGRESS|HISTORY|VERSIONS|SESSION MODELS|DASHBOARD KEYS|MANAGE)/.test(
          safe,
        );
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
