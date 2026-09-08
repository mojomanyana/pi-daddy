// GENERATED from pi-daddy 7c78769c47177b1972b09e1f5c5474ad44cd2cac by scripts/vendor-work-v4-reader.mjs. Do not hand-edit.
import { parseWorkLedgerText } from "./reader.js";
import { canonicalWorkJson, freezeWork, workDigest, workResultKey as key, sortWorkResults as unique,
  mergeWorkProblems, mergeWorkConflicts } from "./json.js";
import type { EventRef, RevisionRef, WorkFrozen, WorkIngestion, WorkLedgerEvent, WorkProjectionContext,
  WorkClaimResult, WorkObligationResult, WorkProblem, WorkConflict, WorkCoverage, WorkCoverageItem,
  WorkReference, WorkAcceptanceEvent, WorkAvailability } from "./types.js";
import type { resolveWorkSnapshotText } from "./snapshot.js";
import type { foldWorkOccurrences } from "./occurrences.js";

type IndexedEvent = WorkFrozen<WorkLedgerEvent>;

/**
 * Internal first-pass evidence index, NOT the public WorkProjection result.
 * No selector, graph resolution, runtime counts or authority decisions are inferred here.
 * Keep every candidate plus the exact conflicting event references: later reachability must
 * inspect all alternatives, including nonselected associations and redelivered revision bodies.
 */
interface WorkReplayIndex {
  readonly ingestion: WorkFrozen<WorkIngestion>;
  /** One body per validated (eventId,digest); includes quarantined evidence. */
  readonly candidates: readonly IndexedEvent[];
  /** Every alternative of every ID with multiple digests; not a chosen winner or receipt conflict. */
  readonly conflictingEvents: ReadonlyArray<WorkFrozen<EventRef>>;
  /** Exact revision bodies appearing in those conflicts, independent of delivery ID/timestamp. */
  readonly quarantinedRevisions: ReadonlyArray<WorkFrozen<RevisionRef>>;
  /** Central, frozen source index. Body keys point to IDs, not duplicated Cartesian candidate lists. */
  readonly conflictSources: {
    readonly bodies: Readonly<Record<string, readonly string[]>>;
    readonly events: Readonly<Record<string, readonly WorkFrozen<EventRef>[]>>;
  };
  /** Clean delivery identities only; these are evidence, never proof of acceptance or a current head. */
  readonly effectiveEvents: readonly IndexedEvent[];
}

const revisionIdentity = ({ kind, id, revision, digest }: WorkFrozen<RevisionRef>) => key(["revision", kind, id, revision, digest]);
/** The ONLY nested identity definition. Claims deliberately have no nested quarantine identity. */
function nestedIdentity(event: IndexedEvent): string | null {
  switch (event.event) {
    case "work_revision": return revisionIdentity(event.payload.revision);
    case "work_snapshot": return key(["snapshot", event.payload.snapshot.snapshotId, event.payload.snapshot.digest]);
    case "work_occurrence": return key(["occurrence", event.payload]);
    case "work_acceptance": return null;
  }
}
type Sources = Pick<WorkReplayIndex, "conflictSources">;
function sourceIds(index: Sources, event: IndexedEvent | WorkFrozen<EventRef>): readonly string[] {
  const nested = "event" in event ? nestedIdentity(event) : null;
  return [...(index.conflictSources.events[key(event.eventId)] ? [event.eventId] : []),
    ...(nested === null ? [] : index.conflictSources.bodies[nested] ?? [])];
}
/** @internal Only index-derived validated events/references. Raw alternatives remain diagnostic input. */
export function workEventConflictSources(index: Sources, event: IndexedEvent | WorkFrozen<EventRef>): WorkFrozen<EventRef>[] {
  return unique(unique(sourceIds(index, event)).flatMap(id => index.conflictSources.events[key(id)]));
}
/** @internal Exact revision references need not have a clean delivery to be quarantined. */
export function workRevisionConflictSources(index: Sources, ref: WorkFrozen<RevisionRef>): readonly WorkFrozen<EventRef>[] {
  return unique((index.conflictSources.bodies[revisionIdentity(ref)] ?? []).flatMap(id => index.conflictSources.events[key(id)]));
}

function sorted<T>(values: Iterable<T>): T[] {
  // Canonicalize individual rows, not the aggregate. A valid 10,000-record input can have
  // more than 256 candidates/conflicts; the per-wire-array bound must not truncate replay.
  return [...values].map(value => ({ value, key: canonicalWorkJson(value) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    .map(entry => entry.value);
}

/**
 * @internal Strict text -> complete delivery grouping -> quarantine -> effective evidence.
 * Deliberately not re-exported by work-ledger.ts: this is not an unchecked public projector.
 * Raw serialized/archival byte hashes play no role in semantic delivery identity.
 */
export function indexWorkLedgerText(text: string): WorkReplayIndex {
  const ingestion = parseWorkLedgerText(text);
  const groups = new Map<string, Map<string, IndexedEvent>>();
  for (const event of ingestion.events) {
    let group = groups.get(event.eventId);
    if (!group) { group = new Map(); groups.set(event.eventId, group); }
    if (!group.has(event.digest)) {
      // Equal canonical digests can arrive with different property insertion orders. Normalize
      // the validated body so even serialized index output does not choose an arrival's key order.
      // Parse ONLY our own canonical emission, never raw input. Strict ingestion already checked
      // duplicates, domains and digests. JCS can expand exact exponent tokens beyond the delivered
      // text size, so applying the raw-line byte bound again here would reject valid evidence.
      const normalized = JSON.parse(canonicalWorkJson(event)) as WorkLedgerEvent;
      group.set(event.digest, freezeWork(normalized));
    }
  }

  const conflictingEvents: EventRef[] = [];
  const quarantined = new Map<string, RevisionRef>(); // Retained diagnostic view, not a second quarantine policy.
  const bodies = new Map<string, Set<string>>(), eventGroups = new Map<string, EventRef[]>();
  for (const [eventId, group] of groups) {
    if (group.size < 2) continue;
    eventGroups.set(key(eventId), sorted([...group.values()].map(event => ({ eventId, digest: event.digest }))));
    for (const event of group.values()) {
      conflictingEvents.push({ eventId, digest: event.digest });
      const identity = nestedIdentity(event);
      if (identity !== null) {
        const ids = bodies.get(identity) ?? new Set<string>();
        ids.add(eventId); bodies.set(identity, ids);
      }
      if (event.event === "work_revision") {
        const { kind, id, revision, digest } = event.payload.revision;
        // Ingestion verified that this digest covers the entire revision, including kind/ID/scope.
        // Quarantine exact bodies, not every fork or successor sharing a stable entity ID.
        quarantined.set(digest, { kind, id, revision, digest });
      }
    }
  }

  const candidates = sorted([...groups.values()].flatMap(group => [...group.values()]));
  const byKey = <T>(map: Map<string, T>) => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const conflictSources = { bodies: Object.fromEntries(byKey(bodies).map(([identity, ids]) => [identity, [...ids].sort()])),
    events: Object.fromEntries(byKey(eventGroups)) };
  // All existing nested identities use the same source index before any effective evidence is exposed.
  const effectiveEvents = ingestion.complete ? candidates.filter(event => !sourceIds({ conflictSources }, event).length) : [];
  return freezeWork({
    ingestion, candidates, conflictingEvents: sorted(conflictingEvents), conflictSources,
    quarantinedRevisions: sorted(quarantined.values()), effectiveEvents,
  });
}

type Problem = WorkFrozen<WorkProblem>;
type Claim = WorkFrozen<WorkAcceptanceEvent>;
const eventRef = (event: IndexedEvent): EventRef => ({ eventId: event.eventId, digest: event.digest });
const eventReference = (event: IndexedEvent): WorkFrozen<WorkReference> => ({ type: "event", ref: eventRef(event) });
const isConflict = (p: Problem) => p.code.endsWith("CONFLICT");
function coverage(items: readonly WorkFrozen<WorkCoverageItem>[]): WorkFrozen<WorkCoverage> {
  const state = (["conflicted", "unavailable", "unknown"] as const).find(s => items.some(item => item.state === s));
  return { state: state ?? (items.length ? "available" : "unknown"), items: unique(items) };
}

/** @internal Global receipt identity diagnostics exist even without a resolved work selector. */
export function indexWorkReceipts(authority: WorkFrozen<WorkProjectionContext>["authority"]) {
  type Decision = NonNullable<WorkFrozen<WorkProjectionContext>["authority"]>["decisions"][number];
  const receipts = new Map<string, Map<string, Decision>>();
  const conflicts: WorkFrozen<WorkConflict>[] = [];
  for (const d of authority?.decisions ?? []) {
    const group = receipts.get(d.receiptId) ?? new Map<string, Decision>();
    // Complete decision + enclosing authority snapshot; diagnostic identity, NOT authentication.
    group.set(workDigest({ authoritySnapshot: authority!.snapshot, ...d }), d); receipts.set(d.receiptId, group);
  }
  for (const [id, group] of receipts) if (group.size > 1) {
    conflicts.push({ kind: "receipt", id, digests: unique(group.keys()), affectedObligations: [] });
  }
  return { receipts, conflicts: unique(conflicts) };
}

/** @internal Conditional binding proof, not authentication. Only the separately supplied, validated
 * host authority is a TCB input. No wire label, event, receipt-shaped payload or environment is trust. */
export function projectWorkAcceptance(index: WorkReplayIndex, structure: ReturnType<typeof resolveWorkSnapshotText>,
  authority: WorkFrozen<WorkProjectionContext>["authority"], runtime: ReturnType<typeof foldWorkOccurrences>) {
  const snapshot = structure.snapshot!;
  const claims: WorkFrozen<WorkClaimResult>[] = [], obligations: WorkFrozen<WorkObligationResult>[] = [];
  const problems: Problem[] = [...structure.problems];
  const conflicts: WorkFrozen<WorkConflict>[] = [...structure.conflicts, ...runtime.conflicts];
  const eventConflicts = new Set(index.conflictingEvents.map(e => e.eventId));
  const events = new Map(index.candidates.map(e => [key(eventRef(e)), e]));
  const receiptIndex = indexWorkReceipts(authority), { receipts } = receiptIndex;
  conflicts.push(...receiptIndex.conflicts);
  const decisions = [...receipts.values()].filter(g => g.size === 1).flatMap(g => [...g.values()]);
  function available(kind: "artifact" | "evidence", id: string, digest: string): WorkFrozen<WorkCoverageItem> {
    const values = unique((authority?.availability ?? []).filter(row => row.kind === kind && row.id === id && row.digest === digest).map(row => row.available));
    const state: WorkAvailability = values.length > 1 ? "conflicted" : values.length === 0 ? "unknown" : values[0] ? "available" : "unavailable";
    return { kind, identity: { id, digest }, state };
  }
  const allClaims = index.candidates.filter((e): e is Claim => e.event === "work_acceptance");
  function sourceProblems(ref: WorkFrozen<EventRef>, affected: readonly WorkFrozen<RevisionRef>[]): Problem[] {
    const result: Problem[] = [];
    const found = events.get(key(ref));
    for (const event of workEventConflictSources(index, found ?? ref)) {
      result.push({ code: "EVENT_CONFLICT", reference: { type: "event", ref: event }, affectedObligations: affected });
    }
    if (!found) result.push({ code: "REFERENCE_MISSING", reference: { type: "event", ref }, affectedObligations: affected });
    for (const p of runtime.eventProblems.get(key(ref)) ?? []) result.push({ ...p, affectedObligations: affected });
    return mergeWorkProblems(result);
  }
  for (const row of structure.obligations) {
    const binding = row.binding, affected = [binding.obligation];
    const problem = (code: WorkProblem["code"], reference: WorkFrozen<WorkReference> | null): Problem => ({ code, reference, affectedObligations: affected });
    const inventoryProblem = problem("ARTIFACT_UNSELECTED", { type: "revision", ref: binding.obligation });
    const blockers: Problem[] = [...row.problems, ...(binding.artifact === null ? [inventoryProblem] : [])];
    const selectedClaims = allClaims.filter(e => e.payload.binding.scope.id === snapshot.scope.id && e.payload.binding.obligation.id === binding.obligation.id);
    const applicable = (claim: Claim) => {
      const b = claim.payload.binding;
      return key(b.snapshot) === key(structure.selectedSnapshot) && key(b.scope) === key(snapshot.scope) &&
        key(b.intent) === key(binding.intent) && key(b.obligation) === key(binding.obligation) &&
        key(b.artifact) === key(binding.artifact) && key(b.policy) === key(binding.policy);
    };
    const current = selectedClaims.filter(applicable);
    const currentRefs = new Set(current.map(e => key(eventRef(e))));
    for (const e of current) if (eventConflicts.has(e.eventId)) {
      blockers.push(...index.conflictingEvents.filter(ref => ref.eventId === e.eventId).map(ref => problem("EVENT_CONFLICT", { type: "event", ref })));
    }
    for (const [id, group] of receipts) if (group.size > 1 && [...group.values()].some(d => currentRefs.has(key(d.claim)))) {
      conflicts.push({ kind: "receipt", id, digests: unique(group.keys()), affectedObligations: affected });
      blockers.push(problem("RECEIPT_CONFLICT", { type: "authority", ref: authority!.snapshot }));
    }
    const artifactItems = row.artifact ? [available("artifact", row.artifact.id, row.artifact.contentDigest)] : [];
    const artifactCoverage: WorkFrozen<WorkCoverage> = binding.artifact === null ? { state: "unselected", items: [] } : coverage(artifactItems);
    const evidenceCoverage = coverage(unique(current.flatMap(e => e.payload.binding.evidence.map(ref => available("evidence", ref.id, ref.digest)))));
    function coverageProblems(items: readonly WorkFrozen<WorkCoverageItem>[]): Problem[] {
      return items.filter(item => item.state !== "available").map(item => problem(
        item.state === "conflicted" ? "AVAILABILITY_CONFLICT" : item.state === "unavailable" ? "BYTES_UNAVAILABLE" : "AVAILABILITY_MISSING",
        { type: item.kind === "artifact" ? "artifact-bytes" : "evidence-bytes", ref: item.identity },
      ));
    }
    const rowClaims: WorkFrozen<WorkClaimResult>[] = [];
    const trustedDecisions = new Set<string>();
    for (const claim of selectedClaims) {
      if (eventConflicts.has(claim.eventId)) continue; // No first/last winner row, even for a favorable exact alternative.
      if (!applicable(claim)) {
        rowClaims.push({ claim: eventRef(claim), obligation: claim.payload.binding.obligation, applicability: "superseded",
          matchedReceiptIds: [], problems: [problem("SUPERSEDED_BINDING", eventReference(claim))] });
        continue;
      }
      const b = claim.payload.binding;
      const local: Problem[] = [];
      const bytesMatch = row.artifact !== null && b.artifactDigest === row.artifact.contentDigest;
      if (row.artifact && !bytesMatch) local.push(problem("ARTIFACT_DIGEST_MISMATCH", { type: "artifact-bytes", ref: { id: row.artifact.id, digest: b.artifactDigest } }));
      if (!row.artifact && binding.artifact) local.push(problem("REFERENCE_MISSING", { type: "revision", ref: binding.artifact }));
      const matching = decisions.filter(d => bytesMatch && key(d.claim) === key(eventRef(claim)) &&
        d.authorityId === claim.payload.authorityId && key(d.binding) === key(b));
      for (const d of matching) trustedDecisions.add(d.decision);
      if (!authority) local.push(problem("AUTHORITY_MISSING", null));
      else if (!matching.length) local.push(problem(decisions.some(d => d.claim.eventId === claim.eventId) ? "RECEIPT_MISMATCH" : "RECEIPT_MISSING", eventReference(claim)));
      const support = b.evidence.flatMap(ref => ref.event ? sourceProblems(ref.event, affected) : []);
      const availabilityProblems = coverageProblems([...artifactItems, ...b.evidence.map(ref => available("evidence", ref.id, ref.digest))]);
      local.push(...support, ...availabilityProblems);
      // Only EXACT matching current trusted decisions root global support conflicts. Missing trust,
      // wrong bytes and superseded/mismatched receipts cannot turn an unsupported sibling into a veto.
      if (matching.length) blockers.push(...support.filter(isConflict), ...availabilityProblems.filter(isConflict));
      const rejection = matching.some(d => d.decision === "reject");
      rowClaims.push({ claim: eventRef(claim), obligation: b.obligation,
        applicability: rejection ? "unaccepted" : matching.some(d => d.decision === "accept") && local.length === 0 ? "accepted-under-supplied-authority" : "unresolved",
        matchedReceiptIds: unique(matching.map(d => d.receiptId)),
        problems: rejection ? [problem("TRUSTED_REJECTION", eventReference(claim))] : mergeWorkProblems(local),
      });
    }
    if (trustedDecisions.size > 1) blockers.push(problem("DECISION_CONFLICT", { type: "revision", ref: binding.obligation }));
    const blocked = mergeWorkProblems(blockers);
    for (const p of blocked) if (p.code === "EVENT_CONFLICT" && p.reference?.type === "event") {
      const id = p.reference.ref.eventId;
      conflicts.push({ kind: "event", id, digests: index.conflictingEvents.filter(e => e.eventId === id).map(e => e.digest), affectedObligations: affected });
    }
    const finalClaims = rowClaims.map(c => blocked.length && c.applicability !== "superseded" ? { ...c, applicability: "unresolved" as const, problems: blocked } : c);
    const accepted = finalClaims.some(c => c.applicability === "accepted-under-supplied-authority");
    const rejected = finalClaims.some(c => c.applicability === "unaccepted");
    const unresolved = finalClaims.filter(c => c.applicability === "unresolved");
    const acceptance = blocked.length ? "unresolved" : accepted ? "accepted-under-supplied-authority" : rejected ? "unaccepted" : unresolved.length ? "unresolved" : "unaccepted";
    const obligationProblems = blocked.length ? blocked : accepted ? [] : rejected ?
      finalClaims.filter(c => c.applicability === "unaccepted").flatMap(c => c.problems) : unresolved.length ? unresolved.flatMap(c => c.problems) :
        [problem("NO_CLAIM", { type: "revision", ref: binding.obligation })];
    obligations.push({ binding, acceptance, artifactCoverage, evidenceCoverage, claims: unique(finalClaims.map(c => c.claim)), problems: mergeWorkProblems(obligationProblems) });
    claims.push(...finalClaims); problems.push(...obligationProblems, ...finalClaims.flatMap(c => c.problems));
  }
  return { obligations: unique(obligations), claims: unique(claims), supersededClaims: claims.filter(c => c.applicability === "superseded").length,
    conflicts: mergeWorkConflicts(conflicts), problems: mergeWorkProblems([...problems, ...runtime.problems]),
    progress: { accepted: obligations.filter(o => o.acceptance === "accepted-under-supplied-authority").length, total: obligations.length },
  };
}
