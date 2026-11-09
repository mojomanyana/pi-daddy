const privateMarkers = [
  /https?:\/\/|(?:^|[\s("'=])(?:\/|~\/|[A-Z]:[\\/])/i,
  /[a-z\d._%+-]+@[a-z\d.-]+\.[a-z]{2,}/i,
  /\b(?:[\da-f]{32,}|[A-Za-z\d_\-]{36,})\b/i,
  /\b(?:Bearer\s+\S|(?:password|token|api[_ -]?key|secret)\s*[:=]|(?:sk-|ghp_|github_pat_|AKIA)[\w-]{8,})/i,
];

/** Public display text is a separate field from the task, prompt and reasoning. */
export function safeDashboardSummary(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 160 || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const line = value.trim().replace(/\s+/g, " ");
  if (!line || privateMarkers.some((pattern) => pattern.test(line))) return;
  return line;
}

export const dashboardSummaryDescription =
  "Give this child a short purpose for the user's dashboard, e.g. 'Check that stale cache entries refresh'. " +
  "Use public task terms only. Omit secrets, paths, IDs, links and private material. Display only.";

export function dashboardContentEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    !["off", "0"].includes(env.PI_DADDY_ACTIVITY_TIMELINE?.trim() ?? "") &&
    !["off", "metadata-only"].includes(env.PI_DADDY_ACTIVITY_CONTENT?.trim() ?? "")
  );
}

/** Only fixed descriptions cross the observation boundary for regular tools. */
export function toolPurpose(tool: string, args?: unknown): string {
  const params = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (tool === "bash" && typeof params.command === "string" && /^\s*npm\s+(?:test|run\s+test)\s*$/.test(params.command))
    return "Run the project tests";
  if (tool === "read" && typeof params.path === "string" && params.path.length <= 4096) {
    const path = params.path.replaceAll("\\", "/");
    if (/(^|\/)README(?:\.[^/]+)?$/i.test(path)) return "Read the project guide";
    if (/(^|\/)SKILL\.md$/.test(path)) return "Read a skill's instructions";
    if (/(^|\/)(?:tests?|__tests__)\/|(?:\.test|\.spec)\.[^/]+$/i.test(path)) return "Read a test file";
    if (/(^|\/)\.principal\/reports\//.test(path)) return "Read a saved report";
  }
  if (tool === "principal_workflow") {
    switch (params.action) {
      case "prepare":
        return "Prepare the next step";
      case "inspect":
        return "Check the state of a workflow step";
      case "complete":
        return "Record the result of a workflow step";
    }
  }
  switch (tool) {
    case "read":
      return "Read a project file";
    case "grep":
      return "Search file contents";
    case "find":
      return "Find project files";
    case "ls":
      return "List files in a folder";
    case "edit":
      return "Edit a file";
    case "write":
      return "Write a file";
    case "bash":
      return "Run a shell command";
    case "delegate": {
      switch (params.agent) {
        case "review":
          return "Request an independent review";
        case "test-review":
          return "Ask a reviewer to check the tests";
        case "investigate":
          return "Ask a subagent to investigate";
        case "build":
          return "Ask a subagent to implement a change";
        case "plan":
          return "Ask a subagent to prepare a plan";
        default:
          return "Ask a subagent to work on a task";
      }
    }
    case "delegate_all":
      return "Assign tasks to multiple subagents";
    case "delegate_chain":
      return "Assign a sequence of tasks to subagents";
    case "delegate_describe":
      return "Check a subagent's instructions";
    case "principal_workflow":
      return "Manage a workflow step";
    case "codemode":
      return "Run a group of tool calls";
    default:
      return "Use a project tool";
  }
}

export function observedPurpose(tool: string, args: unknown, allowSummary: boolean): string {
  if (tool === "delegate" && allowSummary && args && typeof args === "object") {
    const summary = safeDashboardSummary((args as Record<string, unknown>).dashboardSummary);
    if (summary) return summary;
  }
  return toolPurpose(tool, args);
}
