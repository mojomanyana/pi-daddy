/** Pi hook wiring for local activity observation. It neither decides grants nor adds child authority. */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ActivityTimelineRecorder, ENV_ACTIVITY_TASK, type ActivityIdentity, type ActivitySkill } from "../src/activity-timeline.ts";

export interface ActivitySessionState { activityRootId?: string; activity?: ActivityIdentity & { taskId?: string } }
interface HookContext { cwd: string; model?: { id?: string }; thinkingLevel?: string; ui: { notify(message: string, level?: "info" | "warning" | "error"): void } }
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Register observation hooks. `lifecycleTool` is false in a leaf observer injected with `-e`: that
 * extension has no tools at all, so a child without tool:delegate receives no widened surface.
 */
export function registerActivityTimeline(pi: ExtensionAPI, session?: ActivitySessionState, lifecycleTool = true): void {
  let recorder: ActivityTimelineRecorder | undefined, pendingFinal: string | undefined, finalizedUser: string | undefined;
  let paths = new Map<string, string>(), available = new Map<string, ActivitySkill>();
  let reported = false;
  const report = (ctx: HookContext | undefined, error: unknown) => { if (!reported && ctx) { reported = true; ctx.ui.notify(`pi-daddy activity: observation unavailable (${error instanceof Error ? error.message : String(error)}); governance is unchanged.`, "warning"); } };
  const current = (ctx: HookContext): ActivityTimelineRecorder => {
    const env = session?.activityRootId && !process.env.PI_DADDY_ACTIVITY_ROOT ? { ...process.env, PI_DADDY_ACTIVITY_ROOT: session.activityRootId } : process.env;
    // session_start binds reload ownership after this hook registration; re-create before the first turn
    // if that binding recovered a prior root identity rather than the factory's provisional UUID.
    if (!recorder || (!process.env.PI_DADDY_ACTIVITY_ROOT && session?.activityRootId && recorder.rootId !== session.activityRootId)) recorder = new ActivityTimelineRecorder(ctx.cwd, env);
    return recorder;
  };
  const skills = async (event: unknown, target: ActivityTimelineRecorder) => {
    available = new Map();
    const entries = ((event as { systemPromptOptions?: { skills?: Array<{ name?: string; filePath?: string }> } }).systemPromptOptions?.skills ?? []);
    for (const item of entries) {
      if (!item.name || !item.filePath) continue;
      const source = await readFile(item.filePath, "utf8");
      if (Buffer.byteLength(source) > 256 * 1024) continue;
      const fact = { name: item.name, source: item.filePath, digest: digest(source) };
      available.set(resolve(item.filePath), fact); await target.skill("skill_available", fact);
    }
  };
  if (lifecycleTool) pi.registerTool({
    name: "activity_lifecycle", label: "Activity lifecycle",
    description: "Declare a runtime skill active, finished, or superseded for the local activity timeline. This is not compliance evidence.",
    parameters: Type.Object({ state: Type.Union([Type.Literal("active"), Type.Literal("finished"), Type.Literal("superseded")]), name: Type.String({ minLength: 1, maxLength: 128 }), source: Type.String({ minLength: 1, maxLength: 1024 }), digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) }),
    async execute(_id, params) { const kind = params.state === "active" ? "skill_active" : params.state === "finished" ? "skill_finished" : "skill_superseded"; await recorder?.skill(kind, { name: params.name, source: params.source, digest: params.digest }); return { content: [{ type: "text", text: `Activity recorded: ${params.name} ${params.state}.` }], details: {} }; },
  });
  pi.on("session_start", (_event, ctx: HookContext) => {
    try {
      recorder = current(ctx);
      // A leaf observer attaches to the parent-owned child event; a root gets a stable session identity.
      if (process.env[ENV_ACTIVITY_TASK]) recorder.attach(process.env[ENV_ACTIVITY_TASK]!);
      const identity: ActivityIdentity = { rootId: recorder.rootId, path: recorder.path, ...(recorder.task ? { taskId: recorder.task } : {}) };
      if (session) session.activity = identity;
      ctx.ui.notify(recorder.enabled ? `pi-daddy activity: local observation on (${recorder.contentEnabled ? "private prompt/final content" : "metadata only"}); governance is unchanged.` : "pi-daddy activity: observation off; governance is unchanged.", "info");
    } catch (error) { report(ctx, error); }
    return undefined;
  });
  pi.on("before_agent_start", async (event, ctx: HookContext) => {
    try {
      const target = current(ctx);
      // An injected leaf observer must not fabricate a second child task; its parent-owned execution seam
      // already wrote task_started. Root turns always get a fresh task id under their stable root identity.
      if (!process.env[ENV_ACTIVITY_TASK]) {
        const taskId = await target.start(finalizedUser ?? (event as { prompt?: string }).prompt ?? "", ctx.model?.id, ctx.thinkingLevel);
        finalizedUser = undefined;
        if (session?.activity) session.activity = { rootId: target.rootId, path: target.path, ...(taskId ? { taskId } : {}) };
      }
      await skills(event, target);
    } catch (error) { report(ctx, error); }
    return undefined;
  });
  pi.on("message_end", (event) => {
    const message = (event as { message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> } }).message;
    const text = typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message!.content.filter(part => part.type === "text").map(part => part.text ?? "").join("") : "";
    if (message?.role === "user") finalizedUser = text;
    if (message?.role === "assistant") pendingFinal = text;
    return undefined;
  });
  pi.on("tool_execution_start", (event) => { const value = event as { toolCallId?: string; args?: { path?: unknown } }; if (value.toolCallId && typeof value.args?.path === "string") paths.set(value.toolCallId, value.args.path); return undefined; });
  pi.on("tool_execution_end", async (event) => {
    try { const value = event as { isError?: boolean; toolName?: string; toolCallId?: string }; const path = value.toolCallId ? paths.get(value.toolCallId) : undefined; if (value.toolCallId) paths.delete(value.toolCallId); const skill = path ? available.get(resolve(path)) : undefined; if (!value.isError && value.toolName === "read" && skill) await recorder?.skill("skill_read", skill); } catch { /* observation cannot affect tool execution */ }
    return undefined;
  });
  pi.on("agent_settled", async (event, ctx: HookContext) => {
    try { if (recorder && !process.env[ENV_ACTIVITY_TASK]) await recorder.finish(pendingFinal, (event as { cancelled?: boolean; error?: unknown }).cancelled ? "cancelled" : (event as { error?: unknown }).error ? "failed" : "completed"); pendingFinal = undefined; } catch (error) { report(ctx, error); }
    return undefined;
  });
}

/** A no-tool observer used for governed leaves that intentionally do not load grants.ts. */
export default function activityObserver(pi: ExtensionAPI): void { registerActivityTimeline(pi, undefined, false); }
