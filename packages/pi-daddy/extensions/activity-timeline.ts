/** Pi hook wiring for local activity observation. It neither decides grants nor adds child authority. */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENV_EPISODE_ID } from "../src/kernel/env-names.ts";
import { Type } from "typebox";
import {
  ActivityTimelineRecorder,
  ENV_ACTIVITY_TASK,
  type ActivityIdentity,
  type ActivitySkill,
} from "../src/products/activity-timeline.ts";

export interface ActivitySessionState {
  activityRootId?: string;
  episodeId?: string;
  activity?: ActivityIdentity & { taskId?: string };
}
interface HookContext {
  cwd: string;
  model?: { id?: string };
  thinkingLevel?: string;
  sessionManager?: {
    getBranch(): Array<{
      id: string;
      type: string;
      message?: { role?: string; content?: unknown; stopReason?: string };
    }>;
  };
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Register observation hooks. `lifecycleTool` is false in a leaf observer injected with `-e`: that
 * extension has no tools at all, so a child without tool:delegate receives no widened surface.
 */
export function registerActivityTimeline(pi: ExtensionAPI, session?: ActivitySessionState, lifecycleTool = true): void {
  let recorder: ActivityTimelineRecorder | undefined,
    pendingFinal: string | undefined,
    pendingStopReason: string | undefined,
    observedUser: string | undefined,
    pendingStart: { event: unknown; prompt: string; priorIds: Set<string> } | undefined;
  let turnPriorIds = new Set<string>();
  let activeRoot = false;
  let paths = new Map<string, string>(),
    available = new Map<string, ActivitySkill>();
  let reported = false;
  const report = (ctx: HookContext | undefined, error: unknown) => {
    if (!reported && ctx) {
      reported = true;
      ctx.ui.notify(
        `pi-daddy activity: observation unavailable (${error instanceof Error ? error.message : String(error)}); governance is unchanged.`,
        "warning",
      );
    }
  };
  const current = (ctx: HookContext): ActivityTimelineRecorder => {
    const env = {
      ...process.env,
      ...(session?.activityRootId && !process.env.PI_DADDY_ACTIVITY_ROOT
        ? { PI_DADDY_ACTIVITY_ROOT: session.activityRootId }
        : {}),
      ...(session?.episodeId ? { [ENV_EPISODE_ID]: session.episodeId } : {}),
    };
    // session_start binds reload ownership after this hook registration; re-create before the first turn
    // if that binding recovered a prior root identity rather than the factory's provisional UUID.
    if (
      !recorder ||
      (!process.env.PI_DADDY_ACTIVITY_ROOT && session?.activityRootId && recorder.rootId !== session.activityRootId) ||
      (session?.episodeId !== undefined && recorder.episodeId !== session.episodeId)
    )
      recorder = new ActivityTimelineRecorder(ctx.cwd, env);
    return recorder;
  };
  const skills = async (event: unknown, target: ActivityTimelineRecorder) => {
    available = new Map();
    const entries =
      (event as { systemPromptOptions?: { skills?: Array<{ name?: string; filePath?: string }> } }).systemPromptOptions
        ?.skills ?? [];
    for (const item of entries) {
      if (!item.name || !item.filePath) continue;
      const source = await readFile(item.filePath, "utf8");
      if (Buffer.byteLength(source) > 256 * 1024) continue;
      const fact = { name: item.name, source: item.filePath, digest: digest(source) };
      available.set(resolve(item.filePath), fact);
      await target.skill("skill_available", fact);
    }
  };
  const messageText = (content: unknown): string =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part) => part?.type === "text")
            .map((part) => part.text ?? "")
            .join("")
        : "";
  // Pi emits before_agent_start before user message_end. Read the finalized branch only after
  // every message transformer has run; never carry a prior turn's user into the next task.
  const startPending = async (ctx: HookContext) => {
    const pending = pendingStart;
    if (!pending) return;
    const user = ctx.sessionManager
      ?.getBranch()
      .find((entry) => !pending.priorIds.has(entry.id) && entry.type === "message" && entry.message?.role === "user");
    const target = current(ctx);
    const taskId = await target.start(
      user ? messageText(user.message?.content) : (observedUser ?? pending.prompt),
      ctx.model?.id,
      ctx.thinkingLevel,
    );
    pendingStart = undefined;
    observedUser = undefined;
    if (session) session.activity = { rootId: target.rootId, path: target.path, ...(taskId ? { taskId } : {}) };
    await skills(pending.event, target);
  };
  const resetTurn = () => {
    activeRoot = false;
    pendingStart = undefined;
    observedUser = undefined;
    pendingFinal = undefined;
    pendingStopReason = undefined;
    turnPriorIds = new Set();
    paths.clear();
    available.clear();
  };
  if (lifecycleTool)
    pi.registerTool({
      name: "activity_lifecycle",
      label: "Activity lifecycle",
      description:
        "Declare a runtime skill active, finished, or superseded for the local activity timeline. This is not compliance evidence.",
      parameters: Type.Object({
        state: Type.Union([Type.Literal("active"), Type.Literal("finished"), Type.Literal("superseded")]),
        name: Type.String({ minLength: 1, maxLength: 128 }),
        source: Type.String({ minLength: 1, maxLength: 1024 }),
        digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      }),
      async execute(_id, params) {
        const kind =
          params.state === "active"
            ? "skill_active"
            : params.state === "finished"
              ? "skill_finished"
              : "skill_superseded";
        await recorder?.skill(kind, { name: params.name, source: params.source, digest: params.digest });
        return { content: [{ type: "text", text: `Activity recorded: ${params.name} ${params.state}.` }], details: {} };
      },
    });
  pi.on("session_start", (_event, ctx: HookContext) => {
    resetTurn();
    recorder = undefined;
    try {
      recorder = current(ctx);
      // A leaf observer attaches to the parent-owned child event; a root gets a stable session identity.
      if (process.env[ENV_ACTIVITY_TASK]) recorder.attach(process.env[ENV_ACTIVITY_TASK]!);
      const identity: ActivityIdentity = {
        rootId: recorder.rootId,
        path: recorder.path,
        ...(recorder.task ? { taskId: recorder.task } : {}),
      };
      if (session) session.activity = identity;
      ctx.ui.notify(
        recorder.enabled
          ? `pi-daddy activity: local observation on (${recorder.contentEnabled ? "private prompt/final content" : "metadata only"}); governance is unchanged.`
          : "pi-daddy activity: observation off; governance is unchanged.",
        "info",
      );
    } catch (error) {
      report(ctx, error);
    }
    return undefined;
  });
  pi.on("session_shutdown", () => {
    resetTurn();
    recorder = undefined;
  });
  pi.on("before_agent_start", async (event, ctx: HookContext) => {
    try {
      resetTurn();
      const target = current(ctx);
      // Leaves attach to the parent-owned execution. Roots bind the current finalized user at
      // the first context boundary, or at settlement if cancelled before the first model call.
      if (!process.env[ENV_ACTIVITY_TASK]) {
        activeRoot = true;
        turnPriorIds = new Set(ctx.sessionManager?.getBranch().map((entry) => entry.id) ?? []);
        pendingStart = { event, prompt: (event as { prompt?: string }).prompt ?? "", priorIds: turnPriorIds };
        if (session) session.activity = { rootId: target.rootId, path: target.path };
      } else await skills(event, target);
    } catch (error) {
      report(ctx, error);
    }
    return undefined;
  });
  pi.on("context", async (_event, ctx: HookContext) => {
    try {
      await startPending(ctx);
    } catch (error) {
      report(ctx, error);
    }
    return undefined;
  });
  pi.on("message_end", (event) => {
    const message = (event as { message?: { role?: string; content?: unknown; stopReason?: string } }).message;
    // This fallback is scoped to this pending start. Steering within an active turn cannot
    // overwrite its initial prompt or seed the next root task.
    if (message?.role === "user" && pendingStart && observedUser === undefined)
      observedUser = messageText(message.content);
    if (message?.role === "assistant") {
      pendingFinal = messageText(message.content);
      pendingStopReason = message.stopReason;
    }
    return undefined;
  });
  pi.on("tool_execution_start", (event) => {
    const value = event as { toolCallId?: string; args?: { path?: unknown } };
    if (value.toolCallId && typeof value.args?.path === "string") paths.set(value.toolCallId, value.args.path);
    return undefined;
  });
  pi.on("tool_execution_end", async (event) => {
    try {
      const value = event as { isError?: boolean; toolName?: string; toolCallId?: string };
      const path = value.toolCallId ? paths.get(value.toolCallId) : undefined;
      if (value.toolCallId) paths.delete(value.toolCallId);
      const skill = path ? available.get(resolve(path)) : undefined;
      if (!value.isError && value.toolName === "read" && skill) await recorder?.skill("skill_read", skill);
    } catch {
      /* observation cannot affect tool execution */
    }
    return undefined;
  });
  pi.on("agent_settled", async (event, ctx: HookContext) => {
    if (!activeRoot) return undefined;
    try {
      await startPending(ctx);
      const final = ctx.sessionManager
        ?.getBranch()
        .findLast(
          (entry) => !turnPriorIds.has(entry.id) && entry.type === "message" && entry.message?.role === "assistant",
        );
      const stopReason = final?.message?.stopReason ?? pendingStopReason;
      if (recorder && !process.env[ENV_ACTIVITY_TASK])
        await recorder.finish(
          final ? messageText(final.message?.content) : pendingFinal,
          (event as { aborted?: boolean }).aborted || stopReason === "aborted"
            ? "cancelled"
            : stopReason === "error"
              ? "failed"
              : "completed",
        );
    } catch (error) {
      report(ctx, error);
    } finally {
      resetTurn();
    }
    return undefined;
  });
}

/** A no-tool observer used for governed leaves that intentionally do not load grants.ts. */
export default function activityObserver(pi: ExtensionAPI): void {
  registerActivityTimeline(pi, undefined, false);
}
