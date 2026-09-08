import { createHash } from "node:crypto";
import { buildWorkCapture, type WorkCaptureCaseV2 } from "./work-capture.js";
export interface WorkSignalSnapshot {
  snapshotDigest: string; scopeValid: boolean;
  obligations: Array<{ id: string; digest: string; intentDigest: string; policyDigest: string; artifactDigest: string | null;
    acceptance: "accepted-under-supplied-authority" | "unaccepted" | "unresolved"; coverage: "available" | "unknown" | "unavailable" | "conflicted" }>;
}
export interface WorkSignalFacts {
  scopeDigest: string; version: string; population: string; expectedWaits: string[];
  /** Frozen host facts, not inferred from absence in a display or from worker prose. */
  checkpoints: Array<{ obligationDigest: string; deadlineMs: number; observedAt: number; status: "met" | "pending" | "unknown"; evidence: string }>;
  violations: Array<{ obligationDigest: string; status: "FAIL" | "ERROR"; evidence: string }>;
  priorAccepted: Array<{ obligationDigest: string; intentDigest: string; policyDigest: string; artifactDigest: string; acceptanceEvidence: string }>;
}
export interface WorkCaptureCaseV3 extends Omit<WorkCaptureCaseV2, "capture_schema" | "reason" | "metrics"> {
  capture_schema: 3;
  reason: "overdue_checkpoint" | "reopened_acceptance" | "intent_conflict";
  metrics: { deadlineMs?: number; observedAt?: number; failedChecks?: number };
}
const hash = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const text = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 512 && !/[\u0000-\u001f\u007f]/.test(x);
function signal(base: WorkCaptureCaseV2, reason: WorkCaptureCaseV3["reason"], metrics: WorkCaptureCaseV3["metrics"], evidence: string[]): WorkCaptureCaseV3 {
  const target = base.target, detector = { id: reason, version: base.detector.version, population: base.detector.population };
  const id = createHash("sha256").update(JSON.stringify({ capture_schema: 3, detector, target, reason, metrics, evidence: [...new Set(evidence)].sort() })).digest("hex");
  return Object.freeze({ ...base, capture_schema: 3, id, detector: Object.freeze(detector), reason, classification: "candidate_defect", metrics: Object.freeze(metrics), evidence: Object.freeze([...new Set(evidence)].sort()) as unknown as string[] });
}
/** Additional rules use an explicit new case version; the already-pinned capture_schema2 contract is unchanged. */
export function detectAdditionalWorkCases(snapshot: WorkSignalSnapshot, facts: WorkSignalFacts) {
  if (!hash(snapshot.snapshotDigest) || !hash(facts.scopeDigest) || snapshot.snapshotDigest !== facts.scopeDigest) throw new Error("work signal scope mismatch");
  if (!text(facts.version) || facts.version.length > 128 || !text(facts.population) || !Array.isArray(snapshot.obligations) || snapshot.obligations.length > 256
    || ![facts.expectedWaits, facts.checkpoints, facts.violations, facts.priorAccepted].every(a => Array.isArray(a) && a.length <= 256)
    || facts.expectedWaits.some(d => !hash(d))) throw new Error("invalid work signal bounds");
  for (const o of snapshot.obligations) if (!text(o.id) || ![o.digest,o.intentDigest,o.policyDigest].every(hash) || !(o.artifactDigest === null || hash(o.artifactDigest))
    || !["accepted-under-supplied-authority","unaccepted","unresolved"].includes(o.acceptance) || !["available","unknown","unavailable","conflicted"].includes(o.coverage)) throw new Error("invalid work signal obligation");
  for (const c of facts.checkpoints) if (!hash(c.obligationDigest) || !hash(c.evidence) || !["met","pending","unknown"].includes(c.status)
    || ![c.deadlineMs,c.observedAt].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("invalid declared checkpoint fact");
  for (const v of facts.violations) if (!hash(v.obligationDigest) || !hash(v.evidence) || !["FAIL","ERROR"].includes(v.status)) throw new Error("invalid objective intent fact");
  for (const p of facts.priorAccepted) if (![p.obligationDigest,p.intentDigest,p.policyDigest,p.artifactDigest,p.acceptanceEvidence].every(hash)) throw new Error("invalid prior acceptance fact");
  const cases: Array<WorkCaptureCaseV2 | WorkCaptureCaseV3> = [];
  if (snapshot.scopeValid !== true) return { version: "work-signals-v1" as const, cases, issues: ["scope-unresolved"] };
  for (const o of snapshot.obligations) {
    const base = buildWorkCapture({ detector: { id: "coverage_gap", version: `work-signals-v1:${facts.version}`, population: facts.population },
      target: { kind: "work", snapshotDigest: snapshot.snapshotDigest, obligationId: o.id, obligationDigest: o.digest },
      classification: "coverage_issue", reason: "coverage_gap", metrics: {}, evidence: [snapshot.snapshotDigest,o.digest] });
    const violations = facts.violations.filter(v => v.obligationDigest === o.digest);
    const checkpointFacts = facts.checkpoints.filter(c => c.obligationDigest === o.digest);
    const checkpointStates = new Set(checkpointFacts.map(c => JSON.stringify([c.deadlineMs,c.observedAt,c.status,c.evidence])));
    if (checkpointStates.size > 1) { cases.push(base); continue; } // No latest-timestamp election from contradictory host facts.
    if (o.coverage !== "available" || o.acceptance === "unresolved" || violations.some(v => v.status === "ERROR")) { cases.push(base); continue; }
    if (violations.length) cases.push(signal(base,"intent_conflict",{failedChecks:violations.length},[...base.evidence,...violations.map(v=>v.evidence)]));
    if (facts.expectedWaits.includes(o.digest)) continue;
    for (const c of checkpointFacts) {
      if (c.status === "unknown") { cases.push(base); continue; }
      if (c.status === "pending" && c.observedAt > c.deadlineMs) cases.push(signal(base,"overdue_checkpoint",{deadlineMs:c.deadlineMs,observedAt:c.observedAt},[...base.evidence,c.evidence]));
    }
    if (o.acceptance === "unaccepted") {
      const prior = facts.priorAccepted.filter(p => p.obligationDigest === o.digest && p.intentDigest === o.intentDigest && p.policyDigest === o.policyDigest && p.artifactDigest === o.artifactDigest);
      if (prior.length) cases.push(signal(base,"reopened_acceptance",{},[...base.evidence,...prior.map(p=>p.acceptanceEvidence)]));
    }
  }
  const unique = [...new Map(cases.map(c => [c.id,c])).values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  return { version: "work-signals-v1" as const, cases: unique, issues: [] as string[] };
}
