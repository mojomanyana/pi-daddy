import { createHash } from "node:crypto";

/** Separate from human-authored capture_schema1; a nomination is not a test, verdict or promotion. */
export interface WorkCaptureCaseV2 {
  capture_schema: 2;
  id: string;
  detector: { id: string; version: string; population: string };
  target: { kind: "work"; snapshotDigest: string; obligationId: string; obligationDigest: string };
  classification: "candidate_defect" | "candidate_exemplar" | "coverage_issue";
  reason: "repeat_without_progress" | "economical_exemplar" | "coverage_gap";
  evidence: string[];
  metrics: { equivalentAttempts?: number; measuredCost?: number; costLimit?: number; costUnit?: "wall_ms" | "tool_calls" | "usd" };
  status: "unresolved";
  visibility: "silent";
  causalAttribution: "not-established";
}
export type WorkCaseDisposition = "confirmed_defect" | "expected_behavior" | "exemplar" | "uncertain" | "skip";
export interface WorkCaseDecision {
  decision_schema: 1;
  id: string;
  caseId: string;
  priorDecisionId: string | null;
  disposition: WorkCaseDisposition;
  /** Attributable controller-supplied author, never filled from a nominator's hypothesis. */
  author: string;
  evidence: string[];
  note: string;
}
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value);
const sha = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function closed(value: unknown, names: string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(fields).length === names.length && Reflect.ownKeys(fields).every(key => typeof key === "string" && names.includes(key) && fields[key].enumerable && Object.hasOwn(fields[key], "value"));
}
const hash = /^[a-f0-9]{64}$/;
const text = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 512 && !/[\u0000-\u001f\u007f]/.test(s);
export function buildWorkCapture(input: Omit<WorkCaptureCaseV2, "capture_schema" | "id" | "status" | "visibility" | "causalAttribution">): WorkCaptureCaseV2 {
  if (!closed(input, ["detector", "target", "classification", "reason", "evidence", "metrics"])
    || !closed(input.detector, ["id", "version", "population"]) || !closed(input.target, ["kind", "snapshotDigest", "obligationId", "obligationDigest"])
    || !input.metrics || typeof input.metrics !== "object" || !closed(input.metrics, Object.keys(input.metrics))
    || !Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 256
    || Array.from({ length: input.evidence.length }, (_, i) => i).some(i => !Object.hasOwn(input.evidence, i))) throw new Error("invalid work capture fields");
  if (![input.detector.id, input.detector.version, input.detector.population, input.target.obligationId].every(text)
    || input.target.kind !== "work" || !hash.test(input.target.snapshotDigest) || !hash.test(input.target.obligationDigest)
    || input.evidence.length > 256 || input.evidence.some(e => !hash.test(e))
    || !["candidate_defect", "candidate_exemplar", "coverage_issue"].includes(input.classification)
    || !["repeat_without_progress", "economical_exemplar", "coverage_gap"].includes(input.reason)
    || Object.keys(input.metrics).some(k => !["equivalentAttempts", "measuredCost", "costLimit", "costUnit"].includes(k))
    || Object.entries(input.metrics).some(([key, n]) => key === "costUnit" ? !["wall_ms", "tool_calls", "usd"].includes(String(n)) : typeof n !== "number" || !Number.isFinite(n) || n < 0)
    || (input.reason === "repeat_without_progress" && (input.metrics.equivalentAttempts === undefined || input.metrics.equivalentAttempts < 2))
    || (input.reason === "economical_exemplar" && (input.metrics.measuredCost === undefined || input.metrics.costLimit === undefined || input.metrics.costUnit === undefined || input.metrics.measuredCost > input.metrics.costLimit))
    || (input.metrics.equivalentAttempts !== undefined && !Number.isSafeInteger(input.metrics.equivalentAttempts))) throw new Error("invalid work capture nomination");
  const expected = { repeat_without_progress: "candidate_defect", economical_exemplar: "candidate_exemplar", coverage_gap: "coverage_issue" };
  if (input.classification !== expected[input.reason]) throw new Error("work capture classification mismatch");
  const detector = { id: input.detector.id, version: input.detector.version, population: input.detector.population };
  const target: WorkCaptureCaseV2["target"] = { kind: "work", snapshotDigest: input.target.snapshotDigest, obligationId: input.target.obligationId, obligationDigest: input.target.obligationDigest };
  return { capture_schema: 2, id: sha({ detector, target, reason: input.reason }), detector, target,
    classification: input.classification, reason: input.reason, evidence: [...new Set(input.evidence)].sort(), metrics: Object.fromEntries(Object.entries(input.metrics).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    status: "unresolved", visibility: "silent", causalAttribution: "not-established" };
}
function validDecision(value: Omit<WorkCaseDecision, "decision_schema" | "id">): boolean {
  return closed(value, ["caseId", "priorDecisionId", "disposition", "author", "evidence", "note"])
    && typeof value.caseId === "string" && hash.test(value.caseId)
    && (value.priorDecisionId === null || (typeof value.priorDecisionId === "string" && hash.test(value.priorDecisionId)))
    && text(value.author) && typeof value.note === "string" && value.note.length <= 4000
    && Array.isArray(value.evidence) && value.evidence.length <= 256
    && Array.from({ length: value.evidence.length }, (_, i) => i).every(i => Object.hasOwn(value.evidence, i) && typeof value.evidence[i] === "string" && hash.test(value.evidence[i]))
    && ["confirmed_defect", "expected_behavior", "exemplar", "uncertain", "skip"].includes(value.disposition);
}
/** Immutable correction chain. Calling code must establish the registered case and authorized author. */
export function appendWorkCaseDecision(history: readonly WorkCaseDecision[], input: Omit<WorkCaseDecision, "decision_schema" | "id">): WorkCaseDecision[] {
  if (!validDecision(input)) throw new Error("invalid case decision");
  if (history.length > 4096) throw new Error("case decision history exceeds bound");
  const heads = new Map<string, string>(); const seen = new Set<string>();
  for (const decision of history) {
    if (!closed(decision, ["decision_schema", "id", "caseId", "priorDecisionId", "disposition", "author", "evidence", "note"]) || decision.decision_schema !== 1) throw new Error("invalid case decision history");
    const { decision_schema: _schema, id: recordedId, ...prior } = decision;
    if (!validDecision(prior) || sha(prior) !== recordedId) throw new Error("case decision history identity mismatch");
    if (seen.has(recordedId)) continue;
    if ((heads.get(decision.caseId) ?? null) !== decision.priorDecisionId) throw new Error("case decision history fork or missing parent");
    seen.add(recordedId); heads.set(decision.caseId, recordedId);
  }
  const body = { ...input, evidence: [...new Set(input.evidence)].sort() }; const id = sha(body);
  if (history.some(d => d.id === id)) return [...history];
  const own = history.filter(d => d.caseId === input.caseId); const last = own.at(-1)?.id ?? null;
  if (last !== input.priorDecisionId) throw new Error("stale case decision");
  return [...history, { decision_schema: 1, id, ...body }];
}
