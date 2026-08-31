import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  dashboardPreferencePath,
  offerDashboardHandshake,
  openDashboardCommand,
} from "../src/dashboard-handshake.ts";
import { DASHBOARD_PLUGIN_ID } from "../src/dashboard-herdr.ts";
import type { HerdrExec } from "../src/herdr-cli.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const result = (value: Record<string, unknown>) => ({
  code: 0,
  stdout: JSON.stringify({ id: "test", result: value }),
  stderr: "",
});
const env = {
  HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1",
};

function hostAndPluginExec(options: { installed?: boolean } = {}) {
  let installed = options.installed ?? false;
  let linkedRoot: string | undefined;
  const calls: string[][] = [];
  const exec: HerdrExec = async (args) => {
    calls.push(args);
    if (args[0] === "pane" && args[1] === "current") return result({ pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } });
    if (args[0] === "pane" && args[1] === "process-info") return result({ process_info: { pane_id: "w1:p1", foreground_processes: [{ pid: 42 }] } });
    if (args[0] === "plugin" && args[1] === "list") {
      return result({ plugins: installed ? [{
        plugin_id: DASHBOARD_PLUGIN_ID, version: "1.0.0", enabled: true, plugin_root: linkedRoot,
      }] : [] });
    }
    if (args[0] === "plugin" && args[1] === "link") {
      installed = true;
      linkedRoot = args[2];
      return result({ type: "plugin_linked" });
    }
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
      return result({ plugin_pane: { pane: { pane_id: "w1:p2", terminal_id: "term", tab_id: "w1:t1", workspace_id: "w1" } } });
    }
    if (args[0] === "pane" && args[1] === "get") return result({ pane: { pane_id: "w1:p2", terminal_id: "term", tab_id: "w1:t1", workspace_id: "w1" } });
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { exec, calls };
}

test("Not now is recorded and prevents repeated startup prompts", async () => {
  const root = await tempDir("dashboard-handshake-");
  const preferencePath = dashboardPreferencePath(root);
  const fake = hostAndPluginExec();
  let prompts = 0;
  const notices: string[] = [];
  const input = {
    mode: "tui" as const,
    env,
    pid: 42,
    exec: fake.exec,
    cwd: root,
    ledgerPath: join(root, "ledger.jsonl"),
    pluginRoot: join(root, "plugin"),
    preferencePath,
    paneStatePath: join(root, "panes.json"),
    ui: {
      select: async (_title: string, choices: string[]) => { prompts += 1; assert.deepEqual(choices, ["Install and open", "Not now", "Never ask"]); return "Not now"; },
      notify: (message: string) => void notices.push(message),
    },
  };
  await offerDashboardHandshake(input);
  await offerDashboardHandshake(input);
  assert.equal(prompts, 1);
  assert.equal(fake.calls.some((args) => args[1] === "link"), false);
});

test("dismissing the startup prompt stores no consent choice", async () => {
  const root = await tempDir("dashboard-dismissed-");
  const fake = hostAndPluginExec();
  let prompts = 0;
  const input = {
    mode: "tui" as const,
    env,
    pid: 42,
    exec: fake.exec,
    cwd: root,
    ledgerPath: join(root, "ledger.jsonl"),
    pluginRoot: join(root, "plugin"),
    preferencePath: dashboardPreferencePath(root),
    paneStatePath: join(root, "panes.json"),
    ui: { select: async () => { prompts += 1; return undefined; }, notify: () => {} },
  };
  assert.equal(await offerDashboardHandshake(input), "deferred");
  assert.equal(await offerDashboardHandshake(input), "deferred");
  assert.equal(prompts, 2, "dismissal is not the literal Not now choice and must not be persisted as one");
  assert.equal(fake.calls.some((args) => args[1] === "link"), false);
});

test("Install and open is the only startup choice that links software", async () => {
  const root = await tempDir("dashboard-install-");
  const fake = hostAndPluginExec();
  const notices: string[] = [];
  await offerDashboardHandshake({
    mode: "tui", env, pid: 42, exec: fake.exec, cwd: root, ledgerPath: join(root, "ledger.jsonl"),
    pluginRoot: join(root, "plugin"), preferencePath: dashboardPreferencePath(root), paneStatePath: join(root, "panes.json"),
    ui: { select: async () => "Install and open", notify: (message: string) => void notices.push(message) },
  });
  assert.equal(fake.calls.filter((args) => args[0] === "plugin" && args[1] === "link").length, 1);
  assert.equal(fake.calls.filter((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open").length, 1);
  assert.ok(notices.some((message) => /opened.*without changing focus/i.test(message)));
});

test("outside Herdr the startup handshake and command are diagnostics, not a server reachability guess", async () => {
  const root = await tempDir("dashboard-outside-");
  let prompts = 0;
  await offerDashboardHandshake({
    mode: "tui", env: {}, pid: 42, exec: async () => result({ plugins: [] }), cwd: root,
    pluginRoot: join(root, "plugin"), preferencePath: dashboardPreferencePath(root), paneStatePath: join(root, "panes.json"),
    ui: { select: async () => { prompts += 1; return "Install and open"; }, notify: () => {} },
  });
  assert.equal(prompts, 0);
  await assert.rejects(() => openDashboardCommand({
    env: {}, pid: 42, exec: async () => result({ plugins: [] }), cwd: root, ledgerPath: join(root, "ledger.jsonl"),
    pluginRoot: join(root, "plugin"), paneStatePath: join(root, "panes.json"),
  }), /not hosted inside Herdr/i);
});

test("/grants dashboard checks the exact host before ledger, then ledger before plugin", async () => {
  const root = await tempDir("dashboard-command-order-");
  const fake = hostAndPluginExec();
  await assert.rejects(() => openDashboardCommand({
    env, pid: 42, exec: fake.exec, cwd: root, ledgerPath: undefined,
    pluginRoot: join(root, "plugin"), paneStatePath: join(root, "panes.json"),
  }), /no pi-daddy ledger is configured/i);
  assert.deepEqual(fake.calls.map((args) => args.slice(0, 2)), [
    ["pane", "current"], ["pane", "process-info"],
  ]);
});

test("/grants dashboard never installs an absent plugin silently and gives the exact link command", async () => {
  const root = await tempDir("dashboard-command-");
  const fake = hostAndPluginExec();
  await assert.rejects(() => openDashboardCommand({
    env, pid: 42, exec: fake.exec, cwd: root, ledgerPath: join(root, "ledger.jsonl"),
    pluginRoot: join(root, "bundled plugin"), paneStatePath: join(root, "panes.json"),
  }), /herdr plugin link .*bundled plugin.*--enabled/);
  assert.equal(fake.calls.some((args) => args[1] === "link"), false);
});
