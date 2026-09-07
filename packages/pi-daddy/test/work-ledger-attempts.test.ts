import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildWorkOccurrenceEvent, buildWorkAcceptanceEvent, parseWorkLedgerText, projectWorkLedger,
  appendWorkLedgerEvent, inspectWorkLedger, WorkInputError,
  type WorkFrozen, type WorkLedgerEvent, type WorkOccurrenceEvent, type WorkOccurrencePayload, type WorkProjectionContext } from "../src/work-ledger.ts";
import { workResultKey, sortWorkResults } from "../src/work-ledger-json.ts";
import { layoutFixture, layoutAuthority, layoutAssociationFixture, layoutAssociationAuthority, layoutSuccessorFixture,
  layoutSuccessorAuthority, layoutExecutions, layoutSimulation, fixtureNow, fixtureText, fixtureEventRef, fixtureRevisionRef,
  mutableFixture, walkingFixture, type LayoutRevisionChange } from "./work-ledger-fixtures.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);

type Event = WorkFrozen<WorkLedgerEvent>;
type Occurrence = WorkFrozen<WorkOccurrenceEvent>;
type Labels = WorkOccurrencePayload["labels"];
const emptyLabels: Labels = { sessionId: null, branchLeafId: null, toolCallId: null, taskId: null, workspaceId: null,
  definitionDigest: null, configurationDigest: null, modelId: null, effortId: null };
const counts = { attempts: 2, variants: 3, observedCompletedAttempts: 2 };
const withoutOccurrences = (events: readonly Event[]) => events.filter(e => e.event !== "work_occurrence");
function observation(e: Occurrence, eventId: string, patch: Partial<Omit<WorkOccurrencePayload, "labels">> = {}, labels: Partial<Labels> = {}) {
  return buildWorkOccurrenceEvent({ eventId, now: fixtureNow, payload: { ...e.payload, ...patch, labels: { ...e.payload.labels, ...labels } } });
}
function frozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value)); for (const item of Object.values(value)) frozen(item);
}
function project(events: readonly Event[], ctx: WorkProjectionContext = layoutAuthority()) {
  const text = fixtureText(events), ingestion = parseWorkLedgerText(text); assert.equal(ingestion.complete, true);
  const result = projectWorkLedger(text, ctx); assert.equal(result.scopeState, "valid"); assert.deepEqual(result.errors, []); frozen(result);
  assert.equal(result.runtime!.counts.attempts, result.runtime!.attempts.length);
  assert.deepEqual(result.runtime!.attempts, sortWorkResults(result.runtime!.attempts));
  for (const row of result.runtime!.attempts) {
    assert.deepEqual(Object.keys(row).sort(), ["executionId", "bindings", "parentExecutionId", "childId", "declaredLabels", "observedLabels", "effectiveLabels", "state", "resolution", "problems"].sort());
    assert.deepEqual(row.bindings, sortWorkResults(row.bindings)); assert.deepEqual(row.problems, sortWorkResults(row.problems));
    for (const b of row.bindings) assert.deepEqual(Object.keys(b).sort(), ["scope", "obligation", "variantIds", "artifacts"].sort());
  }
  return result;
}
function* permutations<T>(xs: readonly T[]): Generator<T[]> {
  if (!xs.length) { yield []; return; }
  for (let i = 0; i < xs.length; i++) for (const rest of permutations(xs.filter((_, j) => i !== j))) yield [xs[i], ...rest];
}
const rowFor = (p: ReturnType<typeof project>, id: string = layoutExecutions[0]) => {
  const row = p.runtime!.attempts.find(a => a.executionId === id); assert.ok(row); return row;
};
const inputError = (error: unknown) => error instanceof WorkInputError && error.code === "WORK_SCHEMA_INVALID";

test("layout options join two attempts and three variants to one obligation", async t => {
  const f = layoutFixture(), ctx = layoutAuthority(), dir = await tempDir("layout-demo-"), path = join(dir, "work.jsonl"), grant = join(dir, "grant.jsonl");
  await writeFile(grant, "protected-grant-history\n");
  const text = fixtureText(f.events); assert.equal(parseWorkLedgerText(text).events.length, 11);
  for (const e of f.events) await appendWorkLedgerEvent({ path, grantLedgerPath: grant }, e);
  const bytes = await readFile(path, "utf8"), before = await inspectWorkLedger({ version: 4, path });
  assert.equal(before.status, "read"); assert.equal(before.ingestion!.complete, true); assert.equal(before.projection!.scopeState, "unselected");
  const untrusted = { selectedSnapshot: ctx.selectedSnapshot, authority: null };
  const absent = await inspectWorkLedger({ version: 4, path }, untrusted);
  assert.deepEqual(absent.projection!.progress, { accepted: 0, total: 1 }); assert.equal(absent.projection!.claims[0].applicability, "unresolved");
  assert.deepEqual(absent.projection!.runtime!.counts, counts);
  const inspected = await inspectWorkLedger({ version: 4, path }, ctx), p = inspected.projection!;
  assert.equal(inspected.status, "read"); assert.deepEqual(p, project(f.events, ctx));
  assert.deepEqual(p.progress, { accepted: 1, total: 1 }); assert.deepEqual(p.problems, []); assert.deepEqual(p.conflicts, []);
  assert.deepEqual(p.runtime!.counts, counts); assert.equal(p.obligations[0].acceptance, "accepted-under-supplied-authority");
  assert.equal(p.obligations[0].artifactCoverage.state, "available"); assert.equal(p.obligations[0].evidenceCoverage.state, "available");
  for (const [i, id] of layoutExecutions.entries()) {
    const e = f.occurrences[i === 0 ? 0 : 2], row = rowFor(p, id);
    assert.deepEqual(row, { executionId: id, parentExecutionId: null, childId: "layout-designer", declaredLabels: [],
      observedLabels: [e.payload.labels], effectiveLabels: e.payload.labels, state: "completed", resolution: "resolved", problems: [],
      bindings: [{ scope: fixtureRevisionRef(f.scope), obligation: fixtureRevisionRef(f.obligation), variantIds: i === 0 ? ["layout:a", "layout:b"] : ["layout:c"], artifacts: [fixtureRevisionRef(f.artifact)] }] });
  }
  assert.equal(await readFile(path, "utf8"), bytes); assert.equal(await readFile(grant, "utf8"), "protected-grant-history\n");
  await writeFile(join(dir, "demonstration.json"), JSON.stringify({ label: layoutSimulation, text, bytes, absent, inspected }, null, 2));
  frozen(before); frozen(absent); frozen(inspected); t.diagnostic(layoutSimulation);
});

test("reordered and repeated completions never multiply accepted obligations", () => {
  const f = layoutFixture(), ctx = layoutAuthority();
  const repeated = observation(f.occurrences[0], "layout:repeated-completion");
  const baseline = project([...f.events, repeated, f.secondClaim], ctx);
  assert.deepEqual(baseline.progress, { accepted: 1, total: 1 }); assert.deepEqual(baseline.runtime!.counts, counts);
  assert.equal(baseline.claims.length, 2); assert.ok(baseline.claims.every(c => c.applicability === "accepted-under-supplied-authority" && c.matchedReceiptIds.length === 1));
  for (const order of permutations([...f.occurrences, repeated])) {
    const events = [...withoutOccurrences(f.events), f.secondClaim, ...order];
    for (const seq of [events, [...events].reverse(), [...order, ...events, ...events]]) {
      const c = mutableFixture(ctx); c.authority!.decisions.reverse(); c.authority!.decisions.push(...mutableFixture(c.authority!.decisions));
      assert.deepEqual(project(seq, c), baseline);
    }
  }
  const more = project([...f.events, observation(f.occurrences[0], "layout:fourth-variant", { variantId: "layout:d" })]);
  assert.deepEqual(more.runtime!.counts, { ...counts, variants: 4 }); assert.deepEqual(more.progress, { accepted: 1, total: 1 });
});

test("declared labels never overwrite contradictory observations", () => {
  const f = layoutFixture(), original = f.occurrences[0];
  const observed: Labels = { sessionId: "observed-session", branchLeafId: "observed-leaf", toolCallId: "observed-tool",
    taskId: "observed-task", workspaceId: "observed-workspace", definitionDigest: "b".repeat(64), configurationDigest: "c".repeat(64), modelId: "observed-model", effortId: "observed-effort" };
  const declared: Labels = { sessionId: "declared-session", branchLeafId: "declared-leaf", toolCallId: "declared-tool",
    taskId: "declared-task", workspaceId: "declared-workspace", definitionDigest: "d".repeat(64), configurationDigest: "e".repeat(64), modelId: "declared-model", effortId: "declared-effort" };
  const d = observation(original, "labels:declared", { provenance: "declared", state: "failed" }, declared);
  const o = observation(original, "labels:observed", {}, observed), base = withoutOccurrences(f.events);
  const clean = project([...base, d, o]); assert.deepEqual(rowFor(clean).effectiveLabels, observed); assert.deepEqual(rowFor(clean).declaredLabels, [declared]);
  assert.deepEqual(rowFor(clean).observedLabels, [observed]); assert.equal(rowFor(clean).state, "completed"); assert.equal(rowFor(clean).resolution, "resolved");
  const declarationOnly = rowFor(project([...base, d])); assert.deepEqual(declarationOnly.effectiveLabels, emptyLabels); assert.equal(declarationOnly.state, "unknown");
  assert.deepEqual(declarationOnly.problems.map(p => p.code), ["BRANCH_UNKNOWN"]);
  for (const field of Object.keys(observed) as (keyof Labels)[]) {
    const partial = observation(original, "labels:partial", {}, { ...observed, [field]: null });
    const p = project([...base, partial, o, d]); assert.deepEqual(rowFor(p).effectiveLabels, observed); assert.equal(rowFor(p).resolution, "resolved");
    const conflict = observation(original, "labels:conflict", {}, { ...observed, [field]: declared[field] });
    for (const order of permutations([o, d, conflict])) {
      const result = project([...base, ...order]), row = rowFor(result);
      assert.deepEqual(row.effectiveLabels, { ...observed, [field]: null }); assert.equal(row.resolution, "unresolved");
      assert.equal(result.runtime!.counts.observedCompletedAttempts, 0);
      assert.ok(row.problems.some(p => p.code === "OBSERVATION_CONFLICT"));
      assert.equal(row.problems.some(p => p.code === "BRANCH_UNKNOWN"), field === "branchLeafId");
      assert.deepEqual(row.observedLabels, sortWorkResults([observed, conflict.payload.labels]));
    }
  }
  const payload = mutableFixture(o.payload), built = buildWorkOccurrenceEvent({ eventId: "labels:mutable", now: fixtureNow, payload });
  payload.labels.modelId = "changed"; assert.equal(built.payload.labels.modelId, observed.modelId);
  const ctx = layoutAuthority(), saved = project([...base, built], ctx), serial = JSON.stringify(saved);
  ctx.authority!.decisions[0].binding.evidence[0].digest = "f".repeat(64); assert.equal(JSON.stringify(saved), serial); frozen(saved);
});

test("unknown session branches and missing execution parents remain unresolved", () => {
  const f = layoutFixture(), base = withoutOccurrences(f.events), a = f.occurrences[0], b = f.occurrences[2];
  const unknown = observation(a, "parent:unknown-branch", {}, { branchLeafId: null });
  const gap = project([...base, unknown]), before = JSON.stringify(gap);
  assert.equal(rowFor(gap).effectiveLabels.sessionId, a.payload.labels.sessionId); assert.equal(rowFor(gap).effectiveLabels.branchLeafId, null);
  assert.equal(rowFor(gap).resolution, "unresolved"); assert.deepEqual(rowFor(gap).problems.map(p => p.code), ["BRANCH_UNKNOWN"]);
  const known = project([...base, unknown, a]); assert.equal(rowFor(known).resolution, "resolved"); assert.equal(known.runtime!.counts.observedCompletedAttempts, 1); assert.equal(JSON.stringify(gap), before);
  const parentId = "exec:00000000-0000-4000-8000-000000000023";
  const child = observation(a, "parent:child", { parentExecutionId: parentId });
  const missing = project([...base, child, b]); // b has the SAME logical name, not the named execution ID.
  assert.deepEqual(rowFor(missing).problems, [{ code: "PARENT_MISSING", reference: { type: "execution", id: parentId }, affectedObligations: [fixtureRevisionRef(f.obligation)] }]);
  assert.equal(rowFor(missing).parentExecutionId, parentId); assert.equal(missing.runtime!.counts.observedCompletedAttempts, 1);
  const parent = observation(a, "parent:arrived", { executionId: parentId, childId: "layout-root" });
  const resolved = project([...base, child, b, parent]); assert.equal(rowFor(resolved).resolution, "resolved"); assert.equal(resolved.runtime!.counts.observedCompletedAttempts, 3);
  for (const alternative of [a, observation(a, "parent:other", { parentExecutionId: layoutExecutions[1] })]) {
    const p = project([...base, child, parent, alternative]), row = rowFor(p);
    assert.equal(row.state, "conflicted"); assert.equal(row.parentExecutionId, null); assert.equal(row.childId, null); assert.deepEqual(row.effectiveLabels, emptyLabels);
    assert.ok(row.problems.some(p => p.code === "OCCURRENCE_CONFLICT"));
  }
  assert.throws(() => observation(a, "parent:self", { parentExecutionId: a.payload.executionId }), inputError);
  const cycleA = observation(a, "parent:cycle:a", { parentExecutionId: layoutExecutions[1] });
  const cycleB = observation(b, "parent:cycle:b", { parentExecutionId: layoutExecutions[0] });
  const cycle = project([...base, cycleA, cycleB]); assert.equal(cycle.runtime!.counts.observedCompletedAttempts, 0);
  for (const row of cycle.runtime!.attempts) { assert.equal(row.resolution, "unresolved"); assert.ok(row.problems.some(p => p.code === "PARENT_CYCLE")); }
});

test("shared execution associations retain one attempt and no implied acceptance", () => {
  const f = layoutAssociationFixture(), ctx = layoutAssociationAuthority();
  const absent = project(f.events, { selectedSnapshot: ctx.selectedSnapshot, authority: null });
  assert.deepEqual(absent.progress, { accepted: 0, total: 2 }); assert.deepEqual(absent.runtime!.counts, { attempts: 1, variants: 2, observedCompletedAttempts: 1 });
  const row = rowFor(absent); assert.equal(row.bindings.length, 2); assert.equal(row.resolution, "resolved"); assert.deepEqual(row.problems, []);
  assert.deepEqual(row.bindings.map(b => b.obligation).sort((a, b) => a.id.localeCompare(b.id)), [fixtureRevisionRef(f.base.obligation), fixtureRevisionRef(f.other)]);
  const one = mutableFixture(ctx); one.authority!.decisions = one.authority!.decisions.slice(0, 1);
  const partial = project(f.events, one); assert.deepEqual(partial.progress, { accepted: 1, total: 2 });
  assert.equal(partial.obligations.find(o => o.binding.obligation.id === f.other.payload.revision.id)!.acceptance, "unresolved");
  const both = project(f.events, ctx); assert.deepEqual(both.progress, { accepted: 2, total: 2 }); assert.deepEqual(both.runtime, absent.runtime);
  assert.deepEqual(project([...f.events].reverse(), ctx), both);
  const sameVariant = observation(f.occurrence, "shared:common-variant", { variantId: f.base.occurrences[0].payload.variantId });
  const sharedVariant = project([...f.events.filter(e => e !== f.occurrence), sameVariant], { selectedSnapshot: ctx.selectedSnapshot, authority: null });
  assert.deepEqual(sharedVariant.runtime!.counts, { attempts: 1, variants: 1, observedCompletedAttempts: 1 });
  assert.equal(rowFor(sharedVariant).bindings.length, 2); assert.deepEqual(sharedVariant.progress, { accepted: 0, total: 2 });
});

test("global execution identity conflicts cannot hide behind work associations", () => {
  const f = layoutFixture(), other = walkingFixture();
  for (const kind of ["parent", "logical"] as const) {
    const conflict = observation(f.occurrences[0], `global:${kind}`, { scope: fixtureRevisionRef(other.scope), obligation: fixtureRevisionRef(other.obligation),
      ...(kind === "parent" ? { parentExecutionId: layoutExecutions[1] } : { childId: "different-designer" }) });
    const base = [...f.events, ...other.events], expected = project([...base, conflict]);
    const row = rowFor(expected); assert.equal(row.bindings.length, 1); assert.deepEqual(row.bindings[0].obligation, fixtureRevisionRef(f.obligation));
    assert.equal(row.resolution, "unresolved"); assert.equal(row.state, "conflicted"); assert.equal(row.parentExecutionId, null); assert.equal(row.childId, null); assert.deepEqual(row.effectiveLabels, emptyLabels);
    assert.deepEqual(row.problems, [{ code: "OCCURRENCE_CONFLICT", reference: { type: "execution", id: layoutExecutions[0] }, affectedObligations: [fixtureRevisionRef(f.obligation)] }]);
    assert.deepEqual(expected.progress, { accepted: 0, total: 1 }); assert.equal(expected.runtime!.counts.observedCompletedAttempts, 1);
    assert.ok(expected.runtime!.occurrences.some(e => e.event.digest === conflict.digest)); assert.deepEqual(expected.conflicts, []);
    for (const seq of [[conflict, ...base], [...base, conflict].reverse(), [...base, conflict, conflict]]) assert.deepEqual(project(seq), expected);
    const shared = layoutAssociationFixture(), ctx = layoutAssociationAuthority();
    const badJoin = observation(shared.occurrence, `global:shared:${kind}`, kind === "parent" ? { parentExecutionId: layoutExecutions[1] } : { childId: "other-name" });
    const p = project([...shared.events, badJoin], ctx); assert.equal(p.runtime!.attempts.length, 1); assert.equal(rowFor(p).bindings.length, 2);
    assert.deepEqual(p.progress, { accepted: 0, total: 2 }); assert.equal(p.runtime!.counts.observedCompletedAttempts, 0); assert.deepEqual(rowFor(p).effectiveLabels, emptyLabels);
  }
  const missingChild = observation(f.occurrences[0], "global:null-child", { childId: null });
  assert.equal(rowFor(project([...f.events, missingChild])).childId, "layout-designer");
  const alias = observation(f.occurrences[0], "global:shadow"), rival = observation(f.occurrences[0], "global:shadow", { childId: "other-name" });
  const laundered = observation(f.occurrences[0], "global:laundered");
  const expected = project([...f.events, alias, rival, laundered]);
  assert.equal(rowFor(expected).resolution, "unresolved"); assert.equal(rowFor(expected).state, "conflicted"); assert.deepEqual(rowFor(expected).effectiveLabels, emptyLabels);
  assert.deepEqual(expected.progress, { accepted: 0, total: 1 }); assert.deepEqual(expected.runtime!.counts, { attempts: 2, variants: 2, observedCompletedAttempts: 1 });
  assert.deepEqual(expected.conflicts, [{ kind: "event", id: "global:shadow", digests: [alias.digest, rival.digest].sort(), affectedObligations: [fixtureRevisionRef(f.obligation)] }]);
  assert.deepEqual(expected.runtime!.occurrences.map(e => e.event).sort((a, b) => a.digest.localeCompare(b.digest)), [...f.occurrences, alias, rival, laundered].map(fixtureEventRef).sort((a, b) => a.digest.localeCompare(b.digest)));
  for (const order of permutations([alias, rival, laundered])) assert.deepEqual(project([...order, ...f.events, ...order]), expected);
});

test("successor selections supersede layout acceptance without rewriting history", async t => {
  for (const primary of ["scope", "intent", "obligation", "artifact", "policy", "snapshot"] as LayoutRevisionChange[]) await t.test(primary, async () => {
    const f = layoutSuccessorFixture(primary), ctx = layoutSuccessorAuthority(primary), oldCtx = layoutAuthority();
    const historical = project(f.base.events, oldCtx), saved = JSON.stringify(historical);
    assert.deepEqual(historical.progress, { accepted: 1, total: 1 });
    const dir = await tempDir("layout-successor-"), path = join(dir, "work");
    for (const e of f.events) await appendWorkLedgerEvent({ path, grantLedgerPath: null }, e);
    const read = await inspectWorkLedger({ version: 4, path }, ctx), current = read.projection!;
    assert.equal(read.status, "read"); assert.equal(read.ingestion!.complete, true); assert.equal(current.scopeState, "valid");
    assert.deepEqual(current.progress, { accepted: 1, total: 1 }); assert.deepEqual(current.runtime!.counts, counts);
    assert.equal(current.supersededClaims, 1); assert.equal(current.claims.find(c => c.claim.eventId === f.base.claim.eventId)!.applicability, "superseded");
    assert.deepEqual(current.claims.find(c => c.claim.eventId === f.claim.eventId)!.matchedReceiptIds, [`layout-receipt:${primary}`]);
    for (const name of f.changes) {
      assert.equal(f.current[name].payload.revision.revision, 2); assert.deepEqual(f.current[name].payload.revision.predecessor, fixtureRevisionRef(f.base[name]));
    }
    if (primary === "scope") {
      assert.deepEqual(f.changes, ["scope", "goal", "intent", "obligation"]);
      assert.deepEqual(f.current.goal.payload.revision.parent, fixtureRevisionRef(f.current.scope));
      assert.deepEqual(f.current.intent.payload.revision.parent, fixtureRevisionRef(f.current.goal));
      assert.deepEqual(f.current.obligation.payload.revision.parent, fixtureRevisionRef(f.current.intent));
    }
    if (primary === "snapshot") { assert.deepEqual(f.changes, []); assert.deepEqual(f.current.obligation, f.base.obligation); }
    else assert.equal(f.current[primary].payload.revision.contentDigest, "c".repeat(64));
    const oldReceipts = mutableFixture(ctx); oldReceipts.authority!.decisions = mutableFixture(oldCtx.authority!.decisions);
    const stale = project(f.events, oldReceipts); assert.deepEqual(stale.progress, { accepted: 0, total: 1 });
    assert.deepEqual(stale.claims.find(c => c.claim.eventId === f.claim.eventId)!.matchedReceiptIds, []);
    const onlyOld = project(f.events.filter(e => e !== f.claim), ctx); assert.deepEqual(onlyOld.progress, { accepted: 0, total: 1 }); assert.equal(onlyOld.supersededClaims, 1);
    const mismatched = mutableFixture(ctx); mismatched.authority!.decisions.at(-1)!.binding = mutableFixture(f.base.claim.payload.binding);
    assert.deepEqual(project(f.events, mismatched).progress, { accepted: 0, total: 1 });
    const unavailable = mutableFixture(ctx); unavailable.authority!.availability.find(v => v.id === `layout:${primary}:proof`)!.available = false;
    assert.deepEqual(project(f.events, unavailable).progress, { accepted: 0, total: 1 });
    assert.deepEqual(project(f.events.filter(e => e !== f.occurrences[0]), ctx).progress, { accepted: 0, total: 1 });
    if (f.changes.length) {
      const missingPredecessor = projectWorkLedger(fixtureText(f.events.filter(e => e !== f.base[f.changes[0]])), ctx);
      // Artifact-only history is obligation-local; other structural history removes the denominator.
      assert.equal(missingPredecessor.progress?.accepted ?? 0, 0);
      assert.ok(missingPredecessor.problems.some(p => p.code === "REFERENCE_MISSING"));
    }
    const oldSelection = project(f.events, oldCtx); assert.deepEqual(oldSelection.progress, historical.progress);
    assert.deepEqual(oldSelection.claims.find(c => c.claim.eventId === f.base.claim.eventId), historical.claims[0]);
    // New replay may expose additional historical/runtime rows; the already returned result cannot change.
    assert.equal(JSON.stringify(historical), saved); frozen(historical);
    const all = [...f.events].reverse(); assert.deepEqual(project(all, ctx), current);
    await writeFile(join(dir, "receipt.json"), JSON.stringify({ label: layoutSimulation, primary, ctx, historical, current, stale, text: fixtureText(f.events) }, null, 2));
  });
});

test("receipt-shaped wire data cannot reproduce fixture controller authority", () => {
  const f = layoutFixture(), ctx = layoutAuthority(); assert.deepEqual(project(f.events, ctx).progress, { accepted: 1, total: 1 });
  for (const at of ["payload", "labels"] as const) {
    const e = mutableFixture(f.occurrences[0]); const target: Record<string, unknown> = at === "labels" ? e.payload.labels : e.payload;
    target.receipt = mutableFixture(ctx.authority!.decisions[0]);
    const p = projectWorkLedger(fixtureText([...f.events, e]), ctx); assert.equal(p.progress, null); assert.deepEqual(p.errors, [{ line: f.events.length + 1, code: "WORK_SCHEMA_INVALID" }]);
  }
  const forged = buildWorkAcceptanceEvent({ eventId: "layout:forged", now: fixtureNow, payload: { ...mutableFixture(f.claim.payload), authorityId: "self-approved" } });
  const absent = project([...f.events.filter(e => e !== f.claim), forged], { selectedSnapshot: ctx.selectedSnapshot, authority: null });
  assert.deepEqual(absent.progress, { accepted: 0, total: 1 }); assert.ok(absent.claims[0].problems.some(p => p.code === "AUTHORITY_MISSING"));
  const mismatched = mutableFixture(ctx); mismatched.authority!.decisions[0].claim.digest = "f".repeat(64);
  const bad = project(f.events, mismatched); assert.deepEqual(bad.progress, { accepted: 0, total: 1 }); assert.ok(bad.claims[0].problems.some(p => p.code === "RECEIPT_MISMATCH"));
  for (const kind of ["artifact", "evidence"] as const) {
    const missing = mutableFixture(ctx); missing.authority!.availability = missing.authority!.availability.filter(v => v.kind !== kind);
    assert.deepEqual(project(f.events, missing).progress, { accepted: 0, total: 1 });
    const unavailable = mutableFixture(ctx); unavailable.authority!.availability.find(v => v.kind === kind)!.available = false;
    const result = project(f.events, unavailable); assert.deepEqual(result.progress, { accepted: 0, total: 1 }); assert.ok(result.claims[0].problems.some(p => p.code === "BYTES_UNAVAILABLE"));
  }
  const contradiction = mutableFixture(ctx); contradiction.authority!.decisions.push({ ...mutableFixture(ctx.authority!.decisions[0]), receiptId: "layout:opposition", decision: "reject" });
  const p = project(f.events, contradiction); assert.deepEqual(p.progress, { accepted: 0, total: 1 }); assert.deepEqual(p.conflicts, []);
  assert.deepEqual(p.obligations[0].problems, [{ code: "DECISION_CONFLICT", reference: { type: "revision", ref: fixtureRevisionRef(f.obligation) }, affectedObligations: [fixtureRevisionRef(f.obligation)] }]);
});

test("runtime completion and coverage remain separate from acceptance", () => {
  const f = layoutFixture(), ctx = layoutAuthority();
  const none = project(f.events.filter(e => e !== f.claim), ctx); assert.deepEqual(none.progress, { accepted: 0, total: 1 });
  assert.equal(none.obligations[0].acceptance, "unaccepted"); assert.equal(none.obligations[0].evidenceCoverage.state, "unknown"); assert.deepEqual(none.runtime!.counts, counts);
  const failed = observation(f.occurrences[2], "runtime:failed", { state: "failed" });
  const p = project([...f.events.filter(e => e !== f.occurrences[2]), failed], ctx);
  assert.deepEqual(p.progress, { accepted: 1, total: 1 }); assert.equal(rowFor(p, layoutExecutions[1]).state, "failed"); assert.equal(p.runtime!.counts.observedCompletedAttempts, 1);
  for (const state of ["starting", "running"] as const) {
    const partial = observation(f.occurrences[0], `runtime:${state}`, { state });
    const p = project([...f.events, partial]); assert.equal(rowFor(p).state, "completed"); assert.deepEqual(p.runtime!.counts, counts);
  }
  const unrelatedConflict = project([...f.events, failed]); assert.equal(rowFor(unrelatedConflict, layoutExecutions[1]).state, "conflicted");
  assert.equal(unrelatedConflict.runtime!.counts.observedCompletedAttempts, 1); assert.deepEqual(unrelatedConflict.progress, { accepted: 1, total: 1 }); assert.deepEqual(unrelatedConflict.obligations[0].problems, []);
  const gap = observation(f.occurrences[2], "runtime:gap", {}, { branchLeafId: null });
  assert.deepEqual(project([...f.events.filter(e => e !== f.occurrences[2]), gap]).progress, { accepted: 1, total: 1 });
  const requiredConflict = observation(f.occurrences[0], "runtime:required-failed", { state: "failed" });
  const blocked = project([...f.events, requiredConflict]); assert.deepEqual(blocked.progress, { accepted: 0, total: 1 });
  assert.equal(blocked.claims[0].applicability, "unresolved"); assert.deepEqual(blocked.claims[0].matchedReceiptIds, ["layout-receipt"]);
  assert.equal(blocked.obligations[0].evidenceCoverage.state, "available"); assert.ok(blocked.obligations[0].problems.some(p => p.code === "OBSERVATION_CONFLICT"));
  assert.deepEqual(blocked.conflicts, []); assert.notEqual(workResultKey(blocked.runtime), workResultKey(p.runtime));
});
