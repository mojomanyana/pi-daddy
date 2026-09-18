/** Durable, local-only activity facts. Timeline events never infer skill compliance or provider reasoning. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const ACTIVITY_TIMELINE_VERSION = 1 as const;
export const ENV_ACTIVITY_TIMELINE = "PI_DADDY_ACTIVITY_TIMELINE";
export const ENV_ACTIVITY_CONTENT = "PI_DADDY_ACTIVITY_CONTENT";
/** Per-child transport; these are observation identities, not capability authority. */
export const ENV_ACTIVITY_PATH = "PI_DADDY_ACTIVITY_PATH";
export const ENV_ACTIVITY_ROOT = "PI_DADDY_ACTIVITY_ROOT";
export const ENV_ACTIVITY_TASK = "PI_DADDY_ACTIVITY_TASK";
export const ENV_ACTIVITY_PARENT_TASK = "PI_DADDY_ACTIVITY_PARENT_TASK";
const MAX_EVENT_BYTES = 16 * 1024, MAX_CONTENT_BYTES = 256 * 1024;
const DIGEST = /^[a-f0-9]{64}$/, REF = /^content\/[a-f0-9]{64}$/;
export type TimelineFilter = "everything" | "agents" | "skills" | "needs-you";
export interface ContentReference { digest: string; bytes: number; ref?: string }
export interface ActivitySkill { name: string; source: string; digest: string }
export interface ActivityEvent {
  version: 1; id: string; kind: string; at: string; rootId: string; taskId: string; parentTaskId?: string;
  agentId?: string; agent?: string; outcome?: string; model?: string; thinking?: string;
  prompt?: ContentReference; final?: ContentReference; skill?: ActivitySkill;
}
export interface TimelineSkill extends ActivitySkill { available: boolean; read: boolean; active: boolean; superseded: boolean }
export interface TimelineTask {
  id: string; rootId: string; parentTaskId?: string; startedAt: string; endedAt?: string;
  status: "active" | "finished" | "failed" | "cancelled" | "needs-you";
  model?: string; thinking?: string; prompt?: ContentReference; final?: ContentReference;
  skills: TimelineSkill[]; agents: Array<{ id: string; parentTaskId?: string; agent: string; state: string }>;
}
export interface ActivityTimeline { tasks: TimelineTask[]; refusals: string[] }
export interface ActivityIdentity { rootId: string; path: string; taskId?: string; parentTaskId?: string }

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const validId = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 200;
/** Stable, unambiguous local selector: encoded root identity and task id, separated once by `:`. */
export const activityTaskKey = (rootId: string, taskId: string) => `${encodeURIComponent(rootId)}:${encodeURIComponent(taskId)}`;
function taskFromKey(value: string): { rootId: string; taskId: string } | null {
  const parts = value.split(":"); if (parts.length !== 2 || value.length > 1400) return null;
  try { const [rootId, taskId] = parts.map(decodeURIComponent); return validId(rootId) && validId(taskId) && value === activityTaskKey(rootId, taskId) ? { rootId, taskId } : null; } catch { return null; }
}
function validRef(value: unknown): value is ContentReference {
  const ref = value as ContentReference | null;
  return !!ref && typeof ref === "object" && DIGEST.test(String(ref.digest)) && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 &&
    (ref.ref === undefined || (ref.bytes <= MAX_CONTENT_BYTES && REF.test(ref.ref)));
}
function eventOf(value: unknown): ActivityEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Partial<ActivityEvent>;
  if (event.version !== 1 || !validId(event.id) || !validId(event.kind) || !validId(event.rootId) || !validId(event.taskId) ||
      typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at))) return null;
  if ((event.parentTaskId && !validId(event.parentTaskId)) || (event.agentId && !validId(event.agentId)) ||
      (event.agent && !validId(event.agent)) || (event.prompt && !validRef(event.prompt)) || (event.final && !validRef(event.final))) return null;
  if (event.skill && (!validId(event.skill.name) || typeof event.skill.source !== "string" || event.skill.source.length > 2048 || !DIGEST.test(event.skill.digest))) return null;
  return event as ActivityEvent;
}
export function parseActivityTimeline(text: string): ActivityTimeline {
  const tasks = new Map<string, TimelineTask>(), refusals: string[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    if (!raw.trim()) continue;
    let event: ActivityEvent | null = null;
    try { event = eventOf(JSON.parse(raw)); } catch { /* reported below */ }
    if (!event) { refusals.push(`line ${index + 1}: invalid or unsafe timeline event`); continue; }
    const key = `${event.rootId}\0${event.taskId}`;
    let task = tasks.get(key);
    if (!task) { task = { id: event.taskId, rootId: event.rootId, parentTaskId: event.parentTaskId, startedAt: event.at, status: "active", skills: [], agents: [] }; tasks.set(key, task); }
    if (event.kind === "task_started") { task.model = event.model; task.thinking = event.thinking; task.prompt = event.prompt; task.parentTaskId = event.parentTaskId ?? task.parentTaskId; }
    if (event.kind === "task_finished") { task.endedAt = event.at; task.final = event.final; task.status = event.outcome === "cancelled" ? "cancelled" : ["failed", "error"].includes(event.outcome ?? "") ? "failed" : "finished"; }
    if (event.kind === "needs_you") task.status = "needs-you";
    if (event.skill) {
      let skill = task.skills.find(value => value.name === event!.skill!.name && value.digest === event!.skill!.digest && value.source === event!.skill!.source);
      if (!skill) { skill = { ...event.skill, available: false, read: false, active: false, superseded: false }; task.skills.push(skill); }
      if (event.kind === "skill_available") skill.available = true;
      if (event.kind === "skill_read") skill.read = true;
      if (event.kind === "skill_active") skill.active = true;
      if (event.kind === "skill_finished") skill.active = false;
      if (event.kind === "skill_superseded") { skill.superseded = true; skill.active = false; }
    }
    if (event.kind === "agent_started" && event.agentId) task.agents.push({ id: event.agentId, parentTaskId: event.parentTaskId, agent: event.agent ?? "unknown", state: "active" });
    if (event.kind === "agent_finished" && event.agentId) { const agent = task.agents.find(value => value.id === event!.agentId); if (agent) agent.state = event.outcome ?? "finished"; }
  }
  return { tasks: [...tasks.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)), refusals };
}
function mark(status: TimelineTask["status"]): string { return status === "active" ? "●" : status === "needs-you" ? "!" : status === "failed" || status === "cancelled" ? "×" : "✓"; }
export function renderActivityTimeline(timeline: ActivityTimeline, options: { filter?: TimelineFilter; details?: boolean; content?: { taskKey: string; field: "prompt" | "final"; text: string } } = {}): string {
  const filter = options.filter ?? "everything", lines = ["PI-DADDY ACTIVITY", ""];
  const tasks = timeline.tasks.filter(task => filter === "everything" || filter === "needs-you" && task.status === "needs-you" || filter === "agents" && task.agents.length > 0 || filter === "skills" && task.skills.length > 0);
  for (const task of tasks) {
    lines.push(`${task.parentTaskId ? "  └─ " : ""}${mark(task.status)} ${task.id}  ${task.status}${task.model ? ` · ${task.model}` : ""}${task.thinking ? ` · requested thinking ${task.thinking}` : ""}`);
    if (filter !== "agents") for (const skill of task.skills) lines.push(`  skill ${skill.name} · ${skill.available ? "available" : "availability unknown"}; ${skill.read ? "read" : "not observed read"}; ${skill.active ? "declared active" : "not declared active"}${skill.superseded ? "; superseded" : ""}`);
    if (filter !== "skills") for (const agent of task.agents) lines.push(`  agent ${agent.agent} · ${agent.state}${agent.parentTaskId ? ` · parent ${agent.parentTaskId}` : ""}`);
    if (options.details && (task.prompt || task.final)) { const key = activityTaskKey(task.rootId, task.id); lines.push(`  private details: p ${key} (submitted prompt) · f ${key} (final response)`); }
  }
  if (options.content) lines.push("", `PRIVATE ${options.content.field.toUpperCase()} · ${options.content.taskKey}`, options.content.text);
  if (!tasks.length) lines.push("No activity recorded yet.");
  if (timeline.refusals.length) lines.push(...timeline.refusals.map(refusal => `timeline refusal: ${refusal}`));
  lines.push("", "Filters: Everything · Agents · Skills · Needs-you. Type p <root-id:task-id> or f <root-id:task-id> after d Details; shorthand task ids are refused. Read is observation; active is a declaration; neither proves compliance.");
  return lines.join("\n");
}
export const defaultActivityTimelinePath = (cwd: string) => join(cwd, ".pi", "pi-daddy", "activity.jsonl");
export function activityIdentity(cwd: string, env: NodeJS.ProcessEnv = process.env): ActivityIdentity {
  const configured = env[ENV_ACTIVITY_TIMELINE]?.trim(), transported = env[ENV_ACTIVITY_PATH]?.trim();
  const path = transported ? resolve(transported) : configured && configured !== "1" && configured !== "off" && configured !== "0" ? resolve(cwd, configured) : defaultActivityTimelinePath(cwd);
  return { rootId: env[ENV_ACTIVITY_ROOT]?.trim() || randomUUID(), path, ...(env[ENV_ACTIVITY_TASK]?.trim() ? { taskId: env[ENV_ACTIVITY_TASK].trim() } : {}), ...(env[ENV_ACTIVITY_PARENT_TASK]?.trim() ? { parentTaskId: env[ENV_ACTIVITY_PARENT_TASK].trim() } : {}) };
}
export class ActivityTimelineRecorder {
  readonly enabled: boolean; readonly contentEnabled: boolean; readonly path: string; readonly rootId: string; private taskId?: string;
  constructor(cwd: string, env: NodeJS.ProcessEnv = process.env) { const configured = env[ENV_ACTIVITY_TIMELINE]?.trim(); this.enabled = configured !== "off" && configured !== "0"; this.contentEnabled = env[ENV_ACTIVITY_CONTENT]?.trim() !== "metadata-only" && env[ENV_ACTIVITY_CONTENT]?.trim() !== "off"; const identity = activityIdentity(cwd, env); this.path = identity.path; this.rootId = identity.rootId; this.taskId = identity.taskId; }
  get task(): string | undefined { return this.taskId; }
  attach(taskId: string): void { this.taskId = taskId; }
  async start(prompt: string, model?: string, thinking?: string, parentTaskId?: string): Promise<string | undefined> { if (!this.enabled) return undefined; this.taskId = randomUUID(); await this.append("task_started", { parentTaskId, model, thinking, prompt: await this.content(prompt) }); return this.taskId; }
  async childStarted(taskId: string, parentTaskId: string | undefined, agent: string, prompt: string, model?: string, thinking?: string): Promise<void> { if (!this.enabled) return; this.taskId = taskId; await this.append("task_started", { parentTaskId, agentId: taskId, agent, model, thinking, prompt: await this.content(prompt) }); await this.append("agent_started", { parentTaskId, agentId: taskId, agent }); }
  async childFinished(taskId: string, parentTaskId: string | undefined, agent: string, final: string, outcome: "completed" | "failed" | "cancelled"): Promise<void> { if (!this.enabled) return; this.taskId = taskId; await this.append("agent_finished", { parentTaskId, agentId: taskId, agent, outcome }); await this.finish(final, outcome); }
  async finish(final: string | undefined, outcome: "completed" | "failed" | "cancelled" = "completed"): Promise<void> { if (this.enabled && this.taskId) await this.append("task_finished", { outcome, ...(final === undefined ? {} : { final: await this.content(final) }) }); }
  async skill(kind: "skill_available" | "skill_read" | "skill_active" | "skill_finished" | "skill_superseded", skill: ActivitySkill): Promise<void> { if (this.taskId) await this.append(kind, { skill }); }
  async append(kind: string, fields: Omit<Partial<ActivityEvent>, "version" | "id" | "kind" | "at" | "rootId" | "taskId">): Promise<void> { if (!this.enabled || !this.taskId) return; const event: ActivityEvent = { version: 1, id: randomUUID(), kind, at: new Date().toISOString(), rootId: this.rootId, taskId: this.taskId, ...fields }; const text = JSON.stringify(event); if (Buffer.byteLength(text) > MAX_EVENT_BYTES) throw Error("activity timeline event exceeds bound"); await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); await appendFile(this.path, `${text}\n`, { mode: 0o600 }); }
  private async content(value: string): Promise<ContentReference> { const digest = sha(value), bytes = Buffer.byteLength(value); if (!this.contentEnabled || bytes > MAX_CONTENT_BYTES) return { digest, bytes }; const root = join(dirname(this.path), "content"), target = join(root, digest); await mkdir(root, { recursive: true, mode: 0o700 }); try { await readFile(target, "utf8"); } catch { const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 }); await rename(temporary, target); } return { digest, bytes, ref: `content/${digest}` }; }
}
export async function readActivityContent(timelinePath: string, reference: ContentReference): Promise<string> {
  if (!validRef(reference) || !reference.ref) throw Error("TIMELINE_REFERENCE_INVALID");
  const root = resolve(dirname(timelinePath), "content"), target = resolve(dirname(timelinePath), reference.ref);
  if (!target.startsWith(`${root}${sep}`) || await realpath(root) !== root) throw Error("TIMELINE_REFERENCE_INVALID");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const before = await handle.stat(); if (!before.isFile() || before.nlink !== 1 || before.size > MAX_CONTENT_BYTES) throw Error("TIMELINE_REFERENCE_INVALID"); const value = await handle.readFile("utf8"), after = await handle.stat(); if (after.size !== before.size || Buffer.byteLength(value) !== reference.bytes || sha(value) !== reference.digest) throw Error("TIMELINE_REFERENCE_TAMPERED"); return value; } finally { await handle.close(); }
}
export async function detailForTimeline(timelinePath: string, taskKey: string, field: "prompt" | "final"): Promise<{ taskKey: string; field: "prompt" | "final"; text: string }> {
  const identity = taskFromKey(taskKey); if (!identity) throw Error("TIMELINE_DETAIL_INVALID");
  const timeline = parseActivityTimeline(await readFile(timelinePath, "utf8"));
  const task = timeline.tasks.find(value => value.rootId === identity.rootId && value.id === identity.taskId);
  const reference = task?.[field]; if (!reference) throw Error("TIMELINE_DETAIL_UNAVAILABLE");
  return { taskKey, field, text: await readActivityContent(timelinePath, reference) };
}
