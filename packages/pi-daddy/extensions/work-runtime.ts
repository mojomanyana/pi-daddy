import type { Delegation } from "../src/delegate.ts";
import { retentionConfigurationDigest } from "../src/execution-retention.ts";
import { appendDeclaredWorkOccurrence } from "../src/work-command.ts";
import type { WorkOccurrencePayload } from "../src/work-ledger.ts";
import type { GrantsSession } from "./session.ts";
import type { PreparedWorkspace } from "./workspace-runtime.ts";

export async function beginDeclaredWorkAttempt(input: {
  session: GrantsSession;
  plan: Delegation;
  childId: string;
  executionId: string;
  parentExecutionId: string | null;
  toolCallId?: string;
  preparedWorkspace?: PreparedWorkspace;
  configuredTimeoutMs: number;
  startedAt: Date;
}): Promise<null | { finish(state: Extract<WorkOccurrencePayload["state"], "completed" | "failed">): Promise<void> }> {
  const state = input.session.declaredWork;
  if (!state) return null;
  const argument = (flag: string): string | null => {
    const index = input.plan.args.indexOf(flag);
    return index >= 0 ? input.plan.args[index + 1] ?? null : null;
  };
  const identity = {
    executionId: input.executionId,
    parentExecutionId: input.parentExecutionId,
    childId: input.childId,
    toolCallId: input.toolCallId ?? null,
    taskId: input.plan.correlation?.task_id ?? input.plan.taskDigest,
    workspaceId: input.preparedWorkspace?.workspace.workspaceId ?? input.plan.correlation?.workspace_id ?? null,
    definitionDigest: input.plan.definitionDigest?.sha256 ?? null,
    configurationDigest: retentionConfigurationDigest({
      args: input.plan.args,
      effective: input.plan.effective,
      timeoutMs: input.configuredTimeoutMs,
    }),
    modelId: argument("--model"),
    effortId: argument("--thinking"),
  };
  await appendDeclaredWorkOccurrence(state, { ...identity, now: input.startedAt }, "starting");
  return { finish: (terminal) => appendDeclaredWorkOccurrence(state, { ...identity, now: new Date() }, terminal) };
}
