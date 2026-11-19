/** Optional working-style guidance. This data never participates in execution authority or task identity. */
export { ENV_WORK_MODE } from "./env-names.ts";
export const WORK_MODE_EMPHASES = ["speed", "altitude", "depth", "range"] as const;
export type WorkModeEmphasis = (typeof WORK_MODE_EMPHASES)[number];
export interface WorkModeSelection {
  mode: "standard" | "ambitious";
  emphases: WorkModeEmphasis[];
}
export interface WorkModeSnapshot {
  available: boolean;
  selection: WorkModeSelection;
  nextRequest?: WorkModeSelection;
  active?: WorkModeSelection;
  inherited: boolean;
  note?: string;
}
export const WORK_MODE_LABELS: Record<WorkModeEmphasis, string> = {
  speed: "Faster delivery",
  altitude: "Better outcome",
  depth: "Deeper proof",
  range: "Broader approaches",
};
export const standardWorkMode = (): WorkModeSelection => ({ mode: "standard", emphases: [] });

/** Accept only bounded enumerated data. No arbitrary prompt can enter through stored state or transport. */
export function parseWorkMode(value: unknown): WorkModeSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "mode" && key !== "emphases")) return;
  if (input.mode !== "standard" && input.mode !== "ambitious") return;
  const choices = input.emphases;
  if (!Array.isArray(choices) || choices.length > WORK_MODE_EMPHASES.length) return;
  if (choices.some((item) => !WORK_MODE_EMPHASES.includes(item as WorkModeEmphasis))) return;
  if (new Set(choices).size !== choices.length) return;
  if (input.mode === "standard" && choices.length > 0) return;
  return {
    mode: input.mode,
    emphases: WORK_MODE_EMPHASES.filter((item) => choices.includes(item)),
  };
}

export function workModeLabel(value: WorkModeSelection): string {
  return value.mode === "standard"
    ? "Standard (current behavior)"
    : `Ambitious · ${value.emphases.length ? value.emphases.map((key) => WORK_MODE_LABELS[key]).join(" + ") : "balanced"}`;
}

const emphases: Record<WorkModeEmphasis, string> = {
  speed:
    "Faster delivery: simplify the approach, reuse valid evidence and completed work, and parallelize useful independent work when worthwhile.",
  altitude:
    "Better outcome: examine the purpose behind the requested artifact and consider a better route to the agreed outcome.",
  depth:
    "Deeper proof: challenge important assumptions using raw evidence, suitable professional instruments and a small decisive experiment.",
  range:
    "Broader approaches: borrow a useful technique from another discipline when it changes the method or result; choose concrete methods, not expert personas.",
};

/** Standard is a strict prompt no-op. Child guidance supplements, and never replaces, its assigned role. */
export function workModeGuidance(value: WorkModeSelection | undefined, role: "parent" | "child"): string | undefined {
  if (!value || value.mode === "standard") return;
  const selected = value.emphases.length ? value.emphases : WORK_MODE_EMPHASES;
  return [
    "<pi-daddy-work-mode>",
    `Working style: ${workModeLabel(value)}. This is optional approach guidance for this request.`,
    role === "child"
      ? "Stay within the assigned task and role: review remains review and read-only investigation remains read-only. Return evidence and useful findings to the parent."
      : "Own the agreed outcome and choose a proportionate approach using relevant installed skills and available tools.",
    ...selected.map((key) => emphases[key]),
    "Select the useful directions; they are not required stages. Before expensive work, identify the important assumption, " +
      "available raw evidence and a check that could disprove it.",
    "Use observed results to revise the method. Seek independent checks such as tests, measurements, source data or actual user-path observations. " +
      "Another model's opinion alone is not proof.",
    "Treat stretch targets as bounded experiments with a baseline and honest results. Ask about material changes to the agreed goal, scope or cost; " +
      "continue routine authorized work without extra ceremony.",
    "Missing optional evidence narrows claims, not independent work. Keep genuine permission and execution constraints. " +
      "Mode selection changes no permissions, tools, models, limits or JEV settings.",
    "Reuse completed work and current evidence. No mandatory delegation, research, evaluation or memory calls: " +
      "use them only when useful and available under their existing rules.",
    "For useful progress checkpoints, preserve the chosen approach, observed findings, limitations and next unfinished step through available memory, " +
      "so resuming need not repeat work.",
    "Keep planning and reporting concise; spend effort on delivery and verification.",
    "</pi-daddy-work-mode>",
  ].join("\n");
}
