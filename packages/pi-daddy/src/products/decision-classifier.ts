import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EcosystemHarvestConfig } from "../kernel/ecosystem-config.ts";

type Registry = ExtensionContext["modelRegistry"];
export const directProvider = "openrouter-direct";
const prefix = directProvider + "/";
export function classifierRecovery(model: string): string {
  if (model.startsWith("openrouter/"))
    return "In the Pi chat pane, run /login openrouter and check the connection. Then reopen the classifier picker.";
  if (model.startsWith(prefix))
    return "Check OPENROUTER_API_KEY in the shell that starts Pi, restart Pi, then reopen the classifier picker.";
  return "Check the classifier provider connection in Pi, then reopen the classifier picker.";
}
export const harvestQuestion = {
  type: "bool" as const,
  instructions: "Should this completed coding-agent turn be saved as a regression evaluation?",
  criteria: {
    true: "A generalizable agent or skill failure, such as a thrash loop, wrong assumption, review blocker, or tool misuse.",
    false: "Routine work, a preference change, or a one-off environment hiccup.",
  },
};
type Question = typeof harvestQuestion | { type: "choice"; instructions: string; criteria: Record<string, string> };
type State = Record<string, string | string[]>;
export function thresholdFor(config: EcosystemHarvestConfig | undefined, model: string): number {
  const saved = config?.thresholds?.[model];
  if (saved !== undefined) return saved;
  const id = model.slice(model.indexOf("/") + 1);
  if (model.startsWith(prefix) || model.startsWith("openrouter/")) {
    if (id === "typesafe/jev-1.14") return 0.53;
    if (id === "openai/gpt-6-luna-decisions") return 0.65;
    if (id === "jaredpalmer/kev-4b") return 0.5;
  }
  return config?.minConfidence ?? 0.75;
}
export async function classifierCatalog(registry: Registry) {
  const models = new Set<string>();
  const errors: string[] = [];
  const results = await Promise.allSettled([
    (async () => {
      const found = await registry.getAvailableOfType("classifier", undefined, { signal: AbortSignal.timeout(10000) });
      return found.map((m) => m.provider + "/" + m.id);
    })(),
    (async () => {
      if (!process.env.OPENROUTER_API_KEY) return [];
      const response = await fetch("https://openrouter.ai/api/v1/models?output_modalities=decisions", {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw Error("Catalog HTTP " + response.status);
      const { data } = (await response.json()) as {
        data: { id: string; architecture?: { output_modalities?: string[] } }[];
      };
      return data.filter((m) => m.architecture?.output_modalities?.includes("decisions")).map((m) => prefix + m.id);
    })(),
  ]);
  for (const [i, result] of results.entries()) {
    if (result.status === "fulfilled") result.value.forEach((id) => models.add(id));
    else errors.push(i === 0 ? "Pi classifier catalog unavailable" : "OpenRouter direct catalog unavailable");
  }
  return { models: [...models].sort(), errors };
}

export async function askClassifier(
  registry: Registry,
  model: string,
  state: State,
  question: Question,
  signal: AbortSignal,
) {
  const slash = model.indexOf("/");
  const provider = model.slice(0, slash);
  const id = model.slice(slash + 1);
  const key = question.type === "bool" ? "save" : "route";
  if (provider === directProvider) {
    const token = process.env.OPENROUTER_API_KEY;
    if (!token) throw Error("OpenRouter direct requires OPENROUTER_API_KEY in Pi's environment.");
    const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      redirect: "error",
      signal,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: id,
        state,
        questions: { [key]: { ...question, type: question.type === "bool" ? "noul" : "choice" } },
      }),
    });
    if (!response.ok) throw Error("OpenRouter returned HTTP " + response.status);
    const result = await response.json();
    if (result.error) throw Error("OpenRouter decision failed.");
    const answer = result.answers?.[key];
    return {
      value:
        question.type === "bool"
          ? answer?.type === "noul"
            ? answer.noul
            : undefined
          : answer?.type === "choice"
            ? answer.choice
            : undefined,
      model: String(result.model ?? id),
    };
  }
  const selected = registry.getModelOfType("classifier", provider, id);
  if (!selected) throw Error("Classifier unavailable: " + model);
  const result = await registry.classify(selected, { state, questions: { [key]: question } }, { signal });
  if (result.stopReason !== "stop") throw Error("Classifier request failed: " + model);
  const answer = result.answers[key];
  return {
    value:
      question.type === "bool" && answer?.type === "bool"
        ? answer.probability
        : question.type === "choice" && answer?.type === "choice"
          ? answer.choice
          : undefined,
    model: result.provider + "/" + result.model,
  };
}
export async function harvestProbability(registry: Registry, model: string, digest: string, signal: AbortSignal) {
  const answer = await askClassifier(registry, model, { turn: digest }, harvestQuestion, signal);
  if (typeof answer.value !== "number" || !Number.isFinite(answer.value) || answer.value < 0 || answer.value > 1)
    throw Error("Invalid decision probability from " + model);
  return { probability: answer.value as number, model: answer.model };
}
