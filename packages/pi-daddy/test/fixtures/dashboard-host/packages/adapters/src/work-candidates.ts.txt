import { createHash } from "node:crypto";
import { buildWorkCapture, type WorkCaptureCaseV2 } from "@skill-harness/core";
import type { WorkProjection, WorkAttempt } from "./generated/retention-v2-work-types.js";
export interface WorkDetectionOptions {
  version: string;
  population: string;
  scopeDigest: string;
  minEquivalentAttempts: number;
  /** Explicit frozen domain facts, never inferred from worker prose. Values are obligation digests. */
  expectedWaits: string[];
  expectedFailures: string[];
  exemplar?: { unit: "wall_ms" | "tool_calls" | "usd"; maximum: number };
  usage?: Record<string, { observed: boolean; cost: number; unit: "wall_ms" | "tool_calls" | "usd"; evidence: string }>;
}
export const WORK_CANDIDATE_IMPLEMENTATION = "structural-work-v2";
const hash = /^[a-f0-9]{64}$/;
/** Consumes the actual P01 host projection, not arbitrary native wire or a new acceptance authority. */
export function detectWorkCandidates(work: WorkProjection, options: WorkDetectionOptions) {
  if (![options.version, options.population].every(s => typeof s === "string" && s.length > 0 && s.length <= 128 && !/[\u0000-\u001f\u007f]/.test(s))
    || !Array.isArray(options.expectedWaits) || !Array.isArray(options.expectedFailures)
    || options.expectedWaits.length > 4096 || options.expectedFailures.length > 4096
    || options.expectedFailures.some(id => typeof id !== "string" || !id || id.length > 512)
    || !Number.isSafeInteger(options.minEquivalentAttempts) || options.minEquivalentAttempts < 2 || options.minEquivalentAttempts > 256
    || !hash.test(options.scopeDigest) || options.expectedWaits.some(d => !hash.test(d))
    || (options.exemplar && (!Number.isFinite(options.exemplar.maximum) || options.exemplar.maximum < 0))) throw new Error("invalid structural detector policy");
  if (work.selectedSnapshot && work.selectedSnapshot.digest !== options.scopeDigest) throw new Error("detector scope mismatch");
  if (work.scopeState !== "valid" || !work.selectedSnapshot || !work.runtime || work.errors.length) {
    return { version: "work-candidates-v1" as const, cases: [] as WorkCaptureCaseV2[], issues: ["work-scope-not-resolved"], expected: [] as string[] };
  }
  const policyDigest = createHash("sha256").update(JSON.stringify({ minEquivalentAttempts: options.minEquivalentAttempts, exemplar: options.exemplar ? { unit: options.exemplar.unit, maximum: options.exemplar.maximum } : null })).digest("hex");
  const version = `${WORK_CANDIDATE_IMPLEMENTATION}:${options.version}:${policyDigest}`;
  const cases: WorkCaptureCaseV2[] = [], expected: string[] = [];
  const waits = new Set(options.expectedWaits), expectedFailures = new Set(options.expectedFailures);
  const occurrences = work.runtime.occurrences;
  for (const obligation of work.obligations) {
    const ref = obligation.binding.obligation;
    const target = { kind: "work" as const, snapshotDigest: work.selectedSnapshot.digest, obligationId: ref.id, obligationDigest: ref.digest };
    const evidence = [target.snapshotDigest, target.obligationDigest];
    const add = (reason: WorkCaptureCaseV2["reason"], classification: WorkCaptureCaseV2["classification"], metrics: WorkCaptureCaseV2["metrics"], refs = evidence) => {
      cases.push(buildWorkCapture({ detector: { id: reason, version, population: options.population }, target, reason, classification, metrics, evidence: refs }));
    };
    if (waits.has(ref.digest)) { expected.push(`declared-wait:${ref.digest}`); continue; }
    if (obligation.acceptance === "unresolved" || obligation.artifactCoverage.state !== "available" || obligation.evidenceCoverage.state !== "available" || obligation.problems.some(problem => problem.code !== "TRUSTED_REJECTION")) {
      add("coverage_gap", "coverage_issue", {}); continue;
    }
    for (const attempt of work.runtime.attempts) if (expectedFailures.has(attempt.executionId) && attempt.bindings.some(b => b.obligation.digest === ref.digest)) expected.push(`expected-failure:${attempt.executionId}`);
    const attempts = work.runtime.attempts.filter(attempt => attempt.resolution === "resolved"
      && !expectedFailures.has(attempt.executionId)
      && attempt.bindings.some(b => b.obligation.id === ref.id && b.obligation.digest === ref.digest)
      && occurrences.some(o => o.payload.executionId === attempt.executionId && o.payload.obligation.id === ref.id && o.payload.obligation.digest === ref.digest
        && o.payload.provenance === "observed" && ["completed", "failed"].includes(o.payload.state)));
    if (obligation.acceptance === "accepted-under-supplied-authority") {
      if (!work.authoritySnapshot || !options.exemplar || !attempts.length) continue;
      const usage = attempts.map(a => options.usage?.[a.executionId]);
      if (usage.some(u => !u || !u.observed || u.unit !== options.exemplar!.unit || !Number.isFinite(u.cost) || u.cost < 0 || !hash.test(u.evidence))) continue;
      const measuredCost = usage.reduce((sum, u) => sum + u!.cost, 0);
      if (measuredCost <= options.exemplar.maximum) add("economical_exemplar", "candidate_exemplar",
        { measuredCost, costLimit: options.exemplar.maximum, costUnit: options.exemplar.unit }, [...evidence, ...usage.map(u => u!.evidence)]);
      continue;
    }
    const groups = new Map<string, WorkAttempt[]>();
    for (const attempt of attempts) {
      const config = attempt.effectiveLabels.configurationDigest;
      if (!config || !hash.test(config) || !attempt.observedLabels.some(label => label.configurationDigest === config)) continue;
      const bindings = attempt.bindings.filter(b => b.obligation.id === ref.id && b.obligation.digest === ref.digest);
      const bindingKeys = bindings.map(b => JSON.stringify({ variants: [...b.variantIds].sort(), artifacts: b.artifacts.map(a => a.digest).sort() })).sort();
      const key = JSON.stringify([config, attempt.effectiveLabels.modelId, attempt.effectiveLabels.effortId, bindingKeys]);
      groups.set(key, [...(groups.get(key) ?? []), attempt]);
    }
    const strongest = [...groups].sort(([ka, a], [kb, b]) => b.length - a.length || (ka < kb ? -1 : ka > kb ? 1 : 0))[0]?.[1] ?? [];
    const ids = new Set(strongest.map(a => a.executionId));
    if (ids.size >= options.minEquivalentAttempts) {
      const refs = occurrences.filter(o => ids.has(o.payload.executionId) && o.payload.obligation.id === ref.id && o.payload.obligation.digest === ref.digest).map(o => o.event.digest);
      add("repeat_without_progress", "candidate_defect", { equivalentAttempts: ids.size }, [...evidence, ...refs]);
    }
  }
  return { version: "work-candidates-v1" as const, cases: cases.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), issues: [] as string[], expected: expected.sort() };
}
