import type { GrantsSession } from "./session.ts";

export function ecosystemToolLabel(name: string, agent?: unknown): string | undefined {
  if (name === "delegate" && typeof agent === "string" && /^[\w.-]{1,80}$/.test(agent)) return "Delegate · " + agent;
  if (name.startsWith("delegate") || name === "quick_review") return "Daddy · " + name;
  if (name.startsWith("bookie_")) return "Bookie · " + name.slice(7).replaceAll("_", " ");
  if (name.startsWith("scout_") || name.startsWith("research_"))
    return "Scout · " + name.replace(/^(scout|research)_/, "").replaceAll("_", " ");
  if (name.startsWith("skill_")) return "Skill Harness · " + name.slice(6).replaceAll("_", " ");
}

export function summarizeObservations(session: GrantsSession): { memoryLines: string[]; researchLines: string[] } {
  const memoryLines: string[] = [];
  const researchLines: string[] = [];
  try {
    const obs = session.dashboardObservations?.();
    for (const src of obs?.sources ?? []) {
      const producer = String((src as { producer?: string }).producer ?? "").toLowerCase();
      const target = producer.includes("scout") ? researchLines : producer.includes("bookie") ? memoryLines : undefined;
      if (!target) continue;
      const items = (src as { items?: Array<{ label?: string; state?: string }> }).items ?? [];
      for (const item of items.slice(0, 6)) {
        target.push(`${item.label ?? producer} (${item.state ?? "observed"})`);
      }
    }
  } catch {
    /* Observations are optional. */
  }
  return { memoryLines, researchLines };
}
