/** Per-definition child model and thinking configuration, resolved before a delegation is planned. */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ModelSource = "explicit" | "session" | "definition" | "global" | "pi";
export type ThinkingSource = ModelSource | "advisor";
export interface DefinitionRuntimeChoice {
  model?: string;
  thinking?: ThinkingLevel;
}
export interface DefinitionRuntimeSettings {
  defaults: DefinitionRuntimeChoice;
  definitions: Map<string, DefinitionRuntimeChoice>;
}
export interface ResolvedDefinitionRuntime {
  model?: string;
  modelSource: ModelSource;
  thinking?: ThinkingLevel;
  thinkingSource: ThinkingSource;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const parseThinkingLevel = (value: unknown): ThinkingLevel | undefined =>
  typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
export const parseConfiguredModel = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1 || /\s/.test(value)) return undefined;
  return `${value.slice(0, colon)}/${value.slice(colon + 1)}`;
};
const choice = (value: unknown): DefinitionRuntimeChoice => {
  if (!isObject(value)) return {};
  return {
    ...(parseConfiguredModel(value.model) ? { model: parseConfiguredModel(value.model) } : {}),
    ...(parseThinkingLevel(value.thinking) ? { thinking: parseThinkingLevel(value.thinking) } : {}),
  };
};

export function definitionRuntimeSettingsFrom(raw: unknown): DefinitionRuntimeSettings {
  const definitions = new Map<string, DefinitionRuntimeChoice>();
  if (isObject(raw) && Array.isArray(raw.definitions)) {
    for (const entry of raw.definitions) {
      if (!isObject(entry) || typeof entry.name !== "string") continue;
      definitions.set(entry.name, choice(entry));
    }
  }
  return { defaults: isObject(raw) ? choice(raw.defaults) : {}, definitions };
}

export function resolvedModelOf(value: string | undefined): { provider: string; modelId: string } | null {
  if (!value) return null;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1
    ? { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
    : null;
}

export function resolveDefinitionRuntime(input: {
  definition?: string;
  explicit: { model?: string; thinking?: string };
  session: ReadonlyMap<string, DefinitionRuntimeChoice>;
  settings: DefinitionRuntimeSettings;
  piModel?: string;
  advisorThinking?: string;
}): ResolvedDefinitionRuntime {
  const session = input.definition ? input.session.get(input.definition) : undefined;
  const definition = input.definition ? input.settings.definitions.get(input.definition) : undefined;
  const modelCandidates: Array<[string | undefined, ModelSource]> = [
    [input.explicit.model, "explicit"],
    [session?.model, "session"],
    [definition?.model, "definition"],
    [input.settings.defaults.model, "global"],
    [input.piModel, "pi"],
  ];
  const thinkingCandidates: Array<[string | undefined, ThinkingSource]> = [
    [input.explicit.thinking, "explicit"],
    [session?.thinking, "session"],
    [input.advisorThinking, "advisor"],
    [definition?.thinking, "definition"],
    [input.settings.defaults.thinking, "global"],
  ];
  const selectedModel = modelCandidates.find(([value]) => value !== undefined) ?? [undefined, "pi" as const];
  const selectedThinking = thinkingCandidates.find(([value]) => value !== undefined) ?? [undefined, "pi" as const];
  return {
    model: selectedModel[0],
    modelSource: selectedModel[1],
    thinking: parseThinkingLevel(selectedThinking[0]),
    thinkingSource: selectedThinking[1],
  };
}
