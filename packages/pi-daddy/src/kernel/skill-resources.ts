/** Read Pi's configured resource surface without locks, installs, extension execution or model calls. */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

interface SkillResources {
  skills: { path: string; enabled: boolean; metadata: { source: string; scope: string; origin: string; baseDir?: string } }[];
  configured: { source: string; scope: string; installedPath?: string }[];
}

export function skillResourceName(path: string): string {
  const parts = path.split(/[\\/]/);
  const file = parts.at(-1) ?? "";
  return file.toLowerCase() === "skill.md" ? parts.at(-2) ?? "" : file.replace(/\.md$/i, "");
}

export async function resolveSkillResources(cwd: string): Promise<SkillResources> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.fromStorage({
    withLock(scope, read) {
      const path = scope === "global" ? join(agentDir, "settings.json") : join(cwd, ".pi", "settings.json");
      let text: string | undefined;
      try { text = readFileSync(path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // This storage is intentionally read-only: no lock files or migrated settings are persisted.
      read(text);
    },
  });
  const errors = settingsManager.drainErrors();
  if (errors.length) throw new Error(`Cannot discover skills: ${errors.map(e => `${e.scope} settings: ${e.error.message}`).join("; ")}`);
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await manager.resolve(async () => "skip");
  // Pi has already applied package identity, scope, manifest and settings filters and precedence.
  const seen = new Set<string>();
  const skills = resolved.skills.filter(resource => resource.enabled).flatMap(resource => {
    try {
      const path = statSync(resource.path).isDirectory() ? join(resource.path, "SKILL.md") : resource.path;
      return statSync(path).isFile() ? [{ ...resource, path }] : [];
    } catch { return []; }
  }).filter(resource => {
    // Reserve identity before parsing: a malformed local override cannot reveal a wider package ceiling.
    const name = skillResourceName(resource.path);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  return { skills, configured: manager.listConfiguredPackages() };
}
