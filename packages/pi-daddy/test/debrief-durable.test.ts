import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { durableHarness, signalInputs, blindInputs, hash } from "./debrief-durable-fixture.ts";
import { attentionFixture } from "./debrief-host-fixture.ts";
import { createRetainedDebrief, openDebriefBlindPreview, retainDebriefBlind } from "../src/debrief-host.ts";
import { createDebriefPresenter } from "../src/debrief.ts";
import { reviewPage } from "../src/debrief-contract.ts";
import { renderDebrief, debriefAction } from "../src/debrief-render.ts";
after(cleanupTempDirs);
async function fixture(scopeValid = true) {
  const root = await tempDir("durable-debrief-"), h = await durableHarness(root), input = signalInputs(scopeValid);
  const observation = h.api.retainWorkSignalObservation(h.archiveRoot, input.snapshot, input.facts);
  const batch = h.api.captureWorkSignalCases(h.archiveRoot, observation.manifestId), author = "operator:fixture";
  const args = { archiveRoot: h.archiveRoot, scope: "explicit-week", author, cases: { version: "work-signals-v1" as const, batchId: batch.batchId, observationId: observation.manifestId }, persistence: attentionFixture(root) };
  return { ...h, root, input, observation, batch, author, args };
}
async function archiveSnapshot(root: string) {
  const entries: Record<string, string> = {};
  const walk = async (dir: string) => { for (const item of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, item.name); if (item.isDirectory()) await walk(p); else if (item.isFile()) entries[p] = hash(await readFile(p)); else throw new Error("unexpected fixture link");
  } }; await walk(root); return entries;
}

test("explicit case-v3 selected pages use actual writer/CAS, keep nine selected cases and five total slots", async () => {
  const f = await fixture(), raw = f.api.createWorkSignalReviewer(f.archiveRoot, f.batch.batchId, f.author);
  for (const offset of [0, 4, 8]) reviewPage(raw.list(offset, 4), 4, offset, f.args.cases);
  const bad = structuredClone(raw.list(0, 4)); bad.items[0].candidate.id = "f".repeat(64);
  assert.throws(() => reviewPage(bad, 4, 0, f.args.cases), /invalid case/);
  const wideFacts = { ...f.input.facts, violations: Array.from({ length: 256 }, (_, i) => ({ obligationDigest: f.input.snapshot.obligations[0].digest, status: "FAIL", evidence: hash("wide" + i) })) };
  const wideObs = f.api.retainWorkSignalObservation(f.archiveRoot, f.input.snapshot, wideFacts), wideBatch = f.api.captureWorkSignalCases(f.archiveRoot, wideObs.manifestId);
  const wide = f.api.createWorkSignalReviewer(f.archiveRoot, wideBatch.batchId, f.author); let maximum = 0;
  for (const offset of [0, 4, 8]) { const page = reviewPage(wide.list(offset, 4), 4, offset, { batchId: wideBatch.batchId, observationId: wideObs.manifestId }); for (const item of page.items) maximum = Math.max(maximum, (item.candidate.evidence as string[]).length); }
  assert.equal(maximum, 258, "all256 declared violations plus base evidence remain bound, not truncated");
  const blindInput = await blindInputs(f.api), binding = retainDebriefBlind(f.api, f.archiveRoot, blindInput, f.author);
  const p = createRetainedDebrief(f.api, { ...f.args, blind: binding });
  const frame = await p.open({ mode: "manual", userPresent: true }); assert.equal(frame.state, "open");
  assert.equal(frame.total, 9); assert.equal(frame.cards.length, 5); assert.equal(frame.unexposed, 5); assert.equal(frame.remainingBudget, 0);
  assert.equal(frame.observation!.id, f.observation.manifestId); assert.match(renderDebrief(frame), /selected-batch only/);
  const card = frame.cards.find(c => c.kind === "case")!; assert.equal(card.kind, "case");
  await debriefAction(p, `label ${card.slot} confirmed_defect explicit fixture label`);
  const labelled = p.view().cards[0]; assert.equal(labelled.kind === "case" && labelled.resolution, "label-recorded");
  const history = raw.history(card.caseManifestId); assert.equal(history.length, 1); assert.equal(history[0].author, f.author);
  assert.throws(() => raw.decide({ caseManifestId: card.caseManifestId, priorDecisionId: null, disposition: "skip", note: "stale" }), /stale/);
  await p.label({ caseManifestId: card.caseManifestId, priorDecisionId: null, disposition: "confirmed_defect", note: "explicit fixture label" }); assert.equal(raw.history(card.caseManifestId).length, 1);
  await assert.rejects(p.label({ caseManifestId: "f".repeat(64), priorDecisionId: null, disposition: "skip", note: "not selected" }), /not exposed/);
  p.close(); await p.open({ mode: "manual", userPresent: true }); assert.equal(p.view().budgetSpent, 5);
});

test("zero-card observation issues survive explicit v3 opt-in; old/wrong batches and checkpoint switches refuse", async () => {
  const f = await fixture(false), p = createRetainedDebrief(f.api, f.args), v = await p.open({ mode: "manual", userPresent: true });
  assert.equal(v.state, "open"); assert.equal(v.total, 0); assert.deepEqual(v.observation!.issues, ["scope-unresolved"]); assert.match(renderDebrief(v), /scope-unresolved/);
  assert.throws(() => f.api.createWorkCaseReviewer(f.archiveRoot, f.batch.batchId, f.author), /batch/);
  const old = createDebriefPresenter({ scope: "old", reviewer: f.api.createWorkSignalReviewer(f.archiveRoot, f.batch.batchId, f.author) });
  assert.match((await old.open({ mode: "manual", userPresent: true })).state, /unavailable/);
  const changed = { ...f.input.facts, version: "different" }, obs = f.api.retainWorkSignalObservation(f.archiveRoot, f.input.snapshot, changed), batch = f.api.captureWorkSignalCases(f.archiveRoot, obs.manifestId);
  const switched = createRetainedDebrief(f.api, { ...f.args, cases: { version: "work-signals-v1", batchId: batch.batchId, observationId: obs.manifestId } });
  assert.match((await switched.open({ mode: "manual", userPresent: true })).state, /unavailable/);
  assert.throws(() => createRetainedDebrief(f.api, { ...f.args, author: "" }), /author/);
  const wrong = createRetainedDebrief(f.api, { ...f.args, scope: "wrong", cases: { ...f.args.cases, observationId: "f".repeat(64) } });
  assert.match((await wrong.open({ mode: "manual", userPresent: true })).state, /unavailable/);
});

test("durable blind preview is read-only, private retention freezes inputs, and reconnect reads quality without reveal", async () => {
  const f = await fixture(), input = await blindInputs(f.api), binding = retainDebriefBlind(f.api, f.archiveRoot, input, f.author);
  const preview = openDebriefBlindPreview(f.api, f.archiveRoot, binding), before = await archiveSnapshot(f.archiveRoot);
  assert.deepEqual(Object.keys(preview).sort(), ["quality", "readArtifact", "view"]); const view: any = preview.view();
  assert.equal(preview.quality(), null); assert.ok(!JSON.stringify(view).match(/fixture:|cost|seed|proposer|judge|archive/));
  for (const c of view.cards) { const bytes = await preview.readArtifact(c.label, c.artifactDigests[0]); bytes.fill(0); assert.notEqual(hash(await preview.readArtifact(c.label, c.artifactDigests[0])), hash(bytes)); }
  assert.deepEqual(await archiveSnapshot(f.archiveRoot), before);
  input.evidence[0].cost = 999; for (const bytes of input.qualification.artifacts.values()) bytes.fill(0); assert.deepEqual(preview.view(), view);
  const p = createRetainedDebrief(f.api, { ...f.args, blind: binding }); await p.open({ mode: "manual", userPresent: true });
  await assert.rejects(p.reveal(), /quality/); await debriefAction(p, `choose one ${view.cards[0].label}`);
  const first: any = p.view().cards.at(-1); assert.equal(first.choiceConfirmed, true); assert.equal(first.revealed, null);
  const checkpoint = await f.args.persistence.load();
  const next = createRetainedDebrief(f.api, { ...f.args, blind: binding }); const opened = await next.open({ mode: "manual", userPresent: true });
  const restored: any = opened.cards.at(-1); assert.equal(restored.choiceConfirmed, true); assert.equal(restored.revealed, null); assert.deepEqual(await f.args.persistence.load(), checkpoint);
  assert.ok(!JSON.stringify(opened).match(/fixture:|"cost"|"seed"|"proposer"|"judge"/));
  await assert.rejects(next.choose({ kind: "one", labels: [view.cards[1].label] }), /locked/);
  assert.throws(() => f.api.openBlindIntervention(f.archiveRoot, binding.comparisonId, f.author).choose({ kind: "one", labels: [view.cards[1].label] }), /locked/);
  const child = `const{openBlindIntervention}=await import(${JSON.stringify(new URL("file:" + join(f.modules, "blind-intervention.js")).href)});const p=openBlindIntervention(${JSON.stringify(f.archiveRoot)},${JSON.stringify(binding.comparisonId)},${JSON.stringify(f.author)});console.log(JSON.stringify({view:p.view(),quality:p.quality()}));`;
  const restarted = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", child], { env: process.env, timeout: 5000 });
  assert.deepEqual(JSON.parse(restarted.stdout).quality, first.choice); assert.ok(!restarted.stdout.includes('"cost"'));
  await debriefAction(next, "reveal"); const revealed: any = next.view().cards.at(-1); assert.equal(revealed.revealed.arms.length, 2); assert.ok(revealed.revealed.arms.every((a: any) => a.cost < 999));
  assert.equal(next.view().budgetSpent, 5); assert.throws(() => openDebriefBlindPreview(f.api, f.archiveRoot, { ...binding, author: "other" }).view(), /author/);
});

test("missing original observation/foreign case and malformed original blind bytes cannot become decisions or reveal", async () => {
  const f = await fixture(), other = signalInputs(); other.facts.version = "other";
  const obs = f.api.retainWorkSignalObservation(f.archiveRoot, other.snapshot, other.facts), cases = f.api.captureWorkSignalCases(f.archiveRoot, obs.manifestId);
  const forged = f.api.retainArchiveSource(f.archiveRoot, { sourceId: `work-signal-batch-${f.observation.manifestId}`, parser: { id: "work-signal-batch", version: "1" }, retention: "exact", bytes: Buffer.from(JSON.stringify({ version: "work-signal-batch-v1", observationId: f.observation.manifestId, candidateIds: cases.candidateIds, visibility: "silent", promotion: "not-authorized" })) });
  const wrong = createRetainedDebrief(f.api, { ...f.args, cases: { ...f.args.cases, batchId: forged.manifestId } }); assert.match((await wrong.open({ mode: "manual", userPresent: true })).state, /unavailable/);
  const p = createRetainedDebrief(f.api, { ...f.args, scope: "valid" }), v = await p.open({ mode: "manual", userPresent: true }), card: any = v.cards[0];
  const path = join(f.archiveRoot, "objects", f.observation.inputSha256); await rename(path, path + ".preserved");
  assert.equal(await p.label({ caseManifestId: card.caseManifestId, priorDecisionId: null, disposition: "confirmed_defect", note: "missing source" }), "unknown");
  const input = await blindInputs(f.api), b = retainDebriefBlind(f.api, f.archiveRoot, input, f.author), pre = openDebriefBlindPreview(f.api, f.archiveRoot, b);
  const source = f.api.readArchiveSource(f.archiveRoot, b.comparisonId), bundle = join(f.archiveRoot, "objects", source.reference.sha256);
  await rename(bundle, bundle + ".preserved"); await writeFile(bundle, "{", { mode: 0o600 }); assert.throws(() => pre.quality(), /unavailable/); assert.throws(() => pre.view(), /unavailable/);
  assert.throws(() => f.api.openBlindIntervention(f.archiveRoot, b.comparisonId, f.author).reveal(), /unavailable/);
});

test("actual current v2 writer remains opt-in compatible and new signal writer refuses old batches", async () => {
  const f = await fixture(), candidate = f.api.buildWorkCapture({ detector: { id: "repeat", version: "1", population: "old" }, target: { kind: "work", snapshotDigest: hash("old"), obligationId: "old", obligationDigest: hash("old-o") }, classification: "candidate_defect", reason: "repeat_without_progress", metrics: { equivalentAttempts: 2 }, evidence: [hash("old-e")] });
  const id = f.api.retainWorkCandidate(f.archiveRoot, candidate), batch = f.api.retainArchiveSource(f.archiveRoot, { sourceId: "old-batch", parser: { id: "work-candidate-batch", version: "1" }, retention: "exact", bytes: Buffer.from(JSON.stringify({ version: "work-candidate-batch-v1", candidateIds: [id], visibility: "silent", promotion: "not-authorized" })) });
  assert.throws(() => f.api.createWorkSignalReviewer(f.archiveRoot, batch.manifestId, f.author), /unavailable|unsupported/);
  const p = createRetainedDebrief(f.api, { ...f.args, cases: { version: "work-case-v2", batchId: batch.manifestId } });
  const frame = await p.open({ mode: "manual", userPresent: true }); assert.equal(frame.state, "open"); assert.equal(frame.cards.length, 1); assert.equal(frame.observation, undefined);
  await debriefAction(p, "label 1 skip deferred"); assert.equal(p.view().budgetSpent, 1); const card: any = p.view().cards[0]; assert.equal(card.resolution, "unresolved");
});

test("failed durable quality sync is not success; reconnect reads original choice without replay or implicit reveal", async () => {
  const f = await fixture(), input = await blindInputs(f.api), b = retainDebriefBlind(f.api, f.archiveRoot, input, f.author);
  const p = createRetainedDebrief(f.api, { ...f.args, blind: b }); await p.open({ mode: "manual", userPresent: true });
  const card: any = p.view().cards.at(-1), choice = { kind: "one" as const, labels: [card.variants[0].label] };
  const original = { open: fs.openSync, sync: fs.fsyncSync }; let target = -1, failed = false;
  fs.openSync = ((...args: any[]) => { const fd = Reflect.apply(original.open, fs, args); if (String(args[0]) === join(f.archiveRoot, "blind-decisions", b.comparisonId, "choice.json")) target = fd; return fd; }) as typeof fs.openSync;
  fs.fsyncSync = (fd => { if (fd === target && !failed) { failed = true; throw new Error("owned quality sync failure"); } return original.sync(fd); }) as typeof fs.fsyncSync;
  syncBuiltinESMExports();
  try { await assert.rejects(p.choose(choice), /owned quality sync failure/); }
  finally { fs.openSync = original.open; fs.fsyncSync = original.sync; syncBuiltinESMExports(); }
  assert.equal(failed, true); assert.equal((p.view().cards.at(-1) as any).choiceConfirmed, false);
  const before = await archiveSnapshot(f.archiveRoot), next = createRetainedDebrief(f.api, { ...f.args, blind: b });
  const restored: any = (await next.open({ mode: "manual", userPresent: true })).cards.at(-1);
  assert.equal(restored.choiceConfirmed, true); assert.equal(restored.revealed, null); assert.deepEqual(restored.choice, choice);
  assert.deepEqual(await archiveSnapshot(f.archiveRoot), before);
  const artifactHash = input.evidence[0].artifactDigests[0], path = join(f.archiveRoot, "objects", artifactHash); await rename(path, path + ".preserved");
  await assert.rejects(next.reveal(), /unavailable/); assert.equal((next.view().cards.at(-1) as any).revealed, null);
});
