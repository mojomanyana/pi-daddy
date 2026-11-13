import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ApprovalUI, PromptRequest } from "./approval-prompt.ts";

const DETAILS = "View permission details";
const BACK = "Back to decision";
const NEXT = "Next page";
const PREVIOUS = "Previous page";

/** Only these strings belong on the terminal; the original values still identify the grant. */
function clean(text: string): string {
  return stripVTControlCharacters(text.replace(/\r\n?/g, "\n"))
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/[\u2028\u2029]/gu, "\n");
}

function oneLine(value: string, limit: number): string {
  const chars = [...value.trim().replace(/\s+/gu, " ")];
  return chars.length <= limit
    ? chars.join("")
    : chars
        .slice(0, limit - 1)
        .join("")
        .trimEnd() + "…";
}

function permissionAction(capability: string): string {
  const actions: Record<string, string> = {
    "tool:bash": "run shell commands",
    "tool:write": "write files",
    "tool:edit": "edit files",
    "tool:delegate": "delegate work to another agent",
  };
  return actions[capability] ?? `use ${oneLine(clean(capability), 90)}`;
}

function headline(request: PromptRequest): string {
  const capabilities = request.capabilities ?? [request.capability];
  const subject = request.path === "delegate" ? "this delegated agent" : oneLine(clean(request.subject), 80);
  return capabilities.length === 1
    ? `Allow ${subject} to ${permissionAction(capabilities[0]!)}?`
    : `Allow ${subject} these ${capabilities.length} permissions?`;
}

function scopeHint(request: PromptRequest): string {
  if (request.bindingKey) return "Remembered choices apply only to this exact request.";
  return request.path === "delegate"
    ? "A session choice also covers other unnamed delegated agents."
    : "A remembered choice also covers other tasks for this agent.";
}

/** Render the full, untrusted brief in pages so choices stay reachable on a typical terminal. */
function detailLines(request: PromptRequest): string[] {
  const rows = [
    ...(request.capabilities ?? [request.capability]).map((capability) => `Permission: ${clean(capability)}`),
    `Agent: ${clean(request.subject)}`,
    ...(request.project ? [`Permission project: ${clean(request.project)}`] : []),
    ...(request.workspace ? [`Requested workspace: ${clean(request.workspace)}`] : []),
    scopeHint(request),
    ...(request.bindingKey ? ["Reuse requires the same task, tools, parent and bound context."] : []),
    "",
    "Requested task",
    clean(request.task ?? "").trim() || "No task description supplied.",
  ];
  return rows
    .join("\n")
    .split("\n")
    .flatMap((line) => {
      const chunks = line.match(/.{1,58}(?:\s+|$)|.{1,58}/gu);
      return chunks ? chunks.map((chunk) => chunk.trimEnd()) : [""];
    });
}

/** Details are informational. The same decision and its original deadline stay in force across pages. */
export async function selectPermission(
  ui: ApprovalUI,
  request: PromptRequest,
  labels: string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  const task = clean(request.task ?? "")
    .split("\n")
    .find((line) => line.trim());
  const title = [
    headline(request),
    ...((request.capabilities?.length ?? 1) > 1
      ? request.capabilities!.map((capability) => `  • ${permissionAction(capability)}`)
      : []),
    ...(task ? [`Requested task: ${oneLine(task, 115)}`] : []),
    ...(request.project
      ? [`Permission project: ${oneLine(clean(basename(request.project) || request.project), 60)}`]
      : []),
    ...((request.capabilities ?? [request.capability]).includes("tool:bash")
      ? ["Shell access can change files and run other commands."]
      : []),
    ...(request.recheckReason ? [request.recheckReason] : []),
    scopeHint(request),
  ].join("\n");
  const choices = [...labels, DETAILS];
  let lines: string[] | undefined;
  let page = -1;
  while (!signal.aborted) {
    if (page < 0) {
      const choice = await ui.select(title, choices, { signal });
      if (choice !== DETAILS) return choice;
      lines ??= detailLines(request);
      page = 0;
    } else {
      const pages = Math.ceil(lines!.length / 8);
      const title = [`Permission details · ${page + 1}/${pages}`, ...lines!.slice(page * 8, page * 8 + 8)].join("\n");
      const options = [BACK, ...(page + 1 < pages ? [NEXT] : []), ...(page > 0 ? [PREVIOUS] : [])];
      const nav = await ui.select(title, options, { signal });
      if (nav === undefined || !options.includes(nav)) return undefined;
      if (nav === BACK) page = -1;
      else page += nav === NEXT ? 1 : -1;
    }
  }
  return undefined;
}
