import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  DASHBOARD_PROTOCOL_VERSION,
  dashboardFrame,
} from "../src/dashboard-cli.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("the installed-style symlink actually invokes the dashboard bin", async () => {
  const cwd = await tempDir("dashboard-bin-");
  const link = join(cwd, "pi-daddy-dashboard");
  await symlink(join(import.meta.dirname, "..", "src", "dashboard-cli.ts"), link);
  const output = execFileSync(process.execPath, [link, "--once", "--no-color"], { cwd, encoding: "utf8" });
  assert.match(output, /pi-daddy is missing or its ledger is inactive/);
});

test("a plugin opened before pi-daddy explains exact setup without modifying pi", async () => {
  const cwd = await tempDir("dashboard-setup-");
  const frame = await dashboardFrame({ cwd, color: false, width: 100 });
  assert.match(frame, /pi-daddy is missing or its ledger is inactive/i);
  assert.match(frame, /pi install npm:pi-daddy/);
  assert.match(frame, /export PI_GRANTS_LEDGER=/);
  assert.match(frame, /\/grants dashboard/);
});

test("an incompatible core/plugin protocol is loud and renders no guessed tree", async () => {
  const cwd = await tempDir("dashboard-protocol-");
  const frame = await dashboardFrame({
    cwd,
    ledgerPath: join(cwd, "ledger.jsonl"),
    protocol: DASHBOARD_PROTOCOL_VERSION + 1,
    color: false,
    width: 100,
  });
  assert.match(frame, /INCOMPATIBLE/);
  assert.match(frame, new RegExp(`plugin protocol ${DASHBOARD_PROTOCOL_VERSION}`));
  assert.match(frame, new RegExp(`core requested ${DASHBOARD_PROTOCOL_VERSION + 1}`));
  assert.doesNotMatch(frame, /No governed executions recorded/);
});

test("a configured ledger that does not exist yet remains a live empty view", async () => {
  const cwd = await tempDir("dashboard-empty-");
  const ledgerPath = join(cwd, ".pi", "grants.jsonl");
  const frame = await dashboardFrame({ cwd, ledgerPath, color: false, width: 100 });
  assert.match(frame, /No governed executions recorded yet/);
  assert.match(frame, /waiting for ledger/);
});

test("a corrupt ledger is surfaced and never rewritten", async () => {
  const cwd = await tempDir("dashboard-corrupt-");
  const ledgerPath = join(cwd, ".pi", "grants.jsonl");
  await mkdir(join(cwd, ".pi"));
  const content = "{not-json\n";
  await writeFile(ledgerPath, content);
  const frame = await dashboardFrame({ cwd, ledgerPath, color: false, width: 100 });
  assert.match(frame, /1 corrupt line/);
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(ledgerPath, "utf8")), content);
});
