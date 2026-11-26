/**
 * Zero-friction cross-OS ecosystem installer & doctor (`pi-daddy setup` / `pi-daddy doctor`)
 * (Layer 3: products). Works natively on macOS, Linux, and Windows.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ecosystemConfigPath,
  readEcosystemConfig,
  resolveEcosystemModelCandidates,
  saveEcosystemConfig,
  type EcosystemConfig,
  type EcosystemModelFallbacks,
  type EcosystemModelsConfig,
} from "../kernel/ecosystem-config.ts";
import release from "./ecosystem-release.json" with { type: "json" };
import { compareStableVersions } from "../kernel/stable-version.ts";
import { agentDir, piProjectDir } from "../kernel/project-paths.ts";
import {
  buildAutoPreset,
  loadProviderCatalog,
  type ProviderCatalog,
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
  autoModels?: EcosystemModelsConfig,
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
  const name = requested ?? previousName ?? legacyName ?? "session";
  const base = PROVIDER_PRESETS[name];
  const defaults = autoModels ?? (!requested && previousName ? previous?.defaults : undefined) ?? base.models;
  const models: EcosystemModelsConfig = { ...defaults, ...existing.models };
  for (const tier of tiers) {
    const value = existing.models?.[tier];
    const wasDefault = previous
      ? previous.defaults?.[tier] === value
      : Object.values(PROVIDER_PRESETS).some((preset) => preset.models[tier] === value);
    if (value === undefined || (wasDefault && (requested || previousName))) {
      if (defaults[tier] === undefined) delete models[tier];
      else models[tier] = defaults[tier];
    }
  }
  const modelFallbacks: EcosystemModelFallbacks = { ...existing.modelFallbacks };
  if (autoFallbacks) {
    for (const tier of tiers) {
      const old = existing.modelFallbacks?.[tier];
      if (old && JSON.stringify(old) !== JSON.stringify(previous?.fallbacks?.[tier])) continue;
      if (autoFallbacks[tier]) modelFallbacks[tier] = autoFallbacks[tier];
      else delete modelFallbacks[tier];
    }
  }
  return {
    ...existing,
    setupPreset: {
      name,
      defaults: { ...defaults },
      ...((autoFallbacks ?? previous?.fallbacks) && { fallbacks: autoFallbacks ?? previous?.fallbacks }),
    },
    models,
    ...(existing.modelFallbacks || Object.keys(modelFallbacks).length ? { modelFallbacks } : {}),
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

export function runEcosystemSetup(options: { preset?: string; skipInstall?: boolean; pinned?: boolean } = {}): number {
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
    let pins: Record<string, string> | undefined;
    if (options.pinned) {
      // The snapshot uses the invoking release's Daddy paired with the tested companion versions.
      const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
      pins = { ...release.publicVersions, "pi-daddy": version };
    }
    for (const name of release.normalCliInstalls) {
      const pkg = pins ? `npm:${name}@${pins[name]}` : `npm:${name}`;
      console.log(`  installing ${pkg}...`);
      // Pi updates existing declarations by package identity, preserving any resource filters.
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
    let autoModels: EcosystemModelsConfig | undefined;
    const requestedModels = tiers.flatMap((tier) => resolveEcosystemModelCandidates(tier));
    let catalog: ProviderCatalog | undefined;
    try {
      catalog = loadProviderCatalog(requestedModels);
    } catch (error) {
      if (preset === "auto")
        console.log(
          "  Connect a provider with /login and select a model with /model. Fresh profiles follow that model.",
        );
      console.log("  Model availability could not be verified: " + String(error));
    }
    if (preset === "auto" && catalog) {
      const detected = buildAutoPreset(catalog);
      autoModels = detected.models;
      for (const reason of detected.diagnostics) console.log("  " + reason);
      resolvedPreset = detected.preset;
      autoFallbacks = detected.fallbacks;
      const summary = detected.detected.map((d) => `${d.label} (${d.source})`).join(", ") || "none -> session default";
      console.log(`pi-daddy setup: auto-detected providers: ${summary}`);
    }
    const config = applyPreset(readEcosystemConfig() ?? {}, resolvedPreset, autoFallbacks, autoModels);
    const file = saveEcosystemConfig(config);
    if (catalog) reportTierAvailability(catalog);
    console.log(`pi-daddy setup: wrote ${file} (preset: ${config.setupPreset?.name})`);
    console.log(
      `Configured models: ${tiers.map((tier) => `${tier}=${resolveEcosystemModelCandidates(tier)[0] ?? "session"}`).join(", ")}`,
    );
  } catch (error) {
    console.error(`pi-daddy setup: ${String(error)}`);
    return 1;
  }
  console.log(
    options.skipInstall
      ? "Preset settings saved. Package installation skipped."
      : "\nSetup complete! Start `pi` and run `/dashboard split` or `/dashboard open`.",
  );
  if (!options.skipInstall) {
    console.log(
      options.pinned
        ? "Installed the pinned snapshot. Run setup without --pinned to enable extension updates."
        : "Update the ecosystem with `pi update --extensions`.",
    );
  }
  return 0;
}

function reportTierAvailability(catalog: ProviderCatalog) {
  for (const tier of tiers) {
    const candidates = resolveEcosystemModelCandidates(tier);
    let chosen = false;
    for (const spec of candidates) {
      if (spec === "session") break;
      const efforts = catalog.models[spec];
      if (!efforts?.length) {
        console.log(
          "  " + tier + ": " + spec + " unavailable in Pi's offline catalog (extension providers may differ)",
        );
        continue;
      }
      const note = tier === "fast" && !efforts.includes("off") ? "; harvest needs thinking off" : "";
      console.log("  " + tier + ": " + spec + " available (" + efforts.join(", ") + note + ")");
      chosen = true;
      break;
    }
    if (!chosen) console.log("  " + tier + ": active Pi session when available");
  }
}

function reportPackagePins(path: string, local: boolean): void {
  let settings: { packages?: Array<string | { source?: string }> };
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.log(`  ? Cannot read ${path}: ${String(error)}`);
    return;
  }
  if (!Array.isArray(settings?.packages)) return;
  for (const entry of settings.packages) {
    const source = typeof entry === "string" ? entry : entry?.source;
    const match = typeof source === "string" ? /^npm:([^@]+)@(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)$/.exec(source) : null;
    if (!match || !release.normalCliInstalls.includes(match[1])) continue;
    const unpinned = `pi install ${local ? "--local " : ""}npm:${match[1]}`;
    console.log(`  ! Pinned source ${source} in ${path}. To track updates, run \`${unpinned}\`.`);
  }
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

  console.log("pi-daddy doctor — Ecosystem Health Check\n");
  let failed = false;
  for (const c of checks) {
    const mark = c.ok ? "✓" : c.optional ? "○" : "✗";
    if (!c.ok && !c.optional) failed = true;
    console.log(`  ${mark} ${c.name.padEnd(36)} ${c.output || c.detail || "not found"}`);
  }
  console.log(`  ✓ ${"Terminal auto-split support".padEnd(36)} ${splitters.join(", ") || "use /dashboard open in Pi"}`);
  const cfgPath = ecosystemConfigPath();
  try {
    const cfg = readEcosystemConfig();
    if (checks.every((check) => !["pi CLI", "Node.js"].includes(check.name) || check.ok)) {
      const catalog = loadProviderCatalog(tiers.flatMap((tier) => resolveEcosystemModelCandidates(tier)));
      const summary = buildAutoPreset(catalog);
      console.log(
        "  Detected model providers: " +
          (summary.detected.map((p) => p.label + " (" + p.source + ")").join(", ") || "none"),
      );
      for (const reason of summary.diagnostics) console.log("  " + reason);
      reportTierAvailability(catalog);
    }
    console.log(
      `  ${cfg ? "✓" : "○"} ${"Ecosystem config".padEnd(36)} ${cfgPath} (${cfg ? "present" : "not created — run `pi-daddy setup`"})`,
    );
  } catch (error) {
    console.log(`  ✗ ${String(error)}`);
    failed = true;
  }
  reportPackagePins(join(agentDir(), "settings.json"), false);
  reportPackagePins(join(piProjectDir(process.cwd()), "settings.json"), true);
  return failed ? 1 : 0;
}
