/** Human content previews from an authorized, current producer snapshot; rendering performs no reads. */
import type { DashboardInventory, DashboardSourceSnapshot } from "../kernel/dashboard-observation.ts";
import { dashboardText } from "./dashboard-screen.ts";
import { truncate } from "./dashboard-render.ts";

const clean = (text: string) => dashboardText(text).replace(/\s+/g, " ").trim();

export function inventoryPresentation(inventory: DashboardInventory | undefined) {
  if (!inventory) return { preview: [] as string[], content: [] as string[], references: [] as string[] };
  const entries = inventory.state === "available" ? inventory.entries : [];
  const summary = clean(inventory.summary);
  const coverage = inventory.limited
    ? inventory.count === undefined
      ? "Showing a bounded selection; this is not the full inventory."
      : `Showing ${entries.length} of ${inventory.count} saved items.`
    : undefined;
  return {
    preview: [truncate(summary, 110), ...entries.slice(0, 2).map((entry) => `• ${truncate(clean(entry.title), 90)}`)],
    content: [
      `Scope: ${clean(inventory.scope)}`,
      summary,
      ...(coverage ? [coverage] : []),
      ...entries.flatMap((entry, index) => [
        "",
        `${index + 1}. ${clean(entry.title)}`,
        `   ${clean(entry.summary)}`,
        ...(entry.details ?? []).map((line) => `   ${clean(line)}`),
      ]),
    ],
    references: entries.flatMap((entry) =>
      entry.reference ? [`${clean(entry.title)}: ${clean(entry.reference)}`] : [],
    ),
  };
}

export function observationAge(source: DashboardSourceSnapshot | undefined, now: number): string {
  if (!source) return "No status report received yet.";
  const age = now - Date.parse(source.observedAt);
  if (!Number.isFinite(age) || age < 0) return "The last update time could not be verified.";
  if (age < 10_000) return "Updated just now.";
  if (age < 60_000) return `Updated ${Math.floor(age / 1000)}s ago.`;
  if (age < 3_600_000) return `Updated ${Math.floor(age / 60_000)}m ago.`;
  return `Updated ${Math.floor(age / 3_600_000)}h ago.`;
}
