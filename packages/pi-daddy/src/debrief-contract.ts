import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { parseRetentionJson } from "./retention-json.ts";
const require = createRequire(import.meta.url);
const caseCheck = Compile(require("../contracts/debrief/v1/work-capture/work-case.schema.json"));
const requestCheck = Compile(require("../contracts/debrief/v1/work-capture/review-request.schema.json"));
export type Disposition = "confirmed_defect" | "expected_behavior" | "exemplar" | "uncertain" | "skip";
export interface ReviewRequest { caseManifestId: string; priorDecisionId: string | null; disposition: Disposition; note: string }
export interface ReviewItem { caseManifestId: string; candidate: { id: string; reason: string; [key: string]: unknown }; priorDecisionId: string | null; disposition: Disposition | "unresolved" }
export interface ReviewPort {
  list(offset: number, limit: number): unknown | Promise<unknown>;
  history(caseManifestId: string): unknown | Promise<unknown>;
  decide?: (request: ReviewRequest) => unknown | Promise<unknown>;
}
export interface BlindChoice { kind: "one" | "tie" | "none" | "insufficient"; labels: string[] }
export interface BlindView { version: "blind-intervention-view-v1"; cards: { label: string; artifactDigests: string[] }[]; limitations: string[] }
export interface BlindPort {
  view(): unknown | Promise<unknown>;
  readArtifact(label: string, digest: string): Uint8Array | Promise<Uint8Array>;
  choose(choice: BlindChoice): unknown | Promise<unknown>;
  reveal(): unknown | Promise<unknown>;
}
export const dataKey = (v: unknown): string => Array.isArray(v) ? `[${v.map(dataKey).join(",")}]` : v !== null && typeof v === "object"
  ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + dataKey((v as Record<string, unknown>)[k])).join(",")}}` : JSON.stringify(v);
export const dataDigest = (v: unknown) => createHash("sha256").update(dataKey(v)).digest("hex");
export const byteDigest = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
export const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function detached<T>(input: T): T {
  const active = new Set<object>(); let count = 0;
  const inspect = (v: unknown, depth: number): void => {
    if (++count > 50000 || depth > 32) throw new Error("debrief data bound exceeded");
    if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return;
    if (!v || typeof v !== "object" || active.has(v)) throw new Error("plain debrief data required");
    const array = Array.isArray(v), prototype = Object.getPrototypeOf(v), fields = Object.getOwnPropertyDescriptors(v);
    if (array ? prototype !== Array.prototype || v.length > 4096 || Reflect.ownKeys(fields).length !== v.length + 1 : ![Object.prototype, null].includes(prototype)) throw new Error("plain debrief object/array required");
    active.add(v);
    for (const k of Reflect.ownKeys(fields)) {
      if (array && k === "length") continue;
      const d = fields[k as string]; if (typeof k !== "string" || !d.enumerable || !Object.hasOwn(d, "value")) throw new Error("hidden/accessor debrief data refused");
      inspect(d.value, depth + 1);
    }
    if (array) for (let i = 0; i < v.length; i++) if (!Object.hasOwn(fields, String(i))) throw new Error("sparse debrief array");
    active.delete(v);
  };
  inspect(input, 0);
  const text = JSON.stringify(input);
  if (!text || Buffer.byteLength(text) > 1024 * 1024) throw new Error("bounded debrief data required");
  return parseRetentionJson(text) as T;
}
export function freeze<T>(v: T): T { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
export function closed(v: unknown, names: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== [...names].sort().join()) throw new Error("closed debrief object required");
}
export function reviewRequest(input: ReviewRequest): ReviewRequest {
  const r = detached(input); if (!requestCheck.Check(r)) throw new Error("invalid label request"); return freeze(r);
}
export function reviewPage(value: unknown, limit: number, offset = 0) {
  const page = detached(value) as { total: number; offset: number; items: ReviewItem[] };
  closed(page, ["total", "offset", "items"]);
  if (!Number.isSafeInteger(page.total) || page.total < 0 || page.total > 4096 || page.offset !== offset || !Array.isArray(page.items) || page.items.length > limit || page.items.length > Math.max(0, page.total - offset)) throw new Error("invalid bounded case page");
  for (const item of page.items) {
    closed(item, ["caseManifestId", "candidate", "priorDecisionId", "disposition"]);
    const c = item.candidate as Record<string, any>;
    if (!sha(item.caseManifestId) || !caseCheck.Check(c) || !(item.priorDecisionId === null || sha(item.priorDecisionId)) ||
      !["unresolved", "confirmed_defect", "expected_behavior", "exemplar", "uncertain", "skip"].includes(item.disposition) ||
      c.id !== dataDigest({ detector: c.detector, target: c.target, reason: c.reason }) ||
      c.classification !== ({ repeat_without_progress: "candidate_defect", economical_exemplar: "candidate_exemplar", coverage_gap: "coverage_issue" } as Record<string, string>)[c.reason] ||
      (c.reason === "repeat_without_progress" && (c.metrics.equivalentAttempts === undefined || c.metrics.equivalentAttempts < 2)) ||
      (c.reason === "economical_exemplar" && (c.metrics.measuredCost === undefined || c.metrics.costLimit === undefined || c.metrics.costUnit === undefined || c.metrics.measuredCost > c.metrics.costLimit))) throw new Error("invalid case identity/state");
  }
  if (new Set(page.items.map(i => i.caseManifestId)).size !== page.items.length) throw new Error("duplicate case card");
  return freeze(page);
}
export function validatedHistory(value: unknown, item: ReviewItem) {
  const history = detached(value) as Record<string, any>[];
  if (!Array.isArray(history) || history.length > 4096) throw new Error("invalid review history");
  let prior: string | null = null;
  for (const d of history) {
    closed(d, ["decision_schema", "id", "caseId", "priorDecisionId", "disposition", "author", "evidence", "note"]);
    const { decision_schema, id, ...body } = d;
    if (decision_schema !== 1 || !sha(id) || dataDigest(body) !== id || d.caseId !== item.candidate.id || d.priorDecisionId !== prior ||
      typeof d.author !== "string" || !d.author || d.author.length > 512 || /[\u0000-\u001f\u007f]/.test(d.author) ||
      !requestCheck.Check({ caseManifestId: item.caseManifestId, priorDecisionId: d.priorDecisionId, disposition: d.disposition, note: d.note }) ||
      !Array.isArray(d.evidence) || d.evidence.length > 256 || !d.evidence.every(sha) || !d.evidence.includes(item.caseManifestId)) throw new Error("unbound review history");
    prior = id;
  }
  return history.at(-1) ?? null;
}
export function matchingHistory(value: unknown, item: ReviewItem, request: ReviewRequest, author: string) {
  const last = validatedHistory(value, item);
  const expected = dataDigest({ caseId: item.candidate.id, priorDecisionId: request.priorDecisionId, disposition: request.disposition,
    author, evidence: [item.caseManifestId], note: request.note });
  return last?.id === expected ? expected : null;
}
export function blindView(value: unknown): BlindView {
  const view = detached(value) as BlindView; closed(view, ["version", "cards", "limitations"]);
  if (view.version !== "blind-intervention-view-v1" || !Array.isArray(view.cards) || view.cards.length < 2 || view.cards.length > 4 || !Array.isArray(view.limitations) || view.limitations.some(v => typeof v !== "string")) throw new Error("unsupported blind view");
  for (const c of view.cards) { closed(c, ["label", "artifactDigests"]); if (!/^variant-[a-f0-9]{16}$/.test(c.label) || !Array.isArray(c.artifactDigests) || c.artifactDigests.length > 4 || !c.artifactDigests.every(sha)) throw new Error("invalid opaque artifact card"); }
  if (new Set(view.cards.map(c => c.label)).size !== view.cards.length) throw new Error("duplicate blind label"); return freeze(view);
}
export function blindChoice(input: BlindChoice, view: BlindView): BlindChoice {
  const c = detached(input); closed(c, ["kind", "labels"]);
  if (!Array.isArray(c.labels) || new Set(c.labels).size !== c.labels.length || c.labels.some(l => !view.cards.some(v => v.label === l)) ||
    !["one", "tie", "none", "insufficient"].includes(c.kind) || (c.kind === "one" ? c.labels.length !== 1 : c.kind === "tie" ? c.labels.length < 2 : c.labels.length !== 0)) throw new Error("invalid quality choice");
  return freeze({ kind: c.kind, labels: [...c.labels].sort() });
}
