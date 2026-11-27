/**
 * Interactive recovery when an explicitly configured specialist model is unavailable or fails preflight.
 * Offers "Use session model once" or "Choose a new default" from compatible configured models while
 * preserving all other operator settings in ecosystem.json.
 */
import { loadEcosystemConfig, readEcosystemConfig, saveEcosystemConfig } from "../src/kernel/ecosystem-config.ts";
import type { ModelCatalogue } from "../src/kernel/model-preflight.ts";

export interface ModelRecoveryUI {
  hasUI?: boolean;
  ui?: {
    select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  };
}

export interface ModelRecoveryOutcome {
  readonly model: string;
  readonly mode: "once" | "default";
}

type RecoveryRegistry = ModelCatalogue & {
  getAvailable?(): ReadonlyArray<{ provider: string; id: string }>;
  hasConfiguredAuth?(model: unknown): boolean;
};

function compatibleModels(registry: RecoveryRegistry) {
  const listed = typeof registry.getAvailable === "function" ? registry.getAvailable() : [];
  return listed
    .filter((m) => typeof m.provider === "string" && typeof m.id === "string")
    .filter((m) => (typeof registry.hasConfiguredAuth === "function" ? registry.hasConfiguredAuth(m) : true))
    .map((m) => `${m.provider}/${m.id}`);
}

export async function recoverUnavailableRoleModel(input: {
  role: string;
  failedModel: string;
  sessionModel?: string;
  registry: RecoveryRegistry;
  ctx?: ModelRecoveryUI;
  signal?: AbortSignal;
}): Promise<ModelRecoveryOutcome | undefined> {
  if (!input.ctx?.hasUI || typeof input.ctx.ui?.select !== "function") return undefined;
  const available = [...new Set(compatibleModels(input.registry))].filter((id) => id !== input.failedModel);
  const canUseSession = Boolean(input.sessionModel && input.sessionModel !== input.failedModel);
  const useOnce = canUseSession ? `Use session model once (${input.sessionModel})` : undefined;
  const chooseDefault = available.length > 0 ? "Choose a new default" : undefined;
  const actions = [...(useOnce ? [useOnce] : []), ...(chooseDefault ? [chooseDefault] : [])];
  if (actions.length === 0) return undefined;

  const picked = await input.ctx.ui.select(
    `Specialist "${input.role}" could not use configured model ${input.failedModel}. Choose recovery:`,
    actions,
    { signal: input.signal },
  );
  if (!picked) return undefined;
  if (picked === useOnce && input.sessionModel) {
    return { model: input.sessionModel, mode: "once" };
  }
  if (picked === chooseDefault) {
    const nextModel = await input.ctx.ui.select(
      `Choose a new default model for specialist "${input.role}":`,
      available,
      { signal: input.signal },
    );
    if (!nextModel || !available.includes(nextModel)) return undefined;
    try {
      const cfg = readEcosystemConfig() ?? loadEcosystemConfig();
      const roleModels = { ...(cfg.delegation?.roleModels ?? {}), [input.role]: nextModel };
      saveEcosystemConfig({ ...cfg, delegation: { ...(cfg.delegation ?? {}), roleModels } });
    } catch {
      /* Persistence is best-effort if config path is read-only. */
    }
    return { model: nextModel, mode: "default" };
  }
  return undefined;
}
