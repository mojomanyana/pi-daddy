import type {
  DashboardNode,
  DashboardProjection,
  DashboardState,
  DashboardWorkflow,
  DashboardWorkflowFact,
} from "./dashboard-projection.ts";
import { isLedgerCapabilityIdentifier, isLedgerDisplayIdentifier } from "./ledger-identifiers.ts";

export interface DashboardRenderOptions {
  width?: number;
  color?: boolean;
  details?: boolean;
  completedRoots?: number;
  completedChildren?: number;
}

const ACTIVE = new Set<DashboardState>(["authorised", "starting", "running"]);
const ATTENTION = new Set<DashboardState>(["failed", "refused", "incomplete"]);

const STYLE: Record<DashboardState, { symbol: string; color: number; label: string }> = {
  authorised: { symbol: "●", color: 33, label: "authorised" },
  starting: { symbol: "●", color: 33, label: "starting" },
  running: { symbol: "●", color: 33, label: "running" },
  completed: { symbol: "✓", color: 32, label: "done" },
  failed: { symbol: "✕", color: 31, label: "failed" },
  refused: { symbol: "⛔", color: 31, label: "refused" },
  incomplete: { symbol: "○", color: 90, label: "incomplete" },
  historical: { symbol: "○", color: 90, label: "historical" },
};

function clean(value: string | undefined): string {
  return (value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
}

const displayIdentifier = (value: string | undefined): string =>
  isLedgerDisplayIdentifier(value) ? value : "";

const ANSI_SGR = /\u001b\[[0-9;]*m/g;
const WIDE_CELL = /\p{Extended_Pictographic}|[\u2E80-\u9FFF\uF900-\uFAFF]/u;

function cellWidth(value: string): number {
  return [...value.replace(ANSI_SGR, "")].reduce((sum, char) => sum + (WIDE_CELL.test(char) ? 2 : 1), 0);
}

function truncate(value: string, width: number): string {
  if (cellWidth(value) <= width) return value;
  const target = Math.max(0, width - 1);
  let cells = 0;
  let output = "";
  let styled = false;
  for (let index = 0; index < value.length;) {
    if (value[index] === "\u001b") {
      const match = /^\u001b\[([0-9;]*)m/.exec(value.slice(index));
      if (match) {
        output += match[0];
        styled = match[1] !== "0" && match[1] !== "";
        index += match[0].length;
        continue;
      }
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const next = WIDE_CELL.test(char) ? 2 : 1;
    if (cells + next > target) break;
    output += char;
    cells += next;
    index += char.length;
  }
  output += "…";
  return styled ? `${output}\u001b[0m` : output;
}

function paint(value: string, code: number, enabled: boolean): string {
  return enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function phaseLabel(node: DashboardNode): string {
  const phase = displayIdentifier(node.correlation?.phase);
  return phase ? phase.replaceAll("-", " ") : "";
}

function workflowFactLine(fact: DashboardWorkflowFact, color: boolean): string {
  const marker = fact.provenance === "planned" ? "P" : fact.provenance === "observed" ? "O" : "V";
  const symbol = fact.provenance === "planned" ? "○" : fact.provenance === "observed" ? "◉" : fact.state === "blocked" ? "✕" : "✓";
  const code = fact.provenance === "planned" ? 90 : fact.provenance === "observed" ? 33 : fact.state === "blocked" ? 31 : 32;
  return `${marker} ${paint(symbol, code, color)} ${displayIdentifier(fact.subject) || "unlabelled"}  ${fact.state}`;
}

function workflowHeader(workflow: DashboardWorkflow, color: boolean): string {
  const assurance = displayIdentifier(workflow.assurance);
  return paint(
    `◆ ${displayIdentifier(workflow.label) || "declared-workflow"}${assurance ? ` · ${assurance}` : ""} · declared`,
    36,
    color,
  );
}

interface TreeIndex {
  byId: Map<string, DashboardNode>;
  children: Map<string, DashboardNode[]>;
  roots: DashboardNode[];
}

function treeIndex(nodes: DashboardNode[]): TreeIndex {
  const byId = new Map(nodes.map((node) => [node.executionId, node]));
  const children = new Map<string, DashboardNode[]>();
  const roots: DashboardNode[] = [];
  for (const node of nodes) {
    if (node.parentExecutionId && byId.has(node.parentExecutionId)) {
      const list = children.get(node.parentExecutionId) ?? [];
      list.push(node);
      children.set(node.parentExecutionId, list);
    } else roots.push(node);
  }
  const sort = (left: DashboardNode, right: DashboardNode) =>
    Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.executionId.localeCompare(right.executionId);
  roots.sort(sort);
  for (const list of children.values()) list.sort(sort);
  return { byId, children, roots };
}

function hasInterestingDescendant(node: DashboardNode, index: TreeIndex): boolean {
  if (ACTIVE.has(node.state) || ATTENTION.has(node.state)) return true;
  return (index.children.get(node.executionId) ?? []).some((child) => hasInterestingDescendant(child, index));
}

function selectedRoots(roots: DashboardNode[], index: TreeIndex, limit: number): DashboardNode[] {
  const important = roots.filter((root) => hasInterestingDescendant(root, index));
  const quiet = roots.filter((root) => !hasInterestingDescendant(root, index));
  const completed = limit === 0 ? [] : quiet.slice(-limit);
  return [...new Set([...important, ...completed])].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
  );
}

function nodeLine(node: DashboardNode, color: boolean): string {
  const style = STYLE[node.state];
  const phase = phaseLabel(node);
  const pane = displayIdentifier(node.runtime?.herdrPaneId);
  const suffix = [phase, pane ? `pane ${pane}` : ""].filter(Boolean).join(" · ");
  return [
    paint(style.symbol, style.color, color),
    displayIdentifier(node.agentName) || "governed execution",
    style.label.padEnd(10),
    elapsed(node.durationMs),
    suffix,
  ].filter(Boolean).join(" ");
}

function detailLines(node: DashboardNode): string[] {
  const capabilities = node.effectiveGrant.filter(isLedgerCapabilityIdentifier);
  const lines = [`grant ${capabilities.join(", ") || "(none)"}`];
  const workspace = displayIdentifier(node.workspace?.id);
  if (node.workspace && workspace) lines.push(`workspace ${workspace} · ${node.workspace.access}`);
  if (node.executor) lines.push(`executor ${node.executor}`);
  const runId = displayIdentifier(node.correlation?.run_id);
  const taskId = displayIdentifier(node.correlation?.task_id);
  if (runId) lines.push(`correlation ${runId}${taskId ? ` · ${taskId}` : ""}`);
  return lines;
}

function renderTree(
  root: DashboardNode,
  index: TreeIndex,
  options: Required<Pick<DashboardRenderOptions, "width" | "color" | "details" | "completedChildren">>,
): string[] {
  const lines: string[] = [];
  const visit = (node: DashboardNode, prefix: string, branch: string): void => {
    lines.push(truncate(`${prefix}${branch}${nodeLine(node, options.color)}`, options.width));
    const childPrefix = `${prefix}${branch === "" ? "" : branch === "└─ " ? "   " : "│  "}`;
    if (options.details) {
      for (const detail of detailLines(node)) {
        lines.push(truncate(`${childPrefix}   ${paint(clean(detail), 90, options.color)}`, options.width));
      }
    }
    const children = index.children.get(node.executionId) ?? [];
    const important = children.filter((child) => hasInterestingDescendant(child, index));
    const quiet = children.filter((child) => !hasInterestingDescendant(child, index));
    const shownQuiet = options.completedChildren === 0 ? [] : quiet.slice(-options.completedChildren);
    const shown = [...important, ...shownQuiet].sort(
      (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
    );
    const collapsed = quiet.length - shownQuiet.length;
    const entries: Array<{ node?: DashboardNode; collapsed?: number }> = shown.map((child) => ({ node: child }));
    if (collapsed > 0) entries.unshift({ collapsed });
    entries.forEach((entry, position) => {
      const last = position === entries.length - 1;
      if (entry.node) visit(entry.node, childPrefix, last ? "└─ " : "├─ ");
      else lines.push(truncate(
        `${childPrefix}${last ? "└─ " : "├─ "}${paint(`… ${entry.collapsed} completed subtree${entry.collapsed === 1 ? "" : "s"}`, 90, options.color)}`,
        options.width,
      ));
    });
  };
  visit(root, "", "");
  return lines;
}

export function renderDashboard(projection: DashboardProjection, options: DashboardRenderOptions = {}): string {
  const resolved = {
    width: Math.max(10, options.width ?? 80),
    color: options.color ?? true,
    details: options.details ?? false,
    completedRoots: Math.max(0, options.completedRoots ?? 3),
    completedChildren: Math.max(0, options.completedChildren ?? 2),
  };
  const index = treeIndex(projection.nodes);
  const lines = [paint("PI-DADDY", 1, resolved.color), ""];

  const rendered = new Set<string>();
  for (const workflow of projection.workflows) {
    const roots = index.roots.filter((root) => root.correlation?.run_id === workflow.runId);
    const facts = projection.workflowFacts.filter((fact) => fact.runId === workflow.runId);
    if (roots.length === 0 && facts.length === 0) continue;
    for (const root of roots) rendered.add(root.executionId);
    lines.push(workflowHeader(workflow, resolved.color));
    for (const fact of facts) lines.push(truncate(workflowFactLine(fact, resolved.color), resolved.width));
    for (const root of selectedRoots(roots, index, resolved.completedRoots)) {
      lines.push(...renderTree(root, index, resolved));
    }
    lines.push("");
  }

  const generic = index.roots.filter((root) => !rendered.has(root.executionId));
  for (const root of selectedRoots(generic, index, resolved.completedRoots)) {
    lines.push(...renderTree(root, index, resolved));
  }
  if (projection.nodes.length === 0) lines.push(paint("No governed executions recorded yet.", 90, resolved.color));

  if (projection.corrupt.length > 0) {
    lines.push("", paint(`ledger: ${projection.corrupt.length} corrupt line(s)`, 31, resolved.color));
    for (const entry of projection.corrupt.slice(0, 3)) {
      // Never render raw corrupt text: it may contain exactly the task/output fields the ledger forbids.
      lines.push(truncate(`  line ${entry.line}: ${clean(entry.reason)}`, resolved.width));
    }
  }
  if (projection.orphanEvents > 0) {
    lines.push(paint(`${projection.orphanEvents} historical event(s) not joined — childId is not an occurrence id`, 90, resolved.color));
  }
  lines.push(
    "",
    paint(`depth ${projection.maxDepth} · ${projection.active} active`, 90, resolved.color),
    paint("P planned · O observed inline · V controller-validated · E enforced child · D declared labels", 90, resolved.color),
  );
  return lines.map((line) => truncate(line, resolved.width)).join("\n");
}
