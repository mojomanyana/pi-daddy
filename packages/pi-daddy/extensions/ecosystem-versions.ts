/** Report loaded package generations separately from the manifests currently installed on disk. */
import {
  DefaultPackageManager,
  SettingsManager,
  VERSION,
  getPackageDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readBoundedTextSync } from "../src/kernel/bounded-read-sync.ts";
import { agentDir } from "../src/kernel/project-paths.ts";
import type { EcosystemPackageId, EcosystemVersionRow, EcosystemVersions } from "../src/products/ecosystem-versions.ts";

const CHANNEL = "pi-daddy:ecosystem-versions:v1";
const packages = [
  { id: "pi", label: "Pi", names: ["@earendil-works/pi-coding-agent"] },
  { id: "pi-daddy", label: "pi-daddy", names: ["pi-daddy"] },
  { id: "principal-pi-skills", label: "Principal", names: ["principal-pi-skills"] },
  { id: "skill-harness", label: "Harness", names: ["skill-harness", "skill-harness-monorepo"] },
  { id: "pi-scout-research", label: "Scout", names: ["pi-scout-research"] },
  { id: "bookie-pi-skills", label: "Bookie", names: ["pi-bookie", "bookie-pi-skills", "@bookie/pi-extension"] },
] as const;
interface LoadedPackage {
  id: EcosystemPackageId;
  version: string | null;
  root: string;
}
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
function manifest(root: string, names: readonly string[]): string | null {
  try {
    const value = JSON.parse(readBoundedTextSync(join(root, "package.json"), { maxBytes: 128 * 1024 }).text);
    return names.includes(value.name) && typeof value.version === "string" && versionPattern.test(value.version)
      ? value.version
      : null;
  } catch {
    return null;
  }
}
export interface VersionInventoryPorts {
  hostVersion: string;
  hostRoot: string;
  ownRoot: string;
  readVersion(root: string, names: readonly string[]): string | null;
  configured(ctx: ExtensionContext): Array<{ source: string; scope: "user" | "project"; installedPath?: string }>;
}
const defaultPorts = (ownRoot: string): VersionInventoryPorts => ({
  hostVersion: VERSION,
  hostRoot: getPackageDir(),
  ownRoot,
  readVersion: manifest,
  configured: (ctx) =>
    new DefaultPackageManager({
      cwd: ctx.cwd,
      agentDir: agentDir(),
      settingsManager: SettingsManager.create(ctx.cwd, agentDir(), {
        projectTrusted: ctx.isProjectTrusted?.() === true,
      }),
    }).listConfiguredPackages(),
});
/** Every package answers synchronously on Pi's native event bus; old packages stay explicitly unreported. */
export function createEcosystemVersionInventory(
  pi: Pick<ExtensionAPI, "events"> & Partial<Pick<ExtensionAPI, "getCommands">>,
  ownRoot: string,
  ports = defaultPorts(ownRoot),
) {
  const own: LoadedPackage = {
    id: "pi-daddy",
    root: ports.ownRoot,
    version: ports.readVersion(ports.ownRoot, ["pi-daddy"]),
  };
  return (ctx: ExtensionContext): EcosystemVersions => {
    const reports: LoadedPackage[] = [own, { id: "pi", root: ports.hostRoot, version: ports.hostVersion }];
    pi.events?.emit(CHANNEL, {
      report: (value: unknown) => {
        if (!value || typeof value !== "object") return;
        const item = value as LoadedPackage;
        if (
          !["principal-pi-skills", "skill-harness", "pi-scout-research", "bookie-pi-skills"].includes(item.id) ||
          typeof item.root !== "string" ||
          !isAbsolute(item.root)
        )
          return;
        if (typeof item.version !== "string" || !versionPattern.test(item.version)) return;
        reports.push({ id: item.id, root: item.root, version: item.version });
      },
    });
    let configured: ReturnType<VersionInventoryPorts["configured"]> = [],
      note: string | undefined;
    try {
      configured = ports.configured(ctx);
    } catch {
      note = "Configured package sources unavailable; loaded reports remain visible.";
    }
    const rows: EcosystemVersionRow[] = packages.map((pkg) => {
      const loaded = reports.filter((item) => item.id === pkg.id);
      const npmName = (source: string) =>
        pkg.names.find((name) => source === `npm:${name}` || source.startsWith(`npm:${name}@`));
      const sources = configured.filter(
        (item) =>
          npmName(item.source) !== undefined ||
          (item.installedPath !== undefined && ports.readVersion(item.installedPath, pkg.names) !== null) ||
          loaded.some((x) => item.installedPath && resolve(item.installedPath) === resolve(x.root)),
      );
      const source = sources.length === 1 ? sources[0] : undefined;
      const root = loaded.length === 1 ? loaded[0].root : loaded.length === 0 ? source?.installedPath : undefined;
      const installedVersion = root ? ports.readVersion(root, pkg.names) : null;
      const loadedVersion = loaded.length === 1 ? loaded[0].version : null;
      const observedRoots = new Set([
        ...loaded.map((item) => resolve(item.root)),
        ...sources.flatMap((item) => (item.installedPath ? [resolve(item.installedPath)] : [])),
      ]);
      const multiple =
        loaded.length > 1 ||
        sources.length > 1 ||
        observedRoots.size > 1 ||
        (loaded.length > 0 && sources.some((item) => !item.installedPath));
      let bookieCommand = false;
      if (pkg.id === "bookie-pi-skills" && root && !multiple) {
        // A registered command proves the extension is loaded, even for older Bookie
        // releases which did not announce a version. The current disk version cannot prove that.
        try {
          bookieCommand =
            pi.getCommands?.().some((cmd) => {
              if (
                cmd.name !== "bookie-work" ||
                cmd.source !== "extension" ||
                !cmd.sourceInfo?.path ||
                !isAbsolute(cmd.sourceInfo.path)
              )
                return false;
              const child = relative(root, cmd.sourceInfo.path);
              return !!child && !isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep);
            }) === true;
        } catch {
          /* Older Pi hosts may not expose a live command catalog. */
        }
      }
      const commands =
        pkg.id === "pi"
          ? ["pi update"]
          : source?.source.startsWith("npm:") && !multiple
            ? [
                `pi install${source.scope === "project" ? " --local" : ""} npm:${npmName(source.source) ?? pkg.names[0]}@<version>`,
              ]
            : ["pi list", "pi config"];
      if (pkg.id === "principal-pi-skills" && root && !multiple) {
        const installer = "'" + join(root, "scripts/install-agents.mjs").replaceAll("'", "'\\''") + "'";
        commands.push(`node ${installer} install`, `node ${installer} check`);
      }
      return {
        id: pkg.id,
        label: pkg.label,
        loadedVersion,
        installedVersion,
        source: multiple ? null : (source?.source ?? (pkg.id === "pi" ? "host runtime" : null)),
        path: root ?? null,
        state: multiple
          ? "multiple"
          : loadedVersion && installedVersion
            ? loadedVersion === installedVersion
              ? "current"
              : "reload-required"
            : !loadedVersion && installedVersion
              ? "not-reported"
              : "unavailable",
        commands,
        ...(bookieCommand ? { commandAvailable: true } : {}),
        note: multiple
          ? "Multiple loaded or configured sources; inspect with pi list before changing versions."
          : !loadedVersion
            ? "This package did not report its loaded generation. Installed bytes alone do not establish the running version."
            : pkg.id === "pi"
              ? "Restart Pi after changing its version."
              : (source?.source.startsWith("npm:")
                  ? "Use an explicit npm version to replace a pin; pi update keeps pinned versions. Reload Pi after installation."
                  : "Observed local source; manage its selected path, then reload Pi. This is not a published-version check.") +
                (pkg.id === "principal-pi-skills"
                  ? " Agent installer commands are optional, for legacy installed agent definitions."
                  : ""),
      };
    });
    return { rows, checkedAt: new Date().toISOString(), note };
  };
}
export function bindEcosystemVersions(
  pi: ExtensionAPI,
  session: { ecosystemVersions?: () => EcosystemVersions },
  ownRoot: string,
): void {
  const read = createEcosystemVersionInventory(pi, ownRoot);
  pi.on("session_start", (_event, ctx) => {
    session.ecosystemVersions = () => read(ctx);
  });
}
