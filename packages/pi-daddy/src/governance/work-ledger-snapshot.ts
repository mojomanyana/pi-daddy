import { indexWorkLedgerText, workEventConflictSources, workRevisionConflictSources } from "./work-ledger-projection.ts";
import { canonicalWorkJson, copyWorkJson, freezeWork } from "./work-ledger-json.ts";
import { validateWorkSelection } from "./work-ledger-validation.ts";
import {
  WorkInputError, type EventRef, type Identity, type ObligationBinding, type RevisionRef,
  type WorkConflict, type WorkDiagnostic, type WorkFrozen, type WorkProblem, type WorkReference,
  type WorkResolutionCode, type WorkRevision, type WorkSnapshot,
} from "./work-ledger-types.ts";

type Ref = WorkFrozen<RevisionRef>;
type Revision = WorkFrozen<WorkRevision>;
type Problem = WorkFrozen<WorkProblem>;
/** Internal shape of WorkProjectionContext.selectedSnapshot, not an authority context. */
interface Selection { snapshot: Identity; event: EventRef }
/** Internal structural result only. Never a substitute for WorkProjection/acceptance/runtime. */
interface SnapshotResolution {
  readonly scopeState: "unselected" | "valid" | "unresolved" | "invalid";
  readonly selectedSnapshot: WorkFrozen<Identity> | null;
  readonly snapshot: WorkFrozen<WorkSnapshot> | null;
  readonly scope: Revision | null;
  readonly revisions: readonly Revision[];
  readonly obligations: ReadonlyArray<{
    readonly binding: WorkFrozen<ObligationBinding>;
    readonly revision: Revision;
    readonly artifact: Revision | null;
    readonly problems: readonly Problem[];
  }>;
  readonly problems: readonly Problem[];
  readonly conflicts: ReadonlyArray<WorkFrozen<WorkConflict>>;
  readonly errors: ReadonlyArray<WorkFrozen<WorkDiagnostic>>;
}
const key = canonicalWorkJson;
const entity = (ref: Ref): string => `${ref.kind}:${ref.id}`;
const reference = (ref: Ref): WorkFrozen<WorkReference> => ({ type: "revision", ref });
function unique<T>(values: readonly T[]): T[] {
  const rows = new Map(values.map(value => [key(value), value]));
  return [...rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
}
function diagnosticKey(row: Problem | WorkFrozen<WorkConflict>): string {
  // Internally built output collections may exceed the wire array bound (e.g. 300 conflicting
  // deliveries). Only their validated scalar/reference constituents use the wire canonicalizer.
  const affected = key(row.affectedObligations);
  return "code" in row
    ? `{"affectedObligations":${affected},"code":${JSON.stringify(row.code)},"reference":${key(row.reference)}}`
    : `{"affectedObligations":${affected},"digests":${JSON.stringify(row.digests)},"id":${JSON.stringify(row.id)},"kind":${JSON.stringify(row.kind)}}`;
}
function sortedDiagnostics<T extends Problem | WorkFrozen<WorkConflict>>(rows: T[]): T[] {
  return rows.map(value => ({ value, key: diagnosticKey(value) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(row => row.value);
}

/** @internal Real builder/text/index/selector path. No unchecked parsed-object projection entry. */
export function resolveWorkSnapshotText(text: string, requested: WorkFrozen<Selection> | null = null): SnapshotResolution {
  const index = indexWorkLedgerText(text);
  const errors: WorkFrozen<WorkDiagnostic>[] = [...index.ingestion.errors];
  let selection: WorkFrozen<Selection> | null = null;
  try {
    const copied = copyWorkJson(requested);
    validateWorkSelection(copied);
    selection = copied as unknown as WorkFrozen<Selection> | null;
  } catch (error) {
    if (!(error instanceof WorkInputError)) throw error;
    errors.push({ line: null, code: "WORK_CONTEXT_INVALID" });
  }
  const problems = new Map<string, Problem>();
  const conflicts = new Map<string, { digests: string[]; affected: Ref[] }>();
  for (const ref of index.conflictingEvents) {
    const row = conflicts.get(ref.eventId) ?? { digests: [], affected: [] };
    row.digests.push(ref.digest); conflicts.set(ref.eventId, row);
  }
  function problem(code: WorkResolutionCode, ref: WorkFrozen<WorkReference> | null, affected: readonly Ref[] = []) {
    const id = `${code}:${key(ref)}`;
    const old = problems.get(id);
    problems.set(id, { code, reference: ref, affectedObligations: unique([...(old?.affectedObligations ?? []), ...affected]) });
  }
  function conflict(id: string, affected: readonly Ref[]) {
    const row = conflicts.get(id);
    if (!row) return;
    row.affected = unique([...row.affected, ...affected]);
    for (const digest of row.digests) problem("EVENT_CONFLICT", { type: "event", ref: { eventId: id, digest } }, affected);
  }
  function reports() {
    return {
      problems: sortedDiagnostics([...problems.values()]),
      conflicts: sortedDiagnostics([...conflicts].map(([id, row]) => ({
        kind: "event" as const, id, digests: [...row.digests].sort(), affectedObligations: unique(row.affected),
      }))), errors,
    };
  }
  function empty(scopeState: SnapshotResolution["scopeState"]): SnapshotResolution {
    return freezeWork({ scopeState, selectedSnapshot: selection?.snapshot ?? null,
      snapshot: null, scope: null, revisions: [], obligations: [], ...reports() });
  }
  if (errors.length) { problem("INPUT_INCOMPLETE", null); return empty("unresolved"); }
  if (!selection) { problem("NO_SELECTION", null); return empty("unselected"); }

  // Exact event AND nested snapshot identity: never elect a head from candidate order or time.
  const nominated = index.candidates.find(event => event.eventId === selection!.event.eventId && event.digest === selection!.event.digest);
  const exactSnapshot = nominated?.event === "work_snapshot" &&
    nominated.payload.snapshot.snapshotId === selection.snapshot.id && nominated.payload.snapshot.digest === selection.snapshot.digest
    ? nominated.payload.snapshot : null;
  // A nominated inventory is diagnostic evidence only until ALL conflicting source IDs have been
  // checked. Nested identity, not delivery ID/time, connects an alias to the selected closure.
  const affected = exactSnapshot?.revisions.filter(ref => ref.kind === "obligation") ?? [];
  const snapshotSources = workEventConflictSources(index, exactSnapshot ? nominated! : selection.event);
  for (const source of snapshotSources) conflict(source.eventId, affected);
  // An empty selected inventory is still quarantined: affected.length is not a validity test.
  if (snapshotSources.length) return empty("unresolved");
  if (!nominated) { problem("REFERENCE_MISSING", { type: "event", ref: selection.event }); return empty("unresolved"); }
  if (!exactSnapshot) {
    problem("SCOPE_INVALID", { type: "snapshot", ref: selection.snapshot }); return empty("invalid");
  }
  const snapshot = exactSnapshot;
  const selected = new Map<string, Ref>();
  let invalid = false, missing = false;
  function reject(code: WorkResolutionCode, ref: Ref, affected: readonly Ref[] = []) {
    invalid = true; problem(code, reference(ref), affected);
  }
  for (const ref of [snapshot.scope, ...snapshot.revisions]) {
    if (selected.has(entity(ref))) reject("REVISION_INVALID", ref);
    selected.set(entity(ref), ref); // Diagnostic lookup only if invalid; no rows will be exposed.
  }
  const obligationRefs = snapshot.revisions.filter(ref => ref.kind === "obligation");
  const allAffected = unique(obligationRefs);
  const records = new Map<string, Revision>();
  const quarantineSources = new Map<string, readonly WorkFrozen<EventRef>[]>();
  for (const event of index.candidates) if (event.event === "work_revision") {
    const r = event.payload.revision;
    const ref = { kind: r.kind, id: r.id, revision: r.revision, digest: r.digest };
    if (!records.has(key(ref))) {
      const sources = workRevisionConflictSources(index, ref);
      if (sources.length) quarantineSources.set(key(ref), sources);
    }
    records.set(key(ref), r);
  }
  const isSelected = (ref: Ref) => key(selected.get(entity(ref)) ?? null) === key(ref);
  function lookup(ref: Ref, affected: readonly Ref[], localArtifact = false): Revision | null {
    // A scope revision's ID is its scopeId by the validated wire contract. This contradiction
    // is already known from the reference; absent bytes must not downgrade it to a mere gap.
    if (ref.kind === "scope" && ref.id !== snapshot.scope.id) reject("SCOPE_INVALID", ref, affected);
    const sources = quarantineSources.get(key(ref));
    if (sources) {
      for (const source of sources) conflict(source.eventId, affected);
      if (!localArtifact) missing = true;
      return null;
    }
    const r = records.get(key(ref));
    if (!r) {
      problem("REFERENCE_MISSING", reference(ref), affected);
      if (!localArtifact) missing = true;
      return null;
    }
    if (r.scopeId !== snapshot.scope.id) reject("REVISION_INVALID", ref, affected);
    return r;
  }

  function walk(root: Ref, affected: readonly Ref[], localArtifact = false) {
    // Iterative traversal: the wire depth bound does not impose a limit on revision history length.
    type Frame = { ref: Ref; current: boolean; exit?: boolean; local?: boolean };
    const stack: Frame[] = [{ ref: root, current: true, local: localArtifact }];
    const done = new Set<string>(), active = new Set<string>();
    while (stack.length) {
      const frame = stack.pop()!, id = `${frame.current}:${key(frame.ref)}`;
      if (frame.exit) { active.delete(id); done.add(id); continue; }
      if (active.has(id)) { reject("CYCLE", frame.ref, affected); continue; }
      if (done.has(id)) continue;
      if (frame.current && selected.has(entity(frame.ref)) && !isSelected(frame.ref)) reject("REVISION_INVALID", frame.ref, affected);
      if (frame.current && frame.ref.kind === "scope" && key(frame.ref) !== key(snapshot.scope)) reject("SCOPE_INVALID", frame.ref, affected);
      const r = lookup(frame.ref, affected, frame.local);
      if (!r) continue;
      active.add(id); stack.push({ ...frame, exit: true });
      if (r.predecessor) {
        const prior = lookup(r.predecessor, affected);
        if (prior && (prior.kind !== r.kind || prior.id !== r.id || prior.scopeId !== r.scopeId || prior.revision + 1 !== r.revision)) {
          reject("REVISION_INVALID", frame.ref, affected);
        }
        stack.push({ ref: r.predecessor, current: false });
      }
      if (r.parent) {
        if (entity(r.parent) === entity(frame.ref)) reject("CYCLE", frame.ref, affected);
        stack.push({ ref: r.parent, current: frame.current });
      }
      if (r.policy) {
        if (frame.current && !isSelected(r.policy)) reject("REVISION_INVALID", r.policy, affected);
        stack.push({ ref: r.policy, current: frame.current });
      }
      for (const dep of r.dependencies) {
        if (entity(dep) === entity(frame.ref)) reject("CYCLE", frame.ref, affected);
        if (frame.current && !isSelected(dep)) reject("DEPENDENCY_INVALID", dep, affected);
        stack.push({ ref: dep, current: frame.current });
      }
    }
  }
  // Structural roots must be checked even when no obligation names them. Then walk each obligation
  // independently to accumulate exact affected-obligation reachability, including shared ancestors.
  walk(snapshot.scope, allAffected);
  for (const ref of snapshot.revisions) {
    const affected = ref.kind === "obligation" ? [ref] : snapshot.bindings.filter(binding =>
      [binding.intent, binding.policy, binding.artifact].some(value => value && key(value) === key(ref)),
    ).map(binding => binding.obligation).filter(isSelected);
    walk(ref, affected, ref.kind === "artifact");
  }
  function ancestor(obligation: Ref, intent: Ref): boolean | null {
    const seen = new Set<string>();
    let cursor: Ref | null = obligation;
    while (cursor) {
      const id = key(cursor);
      if (seen.has(id) || quarantineSources.has(id)) return null;
      seen.add(id);
      const r = records.get(id);
      if (!r) return null;
      cursor = r.parent;
      if (cursor && key(cursor) === key(intent)) return true;
    }
    return false;
  }
  for (const ref of obligationRefs) {
    if (snapshot.bindings.filter(binding => key(binding.obligation) === key(ref)).length !== 1) reject("SCOPE_INVALID", ref, [ref]);
  }
  for (const binding of snapshot.bindings) {
    const affected = isSelected(binding.obligation) ? [binding.obligation] : [];
    if (!isSelected(binding.obligation)) reject("SCOPE_INVALID", binding.obligation);
    if (!isSelected(binding.intent)) reject("SCOPE_INVALID", binding.intent, affected);
    if (!isSelected(binding.policy)) reject("REVISION_INVALID", binding.policy, affected);
    const r = lookup(binding.obligation, affected);
    if (r && key(r.policy) !== key(binding.policy)) reject("REVISION_INVALID", binding.policy, affected);
    if (r && ancestor(binding.obligation, binding.intent) === false) reject("SCOPE_INVALID", binding.intent, affected);
    if (binding.artifact && !isSelected(binding.artifact)) reject("ARTIFACT_UNSELECTED", binding.artifact, affected);
  }
  if (invalid) return empty("invalid");
  if (missing) return empty("unresolved");
  const diagnostics = reports();
  return freezeWork({
    scopeState: "valid", selectedSnapshot: selection.snapshot, snapshot,
    scope: records.get(key(snapshot.scope))!,
    revisions: unique(snapshot.revisions.flatMap(ref => {
      const r = quarantineSources.has(key(ref)) ? undefined : records.get(key(ref));
      return r ? [r] : [];
    })),
    obligations: snapshot.bindings.map(binding => ({
      binding, revision: records.get(key(binding.obligation))!,
      artifact: binding.artifact && !quarantineSources.has(key(binding.artifact)) ? records.get(key(binding.artifact)) ?? null : null,
      problems: diagnostics.problems.filter(p => p.affectedObligations.some(ref => key(ref) === key(binding.obligation))),
    })), ...diagnostics,
  });
}
