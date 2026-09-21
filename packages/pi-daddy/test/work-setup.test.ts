import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, stat, symlink, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import {
  recordWorkSetup,
  workSetup,
  loadWorkSetup,
  selectRecordedWork,
  workPresentation,
  listWorkSetups,
} from "../src/products/work-setup.ts";
import { loadDeclaredWork, appendDeclaredWorkOccurrence } from "../src/products/work-command.ts";
import { readProductJson, writeProductJson } from "../src/products/product-files.ts";
import { projectWorkLedger, parseWorkLedgerText } from "../src/governance/work-ledger.ts";
import { readDailyView } from "../src/products/daily-view.ts";
import { withOrdinaryChild } from "../extensions/ordinary-runtime.ts";
import type { GrantsSession } from "../extensions/session.ts";
import { supportedModelEfforts } from "../src/kernel/model-preflight.ts";
import { declaredWorkPath, workSetupsDir } from "../src/kernel/project-paths.ts";
after(cleanupTempDirs);
export function setup() {
  return workSetup({
    version: "work-setup-v1",
    id: "launch",
    outcome: "Ship a usable page",
    maxParallel: 2,
    tasks: [
      {
        id: "research",
        outcome: "Find requirements",
        agent: "reader",
        model: "provider/model-a",
        thinking: "low",
        dependencies: [],
      },
      {
        id: "review",
        outcome: "Review changes",
        agent: "reviewer",
        model: "provider/model-b",
        thinking: "high",
        dependencies: ["research"],
      },
    ],
  });
}

test("ordinary setup retains a selected multi-task DAG with exact private labels, profiles and unchanged P01 authority", async () => {
  const cwd = await tempDir("work-setup-");
  await mkdir(join(cwd, ".pi"), { mode: 0o755 });
  const recorded = await recordWorkSetup(cwd, setup());
  assert.equal((await stat(join(cwd, ".pi"))).mode & 0o777, 0o755);
  assert.equal(await loadDeclaredWork(declaredWorkPath(cwd)), null, "recording is not selection");
  const selected = await selectRecordedWork(recorded, null),
    loaded = await loadWorkSetup((await loadDeclaredWork(selected.statePath))!);
  assert.deepEqual(loaded?.setup, setup());
  assert.equal((await workPresentation(selected))?.outcome, setup().outcome);
  const bytes = await readFile(recorded.state.ledgerPath, "utf8"),
    p = projectWorkLedger(bytes, { selectedSnapshot: selected.selectedSnapshot, authority: null });
  assert.equal(p.scopeState, "valid");
  assert.equal(p.obligations.length, 2);
  assert.ok(p.obligations.every((o) => o.acceptance !== "accepted-under-supplied-authority"));
  assert.doesNotMatch(bytes, /Ship a usable page|Read requirements|provider\/model-a/);
  assert.equal(
    (await stat(join(workSetupsDir(cwd), `${recorded.state.selectedSnapshot.snapshot.digest}.json`))).mode & 0o777,
    0o600,
  );
  assert.equal((await listWorkSetups(cwd)).length, 1);
});

test("cycles, silent topology edits, changed metadata and unsafe local files refuse", async () => {
  const cyclic = setup();
  cyclic.tasks[0].dependencies = ["review"];
  assert.throws(() => workSetup(cyclic), /cycle/);
  assert.throws(() => workSetup({ ...setup(), maxParallel: 9 }), /parallel limit/);
  const cwd = await tempDir("work-scope-"),
    r = await recordWorkSetup(cwd, setup());
  await selectRecordedWork(r, null);
  const before = await readFile(r.state.ledgerPath, "utf8"),
    changed = setup();
  changed.tasks[1].dependencies = [];
  await assert.rejects(recordWorkSetup(cwd, changed, "revise", r.state), /topology changes require a new work/);
  assert.equal(await readFile(r.state.ledgerPath, "utf8"), before);
  const path = join(workSetupsDir(cwd), `${r.state.selectedSnapshot.snapshot.digest}.json`),
    metadata = (await readProductJson(path)) as any;
  metadata.setup.maxParallel = 1;
  await writeProductJson(path, metadata, true);
  await assert.rejects(loadWorkSetup(r.state), /labels are stale or mismatched/);
  const alias = join(cwd, "alias.json");
  await symlink(path, alias);
  await assert.rejects(readProductJson(alias), /private regular/);
  await chmod(path, 0o644);
  await assert.rejects(readProductJson(path), /private regular/);
});

test("scope and same-scope alternatives are retained, explicit, and loadable after selecting them", async () => {
  const cwd = await tempDir("work-revisions-"),
    r = await recordWorkSetup(cwd, setup());
  await selectRecordedWork(r, null);
  const alternative = setup();
  alternative.outcome = "Alternative page";
  alternative.tasks[1].thinking = "medium";
  const alt = await recordWorkSetup(cwd, alternative, "alternative", r.state);
  assert.equal(alt.state.scope.digest, r.state.scope.digest);
  assert.notEqual(alt.state.selectedSnapshot.snapshot.digest, r.state.selectedSnapshot.snapshot.digest);
  assert.equal(
    (await loadDeclaredWork(r.state.statePath))?.selectedSnapshot.snapshot.digest,
    r.state.selectedSnapshot.snapshot.digest,
  );
  await selectRecordedWork(alt, r.state.selectedSnapshot);
  assert.equal((await loadWorkSetup(alt.state))?.setup.tasks[1].thinking, "medium");
  const revised = { ...alternative, outcome: "Smaller page" },
    next = await recordWorkSetup(cwd, revised, "revise", alt.state);
  assert.equal(next.state.scope.revision, 2);
  assert.notEqual(next.state.scope.digest, alt.state.scope.digest);
  await selectRecordedWork(next, alt.state.selectedSnapshot);
  assert.equal((await loadWorkSetup(next.state))?.setup.outcome, "Smaller page");
  assert.equal((await listWorkSetups(cwd)).length, 3);
});

test("concurrent children bind their own obligations without mutating session selection; panel labels are observed not planned", async () => {
  const cwd = await tempDir("work-occurrences-"),
    r = await recordWorkSetup(cwd, setup());
  await selectRecordedWork(r, null);
  await Promise.all(
    r.tasks.map((task, i) =>
      appendDeclaredWorkOccurrence(
        { ...r.state, obligation: task.obligation },
        {
          executionId: `exec:00000000-0000-4000-8000-00000000000${i + 1}`,
          parentExecutionId: null,
          childId: `d0.${i + 1}`,
          variantId: null,
          toolCallId: null,
          taskId: null,
          workspaceId: null,
          definitionDigest: null,
          configurationDigest: null,
          modelId: `actual/model-${i}`,
          effortId: "medium",
          now: new Date("2026-09-14T00:00:00Z"),
        },
        "starting",
      ),
    ),
  );
  assert.equal((await loadDeclaredWork(r.state.statePath))?.obligation.digest, r.tasks[0].obligation.digest);
  const view = await readDailyView({
    workLedgerPath: r.state.ledgerPath,
    workContext: { selectedSnapshot: r.state.selectedSnapshot, authority: null },
  });
  assert.ok(view.obligations.every((o) => o.attempts.length === 1));
  assert.equal(view.attempts[0].modelId, "actual/model-0");
  assert.equal(view.attempts[1].effortId, "medium");
  assert.equal(parseWorkLedgerText(await readFile(r.state.ledgerPath, "utf8")).errors.length, 0);
});

test("scope rebound during approval cannot launch a pinned child under the new selection", async () => {
  const cwd = await tempDir("work-late-admission-"),
    r = await recordWorkSetup(cwd, setup());
  let calls = 0;
  const session = {
    declaredWork: {
      ...r.state,
      selectedSnapshot: {
        ...r.state.selectedSnapshot,
        snapshot: { ...r.state.selectedSnapshot.snapshot, digest: "f".repeat(64) },
      },
    },
  } as GrantsSession;
  const input = {
    session,
    declaredWork: r.state,
    executionId: "exec:00000000-0000-4000-8000-000000000001",
    parentExecutionId: null,
    childId: "d0.1",
  };
  await assert.rejects(
    withOrdinaryChild(input, async () => {
      calls++;
      return { ok: true, exitCode: 0, text: "done", granted: [], depth: 1 };
    }),
    /changed before original child admission/,
  );
  assert.equal(calls, 0);
});

test("effort authoring follows resolved catalogue support and never silently clamps", () => {
  assert.deepEqual(supportedModelEfforts({ reasoning: false }), ["off"]);
  assert.deepEqual(
    supportedModelEfforts({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: null,
      },
    }),
    ["low", "medium", "high", "xhigh"],
  );
  assert.ok(!supportedModelEfforts({ reasoning: true }).includes("max"));
});
