import type { DebriefFrame, DebriefPresenter } from "./debrief.ts";
import { isDebriefPresenter } from "./debrief.ts";
const safe = (v: unknown) => String(v).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
export function renderDebrief(view: DebriefFrame, width = 100): string {
  const lines = ["PI-DADDY — MANUAL DEBRIEF / WEEKLY QUEUE", `State: ${view.state}; automatic presentation UNQUALIFIED`,
    `Attention: ${view.budgetSpent ?? "UNKNOWN"}/5 allocated slots; ${view.unexposed} incidents not exposed; persistence: ${view.persistence}`,
    view.fixture ? "FROZEN SYNTHETIC FIXTURE — public seed/artifacts, NOT a real blind study" : "Host identity, pause policy and durability are not authenticated by this view."];
  if (view.observation) lines.push(`Selected signal batch: ${view.total} cases; observation ${view.observation.id}`,
    `Observation issues: ${view.observation.issues.join(", ") || "none recorded"}; counts are selected-batch only.`);
  if (view.remainingBudget === null) lines.push("Attention persistence UNKNOWN — no new exposure allowance is inferred.");
  if (view.remainingBudget === 0) lines.push("New questions DEFERRED — budget exhausted. Reopen retains the same slots; answers/skip do not refill them.");
  for (const card of view.cards) {
    if (card.kind === "case") lines.push(`${card.slot}. CASE — ${card.summary}`, `   ${card.disposition} / ${card.resolution}; labels ${card.actionEnabled ? "enabled" : "unavailable or already submitted"}`);
    else {
      lines.push(`${card.slot}. BLIND QUALITY — one shared slot; ${card.choice ? card.choice.kind : "UNSELECTED / UNRESOLVED"}`);
      for (const variant of card.variants) lines.push(`   ${variant.label}: ${variant.text.join(" | ")}`);
      lines.push("   Filenames/captions/metadata omitted; arbitrary artifact text may disclose identity.");
      if (card.revealed) {
        lines.push("   AFTER QUALITY CHOICE — no routing/adoption authorized");
        for (const arm of (card.revealed as { arms: { label: string; cost: number | null; costUnit: string; configuration: Record<string, unknown> }[] }).arms) {
          lines.push(`   ${arm.label}: ${arm.cost ?? "unknown"} ${arm.costUnit}`);
          for (const [key, value] of Object.entries(arm.configuration)) lines.push(`      ${key}: ${String(value)}`);
        }
      }
      else lines.push(`   Configuration/cost hidden; reveal ${card.choiceConfirmed ? "available" : "locked"}. Choices: one / tie / none / insufficient.`);
    }
  }
  lines.push("Skip and unselected remain unresolved. Labels are not work acceptance, causal proof or routing/adoption.",
    "Own dashboard commands: label SLOT DISPOSITION NOTE | choose KIND LABEL... | reveal | reconcile SLOT | close | open",
    "No worker messages, control dispatch or automatic recovery. Missing host callbacks disable actions.");
  const w = Math.max(40, Math.min(240, Math.floor(width) || 100));
  return lines.slice(0, 80).map(line => { const text = safe(line); return text.length > w ? text.slice(0, w - 1) + "…" : text; }).join("\n");
}
/** The actual existing dashboard action seam; no terminal/worker transport or authority metadata. */
export async function debriefAction(presenter: DebriefPresenter, command: string): Promise<unknown> {
  if (!isDebriefPresenter(presenter) || typeof command !== "string" || command.length > 4096) throw new Error("invalid debrief action");
  const [action, ...args] = command.trim().split(/\s+/), view = presenter.view();
  if (action === "close" && !args.length) { return presenter.close(); }
  if (action === "open" && !args.length) { return presenter.open({ mode: "manual", userPresent: true }); }
  if (action === "reveal" && !args.length) { return presenter.reveal(); }
  if (action === "choose") { return presenter.choose({ kind: args[0] as "one", labels: args.slice(1) }); }
  const slot = Number(args[0]), card = view.cards.find(c => c.slot === slot);
  if (card?.kind !== "case") throw new Error("exact exposed case slot required");
  if (action === "reconcile" && args.length === 1) { return presenter.reconcile(card.caseManifestId); }
  if (action === "label" && args.length >= 2) {
    return presenter.label({ caseManifestId: card.caseManifestId, priorDecisionId: card.priorDecisionId, disposition: args[1] as "skip", note: args.slice(2).join(" ") });
  }
  throw new Error("unsupported debrief action");
}
