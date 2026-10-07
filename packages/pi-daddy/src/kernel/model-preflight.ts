import { refusal, type StructuredRefusal } from "./refusals.ts";
import { ENV_ALLOW_UNRESOLVED_MODELS } from "./env-names.ts";
export { ENV_ALLOW_UNRESOLVED_MODELS } from "./env-names.ts";

/** Pi's resolved catalogue carries provider support in thinkingLevelMap. Never silently clamp a user's choice. */
export function supportedModelEfforts(model: {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}): ("off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")[] {
  if (!model.reasoning) return ["off"];
  return (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && ((level !== "xhigh" && level !== "max") || mapped !== undefined);
  });
}

export interface ModelCatalogue {
  find(provider: string, modelId: string): unknown;
  getProviderAuthStatus?(provider: string): { configured: boolean };
}

/** Resolve an explicit provider/id against pi's own session catalogue without probing credentials or network. */
export function preflightModel(
  model: string | undefined,
  catalogue: ModelCatalogue,
  cache: Map<string, boolean>,
  allowUnresolved: boolean,
): StructuredRefusal | undefined {
  if (model === undefined || allowUnresolved) return undefined;
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "";
  const id = slash > 0 ? model.slice(slash + 1) : "";
  let resolved = cache.get(model);
  if (resolved === undefined) {
    resolved = provider.length > 0 && id.length > 0 && catalogue.find(provider, id) !== undefined;
    cache.set(model, resolved);
  }
  if (resolved) return undefined;
  return refusal(
    "MODEL_UNRESOLVED",
    `grants: model ${model || "(empty)"} is not in pi's session catalogue; use provider/id from /model, ` +
      `or set ${ENV_ALLOW_UNRESOLVED_MODELS}=1 to let pi attempt custom resolution`,
    { model: model || "(empty)" },
  );
}

/** Exact candidate only; never enumerate providers, resolve credentials, probe, or clamp effort. */
export function runtimePairUnavailable(
  choice: { model?: string; thinking?: string },
  catalogue: ModelCatalogue,
  allowUnresolved = false,
): string | undefined {
  if (!choice.model) return undefined; // No explicit/current choice: preserve Pi's ordinary configured default.
  const slash = choice.model.indexOf("/");
  const provider = choice.model.slice(0, slash),
    id = choice.model.slice(slash + 1);
  if (slash <= 0 || !id) return "runtime model needs provider/model";
  const model = catalogue.find(provider, id);
  if (!model) return allowUnresolved ? undefined : `model ${choice.model} is not in pi's session catalogue`;
  if (
    choice.thinking !== undefined &&
    typeof model === "object" &&
    model !== null &&
    "reasoning" in model &&
    !supportedModelEfforts(model as { reasoning: boolean }).includes(choice.thinking as never)
  ) {
    return `model ${choice.model} does not support thinking ${choice.thinking}`;
  }
  // configured:false cannot distinguish keyless, missing and unknown public provider auth semantics.
  // Reading the passive status is permitted evidence; never turn it into an authentication attempt.
  catalogue.getProviderAuthStatus?.(provider);
  return undefined;
}
