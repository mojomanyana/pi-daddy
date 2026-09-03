import { refusal, type StructuredRefusal } from "./refusals.ts";

export const ENV_ALLOW_UNRESOLVED_MODELS = "PI_GRANTS_ALLOW_UNRESOLVED_MODELS";

export interface ModelCatalogue {
  find(provider: string, modelId: string): unknown;
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
