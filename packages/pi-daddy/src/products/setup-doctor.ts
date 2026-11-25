/**
 * Zero-friction cross-OS ecosystem installer & doctor (`pi-daddy setup` / `pi-daddy doctor`)
 * (Layer 3: products). Works natively on macOS, Linux, and Windows.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  ecosystemConfigPath,
  readEcosystemConfig,
  resolveEcosystemModelTier,
  saveEcosystemConfig,
  type EcosystemConfig,
  type EcosystemModelFallbacks,
} from "../kernel/ecosystem-config.ts";
import release from "./ecosystem-release.json" with { type: "json" };
import { compareStableVersions } from "../kernel/stable-version.ts";
import {
  buildAutoPreset,
  detectConfiguredProviders,
  PROVIDER_PRESETS,
  type ProviderPresetName,
} from "./provider-detect.ts";
import { detectSupportedSplitters } from "./terminal-split.ts";

const tiers = ["fast", "work", "strong"] as const;
const isPreset = (name: unknown): name is ProviderPresetName =>
  typeof name === "string" && Object.hasOwn(PROVIDER_PRESETS, name);
const validPresetOption = (name: unknown): name is ProviderPresetName | "auto" => name === "auto" || isPreset(name);

function applyPreset(
  existing: EcosystemConfig,
  requested?: ProviderPresetName,
  autoFallbacks?: EcosystemModelFallbacks,
): EcosystemConfig {
  // Legacy profiles have no provenance. Match known shipped values and preserve other model IDs as overrides.
  const previous = existing.setupPreset;
  const previousName = isPreset(previous?.name) ? previous.name : undefined;
  const legacyName = (Object.keys(PROVIDER_PRESETS) as ProviderPresetName[]).find((name) =>
    tiers.some((tier) => {
      const m = PROVIDER_PRESETS[name].models[tier];
      return m !== undefined && m === existing.models?.[tier];
    }),
  );
  const name = requested ?? previousName ?? legacyName ?? "open-weight";
  const base = PROVIDER_PRESETS[name];
  const models: EcosystemConfig["models"] = { ...base.models, ...existing.models };
  for (const tier of tiers) {
    const value = existing.models?.[tier];
    const wasDefault = previous
      ? previous.defaults?.[tier] === value
      : Object.values(PROVIDER_PRESETS).some((preset) => preset.models[tier] === value);
    if (value === undefined || (wasDefault && (requested || previousName))) {
      if (base.models[tier] === undefined) delete models[tier];
      else models[tier] = base.models[tier];
    }
  }
  const modelFallbacks =
    autoFallbacks && Object.keys(autoFallbacks).length > 0
      ? { ...autoFallbacks, ...existing.modelFallbacks }
      : existing.modelFallbacks;
  return {
    ...existing,
    setupPreset: { name, defaults: { ...base.models } },
    models,
    ...(modelFallbacks ? { modelFallbacks } : {}),
    dashboard: { ...base.dashboard, ...existing.dashboard },
    escalation: { ...base.escalation, ...existing.escalation },
    harvest: { ...base.harvest, ...existing.harvest },
    scout: { ...base.scout, ...existing.scout },
    bookie: { ...base.bookie, ...existing.bookie },
  };
}

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

function checkNode() {
  const version = process.versions.node;
  const minimum = release.minimumRuntime.nodeMajor;
  return {
    ok: Number(version.split(".")[0]) >= minimum,
    output: `v${version} (ecosystem requires Node.js ${minimum}+)`,
  };
}

function checkPi() {
  const probe = probeCmd("pi", ["--version"]);
  const minimum = release.minimumRuntime.pi;
  const order = compareStableVersions(probe.output, minimum);
  return {
    ok: probe.ok && order !== undefined && order >= 0,
    output: `${probe.output || "pi CLI unavailable on PATH"} (requires stable Pi >=${minimum})`,
  };
}

export function runEcosystemSetup(options: { preset?: string; skipInstall?: boolean } = {}): number {
  const { preset } = options;
  if (preset !== undefined && !validPresetOption(preset)) {
    const choices = ["auto", ...Object.keys(PROVIDER_PRESETS)].join(", ");
    console.error(`pi-daddy setup: unknown preset '${preset}'. Choose one of: ${choices}.`);
    return 1;
  }
  const node = checkNode();
  if (!node.ok) {
    console.error(`pi-daddy setup: ${node.output}`);
    return 1;
  }
  try {
    readEcosystemConfig();
  } catch (error) {
    console.error(`pi-daddy setup: ${String(error)}`);
    return 1;
  }

  if (!options.skipInstall) {
    const piCheck = checkPi();
    if (!piCheck.ok) {
      console.error(`pi-daddy setup: ${piCheck.output}. Install or update @earendil-works/pi-coding-agent.`);
      return 1;
    }
    // src/products and dist/products are both two directories below the launcher's installed package.
    const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const pins: Record<string, string> = { ...release.publicVersions, "pi-daddy": version };
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
  try {
    // Installation can take a while. Keep edits made by the operator while it was running.
    let resolvedPreset: ProviderPresetName | undefined = preset === "auto" ? undefined : (preset as ProviderPresetName);
    let autoFallbacks: EcosystemModelFallbacks | undefined;
    if (preset === "auto") {
      const detected = buildAutoPreset();
      resolvedPreset = detected.preset;
      autoFallbacks = detected.fallbacks;
      const summary = detected.detected.map((d) => `${d.label} (${d.source})`).join(", ") || "none -> session default";
      console.log(`pi-daddy setup: auto-detected providers: ${summary}`);
    }
    const config = applyPreset(readEcosystemConfig() ?? {}, resolvedPreset, autoFallbacks);
    const file = saveEcosystemConfig(config);
    console.log(`pi-daddy setup: wrote ${file} (preset: ${config.setupPreset?.name})`);
    console.log(
      `Effective models: ${tiers.map((tier) => `${tier}=${resolveEcosystemModelTier(tier) ?? "session"}`).join(", ")}`,
    );
  } catch (error) {
    console.error(`pi-daddy setup: ${String(error)}`);
    return 1;
  }
  console.log(
    options.skipInstall
      ? "Preset settings saved. Package installation skipped."
      : "\nSetup complete! Start `pi` in any git repo and run `/dashboard split` or `pi-daddy panel`.",
  );
  return 0;
}

export function runEcosystemDoctor(): number {
  const checks: Array<{ name: string; ok: boolean; detail?: string; output?: string; optional?: boolean }> = [
    { name: "Platform", ok: true, detail: `${process.platform}/${process.arch}` },
    { name: "Node.js", ...checkNode() },
    { name: "pi CLI", ...checkPi() },
    { name: "git", ...probeCmd("git", ["--version"]) },
    { name: "Docker (optional for open-web Scout)", ...probeCmd("docker", ["--version"]), optional: true },
  ];
  const splitters = detectSupportedSplitters((cmd, args) => probeCmd(cmd, args).ok);
  const providers = detectConfiguredProviders();

  console.log("pi-daddy doctor — Ecosystem Health Check\n");
  let failed = false;
  for (const c of checks) {
    const mark = c.ok ? "✓" : c.optional ? "○" : "✗";
    if (!c.ok && !c.optional) failed = true;
    console.log(`  ${mark} ${c.name.padEnd(36)} ${c.output || c.detail || "not found"}`);
  }
  console.log(`  ✓ ${"Terminal auto-split support".padEnd(36)} ${splitters.join(", ") || "manual (`pi-daddy panel`)"}`);
  console.log(
    `  ${providers.length ? "✓" : "○"} ${"Detected model providers".padEnd(36)} ${
      providers.map((p) => `${p.label} (${p.source})`).join(", ") || "none detected (using session model)"
    }`,
  );
  const cfgPath = ecosystemConfigPath();
  try {
    const cfg = readEcosystemConfig();
    console.log(
      `  ${cfg ? "✓" : "○"} ${"Ecosystem config".padEnd(36)} ${cfgPath} (${cfg ? "present" : "not created — run `pi-daddy setup`"})`,
    );
  } catch (error) {
    console.log(`  ✗ ${"Ecosystem config".padEnd(36)} ${String(error)}`);
    failed = true;
  }
  return failed ? 1 : 0;
}
