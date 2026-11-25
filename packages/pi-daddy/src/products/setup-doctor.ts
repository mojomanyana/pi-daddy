/**
 * Zero-friction cross-OS ecosystem installer & doctor (`pi-daddy setup` / `pi-daddy doctor`)
 * (Layer 3: products). Works natively on macOS, Linux, and Windows.
 */
import { spawnSync } from "node:child_process";
import {
  ecosystemConfigPath,
  loadEcosystemConfig,
  saveEcosystemConfig,
  type EcosystemConfig,
} from "../kernel/ecosystem-config.ts";
import release from "./ecosystem-release.json" with { type: "json" };

const PRESETS: Record<string, EcosystemConfig> = {
  "open-weight": {
    models: {
      fast: "fireworks/accounts/fireworks/models/glm-5p3-flash",
      work: "fireworks/accounts/fireworks/models/deepseek-v4p1-flash",
      strong: "fireworks/accounts/fireworks/models/qwen3p8-max",
    },
    dashboard: { autoStart: true, autoSplit: true },
    escalation: { auto: true },
    scout: { directUrls: true },
    bookie: { autoRecall: true, autoDistill: true },
  },
  google: {
    models: {
      fast: "google/gemini-3.5-flash-lite",
      work: "google/gemini-3.5-flash-lite",
      strong: "google/gemini-3.8-flash",
    },
    dashboard: { autoStart: true, autoSplit: true },
    escalation: { auto: true },
    scout: { directUrls: true },
    bookie: { autoRecall: true, autoDistill: true },
  },
};

function probeCmd(cmd: string, args: string[]): { ok: boolean; output: string } {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 5000,
    shell: process.platform === "win32",
  });
  return {
    ok: res.status === 0,
    output:
      String(res.stdout || res.stderr || "")
        .trim()
        .split(/\r?\n/)[0] ?? "",
  };
}

export function runEcosystemSetup(options: { preset?: string; skipInstall?: boolean } = {}): number {
  const presetName = options.preset && options.preset in PRESETS ? options.preset : "open-weight";
  const existing = loadEcosystemConfig();
  const base = PRESETS[presetName];
  const merged: EcosystemConfig = {
    models: { ...base.models, ...existing.models },
    dashboard: { ...base.dashboard, ...existing.dashboard },
    escalation: { ...base.escalation, ...existing.escalation },
    scout: { ...base.scout, ...existing.scout },
    bookie: { ...base.bookie, ...existing.bookie },
  };
  const cfgFile = saveEcosystemConfig(merged);
  console.log(`pi-daddy setup: wrote ${cfgFile} (preset: ${presetName})`);

  if (!options.skipInstall) {
    const piCheck = probeCmd("pi", ["--version"]);
    if (!piCheck.ok) {
      console.error("pi-daddy setup: `pi` CLI not found on PATH. Install @earendil-works/pi-coding-agent first.");
      return 1;
    }
    const pins: Record<string, string> = release.publicVersions;
    for (const name of release.normalCliInstalls) {
      const pkg = `npm:${name}@${pins[name]}`;
      console.log(`  installing ${pkg}...`);
      const res = spawnSync("pi", ["install", pkg], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      if (res.status !== 0) {
        console.error(`pi-daddy setup: failed installing ${pkg}`);
        return 1;
      }
    }
  }
  console.log("\nSetup complete! Start `pi` in any git repo and run `/dashboard split` or `pi-daddy panel`.");
  return 0;
}

export function runEcosystemDoctor(): number {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const checks: Array<{ name: string; ok: boolean; detail?: string; output?: string; optional?: boolean }> = [
    { name: "Platform", ok: true, detail: `${process.platform}/${process.arch}` },
    { name: "Node.js", ok: nodeMajor >= 22, detail: `v${process.versions.node} (recommended >=24 for SQLite FTS5)` },
    { name: "pi CLI", ...probeCmd("pi", ["--version"]) },
    { name: "git", ...probeCmd("git", ["--version"]) },
    { name: "Docker (optional for open-web Scout)", ...probeCmd("docker", ["--version"]), optional: true },
  ];
  const splitters: string[] = [];
  if (process.env.TMUX || probeCmd("tmux", ["-V"]).ok) splitters.push("tmux");
  if (process.env.WEZTERM_PANE || probeCmd("wezterm", ["--version"]).ok) splitters.push("wezterm");
  if (process.platform === "darwin") splitters.push("iTerm2 (osascript)");
  if (process.platform === "win32" && probeCmd("where", ["wt"]).ok) splitters.push("Windows Terminal (wt)");

  console.log("pi-daddy doctor — Ecosystem Health Check\n");
  let failed = false;
  for (const c of checks) {
    const mark = c.ok ? "✓" : c.optional ? "○" : "✗";
    if (!c.ok && !c.optional) failed = true;
    console.log(`  ${mark} ${c.name.padEnd(36)} ${c.output || c.detail || "not found"}`);
  }
  console.log(`  ✓ ${"Terminal auto-split support".padEnd(36)} ${splitters.join(", ") || "manual (`pi-daddy panel`)"}`);
  const cfgPath = ecosystemConfigPath();
  const cfg = loadEcosystemConfig();
  console.log(
    `  ${cfg.models ? "✓" : "○"} ${"Ecosystem config".padEnd(36)} ${cfgPath} (${cfg.models ? "configured" : "not created — run `pi-daddy setup`"})`,
  );
  return failed ? 1 : 0;
}
