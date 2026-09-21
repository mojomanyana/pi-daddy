import type { DailyAttempt, DailyView } from "./daily-view.ts";
import { renderDailyDetails } from "./daily-view-render.ts";

export interface WorkPresentation {
  outcome: string;
  obligations: { digest: string; outcome: string; agent?: string; dependencies?: string[] }[];
}
export interface PanelAction {
  key: string;
  label: string;
  operation?: string;
  requestDigest?: string;
}
export interface PanelOptions {
  details?: boolean;
  presentation?: WorkPresentation | null;
  connected?: boolean;
  error?: string | null;
  controls?: unknown;
  control?: string;
  actions?: readonly { choice: string; label: string }[];
  learning?: string[];
}
export const panelText = (value: unknown): string =>
  String(value ?? "unknown")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
/** Conservative terminal-cell bound: non-ASCII glyphs take two cells; no ANSI/control bytes survive. */
export function panelLines(lines: readonly string[], width = 80): string {
  const columns = Number.isFinite(width) ? Math.max(12, Math.min(240, Math.floor(width))) : 80;
  return lines
    .flatMap((line) => {
      let row = "",
        cells = 0;
      const rows: string[] = [];
      for (const char of panelText(line)) {
        const size = char.codePointAt(0)! > 127 ? 2 : 1;
        if (cells + size > columns) {
          rows.push(row);
          row = "";
          cells = 0;
        }
        row += char;
        cells += size;
      }
      rows.push(row);
      return rows;
    })
    .join("\n");
}
export function learningSummary(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["Not connected — /grants learning"];
  const v = value as {
    state?: string;
    reason?: string;
    cases?: unknown[];
    comparisons?: { state?: string; reason?: string; title?: string }[];
    trust?: { automaticExposure?: { mode?: string; reason?: string }; reason?: string };
  };
  if (v.state === "deferred")
    return [`Deferred: ${v.reason ?? "evidence unavailable"}`, "/grants learning to reconnect"];
  if (!v.cases || !v.comparisons) return ["Retained learning linked — /grants learning"];
  const reasons = v.comparisons.map((c) => `${c.title ?? "Comparison"}: ${c.reason ?? c.state ?? "not ready"}`);
  return [
    `${v.cases.length} case batch(es); ${v.comparisons.length} comparison(s)`,
    ...reasons.slice(0, 2),
    `Automatic questions: ${v.trust?.automaticExposure?.mode ?? "silent"} — ${v.trust?.automaticExposure?.reason ?? v.trust?.reason ?? "not configured"}`,
    "/grants learning opens deliberate review; not earned exposure",
  ];
}
const finished = (a: DailyAttempt) =>
  ["completed", "failed"].includes(a.intentRuntime) || a.archive?.runtime === "terminal";

/** Ordinary presentation is not another source of authority. All history remains under Details. */
export function renderDailyPanel(view: DailyView, width = 80, options: PanelOptions = {}): string {
  const controls = options.controls as
    | {
        ordinary?: {
          admission?: string;
          children?: { target: { executionId: string }; state: string; abortRequested: boolean }[];
        };
        dispatch?: { paused?: boolean };
      }
    | undefined;
  const live = controls?.ordinary?.children ?? [];
  const rows = new Map(view.attempts.map((a) => [a.executionId, a]));
  const activeIds =
    options.connected && controls?.ordinary
      ? live.filter((r) => r.state === "active").map((r) => r.target.executionId)
      : view.attempts.filter((a) => !finished(a)).map((a) => a.executionId);
  const complete = view.attempts.filter(finished);
  const paused = controls?.dispatch?.paused || controls?.ordinary?.admission === "held-by-original-owner";
  const failed = complete.filter((a) => a.intentRuntime === "failed" || a.archive?.outcome?.failed);
  const unhealthy =
    options.error ||
    options.control === "failed" ||
    options.control === "unknown" ||
    live.some((row) => row.state === "unknown");
  const short = (value: string, rows = 1) => {
    const limit = Math.max(12, width - 4) * rows;
    return [...panelText(value)].length > limit ? [...panelText(value)].slice(0, limit - 3).join("") + "..." : value;
  };
  const status =
    unhealthy || (!activeIds.length && failed.length)
      ? "Needs you"
      : activeIds.length
        ? "Running"
        : paused
          ? "Waiting"
          : !view.obligations.length
            ? "Waiting"
            : view.obligations.every((o) => o.attempts.some((id) => rows.get(id) && finished(rows.get(id)!)))
              ? "Finished"
              : "Waiting";
  const lines = [
    "PI-DADDY",
    options.presentation?.outcome
      ? short(options.presentation.outcome, 2)
      : view.scope
        ? "Selected work — outcome text unavailable"
        : "No work selected",
    "",
    status,
  ];
  if (unhealthy) lines.push("Control or observation needs attention. Open Details; no action was retried.");
  else if (!activeIds.length && failed.length)
    lines.push(`${failed.length} attempt(s) failed. Inspect results in /grants work.`);
  else if (activeIds.length)
    lines.push(
      `${activeIds.length} active agent${activeIds.length === 1 ? "" : "s"}${paused ? "; new work paused" : ""}`,
    );
  else if (paused) lines.push("New work is paused. Running work is not cancelled by pausing.");
  else if (status === "Finished") lines.push("Attempts finished. Review results; completion is not acceptance.");
  else
    lines.push(
      view.obligations.length
        ? "Ready for an explicit run in /grants work. No automatic dispatch."
        : "Declare work with /grants work.",
    );
  for (const id of activeIds.slice(0, 8)) {
    const a = rows.get(id),
      obligation = view.obligations.find((o) => o.attempts.includes(id));
    const label = options.presentation?.obligations.find((o) => o.digest === obligation?.obligation.digest);
    const original = live.find((row) => row.target.executionId === id);
    lines.push(
      `  ${activeIds.indexOf(id) + 1}. ${label?.agent || "Agent"} — ` +
        `${original?.abortRequested ? "Stopping (awaiting settlement)" : options.connected ? "Running" : "Last observed active; freshness unknown"}`,
      `    ${short(label?.outcome || "Attempt details pending capture")}`,
      `    ${a?.modelId || "model unknown"} / effort ${a?.effortId || "unknown"}`,
    );
  }
  if (activeIds.length > 8) lines.push(`  ${activeIds.length - 8} more active agents in Details`);
  if (complete.length) lines.push(`Finished attempts: ${complete.length} (collapsed; Details)`);
  if (view.obligations.length > 1)
    lines.push(`Work: ${view.obligations.length} obligations; /grants work to select or change setup`);
  if (!options.connected) lines.push("Snapshot only — live connection unavailable. /grants host to connect.");
  if (view.continuity === "reconnected-gap") lines.push("Reconnected — earlier observation gap retained.");
  if (options.learning?.length) lines.push("", "Learning", ...options.learning);
  if (options.actions)
    lines.push(
      "",
      "Available actions",
      ...(options.actions.length
        ? options.actions.map((a) => `${a.choice}  ${short(a.label, 2)}`)
        : ["None currently authorized"]),
    );
  lines.push("", "d  Details / history", "Pi coordinates work; skill-harness retains learning evidence.");
  const summary = panelLines(lines, width);
  return options.details
    ? `${summary}\n\n` +
        `${panelLines([options.presentation?.outcome ?? "", ...(options.presentation?.obligations.map((o) => o.outcome) ?? [])], width)}\n` +
        `${renderDailyDetails(view, width)}${options.error ? `\n${panelLines([options.error], width)}` : ""}`
    : summary;
}
