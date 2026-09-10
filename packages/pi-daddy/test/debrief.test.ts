import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
import { harnessFixture, attentionFixture } from "./debrief-host-fixture.ts";
import { createDebriefPresenter } from "../src/debrief.ts";
import { openOrReuseDashboard } from "../src/dashboard-herdr.ts";
import { dashboardFrame, dashboardDebriefAction, ENV_DEBRIEF_FIXTURE } from "../src/dashboard-cli.ts";
import { createFixtureDebrief } from "../src/debrief-fixture.ts";
import { byteDigest, reviewPage } from "../src/debrief-contract.ts";
async function fixture() {
  const root = await tempDir("p08-debrief-"); await chmod(root, 0o700);
  const host = await harnessFixture(root), persistence = attentionFixture(host.archiveRoot);
  let calls = 0;
  const reviewer = { ...host.reviewer, decide: (r: any) => { calls++; return host.reviewer.decide(r); } };
  const options = { scope: `fixture-pause:${host.batchId}`, operatorIdentity: "operator:fixture", reviewer, blind: host.blind, persistence, fixture: true };
  return { root, host, persistence, options, presenter: createDebriefPresenter(options), calls: () => calls };
}
const open = (p: ReturnType<typeof createDebriefPresenter>) => p.open({ mode: "manual", userPresent: true });

test("seven real retained incidents get only four short case cards plus one blind slot, including reopens", async () => {
  const f = await fixture(), p = f.presenter; await open(p);
  const first = p.view(); assert.equal(first.total, 7); assert.equal(first.cards.length, 5); assert.equal(first.unexposed, 3);
  assert.equal(first.cards.filter(c => c.kind === "case").length, 4); assert.equal(first.cards.filter(c => c.kind === "blind").length, 1);
  for (let i = 0; i < 3; i++) { p.close(); await open(p); assert.deepEqual(p.view().cards.map(c => c.slot), [1, 2, 3, 4, 5]); }
  const hidden = f.host.reviewer.list(4, 1).items[0];
  await assert.rejects(p.label({ caseManifestId: hidden.caseManifestId, priorDecisionId: null, disposition: "skip", note: "not exposed" }), /not exposed/);
  const reopened = createDebriefPresenter(f.options); assert.equal(reopened.view().remainingBudget, null); await open(reopened);
  assert.deepEqual(reopened.view().cards, first.cards); assert.equal(f.calls(), 0);
  const rendered = await dashboardFrame({ cwd: f.root, debrief: reopened }); assert.match(rendered, /MANUAL DEBRIEF/); assert.match(rendered, /5\/5/);
});

test("weekly continuation needs another explicit host budget; changing offset cannot refill the same pause", async () => {
  const f = await fixture(); await open(f.presenter);
  const invalid = createDebriefPresenter({ ...f.options, offset: 4 }); await open(invalid); assert.equal(invalid.view().cards.length, 0);
  const root = join(f.host.archiveRoot, "next-manual-budget"); await mkdir(root, { mode: 0o700 });
  const next = createDebriefPresenter({ ...f.options, scope: f.options.scope + ":next", offset: 4, persistence: attentionFixture(root) }); await open(next);
  const before = f.presenter.view().cards.filter(c => c.kind === "case").map(c => c.caseManifestId);
  const after = next.view().cards.filter(c => c.kind === "case").map(c => c.caseManifestId);
  assert.equal(after.length, 3); assert.ok(after.every(id => !before.includes(id))); assert.equal(next.view().cards.length, 4);
});

test("repeated/transient agent_end and claimed pauses cannot authorize automatic exposure; absent/busy manual defers", async () => {
  const f = await fixture();
  for (const boundary of ["agent-end", "agent-end", "idle", "file-tail", "unknown", "verified-closing"]) {
    const v = await f.presenter.open({ mode: "automatic", userPresent: true, boundary }); assert.equal(v.cards.length, 0); assert.match(v.state, /deferred/);
  }
  for (const input of [{ mode: "manual" as const, userPresent: false }, { mode: "manual" as const, userPresent: true, boundary: "busy" }]) assert.equal((await f.presenter.open(input)).cards.length, 0);
  assert.equal(await f.persistence.load(), null); assert.equal(f.calls(), 0);
});

test("real existing action seam writes one harness-owned skip; unanswered and skip remain unresolved across reopen", async () => {
  const f = await fixture(); await open(f.presenter); const card = f.presenter.view().cards[0]; assert.equal(card.kind, "case"); if (card.kind !== "case") return;
  const request = { caseManifestId: card.caseManifestId, priorDecisionId: card.priorDecisionId, disposition: "skip" as const, note: "not enough context" };
  await dashboardDebriefAction(f.presenter, "label 1 skip not enough context");
  assert.equal(f.calls(), 1); assert.equal(await f.presenter.label(request), "recorded"); assert.equal(f.calls(), 1);
  assert.equal(f.host.reviewer.history(card.caseManifestId).length, 1);
  const p = createDebriefPresenter({ ...f.options, reviewer: f.host.review.createWorkCaseReviewer(f.host.archiveRoot, f.host.batchId, "operator:fixture"), persistence: attentionFixture(f.host.archiveRoot) }); await open(p);
  const cards = p.view().cards.filter(c => c.kind === "case"); assert.equal(cards[0].disposition, "skip"); assert.ok(cards.every(c => c.resolution === "unresolved"));
  assert.equal(p.view().cards.length, 5); assert.equal(p.view().unexposed, 3);
});

test("stale/unknown acknowledgement never becomes agreement; reconciliation reads actual history without resending", async () => {
  const f = await fixture();
  const reviewer = { ...f.host.reviewer, decide: (r: any) => { f.host.reviewer.decide(r); throw new Error("owned transport lost acknowledgement"); } };
  const p = createDebriefPresenter({ ...f.options, reviewer }); await open(p);
  const card = p.view().cards[0]; if (card.kind !== "case") throw new Error("case expected");
  const r = { caseManifestId: card.caseManifestId, priorDecisionId: null, disposition: "confirmed_defect" as const, note: "owned explicit label" };
  assert.equal(await p.label(r), "unknown"); assert.equal((p.view().cards[0] as any).resolution, "unresolved");
  assert.equal(await p.reconcile(card.caseManifestId), "recorded"); assert.equal(f.host.reviewer.history(card.caseManifestId).length, 1);
  const g = await fixture(); await open(g.presenter); const second = g.presenter.view().cards[0]; if (second.kind !== "case") throw new Error("case expected");
  g.host.reviewer.decide({ caseManifestId: second.caseManifestId, priorDecisionId: null, disposition: "uncertain", note: "other explicit host decision" });
  assert.equal(await g.presenter.label({ caseManifestId: second.caseManifestId, priorDecisionId: null, disposition: "exemplar", note: "stale UI" }), "unknown");
  assert.equal(await g.presenter.reconcile(second.caseManifestId), "stale-or-unknown"); assert.equal((g.presenter.view().cards[0] as any).resolution, "unresolved");
});

test("operator attribution is independent host input, never inferred from case or receipt-shaped values", async () => {
  const f = await fixture(), p = createDebriefPresenter({ ...f.options, operatorIdentity: undefined }); await open(p);
  assert.ok(p.view().cards.filter(c => c.kind === "case").every(c => !c.actionEnabled));
  const g = await fixture(), mismatch = createDebriefPresenter({ ...g.options, operatorIdentity: "different:host" }); await open(mismatch);
  const card = mismatch.view().cards[0]; if (card.kind !== "case") throw new Error("case expected");
  assert.equal(await mismatch.label({ caseManifestId: card.caseManifestId, priorDecisionId: null, disposition: "exemplar", note: "same text is not same author" }), "stale-or-unknown");
  assert.equal((mismatch.view().cards[0] as any).resolution, "unresolved");
});

test("actual P12 blind API reads retained artifacts by opaque label; quality precedes reveal and changes lock", async () => {
  const f = await fixture(); await open(f.presenter); const before = f.presenter.view();
  assert.equal(JSON.stringify(before).includes('"configuration"'), false); assert.equal(JSON.stringify(before).includes("fixture:a"), false);
  assert.equal(JSON.stringify(before).includes("Synthetic Layout A"), false); assert.equal(JSON.stringify(before).includes("artifact-"), false);
  await assert.rejects(f.presenter.reveal(), /quality choice/);
  const blind = before.cards.find(c => c.kind === "blind"); if (blind?.kind !== "blind") throw new Error("blind expected");
  await dashboardDebriefAction(f.presenter, `choose tie ${blind.variants.map(v => v.label).join(" ")}`);
  assert.equal(JSON.stringify(f.presenter.view()).includes('"configuration"'), false);
  await dashboardDebriefAction(f.presenter, "reveal"); assert.equal(JSON.stringify(f.presenter.view()).includes("fixture:a"), true);
  await assert.rejects(f.presenter.choose({ kind: "none", labels: [] }), /locked/);
  assert.equal(f.presenter.view().cards.length, 5);
  f.presenter.close(); const p = createDebriefPresenter(f.options); await open(p);
  await assert.rejects(p.reveal(), /confirmed quality/); await p.choose({ kind: "tie", labels: blind.variants.map(v => v.label) }); await p.reveal();
});

test("none acceptable and insufficient evidence are valid choices; unselected is not a vote", async () => {
  for (const kind of ["none", "insufficient"] as const) {
    const p = await createFixtureDebrief(); await open(p); const card = p.view().cards.at(-1) as any; assert.equal(card.choice, null);
    await dashboardDebriefAction(p, `choose ${kind}`); await dashboardDebriefAction(p, "reveal");
    assert.equal((p.view().cards.at(-1) as any).choice.kind, kind);
  }
});

test("missing callbacks disable label actions; failed persistence prevents host write and cannot mint a fresh budget", async () => {
  const f = await fixture(), noWriter = createDebriefPresenter({ ...f.options, reviewer: { list: f.host.reviewer.list, history: f.host.reviewer.history } });
  await open(noWriter); assert.ok(noWriter.view().cards.filter(c => c.kind === "case").every(c => !c.actionEnabled));
  await assert.rejects(dashboardDebriefAction(noWriter, "label 1 exemplar yes"), /writer/);
  const g = await fixture(); const store = { ...g.persistence, compareAndSwap: async () => { throw new Error("required host checkpoint refused"); } };
  const p = createDebriefPresenter({ ...g.options, persistence: store }); await open(p);
  assert.equal(p.view().cards.length, 0); await assert.rejects(open(p), /persistence unknown/); assert.equal(g.calls(), 0);
  const falseAck = createDebriefPresenter({ ...g.options, persistence: { durability: "host-owned", load: () => null, compareAndSwap: () => undefined } });
  await open(falseAck); assert.equal(falseAck.view().cards.length, 0); assert.equal(falseAck.view().budgetSpent, null); assert.equal(g.calls(), 0);
});

test("snapshot/render/CLI viewing leaves owned control/session bytes and message count unchanged", async () => {
  const f = await fixture(); const session = join(f.root, "session.jsonl"), control = join(f.root, "control.jsonl");
  await writeFile(session, '{"message":"only owned fixture message"}\n'); await writeFile(control, "owned control fixture\n");
  const before = [await readFile(session), await readFile(control)]; await open(f.presenter);
  for (let i = 0; i < 3; i++) await dashboardFrame({ cwd: f.root, debrief: f.presenter });
  const cli = new URL("../src/dashboard-cli.ts", import.meta.url).pathname;
  for (let i = 0; i < 2; i++) {
    const out = await promisify(execFile)(process.execPath, [cli, "--once", "--debrief-fixture", "--debrief-json"], { cwd: f.root, env: { PATH: "", HOME: f.root, TMPDIR: f.root, PI_CODING_AGENT_DIR: f.root }, timeout: 10000 });
    const frame = JSON.parse(out.stdout); assert.equal(frame.cards.length, 5); assert.equal(frame.fixture, true);
  }
  assert.deepEqual([await readFile(session), await readFile(control)], before); assert.equal((await readFile(session, "utf8")).trim().split("\n").length, 1); assert.equal(f.calls(), 0);
});

test("existing plugin-open seam forwards only the explicit fixture flag; same pause cannot replace blind slot with a fifth case", async () => {
  const f = await fixture(); await open(f.presenter); f.presenter.close(); assert.equal(f.presenter.view().budgetSpent, 5);
  const changed = createDebriefPresenter({ ...f.options, blind: undefined }); await open(changed);
  assert.equal(changed.view().cards.length, 0); assert.equal(changed.view().remainingBudget, 0);
  const old = process.env[ENV_DEBRIEF_FIXTURE]; process.env[ENV_DEBRIEF_FIXTURE] = "1";
  const opens: string[][] = [], reply = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
  try {
    const ledgerPath = join(f.root, "owned-legacy-ledger.jsonl"); await writeFile(ledgerPath, "owned fixture ledger\n");
    await openOrReuseDashboard({ cwd: f.root, ledgerPath, statePath: join(f.root, "pane.json"), host: { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" }, exec: async args => {
      if (args[1] === "list") return reply({ plugins: [{ plugin_id: "pi-daddy.dashboard", version: "1.0.0", enabled: true }] });
      assert.deepEqual(args.slice(0, 3), ["plugin", "pane", "open"]); opens.push(args);
      return reply({ plugin_pane: { pane: { pane_id: "w1:p2", terminal_id: "fixture", tab_id: "w1:t1", workspace_id: "w1" } } });
    } });
    assert.ok(opens[0].includes(`${ENV_DEBRIEF_FIXTURE}=1`));
  } finally { if (old === undefined) delete process.env[ENV_DEBRIEF_FIXTURE]; else process.env[ENV_DEBRIEF_FIXTURE] = old; }
});

test("validated closed data refuses altered case identity and blind metadata before rendering", async () => {
  const f = await fixture(), page = f.host.reviewer.list(0, 4); page.items[0].candidate.id = "0".repeat(64); assert.throws(() => reviewPage(page, 4), /identity/);
  const p = createDebriefPresenter({ ...f.options, blind: { ...f.host.blind, view: () => ({ ...f.host.view, configuration: "leak" }) } });
  await open(p); assert.equal(p.view().cards.length, 0);
  const pins = JSON.parse(await readFile(new URL("../contracts/debrief/v1/provenance.json", import.meta.url), "utf8"));
  for (const pin of pins.records) assert.equal(byteDigest(await readFile(new URL(`../contracts/debrief/v1/${pin.target}`, import.meta.url))), pin.sha256);
});
