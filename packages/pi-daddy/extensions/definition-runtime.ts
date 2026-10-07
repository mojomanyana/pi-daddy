/** Per-definition child model and thinking configuration, resolved before a delegation is planned. */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ModelSource = "explicit" | "session" | "definition" | "authored" | "global" | "pi";
export type ThinkingSource = ModelSource;
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

/** Parse the complete needed list before evaluating availability. No model/thinking cross product. */
export function authoredRuntimePreferences(raw: unknown): Required<DefinitionRuntimeChoice>[] {
  if (raw === undefined) return [];
  let value = raw;
  if (typeof value === "string") {
    const text = value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("runtime-preferences must be a JSON array of model/thinking pairs");
    }
  }
  if (!Array.isArray(value) || value.length > 32)
    throw new Error("runtime-preferences must contain at most 32 ordered pairs");
  return value.map((row, index) => {
    if (
      !isObject(row) ||
      Object.keys(row).some((key) => !["model", "thinking"].includes(key)) ||
      !qualifiedModel(row.model) ||
      !parseThinkingLevel(row.thinking)
    ) {
      throw new Error(`runtime-preferences[${index}] needs an exact provider/model and thinking pair`);
    }
    return { model: row.model as string, thinking: row.thinking as ThinkingLevel };
  });
}

function qualifiedModel(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/\S+$/.test(value);
}

export function resolveDefinitionRuntime(input: {
  definition?: string;
  explicit: { model?: string; thinking?: string };
  session: ReadonlyMap<string, DefinitionRuntimeChoice>;
  settings: DefinitionRuntimeSettings;
  piModel?: string;
  piThinking?: string;
  authoredPreferences?: unknown;
  /** Local, passive evidence only. Undefined means no known reason to reject, not remote health. */
  unavailable?: (choice: DefinitionRuntimeChoice) => string | undefined;
}): ResolvedDefinitionRuntime {
  const session = input.definition ? input.session.get(input.definition) : undefined;
  const project = input.definition ? input.settings.definitions.get(input.definition) : undefined;
  const fixed = [
    [input.explicit, "explicit"],
    [session, "session"],
    [project, "definition"],
  ] as const;
  const model = fixed.find(([choice]) => choice?.model !== undefined);
  const thinking = fixed.find(([choice]) => choice?.thinking !== undefined);
  const fixedModel = model?.[0]?.model;
  const fixedThinking = thinking?.[0]?.thinking;
  if (fixedModel !== undefined && !qualifiedModel(fixedModel))
    throw new Error("explicit runtime model needs provider/model");
  if (fixedThinking !== undefined && !parseThinkingLevel(fixedThinking))
    throw new Error("explicit runtime thinking is invalid");
  const result = (candidate: DefinitionRuntimeChoice, source: ModelSource): ResolvedDefinitionRuntime => ({
    model: fixedModel ?? candidate.model,
    modelSource: model?.[1] ?? source,
    thinking: parseThinkingLevel(fixedThinking ?? candidate.thinking),
    thinkingSource: thinking?.[1] ?? source,
  });
  // Only a complete higher-priority pair can leave malformed authored preferences unused.
  if (fixedModel !== undefined && fixedThinking !== undefined) {
    const selected = result({}, "pi");
    const reason = input.unavailable?.(selected);
    if (reason) throw new Error(reason);
    return selected;
  }
  const preferences = authoredRuntimePreferences(input.authoredPreferences);
  for (const candidate of preferences) {
    if (fixedModel !== undefined && candidate.model !== fixedModel) continue;
    if (fixedThinking !== undefined && candidate.thinking !== fixedThinking) continue;
    const selected = result(candidate, "authored");
    if (!input.unavailable?.(selected)) return selected;
  }
  // Normal fallback fills only missing fields; an overridden row is never described as authored.
  const normal = [
    [input.settings.defaults, "global"],
    [{ model: input.piModel, thinking: parseThinkingLevel(input.piThinking) }, "pi"],
  ] as const;
  let refusal: string | undefined;
  for (const [candidate, source] of normal) {
    const selected = result(
      { model: candidate.model ?? input.piModel, thinking: candidate.thinking ?? parseThinkingLevel(input.piThinking) },
      source,
    );
    // Attribute a field filled from the current session accurately even when another default wins.
    if (!model && candidate.model === undefined) selected.modelSource = "pi";
    if (!thinking && candidate.thinking === undefined) selected.thinkingSource = "pi";
    refusal = input.unavailable?.(selected);
    if (!refusal) return selected;
  }
  throw new Error(refusal ?? "no locally usable configured runtime pair");
}
