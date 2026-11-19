/** Local work-mode drafts. Only the authenticated owner action can apply one. */
import {
  workModeLabel,
  parseWorkMode,
  WORK_MODE_EMPHASES,
  type WorkModeSelection,
  type WorkModeSnapshot,
  type WorkModeEmphasis,
} from "../kernel/work-mode.ts";
import type { DashboardOwnerObservation } from "../kernel/dashboard-observation.ts";

const emphasisLabels: Record<WorkModeEmphasis, string> = {
  speed: "Faster delivery · simplify the route",
  altitude: "Better outcome · connect work to its purpose",
  depth: "Deeper proof · investigate and verify",
  range: "Broader approaches · consider alternatives",
};
type Owner = Pick<DashboardOwnerObservation, "sessionId" | "cwd" | "generation">;
type Row = "mode" | "scope" | WorkModeEmphasis | "apply" | "cancel";
export interface DashboardWorkModeEditor {
  selection: WorkModeSelection;
  scope: "session" | "next-request";
  expectedOwner: Owner;
  selected: Row;
  busy?: boolean;
  error?: string;
}
const sameSelection = (a: WorkModeSelection, b: WorkModeSelection) =>
  a.mode === b.mode &&
  a.emphases.length === b.emphases.length &&
  a.emphases.every((value) => b.emphases.includes(value));
const sameOwner = (a: Owner, b?: Owner) =>
  !!b && a.sessionId === b.sessionId && a.cwd === b.cwd && a.generation === b.generation;

/** Optional capability: old or malformed snapshots must not invent editable controls. */
export function availableWorkMode(value: WorkModeSnapshot | undefined): WorkModeSnapshot | undefined {
  return value?.available === true &&
    typeof value.inherited === "boolean" &&
    parseWorkMode(value.selection) &&
    (value.active === undefined || parseWorkMode(value.active)) &&
    (value.nextRequest === undefined || parseWorkMode(value.nextRequest))
    ? value
    : undefined;
}

export function workModeOverview(value: WorkModeSnapshot | undefined): string[] {
  const mode = availableWorkMode(value);
  if (!mode) return [];
  const current = mode.active ?? mode.selection;
  const rows = [`Work mode · ${mode.active ? "Active now" : "Session"}: ${workModeLabel(current)}`];
  if (mode.active && !sameSelection(mode.active, mode.selection))
    rows.push(`  Session default: ${workModeLabel(mode.selection)}`);
  if (mode.nextRequest) rows.push(`  Next request only: ${workModeLabel(mode.nextRequest)}`);
  return rows;
}

export function openWorkModeEditor(
  value: WorkModeSnapshot | undefined,
  owner: Owner | undefined,
): DashboardWorkModeEditor | undefined {
  const mode = availableWorkMode(value);
  if (!mode || mode.inherited || !owner) return;
  const selection = mode.nextRequest ?? mode.selection;
  return {
    selection: { ...selection, emphases: [...selection.emphases] },
    scope: mode.nextRequest ? "next-request" : "session",
    expectedOwner: { sessionId: owner.sessionId, cwd: owner.cwd, generation: owner.generation },
    selected: "mode",
  };
}

function rows(editor: DashboardWorkModeEditor): Row[] {
  return ["mode", "scope", ...(editor.selection.mode === "ambitious" ? WORK_MODE_EMPHASES : []), "apply", "cancel"];
}
export function workModeEditorKey(
  editor: DashboardWorkModeEditor,
  key: string,
): "apply-work-mode" | "cancel-work-mode" | undefined {
  if (editor.busy) return;
  if (key === "escape") return "cancel-work-mode";
  const keys = rows(editor);
  if (["up", "down", "j", "k"].includes(key)) {
    const delta = key === "up" || key === "k" ? -1 : 1;
    editor.selected = keys[Math.max(0, Math.min(keys.length - 1, keys.indexOf(editor.selected) + delta))]!;
  } else if (key === "return" || key === " ") {
    editor.error = undefined;
    if (editor.selected === "apply") return "apply-work-mode";
    if (editor.selected === "cancel") return "cancel-work-mode";
    if (editor.selected === "mode")
      editor.selection = { mode: editor.selection.mode === "standard" ? "ambitious" : "standard", emphases: [] };
    else if (editor.selected === "scope") editor.scope = editor.scope === "session" ? "next-request" : "session";
    else {
      const selected = editor.selected;
      editor.selection.emphases = WORK_MODE_EMPHASES.filter((item) =>
        item === selected ? !editor.selection.emphases.includes(item) : editor.selection.emphases.includes(item),
      );
    }
  }
}

export function workModeEditorLines(editor: DashboardWorkModeEditor): string[] {
  const row = (key: Row, label: string) => `${key === editor.selected ? ">" : " "} ${label}`;
  return [
    "WORK MODE · draft",
    "Changes apply only when you choose Apply.",
    "",
    row(
      "mode",
      `Mode: ${editor.selection.mode === "standard" ? "Standard · Current behavior" : "Ambitious · Own the outcome"}`,
    ),
    row("scope", `Apply to: ${editor.scope === "session" ? "This session" : "Next request only"}`),
    editor.scope === "session"
      ? "  /new starts again in Standard."
      : "  Expires after one request, including its children.",
    ...(editor.scope === "session" ? ["  Replaces any queued next-request mode."] : []),
    ...(editor.selection.mode === "ambitious"
      ? [
          "",
          "Optional emphases · combine any",
          "None selected: balanced; Pi chooses useful directions.",
          ...WORK_MODE_EMPHASES.map((key) =>
            row(key, `[${editor.selection.emphases.includes(key) ? "x" : " "}] ${emphasisLabels[key]}`),
          ),
        ]
      : []),
    "",
    "Active work keeps the mode it started with.",
    "Permissions, models, JEV and limits stay unchanged.",
    row("apply", editor.busy ? "Applying…" : "Apply work mode"),
    row("cancel", "Cancel"),
    ...(editor.error ? ["", editor.error] : []),
  ];
}

export function workModeEditAction(
  editor: DashboardWorkModeEditor,
  value: WorkModeSnapshot | undefined,
  owner?: Owner,
) {
  const mode = availableWorkMode(value);
  if (!mode || mode.inherited || !sameOwner(editor.expectedOwner, owner)) {
    editor.error = "Session changed or disconnected. Cancel and reopen Work mode.";
    return;
  }
  return {
    action: "set-work-mode" as const,
    selection: editor.selection,
    scope: editor.scope,
    expectedOwner: editor.expectedOwner,
  };
}
