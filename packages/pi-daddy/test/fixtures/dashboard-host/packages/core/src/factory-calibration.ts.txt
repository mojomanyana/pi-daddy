export interface CalibrationComponent { kind: "detector" | "adjudicator"; id: string; version: string; population: string }
export type CalibrationKind = "positive" | "approval" | "rejection";
export type CalibrationSplit = "calibration" | "heldout" | "tuning";
export interface CalibrationPrediction {
  id: string; incidentId: string; component: CalibrationComponent; kind: CalibrationKind; split: CalibrationSplit;
}
/** Independently established host context, not fields accepted from predictions or panel agreement. */
export interface CalibrationOutcome extends CalibrationPrediction { correct: boolean }
export interface CalibrationReport {
  component: CalibrationComponent; kind: CalibrationKind; split: Exclude<CalibrationSplit, "tuning">;
  correct: number; incorrect: number; resolved: number; unresolved: number; conflicted: number; totalIncidents: number;
  precision: number | null; interval: { lower: number; upper: number } | null; advisoryOnly: true;
}
const computedReports = new WeakSet<object>();
const text = (x: unknown) => typeof x === "string" && x.length > 0 && x.length <= 512 && !/[\u0000-\u001f\u007f]/.test(x);
function closed(x: unknown, fields: string[]): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === fields.length && Object.keys(x).every(k => fields.includes(k));
}
function valid(x: CalibrationPrediction, outcome = false): boolean {
  return closed(x, outcome ? ["id", "incidentId", "component", "kind", "split", "correct"] : ["id", "incidentId", "component", "kind", "split"])
    && text(x.id) && text(x.incidentId) && closed(x.component, ["kind", "id", "version", "population"])
    && [x.component.id, x.component.version, x.component.population].every(text)
    && ["calibration", "heldout", "tuning"].includes(x.split)
    && (x.component.kind === "detector" ? x.kind === "positive" : x.component.kind === "adjudicator" && ["approval", "rejection"].includes(x.kind))
    && (!outcome || typeof x.correct === "boolean");
}
const key = (x: Pick<CalibrationPrediction, "component" | "kind" | "split">) => JSON.stringify([x.component.kind, x.component.id, x.component.version, x.component.population, x.kind, x.split]);
function interval(correct: number, count: number) {
  const z = 1.96, z2 = z * z, p = correct / count, denominator = 1 + z2 / count;
  const center = (p + z2 / (2 * count)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / count + z2 / (4 * count * count)) / denominator;
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}
/** Version/population/conditioning-specific statistics; no policy, grants, routing or adoption is changed. */
export function calibratePredictions(predictions: readonly CalibrationPrediction[], context: { outcomes: readonly CalibrationOutcome[] } = { outcomes: [] }) {
  if (predictions.length > 10000 || context.outcomes.length > 10000 || predictions.some(p => !valid(p)) || context.outcomes.some(r => !valid(r, true))) throw new Error("invalid calibration input");
  const byId = new Map<string, CalibrationPrediction>();
  for (const p of predictions) {
    const previous = byId.get(p.id);
    if (previous && (key(previous) !== key(p) || previous.incidentId !== p.incidentId)) throw new Error("prediction identity conflict");
    byId.set(p.id, p);
  }
  const groups = new Map<string, CalibrationPrediction[]>(); let excludedTuning = 0;
  for (const p of byId.values()) {
    if (p.split === "tuning") { excludedTuning++; continue; }
    const k = key(p); groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const referenceIds = new Map<string, string>(); const conflictingIds = new Set<string>();
  for (const r of context.outcomes) {
    const signature = JSON.stringify([key(r), r.incidentId, r.correct]);
    if (referenceIds.has(r.id) && referenceIds.get(r.id) !== signature) conflictingIds.add(r.id);
    referenceIds.set(r.id, signature);
  }
  const labels = new Map<string, Set<boolean>>(); const conflictedIncidents = new Set<string>();
  for (const r of context.outcomes) {
    const k = JSON.stringify([key(r), r.incidentId]);
    if (conflictingIds.has(r.id)) { conflictedIncidents.add(k); continue; }
    const values = labels.get(k) ?? new Set<boolean>(); values.add(r.correct); labels.set(k, values);
  }
  const reports: CalibrationReport[] = [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([groupKey, group]) => {
    const incidents = new Set(group.map(p => p.incidentId)); let correct = 0, incorrect = 0, unresolved = 0, conflicted = 0;
    for (const incident of incidents) {
      const incidentKey = JSON.stringify([groupKey, incident]); const outcomes = labels.get(incidentKey) ?? new Set<boolean>();
      if (outcomes.size !== 1 || conflictedIncidents.has(incidentKey)) { unresolved++; if (outcomes.size > 1 || conflictedIncidents.has(incidentKey)) conflicted++; }
      else if (outcomes.has(true)) correct++; else incorrect++;
    }
    const resolved = correct + incorrect;
    return { component: { ...group[0].component }, kind: group[0].kind, split: group[0].split as "calibration" | "heldout",
      correct, incorrect, resolved, unresolved, conflicted, totalIncidents: incidents.size,
      precision: resolved ? correct / resolved : null, interval: resolved ? interval(correct, resolved) : null, advisoryOnly: true };
  });
  for (const report of reports) { Object.freeze(report.component); if (report.interval) Object.freeze(report.interval); Object.freeze(report); computedReports.add(report); }
  return { version: "factory-calibration-v1" as const, reports, excludedTuning, referenceBasis: "independently-supplied-host-context" as const, advisoryOnly: true as const };
}
export interface ExposurePolicy {
  id: string; component: CalibrationComponent; kind: CalibrationKind; split: "calibration" | "heldout";
  minimumResolved: number; minimumLowerBound: number; attentionRemaining: number; expiresAt: number;
  retireBelowUpperBound?: number;
}
/** A selected pre-established host policy may produce advice; this never applies it or expands authority. */
export function recommendExposure(report: CalibrationReport, policy: ExposurePolicy | null, now: number) {
  if (!computedReports.has(report)) throw new Error("recompute calibration from predictions and independent reference context before evaluating exposure");
  const result = (mode: "silent" | "ask" | "retire", reason: string) => ({ mode, reason, advisoryOnly: true as const });
  if (!policy) return result("silent", "policy-unavailable");
  if (!text(policy.id) || !Number.isSafeInteger(policy.minimumResolved) || policy.minimumResolved < 1
    || !Number.isSafeInteger(policy.attentionRemaining) || policy.attentionRemaining < 0
    || !Number.isFinite(policy.minimumLowerBound) || policy.minimumLowerBound < 0 || policy.minimumLowerBound > 1
    || !Number.isFinite(policy.expiresAt) || !Number.isFinite(now)
    || (policy.retireBelowUpperBound !== undefined && (!Number.isFinite(policy.retireBelowUpperBound) || policy.retireBelowUpperBound < 0 || policy.retireBelowUpperBound > 1))) throw new Error("invalid exposure policy");
  if (key(policy) !== key(report) || now >= policy.expiresAt) return result("silent", "policy-inapplicable-or-expired");
  if (!report.interval || report.resolved < policy.minimumResolved) return result("silent", "insufficient-independent-evidence");
  if (policy.retireBelowUpperBound !== undefined && report.interval.upper < policy.retireBelowUpperBound) return result("retire", "below-selected-reliability-policy");
  if (report.interval.lower < policy.minimumLowerBound || policy.attentionRemaining === 0) return result("silent", "confidence-or-attention-bound");
  return result("ask", "selected-evidence-and-attention-policy-met");
}
