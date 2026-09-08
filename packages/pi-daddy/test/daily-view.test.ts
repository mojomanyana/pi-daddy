import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink, utimes, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
import { dailyFixture, dailyAuthority } from "./daily-view-fixture.ts";
import { fixtureText, fixtureEventRef, revisionRevalidationFixture } from "./work-ledger-fixtures.ts";
import { createDailyViewReader, readDailyView } from "../src/daily-view.ts";
import { renderDailyView } from "../src/daily-view-render.ts";
import { parseArchiveProjection } from "../src/daily-view-input.ts";
import { dashboardFrame, ENV_DAILY_ARCHIVE, ENV_DAILY_WORK, ENV_DAILY_SELECTION } from "../src/dashboard-cli.ts";
import { openOrReuseDashboard } from "../src/dashboard-herdr.ts";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const contract = new URL("../contracts/daily-view/v1/", import.meta.url);
async function fixture() {
  const dir = await tempDir("daily-view-"), workLedgerPath = join(dir, "work.jsonl"), archiveProjectionPath = join(dir, "archive.json");
  await writeFile(workLedgerPath, dailyFixture().text);
  await writeFile(archiveProjectionPath, await readFile(new URL("p03/fixtures/retained-executions.json", contract)));
  return { dir, workLedgerPath, archiveProjectionPath, workContext: dailyAuthority() };
}

test("P03 exact contract and P01 independent fixture authority yield two accepted of three, not three exits", async () => {
  const options = await fixture(), view = await readDailyView(options);
  assert.deepEqual(view.progress, { accepted: 2, total: 3 }); assert.equal(view.obligations[2].acceptance, "unaccepted");
  assert.equal(view.attempts.length, 6); assert.equal(view.obligations.every(o => o.attempts.length === 1), true);
  assert.equal(new Set(view.attempts.slice(0, 3).map(a => a.logicalChildId)).size, 1);
  assert.equal(new Set(view.attempts.slice(0, 3).map(a => a.executionId)).size, 3);
  assert.equal(view.attempts[2].archive!.outcome!.code, 0); assert.ok(view.attempts.every(a => a.activeBranch === null));
  assert.ok(view.attempts.every(a => a.sourceAvailability.every(s => s.state === "missing")));
  const text = await dashboardFrame({ cwd: options.dir, dailyView: options, width: 120 });
  assert.equal(text, renderDailyView(view, 120)); assert.match(text, /2\/3 accepted under supplied P01 authority/);
  assert.match(text, /UNACCEPTED/); assert.match(text, /SNAPSHOT \/ UNKNOWN/); assert.match(text, /P01 matched receipts: fixed-receipt-1/);
  assert.ok(Object.isFrozen(view.obligations[0]));
});

test("unstarted intent, missing authority and disconnected models remain useful without approval inference", async () => {
  const options = await fixture(), f = dailyFixture();
  await writeFile(options.workLedgerPath, fixtureText(f.events.filter(e => e.eventId !== f.occurrences[2].eventId)));
  const view = await readDailyView(options); assert.equal(view.obligations[2].activity, "unstarted");
  const noAuthority = await readDailyView({ ...options, workContext: { selectedSnapshot: options.workContext.selectedSnapshot, authority: null } });
  assert.equal(noAuthority.progress, null); assert.ok(noAuthority.obligations.every(o => o.acceptance === "unresolved"));
  assert.equal(noAuthority.model, "not-consulted-connectivity-unknown");
  const unselected = await readDailyView({ ...options, workContext: undefined });
  assert.equal(unselected.progress, null); assert.equal(unselected.obligations.length, 0); assert.equal(unselected.attempts.length, 6);
  assert.match(renderDailyView(unselected), /EMPTY \/ UNRESOLVED/);
});

test("every read resnapshots; reconnect gaps and changed scope never inherit acceptance or mtime freshness", async () => {
  const options = await fixture(), read = createDailyViewReader(), first = await read(options);
  const old = await readFile(options.archiveProjectionPath);
  await unlink(options.archiveProjectionPath); const missing = await read(options);
  assert.equal(missing.sources.archive, "missing"); assert.ok(missing.attempts.every(a => a.archive === null));
  await writeFile(options.archiveProjectionPath, old); await utimes(options.archiveProjectionPath, new Date(0), new Date(0));
  const back = await read(options); assert.equal(back.continuity, "reconnected-gap"); assert.equal(back.freshness, "snapshot-unknown");
  const changed = revisionRevalidationFixture("scope"); await writeFile(options.workLedgerPath, fixtureText(changed.events));
  const selectedSnapshot = { snapshot: { id: changed.snapshot.payload.snapshot.snapshotId, digest: changed.snapshot.payload.snapshot.digest }, event: fixtureEventRef(changed.snapshot) };
  const next = await read({ ...options, workContext: { ...options.workContext, selectedSnapshot } });
  assert.equal(next.scopeChanged, true); assert.equal(next.progress, null); assert.equal(next.scope?.revision, 2);
  assert.equal(next.authority, "stale-for-selection"); assert.match(renderDailyView(next), /stale-for-selection/);
  assert.deepEqual(first.progress, { accepted: 2, total: 3 }, "historical result remains immutable");
});

test("missing source bytes, mismatches, invalid versions and conflicts cannot become recovered facts", async () => {
  const options = await fixture(), fixtureBytes = await readFile(new URL("../contracts/execution-retention/v2/fixtures/missing-native-session.json", import.meta.url));
  const projection = JSON.parse(await readFile(options.archiveProjectionPath, "utf8"));
  const sha = hash(fixtureBytes), path = join(options.dir, "source.bin");
  assert.equal(projection.executions[0].sourceReferences[0], sha); await writeFile(path, fixtureBytes);
  const supplied = { ...options, sourceManifestFiles: { [sha]: path } };
  assert.equal((await readDailyView(supplied)).attempts[0].sourceAvailability[0].state, "available");
  await writeFile(path, "changed"); assert.equal((await readDailyView(supplied)).attempts[0].sourceAvailability[0].state, "mismatch");
  await unlink(path); assert.equal((await readDailyView(supplied)).attempts[0].sourceAvailability[0].state, "missing");
  projection.version = "execution-archive-projection-v2"; await writeFile(options.archiveProjectionPath, JSON.stringify(projection));
  const invalid = await readDailyView(options); assert.equal(invalid.sources.archive, "error"); assert.ok(invalid.attempts.every(a => a.archive === null));
  projection.version = "execution-archive-projection-v1"; projection.executions.push(projection.executions[0]);
  assert.throws(() => parseArchiveProjection(JSON.stringify(projection)), /ambiguous/);
  assert.throws(() => parseArchiveProjection('{"version":"x","version":"y"}'), /duplicate/);
});

test("fresh host-declared evidence loss narrows acceptance without changing runtime exits", async () => {
  const options = await fixture(), before = await readDailyView(options);
  options.workContext.authority!.availability.find(a => a.id === "evidence-2")!.available = false;
  const after = await readDailyView(options);
  assert.deepEqual(after.progress, { accepted: 1, total: 3 }); assert.deepEqual(before.progress, { accepted: 2, total: 3 });
  assert.equal(after.attempts[1].archive!.outcome!.code, 0); assert.equal(after.obligations[1].evidenceCoverage, "unavailable");
});

test("real existing dashboard CLI reads snapshots without changing sessions, controls, messages or source files", async () => {
  const options = await fixture(), session = join(options.dir, "session.jsonl"), control = join(options.dir, "control.jsonl");
  await writeFile(session, '{"message":"before"}\n'); await writeFile(control, '{"gate":"pending"}\n');
  const paths = [session, control, options.workLedgerPath, options.archiveProjectionPath];
  const before = await Promise.all(paths.map(async p => hash(await readFile(p))));
  const entries = (await readdir(options.dir)).sort();
  const command = new URL("../src/dashboard-cli.ts", import.meta.url).pathname;
  for (let i = 0; i < 3; i++) {
    const result = await promisify(execFile)(process.execPath, [command, "--once", "--daily-json", "--archive-projection", options.archiveProjectionPath,
      "--work-ledger", options.workLedgerPath, "--work-snapshot", JSON.stringify(options.workContext.selectedSnapshot)], {
      cwd: options.dir, env: { PATH: "", HOME: options.dir, TMPDIR: options.dir, PI_CODING_AGENT_DIR: options.dir, PI_OFFLINE: "1" }, timeout: 10000,
    });
    const view = JSON.parse(result.stdout); assert.equal(view.version, "pi-daddy-daily-view-v1"); assert.equal(view.progress, null);
    assert.equal(view.obligations.length, 3); assert.equal(result.stderr, "");
  }
  assert.deepEqual(await Promise.all(paths.map(async p => hash(await readFile(p)))), before);
  assert.deepEqual((await readdir(options.dir)).sort(), entries);
  assert.equal((await readFile(session, "utf8")).trim().split("\n").length, 1);
});

test("existing plugin-open seam forwards only explicit read inputs and never reuses another selection", async () => {
  const options = await fixture(), names = [ENV_DAILY_ARCHIVE, ENV_DAILY_WORK, ENV_DAILY_SELECTION];
  const previous = names.map(name => process.env[name]);
  process.env[ENV_DAILY_ARCHIVE] = options.archiveProjectionPath; process.env[ENV_DAILY_WORK] = options.workLedgerPath;
  process.env[ENV_DAILY_SELECTION] = JSON.stringify(options.workContext.selectedSnapshot);
  const opens: string[][] = [];
  const reply = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
  try {
    const input = { cwd: options.dir, ledgerPath: join(options.dir, "legacy.jsonl"), statePath: join(options.dir, "pane-state.json"),
      host: { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" }, exec: async (args: string[]) => {
        if (args[1] === "list") return reply({ plugins: [{ plugin_id: "pi-daddy.dashboard", version: "1.0.0", enabled: true }] });
        assert.deepEqual(args.slice(0, 3), ["plugin", "pane", "open"]); opens.push(args);
        return reply({ plugin_pane: { pane: { pane_id: `w1:p${opens.length + 1}`, terminal_id: `terminal-${opens.length}`, tab_id: "w1:t1", workspace_id: "w1" } } });
      } };
    await openOrReuseDashboard(input);
    process.env[ENV_DAILY_SELECTION] = "null"; await openOrReuseDashboard(input);
    assert.equal(opens.length, 2); assert.ok(opens[0].includes(`${ENV_DAILY_ARCHIVE}=${options.archiveProjectionPath}`));
    assert.ok(opens[1].includes(`${ENV_DAILY_SELECTION}=null`));
    assert.notEqual(opens[0].find(s => s.startsWith("PI_DADDY_DASHBOARD_KEY=")), opens[1].find(s => s.startsWith("PI_DADDY_DASHBOARD_KEY=")));
    assert.ok(opens.flat().every(s => !s.includes("AUTHORITY=")));
  } finally { names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }); }
});

test("a caller-supplied reader callback cannot replace the dashboard's authority-aware projection", async () => {
  const options = await fixture(); let called = false;
  const text = await dashboardFrame({ cwd: options.dir, dailyView: {}, dailyReader: async () => { called = true; return readDailyView(options); } });
  assert.equal(called, false); assert.match(text, /DAILY VIEW UNAVAILABLE/);
});

test("committed view fixture is reproduced by the actual reader with independently fixed authority", async () => {
  const options = await fixture(), view = await readDailyView(options);
  assert.equal(JSON.stringify(view, null, 2) + "\n", await readFile(new URL("fixtures/view.json", contract), "utf8"));
  assert.equal(renderDailyView(view, 120) + "\n", await readFile(new URL("fixtures/view.txt", contract), "utf8"));
  assert.equal(await readFile(new URL(import.meta.resolve("pi-daddy/contracts/daily-view/v1/fixtures/view.json")), "utf8"), JSON.stringify(view, null, 2) + "\n");
});

test("terminal metadata is escaped, empty/error labels accessible and vendored bytes are hash pinned", async () => {
  const options = await fixture(), p = JSON.parse(await readFile(options.archiveProjectionPath, "utf8"));
  p.executions[0].issues.push("\u001b]2;injected\u0007\nSTEER"); await writeFile(options.archiveProjectionPath, JSON.stringify(p));
  const text = renderDailyView(await readDailyView(options)); assert.ok(!text.includes("\u001b")); assert.ok(!text.includes("\u0007"));
  const empty = await readDailyView({}); assert.match(renderDailyView(empty), /EMPTY/); assert.equal(empty.progress, null);
  const provenance = JSON.parse(await readFile(new URL("p03/provenance.json", contract), "utf8"));
  assert.equal(provenance.commit, "a311df8c991108ada7b6f4b901332232a78e9a44");
  for (const e of provenance.entries) assert.equal(hash(await readFile(new URL("p03/" + e.targetPath, contract))), e.sha256);
});
