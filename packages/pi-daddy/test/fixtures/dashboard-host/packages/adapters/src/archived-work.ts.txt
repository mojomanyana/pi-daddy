import { readArchiveSource, retainArchiveSource } from "./evidence-archive.js";
import { projectWorkLedger, type WorkProjectionContext, type WorkFrozen, type WorkProjection } from "./generated/work-v4/reader.js";
import { WORK_V4_READER_COMMIT } from "./generated/work-v4/pin.js";
import { captureWorkCandidates } from "./work-case-archive.js";
import type { WorkDetectionOptions } from "./work-candidates.js";
import type { WorkSignalFacts, WorkSignalSnapshot } from "@skill-harness/core";
import { retainWorkSignalObservation } from "./work-signal-observation.js";
import { captureWorkSignalCases } from "./work-signal-cases.js";
export type ArchivedWork =
  | { state: "available"; manifestId: string; sourceSha256: string; producerCommit: string; projection: WorkFrozen<WorkProjection> }
  | { state: "missing" | "error"; manifestId: string; reason: string };
/** Pinned producer's actual pure reader/projector, with no append/inspect/file-writing API in the generated facade. */
export function readArchivedWork(root: string, manifestId: string, context: WorkFrozen<WorkProjectionContext> = { selectedSnapshot: null, authority: null }): ArchivedWork {
  const source = readArchiveSource(root, manifestId);
  if (source.status !== "available") return { state: source.status === "missing" ? "missing" : "error", manifestId, reason: "work-source-unavailable" };
  if (source.reference.retention !== "exact" || source.reference.parser.id !== "pi-daddy-work-ledger" || source.reference.parser.version !== "4") return { state: "error", manifestId, reason: "exact-work-v4-source-required" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
    const projection = projectWorkLedger(text, context);
    return { state: "available", manifestId, sourceSha256: source.reference.sha256, producerCommit: WORK_V4_READER_COMMIT, projection };
  } catch { return { state: "error", manifestId, reason: "invalid-work-source-or-context" }; }
}
/** Preserve raw work bytes, derived facts and candidate batch linkage. No authority is read from an archive/context file. */
export function captureArchivedWorkCandidates(root: string, manifestId: string, context: WorkFrozen<WorkProjectionContext>, options: WorkDetectionOptions) {
  const read = readArchivedWork(root, manifestId, context);
  if (read.state !== "available" || read.projection.errors.length || read.projection.scopeState !== "valid") throw new Error("work source/selection incomplete; cannot nominate behavior");
  const cases = captureWorkCandidates(root, read.projection, options);
  const linkage = { version: "archived-work-candidates-v1", workManifestId: manifestId, workSha256: read.sourceSha256, producerCommit: read.producerCommit,
    observationId: cases.observationId, caseBatchId: cases.batchId, candidateIds: cases.candidateIds, authorityBasis: "independently-supplied-host-context", acceptance: "not-assessed" };
  const stored = retainArchiveSource(root, { sourceId: `work-case-link-${read.sourceSha256}`, parser: { id: "archived-work-candidates", version: "1" }, retention: "exact", bytes: Buffer.from(JSON.stringify(linkage)) });
  return { ...linkage, linkageManifestId: stored.manifestId };
}

/** Derive binding/coverage/acceptance fields from the real pinned P01 projection, not caller replacements. */
export function captureArchivedWorkSignals(root: string, manifestId: string, context: WorkFrozen<WorkProjectionContext>, suppliedFacts: WorkSignalFacts | null) {
  const read = readArchivedWork(root, manifestId, context);
  if (read.state !== "available" || read.projection.errors.length || read.projection.scopeState !== "valid" || !read.projection.selectedSnapshot || !read.projection.runtime) throw new Error("work source/selection incomplete; cannot capture signals");
  const work = read.projection, runtime = read.projection.runtime, snapshotDigest = read.projection.selectedSnapshot.digest;
  const snapshot: WorkSignalSnapshot = { snapshotDigest, scopeValid: true,
    obligations: work.obligations.map(o => ({ id: o.binding.obligation.id, digest: o.binding.obligation.digest,
      intentDigest: o.binding.intent.digest, policyDigest: o.binding.policy.digest, artifactDigest: o.binding.artifact?.digest ?? null,
      acceptance: o.acceptance,
      coverage: [o.artifactCoverage.state, o.evidenceCoverage.state].includes("conflicted") ? "conflicted"
        : [o.artifactCoverage.state, o.evidenceCoverage.state].includes("unavailable") ? "unavailable"
        : o.artifactCoverage.state === "available" && o.evidenceCoverage.state === "available" && o.problems.every(p => p.code === "TRUSTED_REJECTION") ? "available" : "unknown" })) };
  // Null means derive only facts the retained projection itself establishes. Empty arrays are explicit:
  // runtime failure is not an objective violation, and absence cannot invent a deadline, expected wait,
  // prior acceptance or authority. Coverage candidates still follow from the projected obligation.
  const facts: WorkSignalFacts = suppliedFacts ?? { scopeDigest: snapshotDigest, version: "observed-work-v1", population: "retained-work",
    expectedWaits: [], checkpoints: [], violations: [], priorAccepted: [] };
  const runtimeFacts = {
    version: "observed-work-runtime-v1", snapshotDigest, sourceManifestId: manifestId,
    attempts: runtime.attempts.map(attempt => {
      const eventDigests = runtime.occurrences.filter(occurrence => occurrence.payload.executionId === attempt.executionId &&
        occurrence.payload.provenance === "observed" && ["completed", "failed", "cancelled"].includes(occurrence.payload.state))
        .map(occurrence => occurrence.event.digest).sort();
      return { executionId: attempt.executionId, state: attempt.state, resolution: attempt.resolution,
        completionEvidence: { state: eventDigests.length ? "available" : "unavailable", eventDigests } };
    }).sort((a,b) => a.executionId < b.executionId ? -1 : a.executionId > b.executionId ? 1 : 0),
    obligations: snapshot.obligations.map(obligation => ({ obligationDigest: obligation.digest, acceptance: obligation.acceptance, coverage: obligation.coverage }))
      .sort((a,b) => a.obligationDigest < b.obligationDigest ? -1 : a.obligationDigest > b.obligationDigest ? 1 : 0),
    unavailable: ["checkpoint-evidence", "expected-wait-evidence", "prior-acceptance-history"],
  };
  const retainedRuntimeFacts = retainArchiveSource(root, { sourceId: `observed-runtime-${read.sourceSha256}`, parser: { id: "observed-work-runtime-facts", version: "1" }, retention: "exact", bytes: Buffer.from(JSON.stringify(runtimeFacts)) });
  // All four digests here are REVISION identities, not artifact content digests.
  // Duplicate obligation bindings cannot be collapsed by this input profile; its validator refuses them.
  const observation = retainWorkSignalObservation(root, snapshot, facts);
  const projection = retainArchiveSource(root, { sourceId: `work-signal-projection-${read.sourceSha256}`, parser: { id: "pi-daddy-work-projection", version: "1" }, retention: "exact", bytes: Buffer.from(JSON.stringify(work)) });
  const cases = captureWorkSignalCases(root, observation.manifestId);
  const linkage = { version: "archived-work-signals-v1", bindingProfile: "work-v4-revision-digests-v1", workManifestId: manifestId,
    workSha256: read.sourceSha256, producerCommit: read.producerCommit, projectionManifestId: projection.manifestId,
    runtimeFactsManifestId: retainedRuntimeFacts.manifestId, observationId: observation.manifestId, caseBatchId: cases.batchId, candidateIds: cases.candidateIds,
    authorityBasis: "independently-supplied-host-context", acceptance: "not-assessed" };
  const stored = retainArchiveSource(root, { sourceId: `work-signal-link-${read.sourceSha256}`, parser: { id: "archived-work-signals", version: "1" }, retention: "exact", bytes: Buffer.from(JSON.stringify(linkage)) });
  return { ...linkage, linkageManifestId: stored.manifestId };
}
