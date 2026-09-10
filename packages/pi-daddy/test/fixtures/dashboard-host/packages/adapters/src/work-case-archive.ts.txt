import { buildWorkCapture, type WorkCaptureCaseV2 } from "@skill-harness/core";
import { readArchiveSource, retainArchiveSource } from "./evidence-archive.js";
import { detectWorkCandidates, type WorkDetectionOptions } from "./work-candidates.js";
import type { WorkProjection } from "./generated/retention-v2-work-types.js";

function validate(value: WorkCaptureCaseV2): WorkCaptureCaseV2 {
  if (!value || value.capture_schema !== 2 || value.status !== "unresolved" || value.visibility !== "silent" || value.causalAttribution !== "not-established") throw new Error("invalid work case state");
  const built = buildWorkCapture({ detector: value.detector, target: value.target, classification: value.classification,
    reason: value.reason, evidence: value.evidence, metrics: value.metrics });
  if (built.id !== value.id || Object.keys(value).sort().join() !== Object.keys(built).sort().join()) throw new Error("invalid work case identity");
  return built;
}
/** Explicit private archival, never promotion into a scored specification or automatic alert exposure. */
export function retainWorkCandidate(root: string, candidate: WorkCaptureCaseV2): string {
  const value = validate(candidate);
  return retainArchiveSource(root, { sourceId: `work-case-${value.id}`, parser: { id: "work-capture", version: "2" }, retention: "exact", bytes: Buffer.from(JSON.stringify(value)) }).manifestId;
}
export function readWorkCandidate(root: string, manifestId: string): WorkCaptureCaseV2 {
  const source = readArchiveSource(root, manifestId);
  if (source.status !== "available" || source.reference.retention !== "exact" || source.reference.parser.id !== "work-capture" || source.reference.parser.version !== "2") throw new Error("work case missing or invalid");
  const value = validate(JSON.parse(source.bytes.toString("utf8")));
  if (source.reference.sourceId !== `work-case-${value.id}`) throw new Error("work case source mismatch");
  return value;
}
/** Capture the actual trusted P01 projection before retaining advisory cases; never a worker callback. */
export function captureWorkCandidates(root: string, work: WorkProjection, options: WorkDetectionOptions) {
  const detection = detectWorkCandidates(work, options);
  const observation = retainArchiveSource(root, {
    sourceId: `work-facts-${options.scopeDigest}`, parser: { id: "pi-daddy-work-projection", version: "1" },
    retention: "exact", bytes: Buffer.from(JSON.stringify(work)),
  });
  const candidates = detection.cases.map(candidate => buildWorkCapture({
    detector: candidate.detector, target: candidate.target, classification: candidate.classification,
    reason: candidate.reason, metrics: candidate.metrics, evidence: [...candidate.evidence, observation.reference.sha256],
  }));
  const candidateIds = candidates.map(candidate => retainWorkCandidate(root, candidate));
  const batch = { version: "work-candidate-batch-v1", observationId: observation.manifestId, candidateIds,
    issues: detection.issues, expected: detection.expected, visibility: "silent", promotion: "not-authorized" };
  const stored = retainArchiveSource(root, { sourceId: `case-batch-${options.scopeDigest}`, parser: { id: "work-candidate-batch", version: "1" },
    retention: "exact", bytes: Buffer.from(JSON.stringify(batch)) });
  return { batchId: stored.manifestId, observationId: observation.manifestId, candidateIds };
}

/** Several observations/detector versions of the same scoped work are not independent incidents. */
export function groupWorkIncidents(cases: readonly WorkCaptureCaseV2[]) {
  if (cases.length > 4096) throw new Error("work incident snapshot exceeds bound");
  const groups = new Map<string, WorkCaptureCaseV2[]>();
  for (const raw of cases) {
    const c = validate(raw); const key = JSON.stringify([c.target.snapshotDigest, c.target.obligationId, c.target.obligationDigest, c.detector.population]);
    const values = groups.get(key) ?? [];
    if (!values.some(v => v.id === c.id && JSON.stringify(v) === JSON.stringify(c))) values.push(c);
    groups.set(key, values);
  }
  return [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, values]) => ({
    key, target: values[0].target, observations: values.sort((a, b) => { const left = JSON.stringify(a), right = JSON.stringify(b); return left < right ? -1 : left > right ? 1 : 0; }),
    status: "unresolved" as const, visibility: "silent" as const,
  }));
}
