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

/** Standard is a strict prompt no-op. Concise, non-contradictory guidance for open-weight models. */
export function workModeGuidance(value: WorkModeSelection | undefined, role: "parent" | "child"): string | undefined {
  if (!value || value.mode === "standard") return;
  const selected = value.emphases;
  const lines = [
    `Working style: ${workModeLabel(value)}.`,
    role === "child"
      ? "Stay strictly within your assigned role and tool ceiling; report concrete evidence."
      : "Own the end-to-end outcome cleanly with zero unnecessary ceremony.",
  ];
  if (selected.length === 0) {
    lines.push(
      role === "child"
        ? "Balanced ambitious mode: verify root causes, cover edge cases with executable tests, and keep the diff minimal and clean."
        : "Balanced ambitious mode: keep simple edits direct; session fanout allows 24 active descendants (8 per call); " +
            "add a second reviewer when you can give it a distinct question; start a 2-candidate delegate_tournament automatically " +
            "when competing approaches have a concrete way to judge them; run related Skill Harness scenarios on shared skill changes.",
    );
  } else {
    for (const key of selected) lines.push(emphases[key]);
  }
  lines.push("Prove every requirement with actual test/command output; keep reporting concise.");
  return lines.join("\n");
}
