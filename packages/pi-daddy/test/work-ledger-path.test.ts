import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, readFile, writeFile, symlink, link, readdir, stat, lstat, readlink, utimes } from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { after, type TestContext } from "node:test";
import { test } from "./bounded-path-test.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { STALE_LOCK_MS } from "../src/file-lock.ts";
import { verifyLedger } from "../src/ledger.ts";
after(cleanupTempDirs);
import {
  buildWorkRevisionEvent, buildWorkSnapshotEvent, buildWorkOccurrenceEvent, buildWorkAcceptanceEvent, parseWorkLedgerText, projectWorkLedger, appendWorkLedgerEvent, inspectWorkLedger, WorkInputError, WorkLedgerWriteError,
  type EventRef, type RevisionRef, type WorkFrozen, type WorkLedgerEvent, type WorkRevisionEvent,
} from "../src/work-ledger.ts";
import { indexWorkLedgerText } from "../src/work-ledger-projection.ts";
import { resolveWorkSnapshotText } from "../src/work-ledger-snapshot.ts";
import type { WorkRevision, WorkSnapshot } from "../src/work-ledger-types.ts";
import { canonicalWorkJson, workDigest } from "../src/work-ledger-json.ts";
import { walkingFixture, fixtureAuthority, fixtureText, fixtureEventRef, fixtureRevisionRef, fixtureExecution, mutableFixture,
  revisionRevalidationFixture, revisionRevalidationAuthority, type FixtureRevisionChange,
  supportQuarantineFixture, supportQuarantineAuthority, type FixtureSupportKind } from "./work-ledger-fixtures.ts";

// Pure first-pass identity tests, NOT proof of selected-scope or acceptance projection.
// No filesystem, environment, subprocess, model, receipt-authority or cleanup operations.
const now = new Date("2026-09-06T12:00:00.000Z");
const digest = "a".repeat(64);
type Event = WorkFrozen<WorkLedgerEvent>;
const scope = (eventId: string, scopeId = "scope:a", content = digest, at = now) => buildWorkRevisionEvent({
  eventId, now: at, revision: {
    kind: "scope", id: scopeId, scopeId, revision: 1, predecessor: null,
    contentDigest: content, parent: null, dependencies: [], ownerId: "owner", permittedEffects: [], policy: null,
  },
});
const revisionRef = (event: WorkFrozen<WorkRevisionEvent>): RevisionRef => {
  const { kind, id, revision, digest } = event.payload.revision;
  return { kind, id, revision, digest };
};
const eventRef = (event: Event): EventRef => ({ eventId: event.eventId, digest: event.digest });
const ref = (kind: RevisionRef["kind"]): RevisionRef => ({ kind, id: kind, revision: 1, digest });
const snapshot = (eventId: string) => buildWorkSnapshotEvent({ eventId, now, snapshot: {
  snapshotId: "snapshot", scope: revisionRef(scope("scope")), revisions: [], bindings: [],
} });
const occurrence = (eventId: string) => buildWorkOccurrenceEvent({ eventId, now, payload: {
  scope: revisionRef(scope("scope")), obligation: ref("obligation"),
  executionId: "exec:00000000-0000-4000-8000-000000000001", parentExecutionId: null,
  childId: "d0.1", variantId: "variant", artifact: ref("artifact"), provenance: "observed", state: "completed",
  labels: { sessionId: null, branchLeafId: null, toolCallId: null, taskId: null, workspaceId: null,
    definitionDigest: null, configurationDigest: null, modelId: null, effortId: null },
} });
const claim = (eventId: string) => buildWorkAcceptanceEvent({ eventId, now, payload: {
  authorityId: "authority", binding: {
    snapshot: { id: "snapshot", digest }, scope: revisionRef(scope("scope")), intent: ref("goal"),
    obligation: ref("obligation"), artifact: ref("artifact"), artifactDigest: digest, policy: ref("policy"),
    evidence: [{ id: "evidence", digest, event: eventRef(occurrence("occurrence")) }],
  },
} });
const text = (events: readonly Event[]) => events.map(e => JSON.stringify(e)).join("\n") + "\n";
// Every closed event/ref starts with digest in canonical key order. Independent ordering oracle.
const sorted = <T extends { readonly digest: string }>(values: readonly T[]): T[] => [...values].sort(
  (a, b) => a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0,
);
const identityView = (result: ReturnType<typeof indexWorkLedgerText>) => {
  // Keep the original identity-view assertions; the new central source map is checked separately.
  const { ingestion: _, conflictSources: _sources, ...identity } = result;
  return identity;
};
function* permutations<T>(values: readonly T[]): Generator<T[]> {
  if (values.length === 0) { yield []; return; }
  for (let i = 0; i < values.length; i++) {
    for (const tail of permutations(values.filter((_, j) => i !== j))) yield [values[i], ...tail];
  }
}
function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("work-v4 delivery index retains real facts and collapses only canonical delivery duplicates", () => {
  const events = [scope("constructor"), snapshot("snapshot"), occurrence("occurrence"), claim("toString")];
  const result = indexWorkLedgerText(text(events));
  assert.deepEqual(result.ingestion, { events, errors: [], complete: true });
  assert.deepEqual(identityView(result), {
    candidates: sorted(events), conflictingEvents: [], quarantinedRevisions: [], effectiveEvents: sorted(events),
  });
  const sameRevision = scope("another-delivery");
  const distinctIds = indexWorkLedgerText(text([events[0], sameRevision]));
  assert.deepEqual(distinctIds.effectiveEvents, sorted([events[0], sameRevision]), "different delivery IDs are not duplicates");
  const compact = JSON.stringify(events[0]);
  const reordered = ` \t${JSON.stringify(Object.fromEntries(Object.entries(events[0]).reverse()))} `;
  assert.notEqual(createHash("sha256").update(compact).digest("hex"), createHash("sha256").update(reordered).digest("hex"));
  for (const deliveries of [[compact, reordered, compact], [reordered, compact, reordered]]) {
    const duplicate = indexWorkLedgerText(deliveries.join("\n"));
    assert.equal(duplicate.ingestion.events.length, 3);
    assert.deepEqual(duplicate.effectiveEvents, [events[0]]);
    assert.deepEqual(duplicate.candidates, [events[0]]);
    assert.deepEqual(duplicate.conflictingEvents, []);
    assert.deepEqual(duplicate.quarantinedRevisions, []);
  }
  assert.equal(JSON.stringify(identityView(indexWorkLedgerText(compact + "\n" + reordered))),
    JSON.stringify(identityView(indexWorkLedgerText(reordered + "\n" + compact))), "no arrival-dependent object-key order");
});

test("work-v4 delivery conflicts quarantine every discriminator and retain all candidate bodies", () => {
  const alternatives = [scope("shared"), snapshot("shared"), occurrence("shared"), claim("shared")] as const;
  const unrelated = scope("healthy", "scope:healthy");
  const expected = {
    candidates: sorted([...alternatives, unrelated]),
    conflictingEvents: sorted(alternatives.map(eventRef)),
    quarantinedRevisions: [revisionRef(alternatives[0])], effectiveEvents: [unrelated],
  };
  for (const order of permutations(alternatives)) {
    const result = indexWorkLedgerText(text([order[0], unrelated, ...order.slice(1), order[0]]));
    assert.equal(result.ingestion.complete, true);
    assert.deepEqual(identityView(result), expected);
    // In particular, retain the claim's evidence reference and the occurrence's execution/scope joins.
    assert.deepEqual(result.candidates.find(e => e.event === "work_acceptance"), alternatives[3]);
    assert.deepEqual(result.candidates.find(e => e.event === "work_occurrence"), alternatives[2]);
  }
});

test("work-v4 revision quarantine cannot be laundered by a new delivery ID or timestamp", () => {
  const a = scope("collision", "scope:a");
  const b = scope("collision", "scope:b", "b".repeat(64));
  const aliasA = scope("alias:a", "scope:a", digest, new Date(now.getTime() + 10));
  const aliasB = scope("alias:b", "scope:b", "b".repeat(64), new Date(now.getTime() + 20));
  const healthy = scope("healthy", "scope:healthy");
  // A different exact revision body of the same stable entity is not elected or globally erased here.
  const otherBody = scope("fork", "scope:a", "c".repeat(64));
  const expected = {
    candidates: sorted([a, b, aliasA, aliasB, healthy, otherBody]),
    conflictingEvents: sorted([a, b].map(eventRef)),
    quarantinedRevisions: sorted([a, b].map(revisionRef)), effectiveEvents: sorted([healthy, otherBody]),
  };
  for (const order of permutations([a, b, aliasA, aliasB])) {
    const result = indexWorkLedgerText(text([...order, healthy, otherBody, ...order]));
    assert.deepEqual(identityView(result), expected);
  }
  const before = indexWorkLedgerText(text([a, aliasA, healthy]));
  assert.deepEqual(before.effectiveEvents, sorted([a, aliasA, healthy]));
  const saved = JSON.stringify(before);
  const after = indexWorkLedgerText(text([a, aliasA, healthy, b]));
  assert.deepEqual(after.effectiveEvents, [healthy]);
  assert.equal(JSON.stringify(before), saved, "later replay cannot mutate a prior result");
  assertDeepFrozen(after);
  assert.throws(() => (after.conflictingEvents as EventRef[]).pop(), TypeError);
});

test("work-v4 timestamp-only conflicts quarantine the shared revision once without choosing latest", () => {
  const early = scope("collision");
  const late = scope("collision", "scope:a", digest, new Date(now.getTime() + 1));
  const alias = scope("new-id");
  assert.notEqual(early.digest, late.digest);
  assert.equal(early.payload.revision.digest, late.payload.revision.digest);
  const result = indexWorkLedgerText(text([early, alias, late, late, early]));
  assert.deepEqual(result.conflictingEvents, sorted([early, late].map(eventRef)));
  assert.deepEqual(result.quarantinedRevisions, [revisionRef(early)]);
  assert.deepEqual(result.effectiveEvents, []);
  assert.deepEqual(result.candidates, sorted([early, late, alias]));
});

test("work-v4 incomplete ingestion retains diagnostics and candidates but exposes no effective facts", () => {
  const good = scope("good");
  const other = scope("good", "scope:other");
  const valid = text([good, other]);
  const result = indexWorkLedgerText(`${valid}\n{broken\n`);
  assert.deepEqual(result.ingestion.errors, [{ line: 4, code: "WORK_JSON_INVALID" }]);
  assert.equal(result.ingestion.complete, false);
  assert.deepEqual(result.candidates, sorted([good, other]));
  assert.deepEqual(result.conflictingEvents, sorted([good, other].map(eventRef)));
  assert.deepEqual(result.effectiveEvents, []);
  const badDigest = { ...good, digest: "b".repeat(64) };
  const invalidAlternative = indexWorkLedgerText(text([good]) + JSON.stringify(badDigest));
  assert.deepEqual(invalidAlternative.ingestion.errors, [{ line: 2, code: "WORK_DIGEST_MISMATCH" }]);
  assert.deepEqual(invalidAlternative.conflictingEvents, [], "corrupt input must not become a validated candidate");
  assert.deepEqual(invalidAlternative.candidates, [good]);
  assert.deepEqual(invalidAlternative.effectiveEvents, []);
  const duplicateMember = JSON.stringify(good).replace('"eventId":"good"', '"eventId":"good","eventId":"hidden"');
  assert.deepEqual(indexWorkLedgerText(duplicateMember).ingestion.errors, [{ line: 1, code: "WORK_DUPLICATE_MEMBER" }]);
  const invalidObject = indexWorkLedgerText([good] as unknown as string);
  assert.deepEqual(invalidObject.ingestion.errors, [{ line: null, code: "WORK_SCHEMA_INVALID" }]);
  assert.deepEqual(invalidObject.effectiveEvents, [], "there is no unchecked object projection route");
  assert.deepEqual(indexWorkLedgerText(" \n\t"), {
    ingestion: { events: [], errors: [], complete: true }, candidates: [], conflictingEvents: [], quarantinedRevisions: [], effectiveEvents: [],
    conflictSources: { bodies: {}, events: {} },
  });
});

test("work-v4 indexing preserves valid compact numeric text when its canonical emission grows", async () => {
  const base = buildWorkSnapshotEvent({ eventId: "large-snapshot", now, snapshot: {
    snapshotId: "snapshot", scope: revisionRef(scope("scope")), bindings: [],
    revisions: Array.from({ length: 256 }, (_, i) => ({
      kind: "artifact" as const, id: `artifact:${i}`.padEnd(128, "x"), revision: 1, digest,
    })),
  } });
  // Real builder seed, then a checksummed wire fixture using another supported exact numeric spelling.
  // Its delivered TEXT is within 64 KiB, though JCS expands each 1e15 reference number to 16 digits.
  const { digest: _snapshotDigest, ...snapshotBody } = base.payload.snapshot;
  const expandedSnapshot = { ...snapshotBody, revisions: snapshotBody.revisions.map(r => ({ ...r, revision: 1e15 })) };
  const { digest: _eventDigest, ...eventBody } = base;
  const body = { ...eventBody, payload: { snapshot: { ...expandedSnapshot, digest: workDigest(expandedSnapshot) } } };
  const expanded = { ...body, digest: workDigest(body) };
  const canonical = canonicalWorkJson(expanded);
  const delivered = canonical.replaceAll('"revision":1000000000000000', '"revision":1e15');
  assert.ok(Buffer.byteLength(canonical) > 65536);
  assert.ok(Buffer.byteLength(delivered) <= 65536);
  assert.equal(parseWorkLedgerText(delivered).complete, true, "the strict ingestion boundary accepts this delivered text");
  const indexed = indexWorkLedgerText(delivered);
  assert.deepEqual(indexed.effectiveEvents, [expanded]);
  assert.deepEqual(indexed.conflictingEvents, []);
  // The input object is valid evidence but its canonical append line would exceed the reader's
  // record bound. Reject BEFORE path validation/I/O rather than creating an unreadable delivery.
  await assert.rejects(appendWorkLedgerEvent({ path: "relative", grantLedgerPath: null }, expanded),
    error => error instanceof WorkInputError && error.code === "WORK_LIMIT_EXCEEDED");
});

test("work-v4 replay result collections are not truncated to the per-wire-array bound", () => {
  const alternatives = Array.from({ length: 300 }, (_, i) => scope("collision", "scope:a", digest, new Date(now.getTime() + i)));
  const conflicting = indexWorkLedgerText(text([...alternatives, alternatives[0]]));
  assert.equal(conflicting.ingestion.events.length, 301);
  assert.deepEqual(conflicting.candidates, sorted(alternatives));
  assert.deepEqual(conflicting.conflictingEvents, sorted(alternatives.map(eventRef)));
  assert.deepEqual(conflicting.quarantinedRevisions, [revisionRef(alternatives[0])]);
  assert.deepEqual(conflicting.effectiveEvents, []);
  const separate = Array.from({ length: 300 }, (_, i) => scope(`delivery:${i}`));
  const clean = indexWorkLedgerText(text(separate));
  assert.deepEqual(clean.effectiveEvents, sorted(separate));
  assert.deepEqual(clean.conflictingEvents, []);
  const oversized = indexWorkLedgerText(text([separate[0]]).repeat(10_001));
  assert.deepEqual(oversized.ingestion.errors, [{ line: null, code: "WORK_LIMIT_EXCEEDED" }]);
  assert.deepEqual(oversized.candidates, []);
  assert.deepEqual(oversized.effectiveEvents, []);
});

// Selector/graph fixtures still use the production builders and strict text boundary.
const graphRevision = (kind: WorkRevision["kind"], id: string, patch: Partial<Omit<WorkRevision, "digest">> = {}) =>
  buildWorkRevisionEvent({ eventId: `graph:${id}:${patch.revision ?? 1}:${patch.scopeId ?? "scope:a"}`, now, revision: {
    kind, id, scopeId: "scope:a", revision: 1, predecessor: null, contentDigest: digest,
    parent: null, dependencies: [], ownerId: "owner", permittedEffects: [], policy: null, ...patch,
  } });
function graphFixture() {
  const s = scope("graph:scope");
  const goal = graphRevision("goal", "goal", { parent: revisionRef(s) });
  const policy = graphRevision("policy", "policy");
  const artifact = graphRevision("artifact", "artifact");
  const dep = graphRevision("obligation", "dep", { parent: revisionRef(goal), policy: revisionRef(policy) });
  const ob = graphRevision("obligation", "ob", {
    parent: revisionRef(goal), policy: revisionRef(policy), dependencies: [revisionRef(dep)],
  });
  return { s, goal, policy, artifact, dep, ob };
}
type GraphFixture = ReturnType<typeof graphFixture>;
function graphSnapshot(f: GraphFixture, patch: Partial<Omit<WorkSnapshot, "digest">> = {}, eventId = "graph:snapshot") {
  return buildWorkSnapshotEvent({ eventId, now, snapshot: {
    snapshotId: "selected", scope: revisionRef(f.s),
    revisions: [f.goal, f.policy, f.artifact, f.dep, f.ob].map(revisionRef),
    bindings: [f.dep, f.ob].map(ob => ({ intent: revisionRef(f.goal), obligation: revisionRef(ob),
      artifact: revisionRef(f.artifact), policy: revisionRef(f.policy) })), ...patch,
  } });
}
const selection = (snapshot: ReturnType<typeof graphSnapshot>) => ({
  snapshot: { id: snapshot.payload.snapshot.snapshotId, digest: snapshot.payload.snapshot.digest }, event: eventRef(snapshot),
});
const graphText = (f: GraphFixture, snapshot = graphSnapshot(f), extra: readonly Event[] = []) => text([...Object.values(f), snapshot, ...extra]);
const problemCodes = (result: ReturnType<typeof resolveWorkSnapshotText>) => result.problems.map(p => p.code);

test("work-v4 exact snapshot selection resolves real structure without inventing public acceptance", () => {
  const f = graphFixture(), snap = graphSnapshot(f), selected = selection(snap);
  const result = resolveWorkSnapshotText(graphText(f), selected);
  assert.deepEqual(Object.keys(result).sort(), ["conflicts", "errors", "obligations", "problems", "revisions", "scope", "scopeState", "selectedSnapshot", "snapshot"]);
  assert.equal(result.scopeState, "valid");
  assert.deepEqual(result.selectedSnapshot, selected.snapshot);
  assert.deepEqual(result.scope, f.s.payload.revision);
  assert.deepEqual(result.snapshot, snap.payload.snapshot);
  assert.equal(result.revisions.length, 5);
  assert.equal(result.obligations.length, 2);
  assert.deepEqual(result.problems, []); assert.deepEqual(result.conflicts, []); assert.deepEqual(result.errors, []);
  for (const row of result.obligations) {
    assert.deepEqual(row.artifact, f.artifact.payload.revision);
    assert.equal(row.revision.digest, row.binding.obligation.digest);
    assert.deepEqual(row.problems, []);
  }
  for (const deliveries of [Object.values(f), Object.values(f).reverse()]) {
    assert.deepEqual(resolveWorkSnapshotText(text([snap, ...deliveries, snap, ...deliveries]), selected), result);
  }
  assertDeepFrozen(result);
  selected.snapshot.id = "changed";
  assert.equal(result.selectedSnapshot?.id, "selected");
  assert.equal(resolveWorkSnapshotText(graphText(f)).scopeState, "unselected");
  assert.deepEqual(resolveWorkSnapshotText(graphText(f)).obligations, []);
  assert.equal(resolveWorkSnapshotText(graphText(f), { ...selection(snap), event: { eventId: "absent", digest } }).scopeState, "unresolved");
  assert.equal(resolveWorkSnapshotText(graphText(f), { ...selection(snap), snapshot: { id: "wrong", digest } }).scopeState, "invalid");
});

test("work-v4 snapshot forks require an exact selector and readable predecessors, never latest head", () => {
  const f = graphFixture(), old = f.ob;
  const { digest: _, ...body } = old.payload.revision;
  const successor = (eventId: string, content: string) => buildWorkRevisionEvent({ eventId, now, revision: {
    ...structuredClone(body), revision: 2, predecessor: revisionRef(old), contentDigest: content,
  } } as Parameters<typeof buildWorkRevisionEvent>[0]);
  const a = successor("fork:a", "b".repeat(64)), b = successor("fork:b", "c".repeat(64));
  const fa = { ...f, ob: a }, fb = { ...f, ob: b };
  const sa = graphSnapshot(fa, {}, "snapshot:a"), sb = graphSnapshot(fb, {}, "snapshot:b");
  const all = text([...Object.values(f), a, b, sa, sb]);
  for (const [snap, expected] of [[sa, a], [sb, b]] as const) {
    const result = resolveWorkSnapshotText(all, selection(snap));
    assert.equal(result.scopeState, "valid");
    assert.equal(result.obligations.find(r => r.revision.id === "ob")?.revision.digest, expected.payload.revision.digest);
  }
  const absent = graphText(fa, sa, [b, sb]);
  const before = resolveWorkSnapshotText(absent, selection(sa));
  assert.equal(before.scopeState, "unresolved"); assert.deepEqual(before.obligations, []);
  assert.ok(before.problems.some(p => p.code === "REFERENCE_MISSING" && p.reference?.type === "revision" && p.reference.ref.digest === old.payload.revision.digest));
  const retained = JSON.stringify(before);
  assert.equal(resolveWorkSnapshotText(absent + text([old]), selection(sa)).scopeState, "valid");
  assert.equal(JSON.stringify(before), retained);
  const duplicated = graphSnapshot(fa, { revisions: [...sa.payload.snapshot.revisions, revisionRef(b)] } as Partial<WorkSnapshot>);
  const invalid = resolveWorkSnapshotText(text([...Object.values(f), a, b, duplicated]), selection(duplicated));
  assert.equal(invalid.scopeState, "invalid"); assert.deepEqual(invalid.obligations, []);
  assert.ok(problemCodes(invalid).includes("REVISION_INVALID"));
});

test("work-v4 graph distinguishes missing ancestors from cross-scope and predecessor contradictions", () => {
  const f = graphFixture(), snap = graphSnapshot(f);
  const withoutGoal = text([f.s, f.policy, f.artifact, f.dep, f.ob, snap]);
  const missing = resolveWorkSnapshotText(withoutGoal, selection(snap));
  assert.equal(missing.scopeState, "unresolved");
  assert.ok(problemCodes(missing).includes("REFERENCE_MISSING"));
  assert.equal(resolveWorkSnapshotText(withoutGoal + text([f.goal]), selection(snap)).scopeState, "valid");
  const foreign = scope("foreign", "scope:foreign");
  const crossedGoal = graphRevision("goal", "goal", { parent: revisionRef(foreign) });
  const cross = { ...f, goal: crossedGoal,
    dep: graphRevision("obligation", "dep", { parent: revisionRef(crossedGoal), policy: revisionRef(f.policy) }),
    ob: graphRevision("obligation", "ob", { parent: revisionRef(crossedGoal), policy: revisionRef(f.policy) }),
  };
  const cs = graphSnapshot(cross);
  assert.equal(resolveWorkSnapshotText(graphText(cross, cs, [foreign]), selection(cs)).scopeState, "invalid");
  assert.equal(resolveWorkSnapshotText(graphText(cross, cs), selection(cs)).scopeState, "invalid",
    "a scope reference names its scope identity even when that contradictory scope record is absent");
  const prior = graphRevision("obligation", "ob", { scopeId: "scope:foreign", parent: revisionRef(crossedGoal), policy: revisionRef(f.policy) });
  const { digest: _, ...body } = f.ob.payload.revision;
  const badSuccessor = graphRevision("obligation", "ob", { ...structuredClone(body), revision: 2, predecessor: revisionRef(prior) } as Partial<WorkRevision>);
  const pf = { ...f, ob: badSuccessor }, ps = graphSnapshot(pf);
  const invalid = resolveWorkSnapshotText(graphText(pf, ps, [prior]), selection(ps));
  assert.equal(invalid.scopeState, "invalid"); assert.ok(problemCodes(invalid).includes("REVISION_INVALID"));
});

test("work-v4 selected dependencies and self-edges cannot be dropped to retain a denominator", () => {
  const f = graphFixture();
  const { digest: _, ...depBody } = f.dep.payload.revision;
  const dep2 = buildWorkRevisionEvent({ eventId: "dep:2", now, revision: {
    ...structuredClone(depBody), revision: 2, predecessor: revisionRef(f.dep),
  } } as Parameters<typeof buildWorkRevisionEvent>[0]);
  const next = { ...f, dep: dep2 }, snap = graphSnapshot(next);
  const wrong = resolveWorkSnapshotText(graphText(next, snap, [f.dep]), selection(snap));
  assert.equal(wrong.scopeState, "invalid"); assert.ok(problemCodes(wrong).includes("DEPENDENCY_INVALID"));
  assert.deepEqual(wrong.obligations, []);
  const self = graphRevision("obligation", "ob", { parent: revisionRef(f.goal), policy: revisionRef(f.policy),
    dependencies: [revisionRef(f.ob)], revision: 2, predecessor: revisionRef(f.ob) });
  const sf = { ...f, ob: self }, ss = graphSnapshot(sf);
  assert.ok(problemCodes(resolveWorkSnapshotText(graphText(sf, ss, [f.ob]), selection(ss))).includes("CYCLE"));
  const parentSelf = graphRevision("goal", "goal", { parent: revisionRef(f.goal), revision: 2, predecessor: revisionRef(f.goal) });
  const gs = graphSnapshot(f, { revisions: [revisionRef(parentSelf), revisionRef(f.policy)] , bindings: [] });
  const parentResult = resolveWorkSnapshotText(text([f.s, f.goal, f.policy, parentSelf, gs]), selection(gs));
  assert.equal(parentResult.scopeState, "invalid"); assert.ok(problemCodes(parentResult).includes("CYCLE"));
});

test("work-v4 snapshot bindings enforce selected ancestry, exact policy and artifact inventory", () => {
  const f = graphFixture(), base = graphSnapshot(f);
  const bindings = structuredClone(base.payload.snapshot.bindings) as WorkSnapshot["bindings"];
  const cases: Array<Partial<Omit<WorkSnapshot, "digest">>> = [
    { bindings: bindings.slice(1) },
    { bindings: [...bindings, { ...bindings[0], obligation: { ...ref("obligation"), id: "unselected" } }] },
    { bindings: bindings.map(b => ({ ...b, policy: { ...ref("policy"), id: "wrong" } })) },
    { revisions: base.payload.snapshot.revisions.filter(r => r.kind !== "artifact") as RevisionRef[] },
  ];
  for (const patch of cases) {
    const snap = graphSnapshot(f, patch);
    const result = resolveWorkSnapshotText(graphText(f, snap), selection(snap));
    assert.equal(result.scopeState, "invalid"); assert.deepEqual(result.obligations, []);
  }
  const other = graphRevision("goal", "other", { parent: revisionRef(f.s) });
  const badIntent = graphSnapshot(f, { revisions: [...base.payload.snapshot.revisions, revisionRef(other)] as RevisionRef[],
    bindings: bindings.map(b => ({ ...b, intent: revisionRef(other) })) });
  assert.equal(resolveWorkSnapshotText(graphText(f, badIntent, [other]), selection(badIntent)).scopeState, "invalid");
  const noBytesRecord = text([f.s, f.goal, f.policy, f.dep, f.ob, base]);
  const missingArtifact = resolveWorkSnapshotText(noBytesRecord, selection(base));
  assert.equal(missingArtifact.scopeState, "valid"); assert.equal(missingArtifact.obligations.length, 2);
  for (const row of missingArtifact.obligations) { assert.equal(row.artifact, null); assert.ok(row.problems.some(p => p.code === "REFERENCE_MISSING")); }
  const unselected = graphSnapshot(f, { bindings: bindings.map(b => ({ ...b, artifact: null })) });
  const result = resolveWorkSnapshotText(graphText(f, unselected), selection(unselected));
  assert.equal(result.scopeState, "valid"); assert.equal(result.obligations.length, 2);
  assert.deepEqual(result.problems, []);
});

test("work-v4 structural conflict reachability includes all alternatives and quarantined redeliveries", () => {
  const f = graphFixture(), snap = graphSnapshot(f);
  const conflicting = buildWorkRevisionEvent({ eventId: f.goal.eventId, now, revision: {
    kind: "scope", id: "elsewhere", scopeId: "elsewhere", revision: 1, predecessor: null, parent: null,
    dependencies: [], ownerId: "owner", permittedEffects: [], policy: null, contentDigest: digest,
  } });
  const { digest: _, ...goalBody } = f.goal.payload.revision;
  const alias = buildWorkRevisionEvent({ eventId: "alias:goal", now, revision: structuredClone(goalBody) } as Parameters<typeof buildWorkRevisionEvent>[0]);
  const expected = resolveWorkSnapshotText(graphText(f, snap, [conflicting, alias]), selection(snap));
  assert.equal(expected.scopeState, "unresolved"); assert.deepEqual(expected.obligations, []);
  assert.ok(problemCodes(expected).includes("EVENT_CONFLICT"));
  const conflict = expected.conflicts.find(c => c.id === f.goal.eventId)!;
  assert.deepEqual(conflict.digests, [f.goal.digest, conflicting.digest].sort());
  assert.deepEqual(conflict.affectedObligations.map(r => r.id).sort(), ["dep", "ob"]);
  for (const order of permutations([f.goal, conflicting, alias])) {
    const events = [f.s, f.policy, f.artifact, f.dep, f.ob, snap, ...order, ...order];
    assert.deepEqual(resolveWorkSnapshotText(text(events), selection(snap)), expected);
  }
  const disconnected = [scope("outside", "one"), scope("outside", "two")];
  const healthy = resolveWorkSnapshotText(graphText(f, snap, disconnected), selection(snap));
  assert.equal(healthy.scopeState, "valid"); assert.equal(healthy.obligations.length, 2);
  assert.deepEqual(healthy.conflicts[0].affectedObligations, []);
  const many = Array.from({ length: 300 }, (_, i) => scope("outside", "one", digest, new Date(now.getTime() + i)));
  const manyResult = resolveWorkSnapshotText(graphText(f, snap, many), selection(snap));
  assert.equal(manyResult.scopeState, "valid");
  assert.deepEqual(manyResult.conflicts[0].digests, many.map(e => e.digest).sort());
  const otherSnapshot = graphSnapshot(f, { snapshotId: "other" });
  const disputed = resolveWorkSnapshotText(graphText(f, snap, [otherSnapshot]), selection(snap));
  assert.equal(disputed.scopeState, "unresolved"); assert.deepEqual(disputed.obligations, []);
  assert.deepEqual(disputed.conflicts.find(c => c.id === snap.eventId)?.affectedObligations.map(r => r.id).sort(), ["dep", "ob"]);
});

test("work-v4 readable unselected ancestors and long scope history do not become implicit selection", () => {
  const f = graphFixture();
  const node = graphRevision("node", "node", { parent: revisionRef(f.goal) });
  const next = { ...f, goal: node,
    dep: graphRevision("obligation", "dep", { parent: revisionRef(node), policy: revisionRef(f.policy) }),
    ob: graphRevision("obligation", "ob", { parent: revisionRef(node), policy: revisionRef(f.policy) }),
  };
  const snap = graphSnapshot(next);
  const before = resolveWorkSnapshotText(graphText(next, snap), selection(snap));
  assert.equal(before.scopeState, "unresolved");
  const resolved = resolveWorkSnapshotText(graphText(next, snap, [f.goal]), selection(snap));
  assert.equal(resolved.scopeState, "valid");
  assert.equal(resolved.revisions.some(r => r.digest === f.goal.payload.revision.digest), false);
  const history = [scope("scope:0")];
  for (let i = 1; i < 500; i++) {
    const prior = history[i - 1], { digest: _, ...body } = prior.payload.revision;
    history.push(buildWorkRevisionEvent({ eventId: `scope:${i}`, now, revision: {
      ...structuredClone(body), revision: i + 1, predecessor: revisionRef(prior),
    } } as Parameters<typeof buildWorkRevisionEvent>[0]));
  }
  const emptySnapshot = buildWorkSnapshotEvent({ eventId: "empty", now, snapshot: {
    snapshotId: "empty", scope: revisionRef(history[history.length - 1]), revisions: [], bindings: [],
  } });
  const empty = resolveWorkSnapshotText(text([...history, emptySnapshot]), selection(emptySnapshot));
  assert.equal(empty.scopeState, "valid"); assert.deepEqual(empty.obligations, []); assert.deepEqual(empty.revisions, []);
  assert.deepEqual(empty.problems, []);
});

test("work-v4 selection remains fail-closed on malformed text and hostile selector objects", () => {
  const f = graphFixture(), snap = graphSnapshot(f);
  const incomplete = resolveWorkSnapshotText(graphText(f) + "{broken", selection(snap));
  assert.equal(incomplete.scopeState, "unresolved"); assert.deepEqual(incomplete.obligations, []);
  assert.deepEqual(incomplete.selectedSnapshot, selection(snap).snapshot);
  assert.ok(problemCodes(incomplete).includes("INPUT_INCOMPLETE"));
  let called = false;
  for (const invalid of [{}, { ...selection(snap), extra: true },
    Object.defineProperty({}, "snapshot", { enumerable: true, get() { called = true; return selection(snap).snapshot; } })]) {
    const result = resolveWorkSnapshotText(graphText(f), invalid as never);
    assert.equal(result.scopeState, "unresolved"); assert.equal(result.selectedSnapshot, null);
    assert.deepEqual(result.errors, [{ line: null, code: "WORK_CONTEXT_INVALID" }]);
    assert.ok(problemCodes(result).includes("INPUT_INCOMPLETE"));
  }
  assert.equal(called, false);
});

// Public authority/selection integration. These tests have no filesystem/child/cleanup side effects.
const publicKeys = ["selectedSnapshot", "authoritySnapshot", "scopeState", "progress", "obligations", "claims",
  "supersededClaims", "conflicts", "problems", "errors", "runtime"].sort();
const publicCodes = (r: ReturnType<typeof projectWorkLedger>) => r.problems.map(p => p.code);
const publicClaim = (id: string, patch: Partial<ReturnType<typeof walkingFixture>["claim"]["payload"]["binding"]> = {}) => {
  const f = walkingFixture();
  return buildWorkAcceptanceEvent({ eventId: id, now, payload: { authorityId: "fixture-controller",
    binding: { ...mutableFixture(f.claim.payload.binding), ...mutableFixture(patch) },
  } });
};

test("public work-v4 projection fails closed with exact shapes and no implicit selector or trust", () => {
  const f = walkingFixture(), ctx = fixtureAuthority(), input = fixtureText(f.events);
  const unselected = projectWorkLedger(input);
  assert.deepEqual(Object.keys(unselected).sort(), publicKeys);
  assert.deepEqual(unselected, { selectedSnapshot: null, authoritySnapshot: null, scopeState: "unselected", progress: null,
    obligations: [], claims: [], supersededClaims: 0, conflicts: [], errors: [], runtime: null,
    problems: [{ code: "NO_SELECTION", reference: null, affectedObligations: [] }] });
  const absent = projectWorkLedger(input, { ...ctx, authority: null });
  assert.equal(absent.scopeState, "valid"); assert.deepEqual(absent.progress, { accepted: 0, total: 1 });
  assert.equal(absent.obligations[0].acceptance, "unresolved");
  assert.equal(absent.claims[0].applicability, "unresolved");
  assert.equal(absent.obligations[0].artifactCoverage.state, "unknown");
  assert.ok(publicCodes(absent).includes("AUTHORITY_MISSING"));
  const incomplete = projectWorkLedger(input + "{broken", ctx);
  assert.equal(incomplete.scopeState, "unresolved"); assert.equal(incomplete.progress, null); assert.equal(incomplete.runtime, null);
  assert.deepEqual(incomplete.obligations, []); assert.deepEqual(incomplete.claims, []);
  assert.deepEqual(incomplete.selectedSnapshot, ctx.selectedSnapshot!.snapshot);
  assert.deepEqual(incomplete.authoritySnapshot, ctx.authority!.snapshot);
  assert.deepEqual(incomplete.errors, [{ line: 9, code: "WORK_JSON_INVALID" }]);
  let getter = false;
  for (const invalid of [null, {}, { ...ctx, extra: true }, { ...ctx, authority: { ...ctx.authority, callback() {} } },
    Object.defineProperty({}, "authority", { enumerable: true, get() { getter = true; return ctx.authority; } })]) {
    const result = projectWorkLedger(input + "{broken", invalid as never);
    assert.equal(result.scopeState, "unresolved"); assert.equal(result.progress, null); assert.equal(result.runtime, null);
    assert.equal(result.selectedSnapshot, null); assert.equal(result.authoritySnapshot, null);
    assert.deepEqual(result.errors, [{ line: 9, code: "WORK_JSON_INVALID" }, { line: null, code: "WORK_CONTEXT_INVALID" }]);
    assert.deepEqual(result.claims, []); assert.ok(publicCodes(result).includes("INPUT_INCOMPLETE"));
  }
  assert.equal(getter, false);
  const missing = projectWorkLedger(fixtureText(f.events.filter(e => e !== f.intent)), ctx);
  assert.equal(missing.scopeState, "unresolved"); assert.equal(missing.runtime, null); assert.equal(missing.progress, null);
  const wrongSelector = fixtureAuthority(); wrongSelector.selectedSnapshot!.snapshot.id = "wrong";
  const invalidScope = projectWorkLedger(input, wrongSelector);
  assert.equal(invalidScope.scopeState, "invalid"); assert.equal(invalidScope.progress, null); assert.equal(invalidScope.runtime, null);
  assert.deepEqual(invalidScope.obligations, []); assert.deepEqual(invalidScope.claims, []); assert.deepEqual(invalidScope.errors, []);
  const emptySnapshot = buildWorkSnapshotEvent({ eventId: "empty-public", now, snapshot: {
    snapshotId: "empty-public", scope: fixtureRevisionRef(f.scope), revisions: [], bindings: [],
  } });
  const zero = projectWorkLedger(fixtureText([f.scope, emptySnapshot]), { selectedSnapshot: {
    snapshot: { id: "empty-public", digest: emptySnapshot.payload.snapshot.digest }, event: fixtureEventRef(emptySnapshot),
  }, authority: null });
  assert.deepEqual(zero.progress, { accepted: 0, total: 0 }); assert.deepEqual(zero.problems, []);
  assert.deepEqual(zero.runtime, { counts: { attempts: 0, variants: 0, observedCompletedAttempts: 0 }, occurrences: [], attempts: [] });
});

test("public fixture authority accepts exact evidence once and returns a real frozen WorkAttempt", () => {
  const f = walkingFixture(), ctx = fixtureAuthority();
  const result = projectWorkLedger(fixtureText(f.events), ctx);
  assert.deepEqual(Object.keys(result).sort(), publicKeys);
  assert.deepEqual(result.progress, { accepted: 1, total: 1 }); assert.equal(result.scopeState, "valid");
  assert.deepEqual(result.problems, []); assert.deepEqual(result.errors, []); assert.deepEqual(result.conflicts, []);
  assert.equal(result.supersededClaims, 0); assert.equal(result.obligations[0].acceptance, "accepted-under-supplied-authority");
  assert.deepEqual(result.claims, [{ claim: fixtureEventRef(f.claim), obligation: fixtureRevisionRef(f.obligation),
    applicability: "accepted-under-supplied-authority", matchedReceiptIds: ["receipt:a"], problems: [] }]);
  const row = result.obligations[0];
  assert.deepEqual(Object.keys(row).sort(), ["binding", "acceptance", "artifactCoverage", "evidenceCoverage", "claims", "problems"].sort());
  assert.deepEqual(row.artifactCoverage, { state: "available", items: [{ kind: "artifact", identity: { id: "artifact", digest }, state: "available" }] });
  assert.deepEqual(row.evidenceCoverage, { state: "available", items: [{ kind: "evidence", identity: { id: "fixture:evidence", digest }, state: "available" }] });
  assert.deepEqual(result.runtime, {
    counts: { attempts: 1, variants: 1, observedCompletedAttempts: 1 },
    occurrences: [{ event: fixtureEventRef(f.occurrence), payload: f.occurrence.payload }],
    attempts: [{ executionId: fixtureExecution, bindings: [{ scope: fixtureRevisionRef(f.scope), obligation: fixtureRevisionRef(f.obligation),
      variantIds: ["variant:a"], artifacts: [fixtureRevisionRef(f.artifact)] }], parentExecutionId: null, childId: "d0.1",
      declaredLabels: [], observedLabels: [f.occurrence.payload.labels], effectiveLabels: f.occurrence.payload.labels,
      state: "completed", resolution: "resolved", problems: [] }],
  });
  assertDeepFrozen(result);
  const saved = JSON.stringify(result);
  for (const events of [f.events.slice().reverse(), [...f.events, ...f.events]]) {
    const reordered = fixtureAuthority(); reordered.authority!.decisions.push(structuredClone(reordered.authority!.decisions[0]));
    reordered.authority!.availability.reverse();
    assert.deepEqual(projectWorkLedger(fixtureText(events), reordered), result);
  }
  ctx.authority!.decisions[0].decision = "reject"; ctx.authority!.availability[0].available = false;
  ctx.selectedSnapshot!.snapshot.id = "changed";
  assert.equal(JSON.stringify(result), saved);
  const noRuntime = projectWorkLedger(fixtureText(f.events.filter(e => e.event !== "work_occurrence" && e.event !== "work_acceptance")), fixtureAuthority());
  assert.deepEqual(noRuntime.runtime, { counts: { attempts: 0, variants: 0, observedCompletedAttempts: 0 }, occurrences: [], attempts: [] });
  assert.deepEqual(noRuntime.progress, { accepted: 0, total: 1 }); assert.equal(noRuntime.obligations[0].acceptance, "unaccepted");
});

test("mixed exact claims use deterministic obligation precedence", () => {
  const f = walkingFixture(), sibling = publicClaim("sibling", { evidence: [{ id: "unsupported", digest, event: null }] });
  const ctx = fixtureAuthority(), events = [...f.events, sibling];
  const result = projectWorkLedger(fixtureText(events), ctx);
  assert.deepEqual(result.progress, { accepted: 1, total: 1 }); assert.deepEqual(result.obligations[0].problems, []);
  assert.equal(result.obligations[0].evidenceCoverage.state, "unknown"); assert.equal(result.obligations[0].artifactCoverage.state, "available");
  assert.equal(result.claims.find(c => c.claim.eventId === sibling.eventId)!.applicability, "unresolved");
  assert.ok(result.claims.find(c => c.claim.eventId === sibling.eventId)!.problems.some(p => p.code === "RECEIPT_MISSING"));
  assert.equal(result.supersededClaims, 0); assert.deepEqual(result.conflicts, []);
  assert.deepEqual(projectWorkLedger(fixtureText([...events].reverse().concat(events)), ctx), result);
  const missingEvent = publicClaim("missing-event", { evidence: [{ id: "unsupported", digest, event: { eventId: "absent", digest } }] });
  assert.deepEqual(projectWorkLedger(fixtureText([...f.events, missingEvent]), ctx).progress, { accepted: 1, total: 1 });
  ctx.authority!.decisions[0].decision = "reject"; ctx.authority!.availability = [];
  const rejected = projectWorkLedger(fixtureText(events), ctx);
  assert.equal(rejected.obligations[0].acceptance, "unaccepted"); assert.deepEqual(rejected.progress, { accepted: 0, total: 1 });
  assert.equal(rejected.obligations[0].evidenceCoverage.state, "unknown");
  assert.ok(rejected.obligations[0].problems.some(p => p.code === "TRUSTED_REJECTION"));
});

test("wire authority and unavailable evidence cannot accept work", () => {
  const f = walkingFixture();
  for (const mutate of [
    (c: ReturnType<typeof fixtureAuthority>) => { c.authority!.decisions[0].authorityId = "forged"; },
    (c: ReturnType<typeof fixtureAuthority>) => { c.authority!.decisions[0].claim.digest = "c".repeat(64); },
    (c: ReturnType<typeof fixtureAuthority>) => { c.authority!.decisions[0].binding.policy.digest = "c".repeat(64); },
    (c: ReturnType<typeof fixtureAuthority>) => { c.authority!.decisions[0].binding.scope.digest = "c".repeat(64); },
    (c: ReturnType<typeof fixtureAuthority>) => { c.authority!.decisions[0].binding.intent.digest = "c".repeat(64); },
    (c: ReturnType<typeof fixtureAuthority>) => { c.authority!.decisions[0].binding.obligation.digest = "c".repeat(64); },
    (c: ReturnType<typeof fixtureAuthority>) => { c.authority!.decisions[0].binding.artifact.digest = "c".repeat(64); },
    (c: ReturnType<typeof fixtureAuthority>) => { c.authority!.decisions[0].binding.artifactDigest = "c".repeat(64); },
    (c: ReturnType<typeof fixtureAuthority>) => { c.authority!.decisions[0].binding.snapshot.id = "old"; },
    (c: ReturnType<typeof fixtureAuthority>) => { c.authority!.decisions[0].binding.evidence[0].digest = "c".repeat(64); },
    (c: ReturnType<typeof fixtureAuthority>) => { c.authority!.availability[0].available = false; },
    (c: ReturnType<typeof fixtureAuthority>) => { c.authority!.availability[1].available = false; },
    (c: ReturnType<typeof fixtureAuthority>) => { c.authority!.availability = []; },
  ]) {
    const ctx = fixtureAuthority(); mutate(ctx);
    const result = projectWorkLedger(fixtureText(f.events), ctx);
    assert.deepEqual(result.progress, { accepted: 0, total: 1 }); assert.equal(result.claims[0].applicability, "unresolved");
  }
  const wrong = publicClaim("wrong-bytes", { artifactDigest: "c".repeat(64) });
  const wrongContext = fixtureAuthority();
  wrongContext.authority!.decisions[0] = { ...wrongContext.authority!.decisions[0], claim: fixtureEventRef(wrong), binding: mutableFixture(wrong.payload.binding) };
  wrongContext.authority!.availability[0].digest = "c".repeat(64);
  const result = projectWorkLedger(fixtureText(f.events.filter(e => e !== f.claim).concat(wrong)), wrongContext);
  assert.deepEqual(result.progress, { accepted: 0, total: 1 }); assert.ok(publicCodes(result).includes("ARTIFACT_DIGEST_MISMATCH"));
  assert.equal(result.claims[0].applicability, "unresolved");
  assert.deepEqual(result.obligations[0].artifactCoverage.items[0].identity, { id: "artifact", digest });
  const missingArtifact = projectWorkLedger(fixtureText(f.events.filter(e => e !== f.artifact)), fixtureAuthority());
  assert.deepEqual(missingArtifact.progress, { accepted: 0, total: 1 }); assert.equal(missingArtifact.obligations[0].acceptance, "unresolved");
  assert.deepEqual(missingArtifact.obligations[0].artifactCoverage, { state: "unknown", items: [] });
  const forged = { ...f.claim, payload: { ...f.claim.payload, receipt: fixtureAuthority().authority!.decisions[0] } };
  assert.equal(projectWorkLedger(fixtureText([...f.events, forged as never]), fixtureAuthority()).progress, null);
});

test("contradictory trusted decisions have exact DECISION_CONFLICT diagnostics without invented receipt conflicts", () => {
  const f = walkingFixture(), ctx = fixtureAuthority();
  const reject = { ...structuredClone(ctx.authority!.decisions[0]), receiptId: "receipt:b", decision: "reject" as const };
  const expected = { code: "DECISION_CONFLICT", reference: { type: "revision", ref: fixtureRevisionRef(f.obligation) }, affectedObligations: [fixtureRevisionRef(f.obligation)] };
  ctx.authority!.decisions.push(reject, structuredClone(reject));
  const result = projectWorkLedger(fixtureText(f.events), ctx);
  assert.deepEqual(result.progress, { accepted: 0, total: 1 }); assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.problems, [expected]); assert.deepEqual(result.obligations[0].problems, [expected]);
  assert.deepEqual(result.claims[0].problems, [expected]); assert.equal(result.claims[0].applicability, "unresolved");
  assert.deepEqual(result.claims[0].matchedReceiptIds, ["receipt:a", "receipt:b"]);
  ctx.authority!.decisions.reverse(); assert.deepEqual(projectWorkLedger(fixtureText([...f.events].reverse()), ctx), result);
  ctx.authority!.decisions = [fixtureAuthority().authority!.decisions[0], { ...reject, authorityId: "mismatch" }];
  assert.deepEqual(projectWorkLedger(fixtureText(f.events), ctx).progress, { accepted: 1, total: 1 });
  ctx.authority!.decisions[1] = { ...reject, binding: { ...reject.binding, snapshot: { id: "old", digest } } };
  assert.deepEqual(projectWorkLedger(fixtureText(f.events), ctx).progress, { accepted: 1, total: 1 });
  const other = buildWorkAcceptanceEvent({ eventId: "other-authority", now,
    payload: { authorityId: "another-controller", binding: mutableFixture(f.claim.payload.binding) } });
  ctx.authority!.decisions[1] = { ...reject, authorityId: "another-controller", claim: fixtureEventRef(other), binding: mutableFixture(other.payload.binding) };
  const differentClaims = projectWorkLedger(fixtureText([...f.events, other]), ctx);
  assert.deepEqual(differentClaims.problems, [expected]); assert.equal(differentClaims.claims.length, 2);
});

test("genuine receipt and availability conflicts block only reachable current support", () => {
  const f = walkingFixture(), ctx = fixtureAuthority();
  ctx.authority!.decisions.push({ ...structuredClone(ctx.authority!.decisions[0]), decision: "reject" });
  const receipt = projectWorkLedger(fixtureText(f.events), ctx);
  assert.deepEqual(receipt.progress, { accepted: 0, total: 1 });
  assert.equal(receipt.conflicts.length, 1); assert.equal(receipt.conflicts[0].kind, "receipt");
  assert.equal(receipt.conflicts[0].id, "receipt:a"); assert.equal(receipt.conflicts[0].digests.length, 2);
  assert.deepEqual(receipt.conflicts[0].affectedObligations, [fixtureRevisionRef(f.obligation)]);
  assert.ok(publicCodes(receipt).includes("RECEIPT_CONFLICT")); assert.ok(!publicCodes(receipt).includes("DECISION_CONFLICT"));
  ctx.authority!.decisions[1].binding.snapshot.id = "bad-alternative";
  assert.deepEqual(projectWorkLedger(fixtureText(f.events), ctx).progress, { accepted: 0, total: 1 });
  const available = fixtureAuthority(); available.authority!.availability.push({ ...available.authority!.availability[1], available: false });
  const contradictory = projectWorkLedger(fixtureText(f.events), available);
  assert.deepEqual(contradictory.progress, { accepted: 0, total: 1 }); assert.deepEqual(contradictory.conflicts, []);
  assert.equal(contradictory.obligations[0].evidenceCoverage.state, "conflicted"); assert.ok(publicCodes(contradictory).includes("AVAILABILITY_CONFLICT"));
  const disconnected = fixtureAuthority();
  disconnected.authority!.decisions.push(...ctx.authority!.decisions.map(d => ({ ...d, receiptId: "outside", claim: { eventId: "outside", digest } })));
  disconnected.authority!.availability.push({ kind: "evidence", id: "outside", digest, available: true }, { kind: "evidence", id: "outside", digest, available: false });
  const healthy = projectWorkLedger(fixtureText(f.events), disconnected);
  assert.deepEqual(healthy.progress, { accepted: 1, total: 1 }); assert.equal(healthy.conflicts.length, 1);
  assert.deepEqual(healthy.conflicts[0].affectedObligations, []);
});

test("public projection preserves superseded history and requires fresh exact snapshot receipts", () => {
  const f = walkingFixture(), ctx = fixtureAuthority();
  const fresh = buildWorkSnapshotEvent({ eventId: "fresh-snapshot", now, snapshot: {
    snapshotId: "fresh", scope: fixtureRevisionRef(f.scope), revisions: mutableFixture(f.snapshot.payload.snapshot.revisions),
    bindings: mutableFixture(f.snapshot.payload.snapshot.bindings),
  } });
  const freshIdentity = { id: "fresh", digest: fresh.payload.snapshot.digest };
  ctx.selectedSnapshot = { snapshot: freshIdentity, event: fixtureEventRef(fresh) };
  const old = projectWorkLedger(fixtureText([...f.events, fresh]), ctx);
  assert.deepEqual(old.progress, { accepted: 0, total: 1 }); assert.equal(old.supersededClaims, 1);
  assert.equal(old.claims[0].applicability, "superseded"); assert.equal(old.obligations[0].acceptance, "unaccepted");
  const renewed = publicClaim("renewed", { snapshot: freshIdentity });
  const unsupported = projectWorkLedger(fixtureText([...f.events, fresh, renewed]), ctx);
  assert.deepEqual(unsupported.progress, { accepted: 0, total: 1 });
  // This explicit fixture declaration authorizes only the independently named renewed test claim.
  ctx.authority!.decisions.push({ ...ctx.authority!.decisions[0], receiptId: "renewed", claim: fixtureEventRef(renewed), binding: mutableFixture(renewed.payload.binding) });
  const result = projectWorkLedger(fixtureText([...f.events, fresh, renewed]), ctx);
  assert.deepEqual(result.progress, { accepted: 1, total: 1 }); assert.equal(result.supersededClaims, 1);
  assert.equal(old.claims[0].applicability, "superseded");
});

// Would fail if applicability ignored selected revisions/snapshots, receipt matching omitted the
// complete binding, or graph checks dropped missing history/duplicate selected entities. No runtime
// defect has been observed: this adds the missing Task 1 matrix, not a manufactured behavioral red.
test("selected revision changes require fresh acceptance receipts", async t => {
  const rebases: Record<FixtureRevisionChange, FixtureRevisionChange[]> = {
    scope: ["scope", "intent", "obligation"], intent: ["intent", "obligation"], obligation: ["obligation"],
    artifact: ["artifact"], policy: ["obligation", "policy"],
  };
  for (const primary of Object.keys(rebases) as FixtureRevisionChange[]) await t.test(primary, () => {
    const f = revisionRevalidationFixture(primary), original = fixtureText(f.base.events);
    const baseline = projectWorkLedger(original, fixtureAuthority()), saved = JSON.stringify(baseline);
    assert.deepEqual(baseline.progress, { accepted: 1, total: 1 }); assert.equal(baseline.scopeState, "valid");
    assert.deepEqual(f.changes, rebases[primary]);
    for (const name of Object.keys(f.current) as FixtureRevisionChange[]) {
      const prior = f.base[name].payload.revision, next = f.current[name].payload.revision;
      assert.equal(next.kind, prior.kind); assert.equal(next.id, prior.id); assert.equal(next.scopeId, prior.scopeId);
      if (rebases[primary].includes(name)) {
        assert.equal(next.revision, 2); assert.deepEqual(next.predecessor, fixtureRevisionRef(f.base[name]));
        assert.notEqual(next.digest, prior.digest);
        assert.equal(next.contentDigest, name === primary ? "c".repeat(64) : prior.contentDigest);
      } else assert.deepEqual(f.current[name], f.base[name], "unchanged revisions are not fictitiously renewed");
    }
    assert.deepEqual(f.current.intent.payload.revision.parent, fixtureRevisionRef(f.current.scope));
    assert.deepEqual(f.current.obligation.payload.revision.parent, fixtureRevisionRef(f.current.intent));
    assert.deepEqual(f.current.obligation.payload.revision.policy, fixtureRevisionRef(f.current.policy));
    const input = fixtureText(f.events), ctx = revisionRevalidationAuthority(primary);
    assert.deepEqual(parseWorkLedgerText(input), { complete: true, events: f.events, errors: [] });
    const selected = (events: readonly Event[], context = ctx) => {
      assert.equal(parseWorkLedgerText(fixtureText(events)).complete, true);
      const result = projectWorkLedger(fixtureText(events), context);
      assert.equal(result.scopeState, "valid"); assert.deepEqual(result.errors, []); assert.deepEqual(result.conflicts, []);
      assert.deepEqual(result.selectedSnapshot, ctx.selectedSnapshot!.snapshot);
      assert.deepEqual(result.obligations[0].binding, f.snapshot.payload.snapshot.bindings[0]);
      return result;
    };
    const row = (result: ReturnType<typeof projectWorkLedger>, event = f.claim) => {
      const found = result.claims.find(c => c.claim.eventId === event.eventId); assert.ok(found);
      assert.deepEqual(found.claim, fixtureEventRef(event)); return found;
    };
    const staleClaimOnly = selected(f.events.filter(e => e !== f.claim));
    assert.deepEqual(staleClaimOnly.progress, { accepted: 0, total: 1 });
    assert.equal(staleClaimOnly.supersededClaims, 1); assert.equal(row(staleClaimOnly, f.base.claim).applicability, "superseded");
    assert.equal(staleClaimOnly.obligations[0].acceptance, "unaccepted");
    // Availability is complete in receipt-only negatives, so missing bytes cannot mask a match bug.
    const negatives: Array<[string, (c: ReturnType<typeof revisionRevalidationAuthority>) => void, string]> = [
      ["no receipts", c => { c.authority!.decisions = []; }, "RECEIPT_MISSING"],
      ["old receipt only", c => { c.authority!.decisions.pop(); }, "RECEIPT_MISSING"],
      ["old primary revision in otherwise fresh receipt", c => { c.authority!.decisions[1].binding[primary] = mutableFixture(f.base.claim.payload.binding[primary]); }, "RECEIPT_MISMATCH"],
      ["old snapshot in otherwise fresh receipt", c => { c.authority!.decisions[1].binding.snapshot = mutableFixture(f.base.claim.payload.binding.snapshot); }, "RECEIPT_MISMATCH"],
      ["wrong claim digest", c => { c.authority!.decisions[1].claim.digest = f.base.claim.digest; }, "RECEIPT_MISMATCH"],
      ["wrong authority", c => { c.authority!.decisions[1].authorityId = "not-the-fixture-controller"; }, "RECEIPT_MISMATCH"],
      ["old evidence binding", c => { c.authority!.decisions[1].binding.evidence = mutableFixture(f.base.claim.payload.binding.evidence); }, "RECEIPT_MISMATCH"],
    ];
    for (const [label, alter, code] of negatives) {
      const bad = revisionRevalidationAuthority(primary); alter(bad);
      const result = selected(f.events, bad), current = row(result);
      assert.deepEqual(result.progress, { accepted: 0, total: 1 }, label);
      assert.equal(result.obligations[0].acceptance, "unresolved", label);
      assert.equal(result.obligations[0].artifactCoverage.state, "available", label);
      assert.equal(result.obligations[0].evidenceCoverage.state, "available", label);
      assert.equal(current.applicability, "unresolved", label); assert.deepEqual(current.matchedReceiptIds, [], label);
      assert.deepEqual(current.problems.map(p => p.code), [code], label);
      assert.equal(row(result, f.base.claim).applicability, "superseded");
    }
    const noAuthority = selected(f.events, { ...ctx, authority: null });
    assert.deepEqual(noAuthority.progress, { accepted: 0, total: 1 }); assert.equal(row(noAuthority).applicability, "unresolved");
    assert.ok(row(noAuthority).problems.some(p => p.code === "AUTHORITY_MISSING"));
    if (primary === "artifact") {
      const oldBytesOnly = revisionRevalidationAuthority(primary);
      oldBytesOnly.authority!.availability = oldBytesOnly.authority!.availability.filter(a => a.kind !== "artifact" || a.digest === digest);
      const missingBytes = selected(f.events, oldBytesOnly);
      assert.deepEqual(missingBytes.progress, { accepted: 0, total: 1 });
      assert.equal(missingBytes.obligations[0].artifactCoverage.state, "unknown");
      assert.deepEqual(row(missingBytes).matchedReceiptIds, ["receipt:revalidation:artifact"]);
      assert.deepEqual(row(missingBytes).problems.map(p => p.code), ["AVAILABILITY_MISSING"]);
    }
    const result = selected(f.events);
    assert.deepEqual(result.progress, { accepted: 1, total: 1 }); assert.equal(result.supersededClaims, 1);
    assert.equal(result.obligations[0].acceptance, "accepted-under-supplied-authority");
    assert.deepEqual(result.obligations[0].problems, []); assert.deepEqual(row(result).problems, []);
    assert.equal(row(result).applicability, "accepted-under-supplied-authority");
    assert.deepEqual(row(result).matchedReceiptIds, [`receipt:revalidation:${primary}`]);
    assert.equal(row(result, f.base.claim).applicability, "superseded");
    assert.deepEqual(row(result, f.base.claim).matchedReceiptIds, []);
    assertDeepFrozen(result); assert.deepEqual(selected([...f.events].reverse().concat(f.events)), result);
    const oldRejection = revisionRevalidationAuthority(primary); oldRejection.authority!.decisions[0].decision = "reject";
    assert.deepEqual(selected(f.events, oldRejection), result, "superseded receipt is not a current veto");
    // A fresh snapshot label alone must not launder an old primary tuple. This assertion directly
    // exercises each applicability comparison separately from receipt-body equality.
    const staleTuple = buildWorkAcceptanceEvent({ eventId: `revalidation:${primary}:stale-tuple`, now, payload: {
      authorityId: "fixture-controller", binding: { ...mutableFixture(f.claim.payload.binding),
        [primary]: mutableFixture(f.base.claim.payload.binding[primary]) },
    } });
    const unknownClaim = buildWorkAcceptanceEvent({ eventId: `revalidation:${primary}:not-authorized`, now,
      payload: mutableFixture(f.claim.payload) });
    const extraClaims = selected([...f.events, staleTuple, unknownClaim]);
    assert.deepEqual(extraClaims.progress, { accepted: 1, total: 1 }); assert.equal(extraClaims.supersededClaims, 2);
    assert.equal(row(extraClaims, staleTuple).applicability, "superseded");
    assert.deepEqual(row(extraClaims, staleTuple).matchedReceiptIds, []);
    assert.equal(row(extraClaims, unknownClaim).applicability, "unresolved");
    assert.deepEqual(row(extraClaims, unknownClaim).matchedReceiptIds, []);
    assert.deepEqual(row(extraClaims, unknownClaim).problems.map(p => p.code), ["RECEIPT_MISSING"]);
    assert.deepEqual(row(extraClaims), row(result), "fixed controller does not bless added input claims");
    const historical = projectWorkLedger(input, fixtureAuthority());
    assert.deepEqual(historical.progress, { accepted: 1, total: 1 });
    assert.deepEqual(row(historical, f.base.claim), baseline.claims[0]); assert.equal(row(historical).applicability, "superseded");
    assert.equal(projectWorkLedger(input).progress, null); assert.equal(projectWorkLedger(input).scopeState, "unselected");
    assert.equal(JSON.stringify(baseline), saved); assert.equal(fixtureText(f.base.events), original);
    assert.deepEqual(projectWorkLedger(original, fixtureAuthority()), baseline);
    // Later unselected fork and unrelated scope history do not elect a head or invalidate this selection.
    const { digest: _, ...forkBody } = mutableFixture(f.current[primary].payload.revision);
    const fork = buildWorkRevisionEvent({ eventId: `revalidation:${primary}:fork`, now: new Date(now.getTime() + 1),
      revision: { ...forkBody, contentDigest: "f".repeat(64) } });
    const outside = scope("revalidation:outside:1", "outside"), { digest: __, ...outsideBody } = mutableFixture(outside.payload.revision);
    const outside2 = buildWorkRevisionEvent({ eventId: "revalidation:outside:2", now, revision: {
      ...outsideBody, revision: 2, predecessor: revisionRef(outside), contentDigest: "f".repeat(64),
    } });
    assert.deepEqual(selected([...f.events, fork, outside, outside2]), result);
    // Required old predecessor and current parent cannot be silently dropped; late replay is pure.
    for (const missing of [f.base[primary], f.current.intent]) {
      const remaining = f.events.filter(e => e !== missing), missingText = fixtureText(remaining);
      assert.equal(parseWorkLedgerText(missingText).complete, true);
      const gap = projectWorkLedger(missingText, ctx), retained = JSON.stringify(gap);
      assert.equal(gap.scopeState, "unresolved"); assert.equal(gap.progress, null); assert.deepEqual(gap.obligations, []);
      assert.ok(gap.problems.some(p => p.code === "REFERENCE_MISSING" && p.reference?.type === "revision" &&
        p.reference.ref.digest === missing.payload.revision.digest));
      assert.deepEqual(selected([...remaining, missing]), result); assert.equal(JSON.stringify(gap), retained);
    }
    // Scope is a singleton outside inventory; in its case duplicate the necessarily rebased obligation.
    const duplicate = primary === "scope" ? "obligation" : primary;
    const ambiguous = buildWorkSnapshotEvent({ eventId: `revalidation:${primary}:ambiguous`, now, snapshot: {
      snapshotId: `revalidation:${primary}:ambiguous`, scope: fixtureRevisionRef(f.current.scope),
      revisions: [...mutableFixture(f.snapshot.payload.snapshot.revisions), fixtureRevisionRef(f.base[duplicate])],
      bindings: mutableFixture(f.snapshot.payload.snapshot.bindings),
    } });
    const ambiguousText = fixtureText([...f.events, ambiguous]); assert.equal(parseWorkLedgerText(ambiguousText).complete, true);
    const invalid = projectWorkLedger(ambiguousText, { ...ctx, selectedSnapshot: selection(ambiguous) });
    assert.equal(invalid.scopeState, "invalid"); assert.equal(invalid.progress, null);
    assert.ok(publicCodes(invalid).includes("REVISION_INVALID"));
    t.diagnostic(`${primary}: primary content changed; revision updates ${rebases[primary].join(",")}; fixed fixture authority only`);
  });
});

// Publicly constructible stable-entity loops are NOT exact-digest cyclic graphs. Keep that distinction
// explicit: self-entity edges get CYCLE; two-entity historical loops violate exact current selection.
test("work-v4 public cycle safeguards reject feasible stable-entity edges", () => {
  const f = walkingFixture();
  const next = (prior: WorkFrozen<WorkRevisionEvent>, eventId: string, patch: Partial<Omit<WorkRevision, "digest">>) => {
    const { digest: _, ...body } = mutableFixture(prior.payload.revision);
    return buildWorkRevisionEvent({ eventId, now, revision: { ...body, revision: 2, predecessor: revisionRef(prior), ...patch } });
  };
  const check = (intent: WorkFrozen<WorkRevisionEvent>, obligation: WorkFrozen<WorkRevisionEvent>, extra: WorkFrozen<WorkRevisionEvent>[], code: "CYCLE" | "REVISION_INVALID" | "DEPENDENCY_INVALID") => {
    const extraObligations = extra.filter(e => e.payload.revision.kind === "obligation");
    const snap = buildWorkSnapshotEvent({ eventId: "cycle:selection", now, snapshot: {
      snapshotId: "cycle:selection", scope: revisionRef(f.scope),
      revisions: [intent, obligation, f.policy, f.artifact, ...extra].map(revisionRef),
      bindings: [obligation, ...extraObligations].map(ob => ({ intent: revisionRef(intent), obligation: revisionRef(ob),
        policy: revisionRef(f.policy), artifact: revisionRef(f.artifact) })),
    } });
    const input = text([...f.events, intent, obligation, ...extra, snap]);
    assert.equal(parseWorkLedgerText(input).complete, true, "real nested and event digests validate");
    const result = projectWorkLedger(input, { selectedSnapshot: selection(snap), authority: null });
    assert.equal(result.scopeState, "invalid"); assert.equal(result.progress, null); assert.deepEqual(result.obligations, []);
    assert.deepEqual(result.errors, []); assert.ok(publicCodes(result).includes(code));
    assert.deepEqual(projectWorkLedger(text([...f.events, intent, obligation, ...extra, snap].reverse()),
      { selectedSnapshot: selection(snap), authority: null }), result);
  };
  const selfGoal = next(f.intent, "cycle:self-goal", { parent: revisionRef(f.intent) });
  check(selfGoal, next(f.obligation, "cycle:self-goal-ob", { parent: revisionRef(selfGoal) }), [], "CYCLE");
  check(f.intent, next(f.obligation, "cycle:self-dependency", { dependencies: [revisionRef(f.obligation)] }), [], "CYCLE");
  const { digest: _, ...goalBody } = mutableFixture(f.intent.payload.revision);
  const between = buildWorkRevisionEvent({ eventId: "cycle:between-goal", now, revision: {
    ...goalBody, id: "between-goal", parent: revisionRef(f.intent),
  } });
  const a2 = next(f.intent, "cycle:goal-a2", { parent: revisionRef(between) });
  check(a2, next(f.obligation, "cycle:goal-a2-ob", { parent: revisionRef(a2) }), [between], "REVISION_INVALID");
  const { digest: __, ...obBody } = mutableFixture(f.obligation.payload.revision);
  const b1 = buildWorkRevisionEvent({ eventId: "cycle:ob-b1", now, revision: {
    ...obBody, id: "other-obligation", dependencies: [revisionRef(f.obligation)],
  } });
  check(f.intent, next(f.obligation, "cycle:ob-a2", { dependencies: [revisionRef(b1)] }), [b1], "DEPENDENCY_INVALID");
  // Strictly decreasing predecessor numbers rule out a finite closed predecessor chain independent
  // of hash difficulty. Invalid same-number/forward edges are schema refusals, not valid cycle tests.
  for (const revision of [2, 3]) assert.throws(() => next(f.obligation, "cycle:bad-predecessor", {
    predecessor: { ...revisionRef(f.obligation), revision },
  }), (error: unknown) => error instanceof WorkInputError && error.code === "WORK_SCHEMA_INVALID");
});

// Integrated Task 1 replay: a previously accepted public observation is not an authority cache.
// Dropping complete-ID grouping, timestamp identity, decoded-member checking, or exact-body/payload
// alias quarantine would break the assertions below. No mutation execution or behavioral red claimed.
test("work-v4 replay quarantines conflicts before accepting selected work", async t => {
  const f = walkingFixture(), ctx = fixtureAuthority(), original = fixtureText(f.events);
  const healthy = projectWorkLedger(original, ctx), retained = JSON.stringify(healthy);
  assert.deepEqual(healthy.progress, { accepted: 1, total: 1 }); assertDeepFrozen(healthy);
  const replayText = (input: string) => {
    assert.equal(parseWorkLedgerText(input).complete, true, "all candidate bodies passed strict ingestion");
    const result = projectWorkLedger(input, ctx); assert.deepEqual(result.errors, []); return result;
  };
  const replay = (events: readonly Event[]) => replayText(fixtureText(events));
  const revisionDelivery = (source: WorkFrozen<WorkRevisionEvent>, eventId: string, at = now) => {
    const { digest: _, ...body } = mutableFixture(source.payload.revision);
    return buildWorkRevisionEvent({ eventId, now: at, revision: body });
  };
  const snapshotDelivery = (source: ReturnType<typeof buildWorkSnapshotEvent>, eventId: string) => {
    const { digest: _, ...body } = mutableFixture(source.payload.snapshot);
    return buildWorkSnapshotEvent({ eventId, now, snapshot: body });
  };
  const conflict = (alternatives: readonly Event[], affected = [fixtureRevisionRef(f.obligation)]) => ({
    kind: "event", id: alternatives[0].eventId, digests: alternatives.map(e => e.digest).sort(), affectedObligations: affected,
  });
  const unchangedHistory = () => {
    assert.equal(fixtureText(f.events), original); assert.equal(JSON.stringify(healthy), retained);
    assert.deepEqual(projectWorkLedger(original, fixtureAuthority()), healthy);
  };
  await t.test("semantic redelivery keeps the accepted observation", () => {
    const formatted = f.events.map(event => " \t" + JSON.stringify(Object.fromEntries(Object.entries(event).reverse()))
      .replaceAll('"revision":1', '"revision":10e-1').replace('"eventId":', '"\\u0065ventId":') + "\t");
    const differentBytes = formatted.join("\n") + "\n";
    const archival = (bytes: string) => createHash("sha256").update(bytes, "utf8").digest("hex");
    assert.notEqual(archival(original), archival(differentBytes));
    assert.deepEqual(parseWorkLedgerText(differentBytes), { events: f.events, errors: [], complete: true });
    assert.equal(parseWorkLedgerText(original + differentBytes).events.length, 16, "physical redeliveries remain in ingestion");
    for (const input of [differentBytes, [...formatted].reverse().join("\n"), original + differentBytes,
      fixtureText([...f.events].reverse().concat(f.events, f.events))]) {
      const result = replayText(input); assert.deepEqual(result, healthy); assert.equal(JSON.stringify(result), retained);
    }
    unchangedHistory();
  });
  await t.test("timestamp-only required evidence conflict and payload aliases", () => {
    const later = buildWorkOccurrenceEvent({ eventId: f.occurrence.eventId, now: new Date(now.getTime() + 1),
      payload: mutableFixture(f.occurrence.payload) });
    const alias = buildWorkOccurrenceEvent({ eventId: "replay:occurrence-alias", now: new Date(now.getTime() + 2),
      payload: mutableFixture(f.occurrence.payload) });
    assert.deepEqual(later.payload, f.occurrence.payload); assert.notEqual(later.digest, f.occurrence.digest);
    const cleanAlias = replay([...f.events, alias]);
    assert.deepEqual(cleanAlias.progress, { accepted: 1, total: 1 });
    assert.deepEqual(cleanAlias.runtime!.counts, healthy.runtime!.counts); assert.equal(cleanAlias.runtime!.occurrences.length, 2);
    const blocked = replayText(original + fixtureText([later])); // conflict is appended after an actual accepted observation
    assert.equal(blocked.scopeState, "valid"); assert.deepEqual(blocked.progress, { accepted: 0, total: 1 });
    assert.deepEqual(blocked.conflicts, [conflict([f.occurrence, later])]);
    assert.equal(blocked.obligations[0].acceptance, "unresolved"); assert.equal(blocked.claims[0].applicability, "unresolved");
    assert.deepEqual(blocked.claims[0].matchedReceiptIds, ["receipt:a"], "matched receipt is diagnostic, not a cached pass");
    assert.equal(blocked.obligations[0].artifactCoverage.state, "available"); assert.equal(blocked.obligations[0].evidenceCoverage.state, "available");
    assert.ok(blocked.claims[0].problems.every(p => p.code === "EVENT_CONFLICT"));
    assert.deepEqual(blocked.claims[0].problems.flatMap(p => p.reference?.type === "event" ? [p.reference.ref.digest] : []).sort(),
      [f.occurrence.digest, later.digest].sort());
    assert.deepEqual(blocked.runtime, { counts: { attempts: 0, variants: 0, observedCompletedAttempts: 0 }, occurrences: [], attempts: [] });
    for (const order of permutations([f.occurrence, later, alias])) {
      assert.deepEqual(replay([...f.events.filter(e => e !== f.occurrence), ...order, ...order]), blocked,
        "a clean ID/timestamp alias of the quarantined payload supplies neither execution facts nor acceptance");
    }
    unchangedHistory();
  });
  await t.test("timestamp-only selected revision conflict and revision aliases", () => {
    const later = revisionDelivery(f.intent, f.intent.eventId, new Date(now.getTime() + 1));
    const alias = revisionDelivery(f.intent, "replay:revision-alias", new Date(now.getTime() + 2));
    assert.equal(later.payload.revision.digest, f.intent.payload.revision.digest); assert.notEqual(later.digest, f.intent.digest);
    assert.deepEqual(replay([...f.events, alias]), healthy, "a clean distinct delivery is not a conflict");
    const blocked = replayText(original + fixtureText([later]));
    assert.equal(blocked.scopeState, "unresolved"); assert.equal(blocked.progress, null); assert.equal(blocked.runtime, null);
    assert.deepEqual(blocked.obligations, []); assert.deepEqual(blocked.claims, []);
    assert.deepEqual(blocked.conflicts, [conflict([f.intent, later])]);
    for (const order of permutations([f.intent, later, alias])) {
      assert.deepEqual(replay([...f.events.filter(e => e !== f.intent), ...order, ...order]), blocked);
    }
    unchangedHistory();
  });
  await t.test("all four alternatives are grouped before selected facts", () => {
    const shared = f.occurrence.eventId;
    const alternatives = [f.occurrence, revisionDelivery(f.intent, shared), snapshotDelivery(f.snapshot, shared),
      buildWorkAcceptanceEvent({ eventId: shared, now, payload: mutableFixture(f.claim.payload) })];
    assert.equal(new Set(alternatives.map(e => e.event)).size, 4); assert.equal(new Set(alternatives.map(e => e.digest)).size, 4);
    const alias = revisionDelivery(f.intent, "replay:mixed-revision-alias", new Date(now.getTime() + 3));
    const blocked = replayText(original + fixtureText(alternatives.slice(1)));
    assert.equal(blocked.scopeState, "unresolved"); assert.equal(blocked.progress, null); assert.equal(blocked.runtime, null);
    assert.deepEqual(blocked.obligations, []); assert.deepEqual(blocked.claims, []);
    assert.deepEqual(blocked.conflicts, [conflict(alternatives)]);
    assert.ok(blocked.problems.some(p => p.code === "EVENT_CONFLICT"));
    // Original selected intent is still delivered under its own clean ID. A selected revision body
    // in ANY mixed-ID alternative must nevertheless quarantine it; no first/last discriminator wins.
    for (const order of permutations(alternatives)) {
      assert.deepEqual(replay([...f.events.filter(e => e !== f.occurrence), ...order, alias, ...order]), blocked);
    }
    unchangedHistory();
  });
  await t.test("disconnected all-kind conflict stays local", () => {
    const outside = graphFixture(), snap = graphSnapshot(outside), shared = "replay:outside";
    const occurred = buildWorkOccurrenceEvent({ eventId: shared, now, payload: { ...mutableFixture(f.occurrence.payload),
      scope: revisionRef(outside.s), obligation: revisionRef(outside.ob), artifact: revisionRef(outside.artifact),
      executionId: "exec:00000000-0000-4000-8000-000000000002", childId: "d0.2",
    } });
    const declared = buildWorkAcceptanceEvent({ eventId: shared, now, payload: { authorityId: "untrusted-outside", binding: {
      snapshot: selection(snap).snapshot, scope: revisionRef(outside.s), intent: revisionRef(outside.goal),
      obligation: revisionRef(outside.ob), artifact: revisionRef(outside.artifact), artifactDigest: digest, policy: revisionRef(outside.policy),
      evidence: [{ id: "outside-evidence", digest, event: eventRef(occurred) }],
    } } });
    const alternatives = [revisionDelivery(outside.s, shared), snapshotDelivery(snap, shared), occurred, declared];
    const outsideFacts = [...Object.values(outside), snap];
    const cleanOutside = projectWorkLedger(text(outsideFacts), { selectedSnapshot: selection(snap), authority: null });
    assert.equal(cleanOutside.scopeState, "valid"); assert.deepEqual(cleanOutside.progress, { accepted: 0, total: 2 });
    const alias = revisionDelivery(outside.s, "replay:outside-alias");
    const expected = { ...healthy, conflicts: [conflict(alternatives, [])] };
    for (const order of permutations(alternatives)) {
      assert.deepEqual(replay([...f.events, ...outsideFacts, ...order, alias, ...order]), expected);
    }
    const selectOutside = projectWorkLedger(text([...f.events, ...outsideFacts, ...alternatives, alias]),
      { selectedSnapshot: selection(snap), authority: null });
    assert.equal(selectOutside.scopeState, "unresolved"); assert.equal(selectOutside.progress, null);
    assert.deepEqual(selectOutside.conflicts[0].affectedObligations.map(r => r.id).sort(), ["dep", "ob"]);
    unchangedHistory();
  });
  await t.test("malformed appended alternatives suppress facts without rewriting history", () => {
    const duplicate = JSON.stringify(f.claim).replace('"eventId":', '"\\u0065ventId":"hidden","eventId":');
    const wrongDigest = JSON.stringify({ ...f.claim, digest: "f".repeat(64) });
    const rounded = JSON.stringify(f.scope).replace('"revision":1', '"revision":1.00000000000000001');
    for (const [line, code] of [[duplicate, "WORK_DUPLICATE_MEMBER"], [wrongDigest, "WORK_DIGEST_MISMATCH"],
      [rounded, "WORK_SCHEMA_INVALID"]]) {
      const input = original + line + "\n", ingestion = parseWorkLedgerText(input), result = projectWorkLedger(input, ctx);
      assert.deepEqual(ingestion, { complete: false, events: f.events, errors: [{ line: 9, code }] });
      assert.deepEqual(result.errors, ingestion.errors); assert.equal(result.scopeState, "unresolved");
      assert.equal(result.progress, null); assert.equal(result.runtime, null); assert.deepEqual(result.obligations, []);
      assert.deepEqual(result.claims, []); assert.deepEqual(result.conflicts, [], "invalid input is not a validated conflict candidate");
      assert.ok(publicCodes(result).includes("INPUT_INCOMPLETE")); unchangedHistory();
    }
  });
});

test("public source conflicts use all alternatives and cannot launder required evidence", () => {
  const f = walkingFixture(), ctx = fixtureAuthority();
  const rival = buildWorkOccurrenceEvent({ eventId: f.occurrence.eventId, now, payload: { ...structuredClone(f.occurrence.payload), state: "failed" } });
  const blocked = projectWorkLedger(fixtureText([...f.events, rival]), ctx);
  assert.deepEqual(blocked.progress, { accepted: 0, total: 1 }); assert.ok(publicCodes(blocked).includes("EVENT_CONFLICT"));
  const conflict = blocked.conflicts.find(c => c.id === f.occurrence.eventId)!;
  assert.deepEqual(conflict.digests, [f.occurrence.digest, rival.digest].sort());
  assert.deepEqual(conflict.affectedObligations, [fixtureRevisionRef(f.obligation)]);
  assert.deepEqual(projectWorkLedger(fixtureText([...f.events, rival].reverse()), ctx), blocked);
  const alternativeClaim = publicClaim(f.claim.eventId, { evidence: [{ id: "unsupported", digest, event: null }] });
  const claimConflict = projectWorkLedger(fixtureText([...f.events, alternativeClaim]), ctx);
  assert.deepEqual(claimConflict.claims, []); assert.deepEqual(claimConflict.progress, { accepted: 0, total: 1 });
  const structuralAlternative = scope(f.intent.eventId, "outside");
  const { digest: _, ...goalBody } = f.intent.payload.revision;
  const alias = buildWorkRevisionEvent({ eventId: "alias-intent", now, revision: mutableFixture(goalBody) });
  const structural = projectWorkLedger(fixtureText([...f.events, structuralAlternative, alias]), ctx);
  assert.equal(structural.progress, null); assert.equal(structural.scopeState, "unresolved");
  const disconnected = projectWorkLedger(fixtureText([...f.events, scope("outside", "one"), scope("outside", "two")]), ctx);
  assert.deepEqual(disconnected.progress, { accepted: 1, total: 1 }); assert.deepEqual(disconnected.conflicts[0].affectedObligations, []);
});

test("public minimal occurrence fold uses global identity and only required evidence gates acceptance", () => {
  const f = walkingFixture(), ctx = fixtureAuthority();
  const unrelatedAssociation = buildWorkOccurrenceEvent({ eventId: "nonselected-association", now, payload: {
    ...structuredClone(f.occurrence.payload), scope: ref("scope"), obligation: ref("obligation"), childId: "different-child",
  } });
  const conflicted = projectWorkLedger(fixtureText([...f.events, unrelatedAssociation]), ctx);
  assert.equal(conflicted.runtime!.counts.attempts, 1); assert.equal(conflicted.runtime!.counts.observedCompletedAttempts, 0);
  assert.equal(conflicted.runtime!.occurrences.length, 2); assert.equal(conflicted.runtime!.attempts[0].bindings.length, 1);
  const attempt = conflicted.runtime!.attempts[0];
  assert.equal(attempt.state, "conflicted"); assert.equal(attempt.resolution, "unresolved");
  assert.equal(attempt.parentExecutionId, null); assert.equal(attempt.childId, null);
  assert.ok(Object.values(attempt.effectiveLabels).every(value => value === null));
  assert.deepEqual(conflicted.progress, { accepted: 0, total: 1 });
  const independent = publicClaim("independent", { evidence: [{ id: "independent", digest, event: null }] });
  const independentContext = fixtureAuthority(); independentContext.authority!.decisions = [{ ...independentContext.authority!.decisions[0],
    claim: fixtureEventRef(independent), binding: mutableFixture(independent.payload.binding) }];
  independentContext.authority!.availability.push({ kind: "evidence", id: "independent", digest, available: true });
  const healthy = projectWorkLedger(fixtureText([...f.events, unrelatedAssociation, independent]), independentContext);
  assert.deepEqual(healthy.progress, { accepted: 1, total: 1 }); assert.deepEqual(healthy.obligations[0].problems, []);
  assert.equal(healthy.runtime!.counts.observedCompletedAttempts, 0);
  const declaration = buildWorkOccurrenceEvent({ eventId: "declared", now, payload: {
    ...structuredClone(f.occurrence.payload), provenance: "declared", labels: { ...f.occurrence.payload.labels, modelId: "declared-model" },
  } });
  const declared = projectWorkLedger(fixtureText([...f.events, declaration]), fixtureAuthority());
  assert.equal(declared.runtime!.attempts[0].effectiveLabels.modelId, null);
  assert.equal(declared.runtime!.attempts[0].declaredLabels[0].modelId, "declared-model");
  assert.deepEqual(declared.progress, { accepted: 1, total: 1 });
});

// Independent canonical oracle for these closed, non-numeric-key result/receipt shapes.
function fixtureCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(fixtureCanonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${fixtureCanonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
test("public receipt diagnostics survive absent or unresolved selection and cover complete authority-scoped bodies", () => {
  const f = walkingFixture(), ctx = fixtureAuthority();
  ctx.authority!.decisions.push({ ...mutableFixture(ctx.authority!.decisions[0]), decision: "reject" });
  const expected = ctx.authority!.decisions.map(d => createHash("sha256").update(fixtureCanonical({ authoritySnapshot: ctx.authority!.snapshot, ...d })).digest("hex")).sort();
  for (const selectedSnapshot of [null, { snapshot: { id: "absent", digest }, event: { eventId: "absent", digest } }]) {
    const result = projectWorkLedger(fixtureText(f.events), { ...ctx, selectedSnapshot });
    assert.equal(result.progress, null); assert.equal(result.runtime, null);
    assert.deepEqual(result.conflicts, [{ kind: "receipt", id: "receipt:a", digests: expected, affectedObligations: [] }]);
  }
  const measured = projectWorkLedger(fixtureText(f.events), ctx);
  assert.deepEqual(measured.conflicts[0].digests, expected);
  const invalid = projectWorkLedger(fixtureText(f.events), { ...ctx, unknown: true } as never);
  assert.equal(invalid.authoritySnapshot, null); assert.deepEqual(invalid.conflicts, []);
});

test("public projection preserves large claim/coverage collections and unsupported conflict siblings", () => {
  const f = walkingFixture(), ctx = fixtureAuthority();
  const extras = Array.from({ length: 300 }, (_, i) => publicClaim(`sibling:${i}`, { evidence: [{ id: `evidence:${i}`, digest, event: null }] }));
  const result = projectWorkLedger(fixtureText([...f.events, ...extras]), ctx);
  assert.deepEqual(result.progress, { accepted: 1, total: 1 }); assert.equal(result.claims.length, 301);
  assert.equal(result.obligations[0].evidenceCoverage.items.length, 301);
  for (const rows of [result.claims, result.problems, result.obligations, result.obligations[0].claims, result.obligations[0].evidenceCoverage.items]) {
    const keys = rows.map(fixtureCanonical); assert.deepEqual(keys, [...new Set(keys)].sort());
  }
  assert.deepEqual(projectWorkLedger(fixtureText([...f.events, ...extras].reverse()), ctx), result);
  const badSources = [scope("unsupported-source", "outside:a"), scope("unsupported-source", "outside:b")];
  const unsupported = publicClaim("unsupported-source-claim", { evidence: [{ id: "unsupported", digest, event: eventRef(badSources[0]) }] });
  const healthy = projectWorkLedger(fixtureText([...f.events, ...badSources, unsupported]), ctx);
  assert.deepEqual(healthy.progress, { accepted: 1, total: 1 }); assert.deepEqual(healthy.obligations[0].problems, []);
  assert.equal(healthy.claims.find(c => c.claim.eventId === unsupported.eventId)!.applicability, "unresolved");
});

test("public work-ledger subpath is additive without changing legacy export targets", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.exports["./work-ledger"], { types: "./dist/work-ledger.d.ts", default: "./dist/work-ledger.js" });
  assert.deepEqual(manifest.exports["./ledger"], { types: "./dist/ledger.d.ts", default: "./dist/ledger.js" });
  assert.equal(manifest.version, "0.25.2");
});

test("public shared execution joins yield one actual attempt with two bindings and no wire acceptance", () => {
  const f = walkingFixture(), { digest: _, ...body } = f.obligation.payload.revision;
  const second = buildWorkRevisionEvent({ eventId: "second-obligation", now, revision: { ...mutableFixture(body), id: "second" } });
  const binding = { ...mutableFixture(f.snapshot.payload.snapshot.bindings[0]), obligation: fixtureRevisionRef(second) };
  const selected = buildWorkSnapshotEvent({ eventId: "two-obligations", now, snapshot: {
    snapshotId: "two", scope: fixtureRevisionRef(f.scope), revisions: [...mutableFixture(f.snapshot.payload.snapshot.revisions), fixtureRevisionRef(second)],
    bindings: [...mutableFixture(f.snapshot.payload.snapshot.bindings), binding],
  } });
  const joined = buildWorkOccurrenceEvent({ eventId: "second-join", now, payload: { ...mutableFixture(f.occurrence.payload), obligation: fixtureRevisionRef(second) } });
  const result = projectWorkLedger(fixtureText([...f.events, second, selected, joined]), {
    selectedSnapshot: { snapshot: { id: "two", digest: selected.payload.snapshot.digest }, event: fixtureEventRef(selected) }, authority: null,
  });
  assert.deepEqual(result.progress, { accepted: 0, total: 2 });
  assert.deepEqual(result.runtime!.counts, { attempts: 1, variants: 1, observedCompletedAttempts: 1 });
  assert.equal(result.runtime!.attempts.length, 1); assert.equal(result.runtime!.attempts[0].bindings.length, 2);
  assert.equal(result.runtime!.attempts[0].resolution, "resolved"); assert.equal(result.runtime!.occurrences.length, 2);
});

test("public required occurrence quarantine survives alias redelivery and context bounds precede receipt collapse", () => {
  const f = walkingFixture();
  const rival = buildWorkOccurrenceEvent({ eventId: f.occurrence.eventId, now, payload: { ...mutableFixture(f.occurrence.payload), state: "failed" } });
  const alias = buildWorkOccurrenceEvent({ eventId: "occurrence-alias", now: new Date(now.getTime() + 1), payload: mutableFixture(f.occurrence.payload) });
  const running = buildWorkOccurrenceEvent({ eventId: "running", now, payload: { ...mutableFixture(f.occurrence.payload), state: "running" } });
  const supported = publicClaim("alias-support", { evidence: [{ id: "fixture:evidence", digest, event: fixtureEventRef(alias) }] });
  const ctx = fixtureAuthority();
  ctx.authority!.decisions[0] = { ...ctx.authority!.decisions[0], claim: fixtureEventRef(supported), binding: mutableFixture(supported.payload.binding) };
  const events = [...f.events, rival, alias, running, supported];
  const result = projectWorkLedger(fixtureText(events), ctx);
  assert.deepEqual(result.progress, { accepted: 0, total: 1 }); assert.equal(result.runtime!.attempts[0].resolution, "unresolved");
  assert.equal(result.runtime!.counts.observedCompletedAttempts, 0); assert.equal(result.runtime!.occurrences.length, 4);
  assert.ok(result.claims.find(c => c.claim.eventId === supported.eventId)!.problems.some(p => p.code === "EVENT_CONFLICT"));
  assert.deepEqual(projectWorkLedger(fixtureText([...events].reverse()), ctx), result);
  const bounded = fixtureAuthority(); bounded.authority!.decisions = Array.from({ length: 257 }, () => mutableFixture(bounded.authority!.decisions[0]));
  const invalid = projectWorkLedger(fixtureText(f.events), bounded);
  assert.deepEqual(invalid.errors, [{ line: null, code: "WORK_CONTEXT_INVALID" }]);
  assert.equal(invalid.authoritySnapshot, null); assert.equal(invalid.selectedSnapshot, null); assert.equal(invalid.progress, null);
});

// Filesystem tests own only newly created tempDir roots. KEEP_TMP retains them during owner evidence runs.
const writeCode = (code: string) => (error: unknown) => error instanceof WorkLedgerWriteError && error.code === code;
const inputCode = (code: string) => (error: unknown) => error instanceof WorkInputError && error.code === code;
const byteLimit = 16 * 1024 * 1024;
function appendChild(t: TestContext, path: string, fault = "none", operation = "append", protection: string | null = null, root = dirname(path)) {
  const escaped = (value: string | null) => JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    unit => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0"));
  const encoded = fault === "observe-encoding";
  // Exactly Node plus the approved helper; no shell, model, package manager, or historical cwd.
  const child = spawn(process.execPath, [new URL("./work-ledger-lock-child.ts", import.meta.url).pathname,
    operation, fault, encoded ? escaped(path) : path, encoded ? escaped(protection) : protection ?? "null", JSON.stringify(walkingFixture().scope)], {
    cwd: root, env: { ...process.env, P01_FIXTURE_ROOT: root }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "", stderr = "";
  assert.ok(child.stdout); assert.ok(child.stderr);
  child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 100_000) child.kill(); });
  child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 100_000) child.kill(); });
  const result = new Promise<any>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) { reject(new Error(`fixture child exit ${code}/${signal}: ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
  // Register rejection handling immediately, including while the parent waits for the pause handshake.
  result.catch(() => undefined);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await result.catch(() => undefined); });
  const paused = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture pause handshake missing")), 20_000);
    timer.unref();
    child.once("message", message => { clearTimeout(timer); if (message === "paused") resolve(); else reject(new Error("unexpected fixture handshake")); });
    child.once("close", () => { clearTimeout(timer); reject(new Error("fixture child exited before pause")); });
  });
  paused.catch(() => undefined);
  return { result, paused, release: () => child.send("release") };
}

test("real work-v4 append and inspection require out-of-band fixture authority", async () => {
  const dir = await tempDir("work-append-"), path = join(dir, "nested", "work"), grant = join(dir, "grants");
  await writeFile(grant, "legacy sentinel\n");
  const f = walkingFixture();
  const options = { path, grantLedgerPath: grant }, first = mutableFixture(f.events[0]);
  const pending = appendWorkLedgerEvent(options, first);
  options.path = grant; first.digest = "f".repeat(64); await pending;
  for (const event of f.events.slice(1)) await appendWorkLedgerEvent({ path, grantLedgerPath: grant }, event);
  assert.equal(await readFile(path, "utf8"), f.events.map(canonicalWorkJson).join("\n") + "\n");
  assert.equal(await readFile(grant, "utf8"), "legacy sentinel\n"); assert.equal(existsSync(grant + ".lock"), false);
  const unselected = await inspectWorkLedger({ version: 4, path });
  assert.deepEqual(Object.keys(unselected).sort(), ["version", "status", "exists", "ingestion", "projection", "errors"].sort());
  assert.equal(unselected.status, "read"); assert.equal(unselected.exists, true); assert.deepEqual(unselected.errors, []);
  assert.equal(unselected.ingestion!.complete, true); assert.equal(unselected.projection!.progress, null);
  const ctx = fixtureAuthority();
  const unresolved = await inspectWorkLedger({ version: 4, path }, { ...ctx, authority: null });
  assert.deepEqual(unresolved.projection!.progress, { accepted: 0, total: 1 });
  const inspectionOptions = { version: 4 as const, path };
  const inspecting = inspectWorkLedger(inspectionOptions, ctx);
  inspectionOptions.path = grant; ctx.authority!.decisions[0].decision = "reject";
  const accepted = await inspecting;
  assert.deepEqual(accepted.projection, projectWorkLedger(fixtureText(f.events), fixtureAuthority()));
  assert.deepEqual(accepted.projection!.runtime!.counts, { attempts: 1, variants: 1, observedCompletedAttempts: 1 });
  assertDeepFrozen(accepted); assert.deepEqual(accepted.projection!.progress, { accepted: 1, total: 1 });
  await appendWorkLedgerEvent({ path, grantLedgerPath: null }, f.scope);
  assert.equal((await inspectWorkLedger({ version: 4, path })).ingestion!.events.length, 9);
  const legacy = await verifyLedger(path);
  assert.equal(legacy.events, 0); assert.equal(legacy.records, 0); assert.equal(legacy.corrupt.length, 9);
  assert.deepEqual(legacy.lifecycle, { starting: 0, running: 0, completed: 0, failed: 0 });
});

test("work-v4 append options candidate and path errors have exact pre-I/O precedence", async () => {
  const dir = await tempDir("work-options-"), path = join(dir, "absent", "work"), good = walkingFixture().scope;
  const bad = { ...good, digest: "b".repeat(64) };
  let getter = false;
  for (const options of [{ path }, { path, grantLedgerPath: undefined }, { path, grantLedgerPath: null, strict: false },
    { path: 1, grantLedgerPath: null }, { path, grantLedgerPath: null, staleRecovery: "age" }, Object.defineProperty({ grantLedgerPath: null }, "path", { enumerable: true, get() { getter = true; return path; } })]) {
    await assert.rejects(appendWorkLedgerEvent(options as never, bad), inputCode("WORK_SCHEMA_INVALID"));
  }
  assert.equal(getter, false);
  await assert.rejects(appendWorkLedgerEvent({ path: "relative", grantLedgerPath: null }, bad), inputCode("WORK_DIGEST_MISMATCH"));
  await assert.rejects(appendWorkLedgerEvent({ path: dir, grantLedgerPath: dir }, { ledgerVersion: 3 } as never), inputCode("WORK_VERSION_UNSUPPORTED"));
  for (const invalid of ["", "relative", path + "\0"]) {
    await assert.rejects(appendWorkLedgerEvent({ path: invalid, grantLedgerPath: null }, good), writeCode("WORK_DESTINATION_INVALID"));
    await assert.rejects(appendWorkLedgerEvent({ path, grantLedgerPath: invalid }, good), writeCode("WORK_DESTINATION_INVALID"));
  }
  assert.deepEqual(await readdir(dir), []);
});

test("work-v4 rejects grant destination aliases before writing", async () => {
  const good = walkingFixture().scope;
  for (const lock of [false, true]) for (const existing of [false, true]) {
    const dir = await tempDir("work-ancestor-"), grant = join(dir, "protected"), reserved = grant + (lock ? ".lock" : "");
    const path = join(reserved, "inside", "nested", "work");
    if (existing) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, "preserve"); }
    const before = await readdir(dir, { recursive: true });
    await assert.rejects(appendWorkLedgerEvent({ path, grantLedgerPath: grant }, good), writeCode("WORK_DESTINATION_ALIAS"));
    assert.deepEqual(await readdir(dir, { recursive: true }), before);
    if (existing) {
      assert.equal(await readFile(path, "utf8"), "preserve");
      const alias = join(dir, "parent-alias"); await symlink(join(reserved, "inside"), alias);
      await assert.rejects(appendWorkLedgerEvent({ path: join(alias, "nested", "work"), grantLedgerPath: grant }, good), writeCode("WORK_DESTINATION_ALIAS"));
    } else {
      const alias = join(dir, "parent-alias"); await symlink(dir, alias);
      await assert.rejects(appendWorkLedgerEvent({ path: join(alias, reserved.slice(dir.length + 1), "work"), grantLedgerPath: grant }, good), writeCode("WORK_DESTINATION_ALIAS"));
      assert.equal(existsSync(reserved), false);
    }
  }
  const dir = await tempDir("work-alias-"), grant = join(dir, "grant"), work = join(dir, "work");
  await writeFile(grant, "preserve-grant");
  for (const path of [grant, join(dir, "x", "..", "grant"), grant + ".lock"]) {
    await assert.rejects(appendWorkLedgerEvent({ path, grantLedgerPath: grant }, good), writeCode("WORK_DESTINATION_ALIAS"));
  }
  await assert.rejects(appendWorkLedgerEvent({ path: work, grantLedgerPath: work + ".lock" }, good), writeCode("WORK_DESTINATION_ALIAS"));
  await symlink(grant, work);
  await assert.rejects(appendWorkLedgerEvent({ path: work, grantLedgerPath: grant }, good), writeCode("WORK_DESTINATION_ALIAS"));
  const hard = join(dir, "hard"); await link(grant, hard);
  await assert.rejects(appendWorkLedgerEvent({ path: hard, grantLedgerPath: grant }, good), writeCode("WORK_DESTINATION_ALIAS"));
  const lockTarget = join(dir, "busy-work"); await link(grant, lockTarget + ".lock");
  await assert.rejects(appendWorkLedgerEvent({ path: lockTarget, grantLedgerPath: grant }, good), writeCode("WORK_DESTINATION_ALIAS"));
  assert.equal(await readFile(grant, "utf8"), "preserve-grant");
  const disjoint = join(dir, "safe", "work"); await appendWorkLedgerEvent({ path: disjoint, grantLedgerPath: grant }, good);
  assert.equal(parseWorkLedgerText(await readFile(disjoint, "utf8")).complete, true);
});

// Physical fixture inventory: recursive readdir follows the intentional self-symlink on this runtime.
// Its variable ELOOP traversal depth is not a write oracle. Preserve inode/mode/bytes/link target instead.
async function encodingPhysicalSnapshot(root: string) {
  const rows: unknown[] = [];
  async function visit(path: string, relative: string, depth: number): Promise<void> {
    assert.ok(depth <= 16 && rows.length < 128, "bounded owned fixture inventory");
    const st = await lstat(path, { bigint: true });
    const info = { path: relative, dev: String(st.dev), ino: String(st.ino), mode: String(st.mode), links: String(st.nlink) };
    if (st.isSymbolicLink()) rows.push({ ...info, target: await readlink(path) });
    else if (st.isDirectory()) {
      rows.push(info);
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative ? relative + "/" + name : name, depth + 1);
    } else { assert.ok(st.isFile() && st.size <= 65536n); rows.push({ ...info, sha256: createHash("sha256").update(await readFile(path)).digest("hex") }); }
  }
  await visit(root, "", 0); return rows;
}

test("encoding physical inventory stops at self-links and detects real byte changes", async () => {
  const dir = await tempDir("work-encoding-inventory-"); await symlink(dir, join(dir, "portal"));
  const before = await encodingPhysicalSnapshot(dir); assert.equal(before.length, 2);
  assert.deepEqual(await encodingPhysicalSnapshot(dir), before);
  await writeFile(join(dir, "sentinel"), "one"); const changed = await encodingPhysicalSnapshot(dir);
  assert.notDeepEqual(changed, before); await writeFile(join(dir, "sentinel"), "two");
  assert.notDeepEqual(await encodingPhysicalSnapshot(dir), changed);
});

test("work-v4 filesystem encoding aliases precede every mutating call", { timeout: 30000 }, async t => {
  for (const lone of ["\ud800", "\udc00"]) for (const inverse of [false, true]) {
    for (const topology of ["absent", "existing", "canonical"]) {
      for (const role of ["leaf", "grant-lock", "work-lock", "ancestor", "lock-ancestor"]) {
        await t.test(`${JSON.stringify(lone)} inverse=${inverse} ${topology} ${role}`, async childTest => {
          const dir = await tempDir("work-encoding-alias-");
          const workName = "name-" + (inverse ? "\ufffd" : lone), grantName = "name-" + (inverse ? lone : "\ufffd");
          let workRoot = dir;
          if (topology === "canonical") { workRoot = join(dir, "portal"); await symlink(dir, workRoot); }
          const ancestor = role === "ancestor" || role === "lock-ancestor";
          const workLeaf = workName + (["grant-lock", "lock-ancestor"].includes(role) ? ".lock" : "");
          const path = ancestor ? join(workRoot, workLeaf, "inside", "nested", "work") : join(workRoot, workLeaf);
          const grant = join(dir, grantName + (role === "work-lock" ? ".lock" : ""));
          const reserved = grant + (["grant-lock", "lock-ancestor"].includes(role) ? ".lock" : "");
          if (topology === "existing") {
            if (ancestor) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, "preserve-work"); }
            else await writeFile(reserved, "preserve-protected");
          }
          const before = await encodingPhysicalSnapshot(dir);
          const result = await appendChild(childTest, path, "observe-encoding", "append", grant, dir).result;
          // Echo equality proves argv did not replace the surrogate before the public API saw it.
          assert.equal(result.observation.path, path); assert.equal(result.observation.protection, grant);
          assert.deepEqual(result, { ok: false, hit: false, name: "WorkLedgerWriteError", code: "WORK_DESTINATION_ALIAS",
            observation: { path, protection: grant, mutations: [] } });
          assert.deepEqual(await encodingPhysicalSnapshot(dir), before);
          if (topology === "existing") assert.equal(await readFile(ancestor ? path : reserved, "utf8"), ancestor ? "preserve-work" : "preserve-protected");
        });
      }
    }
  }
});

test("work-v4 filesystem encoding preserves disjoint Unicode paths and a live mutation observer", async t => {
  for (const name of ["café", "cafe\u0301", "資料-🚀", "replacement-\ufffd", "unpaired-\ud800", "unpaired-\udc00"]) {
    await t.test(JSON.stringify(name), async childTest => {
      const dir = await tempDir("work-encoding-positive-"), grant = join(dir, "grant-資料");
      await writeFile(grant, "preserve-grant");
      const path = join(dir, "nested-🚀", name);
      const result = await appendChild(childTest, path, "observe-encoding", "append", grant, dir).result;
      assert.equal(result.observation.path, path); assert.equal(result.observation.protection, grant);
      assert.equal(result.ok, true);
      assert.ok(result.observation.mutations.some((entry: { operation: string }) => entry.operation === "mkdir"));
      assert.ok(result.observation.mutations.some((entry: { operation: string }) => entry.operation === "writeFile"));
      assert.ok(result.observation.mutations.some((entry: { operation: string }) => entry.operation === "rm"));
      assert.equal(await readFile(path, "utf8"), canonicalWorkJson(walkingFixture().scope) + "\n");
      assert.equal((await inspectWorkLedger({ version: 4, path })).ingestion!.complete, true);
      assert.equal(await readFile(grant, "utf8"), "preserve-grant");
      assert.equal(existsSync(grant + ".lock"), false); assert.equal(existsSync(path + ".lock"), false);
    });
  }
});

test("work-v4 rejects unsafe leaves and sidecars without opening them for content", async () => {
  for (const sidecar of [false, true]) for (const kind of ["directory", "symlink", "dangling", "hardlink", "fifo"]) {
    const dir = await tempDir("work-topology-"), path = join(dir, "work"), target = path + (sidecar ? ".lock" : "");
    const other = join(dir, "other"); await writeFile(other, "preserve");
    if (kind === "directory") await mkdir(target);
    else if (kind === "symlink" || kind === "dangling") await symlink(kind === "symlink" ? other : join(dir, "absent"), target);
    else if (kind === "hardlink") await link(other, target);
    else execFileSync("/usr/bin/mkfifo", [target]); // Inspected POSIX utility; exact fresh target, no shell.
    const before = await readdir(dir);
    await assert.rejects(appendWorkLedgerEvent({ path, grantLedgerPath: null }, walkingFixture().scope), writeCode("WORK_DESTINATION_INVALID"));
    assert.deepEqual(await readdir(dir), before); assert.equal(await readFile(other, "utf8"), "preserve");
    if (kind === "directory" || kind === "fifo") {
      const inspection = await inspectWorkLedger({ version: 4, path: target });
      assert.equal(inspection.status, "error"); assert.deepEqual(inspection.errors, [{ line: null, code: "WORK_INSPECTION_NOT_REGULAR" }]);
    }
  }
  const dir = await tempDir("work-parent-"), parent = join(dir, "parent"); await writeFile(parent, "file");
  await assert.rejects(appendWorkLedgerEvent({ path: join(parent, "work"), grantLedgerPath: null }, walkingFixture().scope), writeCode("WORK_DESTINATION_INVALID"));
  const dangling = join(dir, "dangling"); await symlink(join(dir, "absent"), dangling);
  await assert.rejects(appendWorkLedgerEvent({ path: join(dangling, "work"), grantLedgerPath: null }, walkingFixture().scope), writeCode("WORK_DESTINATION_INVALID"));
});

test("work-v4 append fails closed without repairing existing content", async () => {
  const dir = await tempDir("work-content-"), good = walkingFixture().scope;
  const cases = [["legacy", '{"ledgerVersion":3}\n', "WORK_VERSION_UNSUPPORTED"], ["broken", "{broken\n", "WORK_JSON_INVALID"],
    ["tail", JSON.stringify(good), "WORK_JSON_INVALID"], ["bad-digest", JSON.stringify({ ...good, digest: "b".repeat(64) }), "WORK_DIGEST_MISMATCH"],
    ["corrupt-at-capacity", "{broken\n".padEnd(byteLimit, " "), "WORK_JSON_INVALID"],
    ["oversize", " ".repeat(byteLimit + 1), "WORK_LIMIT_EXCEEDED"]];
  for (const [name, content, code] of cases) {
    const path = join(dir, name); await writeFile(path, content);
    await assert.rejects(appendWorkLedgerEvent({ path, grantLedgerPath: null }, good), inputCode(code));
    assert.equal(await readFile(path, "utf8"), content); assert.equal(existsSync(path + ".lock"), false);
  }
  const preserved = join(dir, "whitespace"), original = " \t" + JSON.stringify(Object.fromEntries(Object.entries(good).reverse())) + "\n";
  await writeFile(preserved, original); await appendWorkLedgerEvent({ path: preserved, grantLedgerPath: null }, good);
  assert.equal(await readFile(preserved, "utf8"), original + canonicalWorkJson(good) + "\n");
});

test("work-v4 locked resulting capacity includes bytes records and concurrent deliveries", async () => {
  const dir = await tempDir("work-capacity-"), path = join(dir, "records"), good = walkingFixture().scope, line = canonicalWorkJson(good) + "\n";
  await writeFile(path, line.repeat(9999)); await appendWorkLedgerEvent({ path, grantLedgerPath: null }, good);
  const full = await readFile(path); assert.equal(parseWorkLedgerText(full.toString()).events.length, 10000);
  await assert.rejects(appendWorkLedgerEvent({ path, grantLedgerPath: null }, good), inputCode("WORK_LIMIT_EXCEEDED"));
  assert.deepEqual(await readFile(path), full);
  const bytes = join(dir, "bytes"), padding = " ".repeat(byteLimit - Buffer.byteLength(line) - 1) + "\n";
  await writeFile(bytes, padding);
  const results = await Promise.allSettled([1, 2].map(() => appendWorkLedgerEvent({ path: bytes, grantLedgerPath: null }, good)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.ok(results.some(r => r.status === "rejected" && inputCode("WORK_LIMIT_EXCEEDED")(r.reason)));
  assert.equal((await stat(bytes)).size, byteLimit); assert.equal(await readFile(bytes, "utf8"), padding + line);
  assert.equal((await inspectWorkLedger({ version: 4, path: bytes })).ingestion!.complete, true);
});

test("work-v4 inspection distinguishes missing invalid unreadable and incomplete content", async () => {
  const dir = await tempDir("work-inspect-"), path = join(dir, "missing");
  assert.deepEqual(await inspectWorkLedger({ version: 4, path }), { version: 4, status: "missing", exists: false, ingestion: null, projection: null, errors: [] });
  for (const [options, code] of [[{ version: 4, path: "relative" }, "WORK_INSPECTION_PATH_INVALID"],
    [{ version: 3, path }, "WORK_VERSION_UNSUPPORTED"], [{ version: 4, path, extra: true }, "WORK_SCHEMA_INVALID"]] as const) {
    const result = await inspectWorkLedger(options as never);
    assert.deepEqual(result, { version: 4, status: "error", exists: null, ingestion: null, projection: null, errors: [{ line: null, code }] });
  }
  const invalidContext = await inspectWorkLedger({ version: 4, path }, {} as never);
  assert.deepEqual(invalidContext.errors, [{ line: null, code: "WORK_CONTEXT_INVALID" }]); assert.equal(invalidContext.exists, null);
  assert.deepEqual(await readdir(dir), []);
  await writeFile(path, "{broken\n"); const corrupt = await inspectWorkLedger({ version: 4, path });
  assert.equal(corrupt.status, "read"); assert.equal(corrupt.ingestion!.complete, false); assert.equal(corrupt.projection!.progress, null);
  assert.deepEqual(corrupt.errors, []);
});

// Scoped child faults exercise the actual shared lock; no parent-process filesystem monkeypatch.
// Suppressing successful-body cleanup errors, skipping cleanup after close failure, or deleting a
// replacement token must fail these assertions. Preserve all bytes: rejection is not rollback.
test("work-v4 lock cleanup failures are reported without undoing appended bytes", { timeout: 60000 }, async t => {
  const line = canonicalWorkJson(walkingFixture().scope) + "\n";
  for (const fault of ["control", "close", "read", "unlink", "close-read", "close-unlink", "replacement", "close-replacement", "read-replacement"]) {
    await t.test(fault, async childTest => {
      const dir = await tempDir("work-cleanup-"), path = join(dir, "work"), grant = join(dir, "grant");
      await writeFile(grant, "protected grant\n"); await writeFile(grant + ".lock", "protected sidecar\n");
      const first = await appendChild(childTest, path, "cleanup-" + fault, "append", grant).result;
      const beforeNext = await readFile(path, "utf8"), lockExists = existsSync(path + ".lock");
      const token = lockExists ? await readFile(path + ".lock", "utf8") : null;
      const next = await appendChild(childTest, path, "none", "append", grant).result;
      const afterNext = await readFile(path, "utf8");
      // Retain the whole observation before asserting, including the reviewer's resolved/orphan/next-failure sequence on red.
      await writeFile(join(dir, "receipt.json"), JSON.stringify({ fault, first, next, beforeNext, afterNext, token }, null, 2));
      const parts = fault.split("-"), replacement = parts.includes("replacement");
      const retainedLock = replacement || parts.includes("read") || parts.includes("unlink");
      const failed = ["close", "read", "unlink"].some(p => parts.includes(p));
      assert.equal(first.cleanup.closes, 1); assert.equal(first.cleanup.reads, 1, "safe ownership check still attempted after close failure");
      assert.equal(first.cleanup.removals, parts.includes("read") || replacement ? 0 : 1);
      assert.match(first.cleanup.token, /^\d+:[0-9a-f-]+\n$/);
      assert.equal(beforeNext, line); assert.equal(lockExists, retainedLock);
      assert.equal(token, retainedLock ? replacement ? "replacement-owner\n" : first.cleanup.token : null);
      assert.deepEqual(next, retainedLock ? { ok: false, hit: false, name: "WorkLedgerWriteError", code: "WORK_LEDGER_WRITE_FAILED" } : { ok: true, hit: false });
      assert.equal(afterNext, retainedLock ? line : line + line, "a later admitted retry is a physical redelivery, not a promised no-op");
      if (retainedLock) assert.equal(await readFile(path + ".lock", "utf8"), token);
      else assert.equal(existsSync(path + ".lock"), false);
      assert.equal((await inspectWorkLedger({ version: 4, path })).ingestion!.complete, true);
      assert.equal(await readFile(grant, "utf8"), "protected grant\n");
      assert.equal(await readFile(grant + ".lock", "utf8"), "protected sidecar\n");
      assert.equal(first.hit, failed); assert.equal(first.ok, !failed, "successful append body must not hide lock cleanup failure");
      if (failed) { assert.equal(first.name, "WorkLedgerWriteError"); assert.equal(first.code, "WORK_LEDGER_WRITE_FAILED"); }
    });
  }
});

test("work-v4 primary body failures survive lock cleanup faults", { timeout: 30000 }, async t => {
  for (const fault of ["close", "read", "unlink", "close-unlink"]) await t.test(fault, async childTest => {
    const dir = await tempDir("work-cleanup-primary-"), path = join(dir, "work"), grant = join(dir, "grant");
    await writeFile(path, "{broken\n"); await writeFile(grant, "protected\n");
    const result = await appendChild(childTest, path, "cleanup-" + fault, "append", grant).result;
    await writeFile(join(dir, "receipt.json"), JSON.stringify(result, null, 2));
    assert.equal(result.ok, false); assert.equal(result.hit, true); assert.equal(result.name, "WorkInputError");
    assert.equal(result.code, "WORK_JSON_INVALID"); assert.equal(result.cleanup.closes, 1); assert.equal(result.cleanup.reads, 1);
    assert.equal(result.cleanup.removals, fault === "read" ? 0 : 1);
    assert.equal(await readFile(path, "utf8"), "{broken\n"); assert.equal(await readFile(grant, "utf8"), "protected\n");
    if (fault === "close") assert.equal(existsSync(path + ".lock"), false);
    else assert.equal(await readFile(path + ".lock", "utf8"), result.cleanup.token);
  });
});

test("lock cleanup preserves legacy age policy and primary callback errors", { timeout: 60000 }, async t => {
  for (const mode of ["default", "age", "disabled"]) for (const fault of ["close", "read", "unlink", "close-read", "close-unlink"]) {
    for (const body of ["", "-body", "-body-undefined"]) await t.test(`${mode}/${fault}/${body || "success"}`, async childTest => {
      const dir = await tempDir("lock-cleanup-policy-"), path = join(dir, "work");
      const result = await appendChild(childTest, path, "cleanup-" + fault, "lock-" + mode + body).result;
      await writeFile(join(dir, "receipt.json"), JSON.stringify(result, null, 2));
      assert.equal(result.hit, true); assert.equal(result.cleanup.closes, 1); assert.equal(result.cleanup.reads, 1);
      assert.equal(result.cleanup.removals, fault.includes("read") ? 0 : 1);
      assert.equal(existsSync(path), false, "lock callback does not create a ledger");
      if (body) { assert.equal(result.ok, false); assert.equal(result.bodySentinel, true, "exact primary rejection, even undefined, survives cleanup"); }
      else if (mode === "disabled") {
        assert.equal(result.ok, false); assert.equal(result.name, "Error");
        assert.equal(result.code, fault.includes("close") ? "EIO" : "EACCES", "first cleanup error wins after both safe attempts");
      } else { assert.equal(result.ok, true); assert.equal(result.value, "body-result", "legacy cleanup remains best effort"); }
    });
  }
});

// REV-SPEC-001: a clean nominated delivery cannot cleanse its exact nested snapshot body in another
// conflicting ID. All main negatives start from real 1/1 support and add ONLY snapshot deliveries.
// Removing the selector's alias-source scan or the index's nested-snapshot filter breaks this test.
test("work-v4 snapshot conflicts quarantine exact selected bodies across clean aliases", async t => {
  const f = walkingFixture(), context = fixtureAuthority(), originalText = fixtureText(f.events);
  const baseline = projectWorkLedger(originalText, context), contextBefore = JSON.stringify(context);
  assert.equal(baseline.scopeState, "valid"); assert.deepEqual(baseline.progress, { accepted: 1, total: 1 });
  assert.deepEqual(baseline.problems, []); assert.deepEqual(baseline.claims[0].matchedReceiptIds, ["receipt:a"]);
  assert.equal(baseline.obligations[0].artifactCoverage.state, "available");
  assert.equal(baseline.obligations[0].evidenceCoverage.state, "available");
  const deliver = (snapshot: WorkFrozen<WorkSnapshot>, eventId: string, seconds = 0) => {
    const { digest: _, ...body } = mutableFixture(snapshot);
    return buildWorkSnapshotEvent({ eventId, now: new Date(now.getTime() + seconds * 1000), snapshot: body });
  };
  const different = (snapshot: WorkFrozen<WorkSnapshot>, snapshotId: string, eventId: string, seconds = 0) =>
    deliver({ ...snapshot, snapshotId }, eventId, seconds);
  const clean = deliver(f.snapshot.payload.snapshot, "snapshot:clean-alias", 3);
  const affected = [fixtureRevisionRef(f.obligation)];
  function expected(healthy: ReturnType<typeof projectWorkLedger>, groups: readonly (readonly Event[])[], refs: readonly RevisionRef[]) {
    const conflicts = groups.map(group => ({ kind: "event", id: group[0].eventId,
      digests: group.map(e => e.digest).sort(), affectedObligations: refs })).sort((a, b) => a.digests[0] < b.digests[0] ? -1 : 1);
    return { ...healthy, scopeState: "unresolved", progress: null, runtime: null, obligations: [], claims: [], supersededClaims: 0, conflicts,
      problems: sorted(groups.flat()).map(e => ({ code: "EVENT_CONFLICT", reference: { type: "event", ref: fixtureEventRef(e) }, affectedObligations: refs })) };
  }
  function check(input: string, ctx: typeof context, want: ReturnType<typeof expected>) {
    const result = projectWorkLedger(input, ctx);
    assert.equal(result.scopeState, "unresolved", "quarantined exact snapshot must suppress selected facts even through a clean event ID");
    assert.deepEqual(result, want); assertDeepFrozen(result);
    const index = indexWorkLedgerText(input);
    assert.equal(index.ingestion.complete, true); assert.deepEqual(index.ingestion.errors, []);
    assert.deepEqual(index.quarantinedRevisions, [], "no revision conflict may mask the snapshot defect");
    assert.equal(index.effectiveEvents.some(e => e.event === "work_snapshot" && e.payload.snapshot.snapshotId === ctx.selectedSnapshot!.snapshot.id &&
      e.payload.snapshot.digest === ctx.selectedSnapshot!.snapshot.digest), false, "first-pass evidence must also quarantine clean nested aliases");
    return result;
  }
  assert.deepEqual(projectWorkLedger(fixtureText([...f.events, clean, clean]), context), baseline);
  assert.deepEqual(projectWorkLedger(fixtureText([...f.events, clean]), { ...context, selectedSnapshot: selection(clean) }), baseline);
  for (const variant of ["different snapshot", "timestamp only", "selected body is third alternative"] as const) await t.test(variant, async () => {
    const alias = deliver(f.snapshot.payload.snapshot, "snapshot:shadow", 1);
    const rival = variant === "timestamp only" ? deliver(f.snapshot.payload.snapshot, alias.eventId, 2)
      : different(f.snapshot.payload.snapshot, "rival-snapshot", alias.eventId, 2);
    const group = variant === "selected body is third alternative" ? [rival, different(f.snapshot.payload.snapshot, "another-rival", alias.eventId, 4), alias] : [alias, rival];
    const input = fixtureText([...f.events, ...group]), result = projectWorkLedger(input, context);
    const dir = await tempDir("snapshot-quarantine-");
    await writeFile(join(dir, "receipt.json"), JSON.stringify({ variant, input, context, baseline, result }, null, 2));
    assert.equal(alias.payload.snapshot.digest, f.snapshot.payload.snapshot.digest); assert.notEqual(alias.digest, rival.digest);
    assert.equal(indexWorkLedgerText(input).conflictingEvents.every(e => e.eventId === alias.eventId), true);
    const want = expected(baseline, [group], affected); check(input, context, want);
    let orders = 0;
    for (const order of permutations([f.snapshot, clean, ...group])) {
      const rest = f.events.filter(e => e !== f.snapshot);
      for (const sequence of [[...rest, ...order], [...order, ...rest].reverse(), [...order, ...rest, ...order, clean, clean]]) {
        const replay = fixtureText(sequence);
        check(replay, context, want); check(replay, { ...context, selectedSnapshot: selection(clean) }, want);
      }
      orders++;
    }
    t.diagnostic(`${variant}: ${orders} orders, forward/reverse/repeated, both exact nominations`);
    const caller = mutableFixture(context), detached = check(input, caller, want), saved = JSON.stringify(detached);
    caller.selectedSnapshot!.snapshot.id = "caller-mutated"; caller.authority!.decisions[0].decision = "reject";
    assert.equal(JSON.stringify(detached), saved); assert.equal(JSON.stringify(context), contextBefore);
  });
  for (const direct of [false, true]) await t.test(`all source conflicts are attributed; nominated ID conflicted=${direct}`, async () => {
    const one = deliver(f.snapshot.payload.snapshot, "snapshot:source-one", 1), two = deliver(f.snapshot.payload.snapshot, "snapshot:source-two", 2);
    const groups = [[one, different(f.snapshot.payload.snapshot, "rival-one", one.eventId)], [two, different(f.snapshot.payload.snapshot, "rival-two", two.eventId)]];
    if (direct) groups.push([f.snapshot, deliver(f.snapshot.payload.snapshot, f.snapshot.eventId, 5)]);
    const input = fixtureText([...f.events, clean, ...groups.flat()]), dir = await tempDir("snapshot-quarantine-sources-");
    await writeFile(join(dir, "receipt.json"), JSON.stringify({ direct, input, context, baseline, result: projectWorkLedger(input, context) }, null, 2));
    const want = expected(baseline, groups, affected); check(input, context, want);
    for (const order of permutations(groups)) check(fixtureText([...order.flat().reverse(), ...f.events, clean, ...order.flat(), clean]), context, want);
  });
  await t.test("different exact body with the same logical ID and scope stays disconnected", async () => {
    const { digest: _, ...body } = mutableFixture(f.snapshot.payload.snapshot);
    const other = buildWorkSnapshotEvent({ eventId: "snapshot:other-clean", now, snapshot: { ...body,
      revisions: body.revisions.filter(r => r.kind !== "artifact"), bindings: body.bindings.map(b => ({ ...b, artifact: null })) } });
    assert.equal(other.payload.snapshot.snapshotId, f.snapshot.payload.snapshot.snapshotId);
    assert.notEqual(other.payload.snapshot.digest, f.snapshot.payload.snapshot.digest);
    const alias = deliver(other.payload.snapshot, "snapshot:outside", 1), rival = different(other.payload.snapshot, "outside-rival", alias.eventId, 2);
    assert.equal(projectWorkLedger(fixtureText([...f.events, other]), { ...context, selectedSnapshot: selection(other) }).scopeState, "valid", "alternate body is legitimate, but is not nominated in the positive control");
    const want = { ...baseline, conflicts: [{ kind: "event", id: alias.eventId, digests: [alias.digest, rival.digest].sort(), affectedObligations: [] }] };
    const input = fixtureText([...f.events, other, clean, alias, rival]), dir = await tempDir("snapshot-quarantine-locality-");
    await writeFile(join(dir, "receipt.json"), JSON.stringify({ input, context, result: projectWorkLedger(input, context) }, null, 2));
    for (const order of permutations([other, clean, alias, rival])) {
      const replay = fixtureText([...order, ...f.events, ...order.reverse()]);
      assert.deepEqual(projectWorkLedger(replay, context), want);
      // The alternate exact body is quarantined even though the healthy selected body is not.
      const effective = indexWorkLedgerText(replay).effectiveEvents;
      assert.ok(effective.some(e => e.digest === f.snapshot.digest));
      assert.ok(effective.some(e => e.digest === clean.digest));
      assert.equal(effective.some(e => e.digest === other.digest), false);
    }
  });
  for (const count of [0, 2]) await t.test(`selected inventory diagnostics with ${count} obligations`, async () => {
    // Diagnostic-cardinality controls only: no authority is manufactured for this second graph.
    const g = graphFixture(), selected = count ? graphSnapshot(g) : graphSnapshot(g, { revisions: [], bindings: [] });
    const ctx = { ...fixtureAuthority(), selectedSnapshot: selection(selected) }, events = [...Object.values(g), selected];
    const healthy = projectWorkLedger(fixtureText(events), ctx);
    assert.equal(healthy.scopeState, "valid"); assert.deepEqual(healthy.progress, { accepted: 0, total: count });
    const alias = deliver(selected.payload.snapshot, "snapshot:inventory-shadow", 1), rival = different(selected.payload.snapshot, "inventory-rival", alias.eventId, 2);
    const refs = count ? sorted([revisionRef(g.dep), revisionRef(g.ob)]) : [], input = fixtureText([...events, alias, rival]);
    const dir = await tempDir("snapshot-quarantine-inventory-");
    await writeFile(join(dir, "receipt.json"), JSON.stringify({ count, input, context: ctx, healthy, result: projectWorkLedger(input, ctx) }, null, 2));
    const want = expected(healthy, [[alias, rival]], refs); check(input, ctx, want);
    for (const order of permutations([selected, alias, rival])) check(fixtureText([...order, ...Object.values(g), ...order]), ctx, want);
  });
  assert.equal(fixtureText(f.events), originalText); assert.equal(JSON.stringify(context), contextBefore);
  assert.deepEqual(projectWorkLedger(originalText, context), baseline); assertDeepFrozen(baseline);
});

// Canonical P01-REV-QUAL-004 also covers reviewer REV-SPEC-002. Only fixed fixture declarations
// create receipts. Central source quarantine must reach required support without becoming an
// unconditional veto from an unsupported sibling. Distinct acceptance events have no nested identity.
test("work-v4 required support consumes exact nested quarantine without untrusted sibling veto", async t => {
  function delivery(event: Event, eventId: string, seconds = 1, rival = false): Event {
    const at = new Date(now.getTime() + seconds * 1000);
    if (event.event === "work_snapshot") {
      const { digest: _, ...body } = mutableFixture(event.payload.snapshot);
      return buildWorkSnapshotEvent({ eventId, now: at, snapshot: { ...body, snapshotId: rival ? `support-rival:${seconds}` : body.snapshotId } });
    }
    if (event.event === "work_revision") {
      const { digest: _, ...body } = mutableFixture(event.payload.revision);
      return buildWorkRevisionEvent({ eventId, now: at, revision: { ...body, contentDigest: rival ? "b".repeat(64) : body.contentDigest } });
    }
    if (event.event === "work_occurrence") return buildWorkOccurrenceEvent({ eventId, now: at, payload: {
      ...mutableFixture(event.payload), labels: { ...event.payload.labels, branchLeafId: rival ? "rival-leaf" : event.payload.labels.branchLeafId },
    } });
    return buildWorkAcceptanceEvent({ eventId, now: at, payload: { ...mutableFixture(event.payload), authorityId: rival ? "untrusted-rival" : event.payload.authorityId } });
  }
  const diagnostics = (groups: Event[][], obligation: RevisionRef) => ({
    problems: sorted(groups.flat()).map(e => ({ code: "EVENT_CONFLICT", reference: { type: "event", ref: fixtureEventRef(e) }, affectedObligations: [obligation] })),
    conflicts: groups.map(g => ({ kind: "event", id: g[0].eventId, digests: g.map(e => e.digest).sort(), affectedObligations: [obligation] }))
      .sort((a, b) => a.digests[0] < b.digests[0] ? -1 : 1),
  });
  for (const aliasReference of [false, true]) for (const variant of ["rival", "timestamp", "multiple"] as const) await t.test(`${variant}; clean reference alias=${aliasReference}`, async () => {
    const f = supportQuarantineFixture("snapshot", aliasReference), ctx = supportQuarantineAuthority("snapshot", aliasReference);
    const original = fixtureText(f.events), savedContext = JSON.stringify(ctx), healthy = projectWorkLedger(original, ctx);
    assert.equal(healthy.scopeState, "valid"); assert.deepEqual(healthy.progress, { accepted: 1, total: 1 }); assert.deepEqual(healthy.problems, []);
    assert.deepEqual(healthy.claims[0].matchedReceiptIds, ["receipt:support"]);
    assert.equal(healthy.obligations[0].artifactCoverage.state, "available"); assert.equal(healthy.obligations[0].evidenceCoverage.state, "available");
    assert.equal(f.support.event, "work_snapshot");
    if (f.support.event !== "work_snapshot") throw Error("fixture kind");
    assert.notEqual(f.support.payload.snapshot.digest, f.base.snapshot.payload.snapshot.digest, "support is NOT the selected snapshot");
    const group = [delivery(f.support, "support:shadow"), delivery(f.support, "support:shadow", 2, variant !== "timestamp")];
    const groups = [group]; if (variant === "multiple") groups.push([delivery(f.support, "support:second", 3), delivery(f.support, "support:second", 4, true)]);
    const input = fixtureText([...f.events, ...groups.flat()]), first = projectWorkLedger(input, ctx), dir = await tempDir("support-quarantine-");
    await writeFile(join(dir, "receipt.json"), JSON.stringify({ aliasReference, variant, original, input, context: ctx, healthy, result: first }, null, 2));
    const expected = diagnostics(groups, fixtureRevisionRef(f.base.obligation));
    function check(text: string) {
      assert.equal(parseWorkLedgerText(text).complete, true);
      const result = projectWorkLedger(text, ctx);
      assert.equal(result.scopeState, "valid", "support conflict must not remove a valid denominator");
      assert.deepEqual(result.progress, { accepted: 0, total: 1 }, "matched receipt cannot cache acceptance through quarantined snapshot support");
      assert.deepEqual(result.errors, []); assert.deepEqual(result.problems, expected.problems); assert.deepEqual(result.conflicts, expected.conflicts);
      assert.equal(result.claims.length, 1); assert.equal(result.claims[0].applicability, "unresolved");
      assert.deepEqual(result.claims[0].matchedReceiptIds, ["receipt:support"]); assert.deepEqual(result.claims[0].problems, expected.problems);
      assert.equal(result.obligations[0].acceptance, "unresolved"); assert.deepEqual(result.obligations[0].problems, expected.problems);
      assert.equal(result.obligations[0].evidenceCoverage.state, "available"); assert.deepEqual(result.runtime, healthy.runtime);
      const index = indexWorkLedgerText(text); assert.deepEqual(index.quarantinedRevisions, []);
      assertDeepFrozen(index.conflictSources);
      assert.deepEqual(index.conflictSources, indexWorkLedgerText(fixtureText([...parseWorkLedgerText(text).events].reverse())).conflictSources);
      assert.deepEqual(Object.values(index.conflictSources.events).flat().map(e => e.digest).sort(), groups.flat().map(e => e.digest).sort());
      assert.ok(index.effectiveEvents.some(e => e.digest === f.base.snapshot.digest));
      assert.equal(index.effectiveEvents.some(e => e.digest === f.support.digest || e.digest === f.referenceAlias.digest), false);
      assertDeepFrozen(result); return result;
    }
    const reference = check(input);
    for (const order of permutations(groups.flat())) for (const seq of [[...f.events, ...order].reverse(), [...order, ...f.events, ...order, f.support, f.referenceAlias]]) {
      assert.deepEqual(check(fixtureText(seq)), reference);
    }
    const detached = projectWorkLedger(input, ctx), serialized = JSON.stringify(detached);
    assert.equal(JSON.stringify(ctx), savedContext); ctx.authority!.decisions[1].decision = "reject";
    assert.equal(JSON.stringify(detached), serialized); assert.equal(fixtureText(f.events), original); assertDeepFrozen(healthy);
  });
  await t.test("same logical support ID and scope with another digest stays local", async () => {
    const f = supportQuarantineFixture(), ctx = supportQuarantineAuthority(), healthy = projectWorkLedger(fixtureText(f.events), ctx);
    if (f.support.event !== "work_snapshot") throw Error("fixture kind");
    const { digest: _, ...body } = mutableFixture(f.support.payload.snapshot);
    const other = buildWorkSnapshotEvent({ eventId: "support:other", now, snapshot: { ...body, revisions: [fixtureRevisionRef(f.base.policy)] } });
    assert.equal(other.payload.snapshot.snapshotId, body.snapshotId); assert.notEqual(other.payload.snapshot.digest, f.support.payload.snapshot.digest);
    const group = [delivery(other, "support:outside"), delivery(other, "support:outside", 2, true)];
    for (const order of permutations([other, ...group])) {
      const result = projectWorkLedger(fixtureText([...order, ...f.events, ...order]), ctx);
      assert.deepEqual(result, { ...healthy, conflicts: [{ kind: "event", id: group[0].eventId, digests: group.map(e => e.digest).sort(), affectedObligations: [] }] });
    }
  });
  await t.test("unsupported sibling is local but trusted current conflicted support blocks", async () => {
    const f = supportQuarantineFixture(), ctx = supportQuarantineAuthority();
    const group = [delivery(f.support, "support:mixed"), delivery(f.support, "support:mixed", 2, true)];
    const input = fixtureText([...f.events, f.base.claim, ...group]);
    const untrusted = mutableFixture(ctx); untrusted.authority!.decisions = untrusted.authority!.decisions.filter(d => d.receiptId !== "receipt:support");
    const result = projectWorkLedger(input, untrusted), dir = await tempDir("support-quarantine-mixed-");
    await writeFile(join(dir, "receipt.json"), JSON.stringify({ input, context: untrusted, result }, null, 2));
    assert.deepEqual(result.progress, { accepted: 1, total: 1 }); assert.equal(result.obligations[0].acceptance, "accepted-under-supplied-authority");
    assert.deepEqual(result.obligations[0].problems, []); assert.equal(result.claims.find(c => c.claim.eventId === f.base.claim.eventId)!.applicability, "accepted-under-supplied-authority");
    const unsupported = result.claims.find(c => c.claim.eventId === f.claim.eventId)!;
    assert.equal(unsupported.applicability, "unresolved"); assert.deepEqual(unsupported.matchedReceiptIds, []);
    assert.ok(unsupported.problems.some(p => p.code === "RECEIPT_MISSING"));
    assert.ok(unsupported.problems.some(p => p.code === "EVENT_CONFLICT"), "local support diagnostics still name the conflict without a global veto");
    assert.deepEqual(result.conflicts[0].affectedObligations, []);
    const trusted = projectWorkLedger(input, ctx); assert.deepEqual(trusted.progress, { accepted: 0, total: 1 });
    assert.ok(trusted.claims.every(c => c.applicability === "unresolved")); assert.deepEqual(trusted.conflicts[0].affectedObligations, [fixtureRevisionRef(f.base.obligation)]);
  });
  for (const kind of ["revision", "occurrence"] as FixtureSupportKind[]) await t.test(`existing ${kind} alias semantics stay consistent`, async () => {
    const f = supportQuarantineFixture(kind), ctx = supportQuarantineAuthority(kind), healthy = projectWorkLedger(fixtureText(f.events), ctx);
    assert.deepEqual(healthy.progress, { accepted: 1, total: 1 });
    const group = [delivery(f.support, `support:${kind}:shadow`), delivery(f.support, `support:${kind}:shadow`, 2, true)];
    for (const order of permutations(group)) {
      const input = fixtureText([...order, ...f.events, ...order]), result = projectWorkLedger(input, ctx);
      assert.equal(result.scopeState, "valid"); assert.deepEqual(result.progress, { accepted: 0, total: 1 });
      assert.deepEqual(result.claims[0].matchedReceiptIds, ["receipt:support"]);
      assert.deepEqual(result.conflicts, diagnostics([group], fixtureRevisionRef(f.base.obligation)).conflicts);
      assert.ok(result.claims[0].problems.every(p => p.code === "EVENT_CONFLICT"));
    }
  });
  await t.test("acceptance payload copies do not invent a nested quarantine identity", () => {
    const f = supportQuarantineFixture("acceptance"), ctx = supportQuarantineAuthority("acceptance");
    const healthy = projectWorkLedger(fixtureText(f.events), ctx); assert.deepEqual(healthy.progress, { accepted: 1, total: 1 });
    assert.notEqual(f.support.digest, f.referenceAlias.digest); assert.deepEqual(f.support.payload, f.referenceAlias.payload);
    const group = [delivery(f.support, "support:acceptance-shadow"), delivery(f.support, "support:acceptance-shadow", 2, true)];
    const result = projectWorkLedger(fixtureText([...f.events, ...group]), ctx);
    assert.deepEqual(result.progress, { accepted: 1, total: 1 }); assert.deepEqual(result.problems, healthy.problems);
    assert.deepEqual(result.claims, healthy.claims); assert.deepEqual(result.conflicts[0].affectedObligations, []);
    const index = indexWorkLedgerText(fixtureText([...f.events, ...group]));
    assert.ok(index.effectiveEvents.some(e => e.digest === f.support.digest)); assert.ok(index.effectiveEvents.some(e => e.digest === f.referenceAlias.digest));
    assert.deepEqual(index.conflictSources.bodies, {}, "distinct acceptance events never receive a nested body identity");
  });
});

test("work-v4 exact I/O classifications preserve late partial bytes and descriptor identity", async t => {
  for (const fault of ["preflight", "resolution", "open", "read", "write", "partial", "descriptor", "swap", "alias-after-open", "alias-swap"]) {
    const dir = await tempDir("work-fault-"), path = join(dir, "work"), grant = join(dir, "grant");
    const original = fault === "read" ? "{broken\n" : fixtureText([walkingFixture().scope]); await writeFile(path, original);
    const result = await appendChild(t, path, fault, "append", fault.startsWith("alias-") ? grant : null).result;
    const code = ["descriptor", "swap"].includes(fault) ? "WORK_DESTINATION_INVALID" : fault.startsWith("alias-") ? "WORK_DESTINATION_ALIAS" : "WORK_LEDGER_WRITE_FAILED";
    assert.deepEqual(result, { ok: false, hit: true, name: "WorkLedgerWriteError", code }, fault);
    if (fault === "swap" || fault === "alias-swap") { assert.equal(await readFile(path, "utf8"), "replacement"); assert.equal(await readFile(fault === "swap" ? path + ".displaced" : grant, "utf8"), original); }
    else assert.equal(await readFile(path, "utf8"), original + (fault === "partial" ? "{partial" : ""));
    if (fault === "partial") {
      await assert.rejects(appendWorkLedgerEvent({ path, grantLedgerPath: null }, walkingFixture().scope), inputCode("WORK_JSON_INVALID"));
      assert.equal((await inspectWorkLedger({ version: 4, path })).ingestion!.complete, false);
      assert.equal(await readFile(path, "utf8"), original + "{partial");
    }
    if (fault === "alias-after-open") assert.equal(await readFile(grant, "utf8"), original);
    assert.equal(existsSync(path + ".lock"), false);
  }
  const closeDir = await tempDir("work-close-fault-"), closePath = join(closeDir, "work"); await writeFile(closePath, "{broken\n");
  assert.deepEqual(await appendChild(t, closePath, "close-on-corrupt").result,
    { ok: false, hit: true, name: "WorkInputError", code: "WORK_JSON_INVALID" });
  assert.equal(await readFile(closePath, "utf8"), "{broken\n");
  for (const fault of ["open", "read", "grow"]) {
    const dir = await tempDir("inspect-fault-"), path = join(dir, "work"); await writeFile(path, "\n");
    const result = await appendChild(t, path, fault, "inspect").result;
    assert.equal(result.hit, true); assert.equal(result.inspection.status, "error"); assert.equal(result.inspection.exists, true);
    assert.equal(result.inspection.ingestion, null); assert.equal(result.inspection.projection, null);
    assert.deepEqual(result.inspection.errors, [{ line: null, code: fault === "grow" ? "WORK_LIMIT_EXCEEDED" : "WORK_INSPECTION_READ_FAILED" }]);
  }
});

test("active work-v4 validation cannot lose its lock by age", { timeout: 25000 }, async t => {
  const dir = await tempDir("work-paused-"), path = join(dir, "work"), good = walkingFixture().scope;
  const line = canonicalWorkJson(good) + "\n", padding = " ".repeat(byteLimit - Buffer.byteLength(line) - 1) + "\n";
  await writeFile(path, padding);
  const a = appendChild(t, path, "pause"); await a.paused;
  const token = await readFile(path + ".lock", "utf8");
  while (Date.now() - (await stat(path + ".lock")).mtimeMs <= STALE_LOCK_MS + 100) await new Promise(r => setTimeout(r, 100));
  const age = Date.now() - (await stat(path + ".lock")).mtimeMs; assert.ok(age > STALE_LOCK_MS); t.diagnostic(`observed live lock age ${Math.floor(age)}ms`);
  const b = await appendChild(t, path).result;
  assert.deepEqual(b, { ok: false, hit: false, name: "WorkLedgerWriteError", code: "WORK_LEDGER_WRITE_FAILED" });
  assert.equal(await readFile(path + ".lock", "utf8"), token); assert.equal(await readFile(path, "utf8"), padding);
  a.release(); assert.deepEqual(await a.result, { ok: true, hit: true });
  assert.equal(await readFile(path, "utf8"), padding + line);
  await assert.rejects(appendWorkLedgerEvent({ path, grantLedgerPath: null }, good), inputCode("WORK_LIMIT_EXCEEDED"));
  assert.equal((await inspectWorkLedger({ version: 4, path })).ingestion!.complete, true);
  const orphan = join(dir, "orphan"); await writeFile(orphan + ".lock", "fixture orphan\n");
  const old = new Date(Date.now() - STALE_LOCK_MS - 1000); await utimes(orphan + ".lock", old, old);
  await assert.rejects(appendWorkLedgerEvent({ path: orphan, grantLedgerPath: null }, good), writeCode("WORK_LEDGER_WRITE_FAILED"));
  assert.equal(await readFile(orphan + ".lock", "utf8"), "fixture orphan\n"); assert.equal(existsSync(orphan), false);
});

test("work-v4 inspection reports a disappeared open target as missing without losing stage diagnostics", async t => {
  const dir = await tempDir("inspect-races-"), path = join(dir, "work"); await writeFile(path, "preserve");
  const gone = await appendChild(t, path, "gone", "inspect").result;
  assert.equal(gone.hit, true);
  assert.deepEqual(gone.inspection, { version: 4, status: "missing", exists: false, ingestion: null, projection: null, errors: [] });
  assert.equal(await readFile(path + ".gone", "utf8"), "preserve");
  await writeFile(path, "preserve");
  const denied = await appendChild(t, path, "stat", "inspect").result;
  assert.equal(denied.hit, true); assert.equal(denied.inspection.exists, null);
  assert.deepEqual(denied.inspection.errors, [{ line: null, code: "WORK_INSPECTION_READ_FAILED" }]);
  const descriptor = await appendChild(t, path, "descriptor", "inspect").result;
  assert.equal(descriptor.hit, true); assert.equal(descriptor.inspection.exists, true);
  assert.deepEqual(descriptor.inspection.errors, [{ line: null, code: "WORK_INSPECTION_NOT_REGULAR" }]);
  const alias = await appendChild(t, path, "preflight", "append", path).result;
  assert.deepEqual(alias, { ok: false, hit: false, name: "WorkLedgerWriteError", code: "WORK_DESTINATION_ALIAS" });
});

test("work-v4 sockets symlink cycles and empty regular locks retain exact topology or busy classifications", async t => {
  for (const sidecar of [false, true]) {
    const dir = await tempDir("work-socket-"), path = join(dir, "work"), socket = path + (sidecar ? ".lock" : "");
    const child = appendChild(t, socket, "none", "socket"); await child.paused;
    assert.equal((await stat(socket)).isSocket(), true);
    await assert.rejects(appendWorkLedgerEvent({ path, grantLedgerPath: null }, walkingFixture().scope), writeCode("WORK_DESTINATION_INVALID"));
    const inspected = await inspectWorkLedger({ version: 4, path: socket });
    assert.deepEqual(inspected.errors, [{ line: null, code: "WORK_INSPECTION_NOT_REGULAR" }]);
    child.release(); assert.deepEqual(await child.result, { ok: true, hit: true });
  }
  const dir = await tempDir("work-cycle-"), cycle = join(dir, "cycle"); await symlink(cycle, cycle);
  await assert.rejects(appendWorkLedgerEvent({ path: join(cycle, "work"), grantLedgerPath: null }, walkingFixture().scope), writeCode("WORK_DESTINATION_INVALID"));
  const busy = join(dir, "busy"); await writeFile(busy + ".lock", "");
  await assert.rejects(appendWorkLedgerEvent({ path: busy, grantLedgerPath: null }, walkingFixture().scope), writeCode("WORK_LEDGER_WRITE_FAILED"));
  assert.equal(await readFile(busy + ".lock", "utf8"), ""); assert.equal(existsSync(busy), false);
});
