import assert from "node:assert/strict";
import { after, test } from "node:test";
import fsPromises, { readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import {
  appendDeclaredWorkOccurrence,
  declareWork,
  loadDeclaredWork,
} from "../src/work-command.ts";
import { parseWorkLedgerText, projectWorkLedger } from "../src/work-ledger.ts";

after(cleanupTempDirs);

test("declareWork creates a selected obligation without retaining the outcome text", async () => {
  const cwd = await tempDir("work-command-");
  const declared = await declareWork({ cwd, id: "factory-c01", outcome: "Show a real task in Herdr" });
  const text = await readFile(declared.ledgerPath, "utf8");
  const stateText = await readFile(declared.statePath, "utf8");
  const loaded = await loadDeclaredWork(declared.statePath);

  assert.equal(parseWorkLedgerText(text).events.length, 5);
  assert.equal(projectWorkLedger(text, { selectedSnapshot: loaded!.selectedSnapshot, authority: null }).scopeState, "valid");
  assert.doesNotMatch(text + stateText, /Show a real task in Herdr/);
  assert.equal(loaded?.id, "factory-c01");
  assert.equal(loaded?.obligation.kind, "obligation");
});

test("same declaration and occurrence deliveries are idempotent; changed text under an id is refused", async () => {
  const cwd = await tempDir("work-command-idempotent-");
  const first = await declareWork({ cwd, id: "daily-task", outcome: "First outcome" });
  const repeated = await declareWork({ cwd, id: "daily-task", outcome: "First outcome" });
  assert.deepEqual(repeated, first);
  await assert.rejects(declareWork({ cwd, id: "daily-task", outcome: "Changed outcome" }), /already names a different outcome/);

  const occurrence = {
    executionId: "exec:00000000-0000-4000-8000-000000000101",
    parentExecutionId: null,
    childId: "d0.1",
    toolCallId: "call_123|fc_456",
    taskId: "task-1",
    workspaceId: null,
    definitionDigest: null,
    configurationDigest: "a".repeat(64),
    modelId: "openai-codex/gpt-5.6-sol",
    effortId: "medium",
    now: new Date("2026-09-11T02:00:00.000Z"),
  } as const;
  await appendDeclaredWorkOccurrence(first, occurrence, "starting");
  await appendDeclaredWorkOccurrence(first, occurrence, "starting");
  await appendDeclaredWorkOccurrence(first, occurrence, "completed");

  const ingestion = parseWorkLedgerText(await readFile(first.ledgerPath, "utf8"));
  assert.equal(ingestion.events.filter(event => event.event === "work_occurrence").length, 2);
  const projection = projectWorkLedger(await readFile(first.ledgerPath, "utf8"), {
    selectedSnapshot: first.selectedSnapshot,
    authority: null,
  });
  assert.equal(projection.runtime?.attempts.length, 1);
  assert.equal(projection.runtime?.attempts[0].state, "completed");
  const starting = ingestion.events.find(event => event.event === "work_occurrence" && event.payload.state === "starting");
  assert.equal(starting && starting.event === "work_occurrence" ? starting.payload.labels.modelId : null, "openai-codex/gpt-5.6-sol");
  assert.match(starting && starting.event === "work_occurrence" ? starting.payload.labels.toolCallId! : "", /^toolcall:[a-f0-9]{64}$/);
});

test("concurrent identical declarations serialize to one five-event graph", async () => {
  const cwd = await tempDir("work-command-concurrent-");
  const [a, b] = await Promise.all([
    declareWork({ cwd, id: "same", outcome: "One outcome" }),
    declareWork({ cwd, id: "same", outcome: "One outcome" }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(parseWorkLedgerText(await readFile(a.ledgerPath, "utf8")).events.length, 5);
});

test("a retry resumes the exact prepared timestamp after state publication interruption", async () => {
  const cwd = await tempDir("work-command-recovery-");
  const statePath = join(cwd, ".pi", "work-current.json"), original = fsPromises.rename; let failed = false;
  fsPromises.rename = (async (...args: Parameters<typeof fsPromises.rename>) => {
    if (!failed && String(args[1]) === statePath) { failed = true; throw new Error("fixture state publication interruption"); }
    return original(...args);
  }) as typeof fsPromises.rename;
  syncBuiltinESMExports();
  try { await assert.rejects(declareWork({ cwd, id: "recover", outcome: "Recover me" }), /fixture state publication/); }
  finally { fsPromises.rename = original; syncBuiltinESMExports(); }
  const recovered = await declareWork({ cwd, id: "recover", outcome: "Recover me" });
  assert.equal(parseWorkLedgerText(await readFile(recovered.ledgerPath, "utf8")).events.length, 5);
});

test("declaration refuses unsupported custom destinations instead of creating an unloadable selection", async () => {
  const cwd = await tempDir("work-command-custom-path-");
  await assert.rejects(declareWork({ cwd, id: "custom", outcome: "Custom", ledgerPath: "other.jsonl" } as any), /unsupported work declaration field/);
  await assert.rejects(declareWork({ cwd, id: "custom", outcome: "Custom", statePath: "other.json" } as any), /unsupported work declaration field/);
});

test("loadDeclaredWork fails closed for malformed or relocated state", async () => {
  const cwd = await tempDir("work-command-invalid-");
  const path = join(cwd, "work.json");
  await writeFile(path, "{}\n", "utf8");
  await assert.rejects(loadDeclaredWork(path), /invalid declared work state/);

  const declared = await declareWork({ cwd, id: "bound", outcome: "Bound" });
  const parsed = JSON.parse(await readFile(declared.statePath, "utf8"));
  parsed.ledgerPath = join(cwd, "elsewhere.jsonl");
  await writeFile(declared.statePath, JSON.stringify(parsed), "utf8");
  await assert.rejects(loadDeclaredWork(declared.statePath), /invalid declared work state/);
});
