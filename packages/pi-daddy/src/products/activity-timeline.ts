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
  id: string; rootId: string; parentTaskId?: string; agent?: string; startedAt: string; endedAt?: string;
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
    if (event.kind === "task_started") { task.model = event.model; task.thinking = event.thinking; task.prompt = event.prompt; task.agent = event.agent ?? task.agent; task.parentTaskId = event.parentTaskId ?? task.parentTaskId; }
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
  return { tasks: [...tasks.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || activityTaskKey(a.rootId, a.id).localeCompare(activityTaskKey(b.rootId, b.id))), refusals };
}

/** Session-local aliases never derive from private prompt text and never renumber after a refresh. */
export class ActivityTimelineAliases {
  private readonly roots = new Map<string, string>(); private readonly tasks = new Map<string, string>(); private readonly selectors = new Map<string, string>();
  selector(task: Pick<TimelineTask, "rootId" | "id">): string {
    let root = this.roots.get(task.rootId);
    if (!root) { root = `r${this.roots.size + 1}`; this.roots.set(task.rootId, root); }
    const key = activityTaskKey(task.rootId, task.id);
    let child = this.tasks.get(key);
    if (!child) { const count = [...this.tasks.keys()].filter(value => taskFromKey(value)?.rootId === task.rootId).length; child = `t${count + 1}`; this.tasks.set(key, child); }
    const selector = `${root}/${child}`; this.selectors.set(selector, key); return selector;
  }
  resolve(selector: string): string | undefined { return this.selectors.get(selector); }
}
export function resolveActivityTaskSelector(timeline: ActivityTimeline, selector: string, aliases?: ActivityTimelineAliases): string | undefined {
  const key = aliases?.resolve(selector) ?? selector, identity = taskFromKey(key);
  return identity && timeline.tasks.some(task => task.rootId === identity.rootId && task.id === identity.taskId) ? key : undefined;
}

const ANSI_SGR = /\u001b\[[0-9;]*m/g;
const WIDE_CELL = /\p{Extended_Pictographic}|[\u2E80-\u9FFF\uF900-\uFAFF]/u;
/** Render controls as literal escapes; only content newlines retain their structural meaning. */
function visualizeControls(value: string, preserveNewlines = false): string {
  let output = "";
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index); if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint), next = index + char.length;
    if (char === "\r" && value[next] === "\n") { output += preserveNewlines ? "\n" : "\\n"; index = next + 1; continue; }
    if (char === "\n") { output += preserveNewlines ? "\n" : "\\n"; index = next; continue; }
    if (codePoint < 0x20 || codePoint === 0x7f) output += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    else if ((codePoint >= 0x80 && codePoint <= 0x9f) || /\p{Cf}/u.test(char)) output += `\\u{${codePoint.toString(16)}}`;
    else output += char;
    index = next;
  }
  return output;
}
function clean(value: string | undefined): string { return visualizeControls(value ?? "").replace(/\s+/g, " ").trim(); }
function cellWidth(value: string): number { return [...value.replace(ANSI_SGR, "")].reduce((sum, char) => sum + (WIDE_CELL.test(char) ? 2 : 1), 0); }
function wrapDetailLine(value: string, width: number): string[] {
  if (value.length === 0) return [""];
  const lines: string[] = []; let line = "", cells = 0;
  for (const char of value) {
    const next = WIDE_CELL.test(char) ? 2 : 1;
    if (cells + next > width && line) { lines.push(line); line = ""; cells = 0; }
    line += char; cells += next;
  }
  lines.push(line); return lines;
}
function safeDetailLines(value: string, width: number): string[] {
  return visualizeControls(value, true).split("\n").flatMap(line => wrapDetailLine(line, width));
}
function truncate(value: string, width: number): string {
  if (cellWidth(value) <= width) return value;
  const target = Math.max(0, width - 1); let cells = 0, output = "", styled = false;
  for (let index = 0; index < value.length;) {
    if (value[index] === "\u001b") { const match = /^\u001b\[([0-9;]*)m/.exec(value.slice(index)); if (match) { output += match[0]; styled = match[1] !== "0" && match[1] !== ""; index += match[0].length; continue; } }
    const codePoint = value.codePointAt(index); if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint), next = WIDE_CELL.test(char) ? 2 : 1;
    if (cells + next > target) break; output += char; cells += next; index += char.length;
  }
  return `${output}…${styled ? "\u001b[0m" : ""}`;
}
function paint(value: string, color: number, enabled: boolean): string { return enabled ? `\u001b[${color}m${value}\u001b[0m` : value; }

interface ActivityRenderOptions { filter?: TimelineFilter; details?: boolean; history?: boolean; color?: boolean; width?: number; aliases?: ActivityTimelineAliases; content?: { taskKey: string; field: "prompt" | "final"; text: string } }
function taskKey(task: Pick<TimelineTask, "rootId" | "id">): string { return `${task.rootId}\0${task.id}`; }
function isAttention(task: TimelineTask): boolean { return task.status !== "finished"; }
function stateLine(task: TimelineTask, child: boolean): { text: string; color: number } {
  if (task.status === "active") return { text: "AGENT ACTIVE", color: 36 };
  if (task.status === "needs-you") return { text: "WAIT NEEDS YOU", color: 33 };
  if (task.status === "failed") return { text: child ? "FAIL CHILD FAILED" : "FAIL PARENT TURN FAILED", color: 31 };
  if (task.status === "cancelled") return { text: child ? "WAIT CHILD CANCELLED" : "WAIT PARENT TURN CANCELLED", color: 33 };
  return { text: child ? "DONE CHILD COMPLETED" : "DONE PARENT TURN ENDED", color: 32 };
}

/** Render only local observation. “Completed” and “ended” never mean accepted. */
export function renderActivityTimeline(timeline: ActivityTimeline, options: ActivityRenderOptions = {}): string {
  const color = options.color === true && Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
  const width = Math.max(10, options.width ?? 80), filter = options.filter ?? "everything", aliases = options.aliases ?? new ActivityTimelineAliases();
  const byKey = new Map(timeline.tasks.map(task => [taskKey(task), task]));
  const children = new Map<string, TimelineTask[]>(), roots: TimelineTask[] = [];
  for (const task of timeline.tasks) {
    const parent = task.parentTaskId ? byKey.get(`${task.rootId}\0${task.parentTaskId}`) : undefined;
    if (parent) { const list = children.get(taskKey(parent)) ?? []; list.push(task); children.set(taskKey(parent), list); } else roots.push(task);
  }
  for (const list of children.values()) list.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  roots.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || activityTaskKey(a.rootId, a.id).localeCompare(activityTaskKey(b.rootId, b.id)));
  const matching = (task: TimelineTask): boolean => filter === "everything" ? true : filter === "agents" ? Boolean(task.agent || task.agents.length) : filter === "skills" ? task.skills.length > 0 : task.status === "needs-you";
  const shown = new Set<string>();
  for (const task of timeline.tasks) if (matching(task)) {
    let current: TimelineTask | undefined = task, seen = new Set<string>();
    while (current && !seen.has(taskKey(current))) { shown.add(taskKey(current)); seen.add(taskKey(current)); current = current.parentTaskId ? byKey.get(`${current.rootId}\0${current.parentTaskId}`) : undefined; }
  }
  const hasAttention = (task: TimelineTask, seen = new Set<string>()): boolean => {
    const key = taskKey(task); if (seen.has(key)) return true; seen.add(key);
    return isAttention(task) || (children.get(key) ?? []).some(child => hasAttention(child, seen));
  };
  const choose = (tasks: TimelineTask[], limit: number): { shown: TimelineTask[]; hidden: number } => {
    const important = tasks.filter(task => hasAttention(task)), quiet = tasks.filter(task => !hasAttention(task));
    const kept = options.history ? quiet : quiet.slice(-limit);
    return { shown: [...important, ...kept].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)), hidden: quiet.length - kept.length };
  };
  const lines = [paint("PI-DADDY ACTIVITY", 36, color), ""];
  const renderTask = (task: TimelineTask, prefix: string, branch: string): void => {
    const key = taskKey(task), directChildren = (children.get(key) ?? []).filter(child => shown.has(taskKey(child)));
    if (!shown.has(key)) return;
    const child = Boolean(task.parentTaskId && byKey.has(`${task.rootId}\0${task.parentTaskId}`));
    const state = stateLine(task, child), selector = aliases.selector(task);
    const heading = clean(task.agent) || (child ? "Governed child" : "User turn");
    const meta = [task.model && `model ${clean(task.model)}`, task.thinking && `thinking ${clean(task.thinking)}`].filter(Boolean).join(" · ");
    lines.push(`${prefix}${branch}${paint(child ? "AGENT" : "USER", child ? 36 : 34, color)} ${heading} [${selector}] · ${paint(state.text, state.color, color)}${meta ? ` · ${meta}` : ""}`);
    const failedChildren = directChildren.filter(value => value.status === "failed").length;
    if (failedChildren) lines.push(`${prefix}${branch ? "   " : ""}  ${paint(`FAIL OBSERVED CHILD FAILURES: ${failedChildren} failed (not accepted)`, 31, color)}`);
    const visibleSkills = task.skills.filter(skill => options.details || filter === "skills" || skill.read || skill.active || skill.superseded);
    for (const skill of visibleSkills) {
      const availabilityOnly = skill.available && !skill.read && !skill.active && !skill.superseded;
      const description = availabilityOnly ? "available only" : `read ${skill.read ? "yes" : "no"} · declared active ${skill.active ? "yes" : "no"}${skill.superseded ? " · superseded" : ""}`;
      lines.push(`${prefix}${branch ? "   " : ""}  ${paint("SKILL", 35, color)} ${clean(skill.name) || "unnamed"} · ${description}`);
    }
    if (options.details || filter === "agents") for (const agent of task.agents) lines.push(`${prefix}${branch ? "   " : ""}  ${paint("AGENT", 36, color)} ${clean(agent.agent) || "unknown"} · observed ${clean(agent.state) || "unknown"}`);
    if (options.details && (task.prompt || task.final)) lines.push(`${prefix}${branch ? "   " : ""}  DETAILS p|f ${selector} · legacy ${activityTaskKey(task.rootId, task.id)}`);
    const selected = choose(directChildren, 2);
    if (selected.hidden > 0) lines.push(`${prefix}${branch ? "   " : ""}  ${paint(`… ${selected.hidden} quiet completed child task${selected.hidden === 1 ? "" : "s"} hidden`, 90, color)}`);
    selected.shown.forEach((value, index) => renderTask(value, `${prefix}${branch === "" ? "" : branch === "└─ " ? "   " : "│  "}`, index === selected.shown.length - 1 ? "└─ " : "├─ "));
  };
  const selectedRoots = choose(roots.filter(task => shown.has(taskKey(task))), 3);
  if (selectedRoots.hidden > 0) lines.push(paint(`… ${selectedRoots.hidden} quiet completed root task${selectedRoots.hidden === 1 ? "" : "s"} hidden`, 90, color));
  for (const root of selectedRoots.shown) renderTask(root, "", "");
  if (!selectedRoots.shown.length) lines.push("No matching local activity recorded yet.");
  if (timeline.refusals.length) lines.push(...timeline.refusals.map(refusal => paint(`FAIL timeline refusal: ${clean(refusal)}`, 31, color)));
  if (options.content) lines.push("", `${paint("PRIVATE", 34, color)} ${options.content.field.toUpperCase()} · ${clean(options.content.taskKey)}`, ...safeDetailLines(options.content.text, width));
  lines.push("", "Keys: d details · h history · Everything|Agents|Skills|Needs-you · p|f <r#/t# or root:task>. Read and declared active are observations, not compliance or acceptance.");
  return lines.map(line => truncate(line, width)).join("\n");
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
