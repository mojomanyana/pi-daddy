/** Small display cache: bounded metadata reads, no filesystem traversal or durable writes. */
import { stat } from "node:fs/promises";
import { readBoundedTextSync } from "../kernel/bounded-read-sync.ts";
import { parseActivityTimeline, detailForTimeline } from "./activity-timeline.ts";
const MAX_BYTES = 2 * 1024 * 1024;
const files = new Map<
  string,
  { checked: number; identity: string; text: string; timeline?: ReturnType<typeof parseActivityTimeline> }
>();
export async function dashboardFile(path: string, now = Date.now()): Promise<string> {
  const cached = files.get(path);
  if (cached && now - cached.checked < 1000) return cached.text;
  const s = await stat(path);
  if (!s.isFile() || s.size > MAX_BYTES)
    throw Error("Dashboard metadata file unavailable or exceeds 2 MiB; no full-history restore");
  const identity = `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  if (cached?.identity === identity) {
    cached.checked = now;
    return cached.text;
  }
  const text = readBoundedTextSync(path, { maxBytes: MAX_BYTES }).text;
  files.set(path, { checked: now, identity, text });
  while (files.size > 4) files.delete(files.keys().next().value!);
  return text;
}
export function dashboardTimeline(path: string, text: string) {
  const cached = files.get(path);
  if (cached?.text === text) return (cached.timeline ??= parseActivityTimeline(text));
  return parseActivityTimeline(text);
}

// One explicit selection, read once. A fresh p/f selection obtains a new checked snapshot.
let detail: { selection: object; source: string; key: string; value: ReturnType<typeof detailForTimeline> } | undefined;
export function dashboardSelectedDetail(selection: { field: "prompt" | "final" }, source: string, key: string) {
  if (detail?.selection !== selection || detail.source !== source || detail.key !== key)
    detail = { selection, source, key, value: detailForTimeline(source, key, selection.field) };
  return detail.value;
}
