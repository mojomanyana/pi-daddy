// GENERATED from pi-daddy 7c78769c47177b1972b09e1f5c5474ad44cd2cac by scripts/vendor-work-v4-reader.mjs. Do not hand-edit.
import { workResultKey as key, sortWorkResults as sorted, mergeWorkProblems } from "./json.js";
import { workEventConflictSources, type indexWorkLedgerText } from "./projection.js";
import type {
  WorkFrozen, WorkSnapshot, WorkOccurrenceEvent, WorkOccurrencePayload, WorkAttempt,
  WorkAttemptBinding, WorkRuntime, WorkProblem, WorkConflict,
} from "./types.js";

type Occurrence = WorkFrozen<WorkOccurrenceEvent>;
type Problem = WorkFrozen<WorkProblem>;
const eventRef = (e: Occurrence) => ({ eventId: e.eventId, digest: e.digest });
const emptyLabels = (): WorkOccurrencePayload["labels"] => ({ sessionId: null, branchLeafId: null,
  toolCallId: null, taskId: null, workspaceId: null, definitionDigest: null, configurationDigest: null, modelId: null, effortId: null });

/** @internal One governed execution identity, many explicit work associations. No acceptance inferred. */
export function foldWorkOccurrences(index: ReturnType<typeof indexWorkLedgerText>, snapshot: WorkFrozen<WorkSnapshot>) {
  const groups = new Map<string, Occurrence[]>();
  const effectiveRefs = new Set(index.effectiveEvents.map(e => key({ eventId: e.eventId, digest: e.digest })));
  for (const event of index.candidates) if (event.event === "work_occurrence") {
    const group = groups.get(event.payload.executionId) ?? [];
    group.push(event); groups.set(event.payload.executionId, group);
  }
  const effective = new Map([...groups].map(([id, group]) => [id, group.filter(e => effectiveRefs.has(key(eventRef(e))))]));
  const selectedObligations = new Set(snapshot.bindings.map(b => key(b.obligation)));
  const selectedJoin = (e: Occurrence) => key(e.payload.scope) === key(snapshot.scope) && selectedObligations.has(key(e.payload.obligation));
  const attempts: WorkFrozen<WorkAttempt>[] = [], occurrences: WorkFrozen<WorkRuntime>["occurrences"][number][] = [];
  const allProblems: Problem[] = [], conflicts: WorkFrozen<WorkConflict>[] = [];
  const eventProblems = new Map<string, readonly Problem[]>();
  for (const [executionId, candidates] of groups) {
    const clean = effective.get(executionId)!;
    const bindings = new Map<string, WorkFrozen<WorkAttemptBinding>>();
    for (const event of clean.filter(selectedJoin)) {
      const p = event.payload, id = key([p.scope, p.obligation]), prior = bindings.get(id);
      bindings.set(id, { scope: p.scope, obligation: p.obligation,
        variantIds: sorted([...(prior?.variantIds ?? []), ...(p.variantId ? [p.variantId] : [])]),
        artifacts: sorted([...(prior?.artifacts ?? []), ...(p.artifact ? [p.artifact] : [])]),
      });
    }
    const affected = sorted([...bindings.values()].map(b => b.obligation));
    const problems: Problem[] = [];
    const problem = (code: WorkProblem["code"], id = executionId) => problems.push({ code, reference: { type: "execution", id }, affectedObligations: affected });
    const badSources = sorted(candidates.flatMap(e => workEventConflictSources(index, e)));
    for (const ref of badSources) problems.push({ code: "EVENT_CONFLICT", reference: { type: "event", ref }, affectedObligations: affected });
    if (bindings.size) for (const id of sorted(badSources.map(ref => ref.eventId))) {
      conflicts.push({ kind: "event", id, digests: index.conflictingEvents.filter(ref => ref.eventId === id).map(ref => ref.digest), affectedObligations: affected });
    }
    const parents = sorted(clean.map(e => e.payload.parentExecutionId));
    const children = sorted(clean.flatMap(e => e.payload.childId ? [e.payload.childId] : []));
    const identityConflict = parents.length > 1 || children.length > 1;
    if (identityConflict) problem("OCCURRENCE_CONFLICT");
    let parentExecutionId = parents.length === 1 ? parents[0] : null;
    let childId = children.length === 1 ? children[0] : null;
    const observed = clean.filter(e => e.payload.provenance === "observed");
    const declaredLabels = sorted(clean.filter(e => e.payload.provenance === "declared").map(e => e.payload.labels));
    const observedLabels = sorted(observed.map(e => e.payload.labels));
    const effectiveLabels = emptyLabels();
    for (const label of Object.keys(effectiveLabels) as Array<keyof WorkOccurrencePayload["labels"]>) {
      const values = sorted(observed.flatMap(e => e.payload.labels[label] === null ? [] : [e.payload.labels[label]!]));
      if (values.length > 1) problem("OBSERVATION_CONFLICT");
      else effectiveLabels[label] = values[0] ?? null;
    }
    const states = new Set(observed.map(e => e.payload.state));
    const terminalConflict = states.has("completed") && states.has("failed");
    if (terminalConflict) problem("OBSERVATION_CONFLICT");
    let state: WorkAttempt["state"] = terminalConflict ? "conflicted" : states.has("completed") ? "completed" :
      states.has("failed") ? "failed" : states.has("running") ? "running" : states.has("starting") ? "starting" : "unknown";
    if (identityConflict || badSources.length) {
      state = "conflicted"; parentExecutionId = null; childId = null;
      Object.assign(effectiveLabels, emptyLabels());
    } else {
      const seen = new Set([executionId]);
      let parent = parentExecutionId;
      while (parent !== null) {
        if (seen.has(parent)) { problem("PARENT_CYCLE", parent); break; }
        seen.add(parent);
        const bodies = effective.get(parent);
        if (!bodies?.length) { problem("PARENT_MISSING", parent); break; }
        const alternatives = sorted(bodies.map(e => e.payload.parentExecutionId));
        if (alternatives.length !== 1) { problem("OCCURRENCE_CONFLICT", parent); break; }
        parent = alternatives[0];
      }
      if (effectiveLabels.branchLeafId === null) problem("BRANCH_UNKNOWN");
    }
    const rowProblems = mergeWorkProblems(problems);
    // Support closure can name an occurrence even when its association is not selected. Keep its
    // global identity diagnostics available internally; only selected joins become public attempts.
    for (const candidate of candidates) eventProblems.set(key(eventRef(candidate)), rowProblems);
    if (!bindings.size) continue;
    allProblems.push(...rowProblems);
    occurrences.push(...candidates.map(e => ({ event: eventRef(e), payload: e.payload })));
    attempts.push({ executionId, bindings: sorted(bindings.values()), parentExecutionId, childId, declaredLabels,
      observedLabels, effectiveLabels, state, resolution: rowProblems.length ? "unresolved" : "resolved", problems: rowProblems });
  }
  const runtime: WorkFrozen<WorkRuntime> = { attempts: sorted(attempts), occurrences: sorted(occurrences), counts: {
    attempts: attempts.length,
    variants: new Set(attempts.flatMap(a => a.bindings.flatMap(b => b.variantIds))).size,
    observedCompletedAttempts: attempts.filter(a => a.resolution === "resolved" && a.state === "completed").length,
  } };
  return { runtime, problems: mergeWorkProblems(allProblems), conflicts, eventProblems };
}
