import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  DASHBOARD_PLUGIN_ID,
  inspectDashboardPlugin,
  openOrReuseDashboard,
  verifyHerdrHost,
} from "../src/dashboard-herdr.ts";
import { DASHBOARD_PROTOCOL_VERSION } from "../src/dashboard-cli.ts";
import type { HerdrExec } from "../src/herdr-cli.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const reply = (result: Record<string, unknown>) => ({
  code: 0,
  stdout: JSON.stringify({ id: "test", result }),
  stderr: "",
});

const hostedEnv = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p1",
  HERDR_TAB_ID: "w1:t1",
  HERDR_WORKSPACE_ID: "w1",
};

test("a reachable server is not evidence that this pi session is hosted in Herdr", async () => {
  let calls = 0;
  const exec: HerdrExec = async () => { calls += 1; return reply({ panes: [] }); };
  const result = await verifyHerdrHost({ env: {}, pid: 42, exec });
  assert.equal(result.ok, false);
  assert.match(result.diagnostic, /not hosted inside Herdr/i);
  assert.equal(calls, 0, "no server probe can upgrade absent pane identity into hosted");
});

test("host verification binds the Herdr pane to the actual pi process", async () => {
  const calls: string[][] = [];
  const exec: HerdrExec = async (args) => {
    calls.push(args);
    if (args[1] === "current") return reply({ pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } });
    return reply({ process_info: { pane_id: "w1:p1", foreground_processes: [{ pid: 4242, name: "pi", argv: ["pi"] }] } });
  };
  const result = await verifyHerdrHost({ env: hostedEnv, pid: 4242, exec });
  assert.equal(result.ok, true);
  assert.deepEqual(result.host, { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" });
  assert.deepEqual(calls, [
    ["pane", "current", "--pane", "w1:p1"],
    ["pane", "process-info", "--pane", "w1:p1"],
  ]);

  const wrong = await verifyHerdrHost({ env: hostedEnv, pid: 9999, exec });
  assert.equal(wrong.ok, false);
  assert.match(wrong.diagnostic, /does not contain this pi process/);
});

test("host verification rejects process information returned for another pane", async () => {
  const exec: HerdrExec = async (args) => args[1] === "current"
    ? reply({ pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } })
    : reply({ process_info: { pane_id: "w1:p9", foreground_processes: [{ pid: 42 }] } });
  const result = await verifyHerdrHost({ env: hostedEnv, pid: 42, exec });
  assert.equal(result.ok, false);
  assert.match(result.diagnostic, /process information.*another pane/i);
});

test("plugin discovery distinguishes absent, disabled, compatible and incompatible installs", async () => {
  const absent = await inspectDashboardPlugin(async () => reply({ plugins: [] }));
  assert.equal(absent.state, "absent");

  const disabled = await inspectDashboardPlugin(async () => reply({ plugins: [{ plugin_id: DASHBOARD_PLUGIN_ID, version: "1.0.0", enabled: false }] }));
  assert.equal(disabled.state, "disabled");

  const compatible = await inspectDashboardPlugin(async () => reply({ plugins: [{ plugin_id: DASHBOARD_PLUGIN_ID, version: "1.4.0", enabled: true }] }));
  assert.equal(compatible.state, "compatible");

  const incompatible = await inspectDashboardPlugin(async () => reply({ plugins: [{ plugin_id: DASHBOARD_PLUGIN_ID, version: "2.0.0", enabled: true }] }));
  assert.equal(incompatible.state, "incompatible");
  assert.match(incompatible.diagnostic, /protocol/i);

  const wrongPackage = await inspectDashboardPlugin(
    async () => reply({ plugins: [{
      plugin_id: DASHBOARD_PLUGIN_ID, version: "1.0.0", enabled: true, plugin_root: "/other/package/herdr-plugin",
    }] }),
    "/trusted/package/herdr-plugin",
  );
  assert.equal(wrongPackage.state, "incompatible");
  assert.match(wrongPackage.diagnostic, /different package/i);

  const disabledWrongPackage = await inspectDashboardPlugin(
    async () => reply({ plugins: [{
      plugin_id: DASHBOARD_PLUGIN_ID, version: "1.0.0", enabled: false, plugin_root: "/other/package/herdr-plugin",
    }] }),
    "/trusted/package/herdr-plugin",
  );
  assert.equal(disabledWrongPackage.state, "incompatible", "provenance must be checked before suggesting enable");
  assert.match(disabledWrongPackage.diagnostic, /different package/i);
});

test("opening targets the calling pi pane, splits right, keeps focus, omits incompatible workspace, and reuses the persisted pane", async () => {
  const dir = await tempDir("dashboard-herdr-");
  const statePath = join(dir, "pi-daddy", "dashboard-panes.json");
  const ledgerPath = join(dir, "ledger.jsonl");
  const calls: string[][] = [];
  let opened = 0;
  const exec: HerdrExec = async (args) => {
    calls.push(args);
    if (args[0] === "plugin" && args[1] === "list") {
      return reply({ plugins: [{ plugin_id: DASHBOARD_PLUGIN_ID, version: "1.0.0", enabled: true }] });
    }
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
      opened += 1;
      if (args.includes("--workspace")) {
        return {
          code: 1,
          stdout: JSON.stringify({
            id: "test",
            error: {
              code: "invalid_params",
              message: "split and zoomed plugin panes target an existing pane; use target_pane_id",
            },
          }),
          stderr: "",
        };
      }
      return reply({
        plugin_pane: {
          pane: { pane_id: "w1:p2", terminal_id: "term-dashboard", tab_id: "w1:t1", workspace_id: "w1" },
        },
      });
    }
    if (args[0] === "pane" && args[1] === "get") {
      return reply({ pane: { pane_id: "w1:p2", terminal_id: "term-dashboard", tab_id: "w1:t1", workspace_id: "w1" } });
    }
    if (args[0] === "pane" && args[1] === "process-info") {
      return reply({ process_info: { pane_id: "w1:p2", foreground_processes: [{ name: "pi-daddy-dashboard" }] } });
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const input = {
    exec,
    host: { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
    ledgerPath,
    cwd: dir,
    statePath,
  };

  const first = await openOrReuseDashboard(input);
  const second = await openOrReuseDashboard(input);
  const fromAnotherDirectory = await openOrReuseDashboard({ ...input, cwd: join(dir, "another-project") });
  assert.equal(first.kind, "opened");
  assert.equal(second.kind, "reused");
  assert.equal(fromAnotherDirectory.kind, "reused", "workspace/tab/ledger identity must not depend on invocation cwd");
  assert.equal(opened, 1);

  const open = calls.find((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open");
  assert.ok(open);
  assert.deepEqual(open.slice(0, 11), [
    "plugin", "pane", "open", "--plugin", DASHBOARD_PLUGIN_ID, "--entrypoint", "dashboard",
    "--placement", "split", "--target-pane", "w1:p1",
  ]);
  assert.equal(open.includes("--workspace"), false, "Herdr rejects workspace_id for a split placement");
  assert.ok(open.includes("--direction") && open.includes("right"));
  assert.ok(open.includes("--no-focus"));
  assert.equal(open.includes("--focus"), false);
  assert.ok(open.some((arg) => arg === `PI_DADDY_LEDGER=${ledgerPath}`));
});

test("a stored pane cannot be reused under a ledger path it did not record", async () => {
  const dir = await tempDir("dashboard-ledger-mismatch-");
  const statePath = join(dir, "state", "panes.json");
  let openCount = 0;
  const exec: HerdrExec = async (args) => {
    if (args[0] === "plugin" && args[1] === "list") {
      return reply({ plugins: [{ plugin_id: DASHBOARD_PLUGIN_ID, version: "1.0.0", enabled: true }] });
    }
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
      openCount += 1;
      return reply({ plugin_pane: { pane: {
        pane_id: "w1:p2", terminal_id: "term-dashboard", tab_id: "w1:t1", workspace_id: "w1",
      } } });
    }
    if (args[0] === "pane" && args[1] === "get") {
      return reply({ pane: {
        pane_id: "w1:p2", terminal_id: "term-dashboard", tab_id: "w1:t1", workspace_id: "w1",
      } });
    }
    if (args[0] === "pane" && args[1] === "process-info") {
      return reply({ process_info: { pane_id: "w1:p2", foreground_processes: [{ name: "pi-daddy-dashboard" }] } });
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const input = {
    exec, host: { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
    ledgerPath: join(dir, "ledger.jsonl"), cwd: dir, statePath,
  };
  await openOrReuseDashboard(input);
  const store = JSON.parse(await readFile(statePath, "utf8")) as {
    panes: Record<string, { ledgerPath: string }>;
  };
  store.panes[Object.keys(store.panes)[0]].ledgerPath = join(dir, "other-ledger.jsonl");
  await writeFile(statePath, `${JSON.stringify(store)}\n`, "utf8");

  await assert.rejects(() => openOrReuseDashboard(input), /pane state.*ledger.*mismatch/i);
  assert.equal(openCount, 1, "malformed navigation state must refuse rather than open or reuse a pane");
});

test("a newly opened dashboard pane is closed if Herdr returns it in another host tab", async () => {
  const dir = await tempDir("dashboard-wrong-open-host-");
  const calls: string[][] = [];
  const exec: HerdrExec = async (args) => {
    calls.push(args);
    if (args[0] === "plugin" && args[1] === "list") {
      return reply({ plugins: [{ plugin_id: DASHBOARD_PLUGIN_ID, version: "1.0.0", enabled: true }] });
    }
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
      return reply({ plugin_pane: { pane: {
        pane_id: "w9:p2", terminal_id: "wrong-host", tab_id: "w9:t3", workspace_id: "w9",
      } } });
    }
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "close") return reply({ type: "ok" });
    throw new Error(`unexpected ${args.join(" ")}`);
  };

  await assert.rejects(() => openOrReuseDashboard({
    exec, host: { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
    ledgerPath: join(dir, "ledger.jsonl"), cwd: dir, statePath: join(dir, "state", "panes.json"),
  }), /returned.*another.*workspace|returned.*another.*tab/i);
  assert.ok(calls.some((args) => args.join(" ") === "plugin pane close w9:p2"), "wrong-host pane must be closed");
});

test("a dashboard pane moved away from the caller tab is replaced, not falsely reused", async () => {
  const dir = await tempDir("dashboard-moved-pane-");
  const statePath = join(dir, "state", "panes.json");
  let openCount = 0;
  let moved = false;
  const exec: HerdrExec = async (args) => {
    if (args[0] === "plugin" && args[1] === "list") {
      return reply({ plugins: [{ plugin_id: DASHBOARD_PLUGIN_ID, version: "1.0.0", enabled: true }] });
    }
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
      openCount += 1;
      return reply({ plugin_pane: { pane: {
        pane_id: `w1:p${openCount + 1}`, terminal_id: `term-${openCount}`, tab_id: "w1:t1", workspace_id: "w1",
      } } });
    }
    if (args[0] === "pane" && args[1] === "get") {
      return reply({ pane: {
        pane_id: moved ? "w2:p9" : "w1:p2", terminal_id: "term-1",
        tab_id: moved ? "w2:t9" : "w1:t1", workspace_id: moved ? "w2" : "w1",
      } });
    }
    if (args[0] === "pane" && args[1] === "process-info") {
      return reply({ process_info: { pane_id: args[3], foreground_processes: [{ name: "pi-daddy-dashboard" }] } });
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const input = {
    exec, host: { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
    ledgerPath: join(dir, "ledger.jsonl"), cwd: dir, statePath,
  };

  assert.equal((await openOrReuseDashboard(input)).kind, "opened");
  moved = true;
  const replacement = await openOrReuseDashboard(input);
  assert.equal(replacement.kind, "opened");
  assert.equal(replacement.workspaceId, "w1");
  assert.equal(replacement.tabId, "w1:t1");
  assert.equal(openCount, 2);
});

test("a malformed nested pane-store entry refuses instead of opening a duplicate", async () => {
  const dir = await tempDir("dashboard-corrupt-pane-entry-");
  const statePath = join(dir, "state", "panes.json");
  let openCount = 0;
  const exec: HerdrExec = async (args) => {
    if (args[0] === "plugin" && args[1] === "list") {
      return reply({ plugins: [{ plugin_id: DASHBOARD_PLUGIN_ID, version: "1.0.0", enabled: true }] });
    }
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
      openCount += 1;
      return reply({ plugin_pane: { pane: {
        pane_id: `w1:p${openCount + 1}`, terminal_id: `term-${openCount}`, tab_id: "w1:t1", workspace_id: "w1",
      } } });
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const input = {
    exec, host: { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
    ledgerPath: join(dir, "ledger.jsonl"), cwd: dir, statePath,
  };
  await openOrReuseDashboard(input);
  const store = JSON.parse(await readFile(statePath, "utf8")) as { panes: Record<string, unknown> };
  store.panes[Object.keys(store.panes)[0]] = null;
  await writeFile(statePath, `${JSON.stringify(store)}\n`, "utf8");

  await assert.rejects(() => openOrReuseDashboard(input), /pane state.*corrupt/i);
  assert.equal(openCount, 1, "corrupt navigation state must not risk a duplicate pane");
});

test("a pane whose dashboard process exited is replaced rather than falsely reused", async () => {
  const dir = await tempDir("dashboard-dead-pane-");
  const statePath = join(dir, "state", "panes.json");
  let openCount = 0;
  let dashboardAlive = true;
  const exec: HerdrExec = async (args) => {
    if (args[0] === "plugin" && args[1] === "list") {
      return reply({ plugins: [{ plugin_id: DASHBOARD_PLUGIN_ID, version: "1.0.0", enabled: true }] });
    }
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
      openCount += 1;
      return reply({ plugin_pane: { pane: {
        pane_id: `w1:p${openCount + 1}`, terminal_id: `term-${openCount}`, tab_id: "w1:t1", workspace_id: "w1",
      } } });
    }
    if (args[0] === "pane" && args[1] === "get") {
      return reply({ pane: { pane_id: "w1:p2", terminal_id: "term-1", tab_id: "w1:t1", workspace_id: "w1" } });
    }
    if (args[0] === "pane" && args[1] === "process-info") {
      return reply({ process_info: {
        pane_id: "w1:p2", foreground_processes: [{ name: dashboardAlive ? "pi-daddy-dashboard" : "bash" }],
      } });
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const input = {
    exec, host: { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
    ledgerPath: join(dir, "ledger.jsonl"), cwd: dir, statePath,
  };
  assert.equal((await openOrReuseDashboard(input)).kind, "opened");
  dashboardAlive = false;
  assert.equal((await openOrReuseDashboard(input)).kind, "opened");
  assert.equal(openCount, 2);
});

test("a pane is closed if persisting its reuse identity fails", async () => {
  const dir = await tempDir("dashboard-save-failure-");
  const stateDir = join(dir, "state");
  const statePath = join(stateDir, "panes.json");
  const calls: string[][] = [];
  const exec: HerdrExec = async (args) => {
    calls.push(args);
    if (args[0] === "plugin" && args[1] === "list") {
      return reply({ plugins: [{ plugin_id: DASHBOARD_PLUGIN_ID, version: "1.0.0", enabled: true }] });
    }
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
      await chmod(stateDir, 0o500);
      return reply({ plugin_pane: { pane: {
        pane_id: "w1:p2", terminal_id: "term-dashboard", tab_id: "w1:t1", workspace_id: "w1",
      } } });
    }
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "close") return reply({ type: "ok" });
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  try {
    await assert.rejects(() => openOrReuseDashboard({
      exec, host: { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
      ledgerPath: join(dir, "ledger.jsonl"), cwd: dir, statePath,
    }), /EACCES|permission denied/i);
  } finally {
    await chmod(stateDir, 0o700).catch(() => undefined);
  }
  assert.ok(calls.some((args) => args.join(" ") === "plugin pane close w1:p2"), "untracked pane must be closed");
});

test("the bundled plugin manifest pins Herdr and dashboard protocol compatibility", async () => {
  const manifest = await readFile(join(import.meta.dirname, "..", "herdr-plugin", "herdr-plugin.toml"), "utf8");
  assert.match(manifest, new RegExp(`id = "${DASHBOARD_PLUGIN_ID.replaceAll(".", "\\.")}"`));
  assert.match(manifest, new RegExp(`version = "${DASHBOARD_PROTOCOL_VERSION}\\.0\\.0"`));
  assert.match(manifest, /min_herdr_version = "0\.8\.0"/);
  assert.match(manifest, /dist\/dashboard-cli\.js/);
});

test("/grants dashboard refuses before Herdr when no ledger is configured", async () => {
  await assert.rejects(() => openOrReuseDashboard({
    exec: async () => reply({}),
    host: { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
    ledgerPath: "",
    cwd: "/tmp",
    statePath: "/tmp/unused-dashboard-state.json",
  }), /ledger.*configured/i);
});
