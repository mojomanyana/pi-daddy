import type { DailyView } from "./daily-view.ts";
const clean = (value: unknown) => String(value ?? "unknown").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
/** Text-only, accessible labels. No command links, control actions, model calls or terminal input. */
export function renderDailyView(view: DailyView, width = 100): string {
  const lines = ["PI-DADDY — READ-ONLY DAILY VIEW", view.narrative,
    `Scope: ${view.scope ? `${view.scope.id} revision ${view.scope.revision} digest ${view.scope.digest}` : "UNRESOLVED — select an exact P01 snapshot"}`,
    `Acceptance authority: ${view.authority}; coverage: PARTIAL; freshness: SNAPSHOT / UNKNOWN`,
    `Models: NOT CONSULTED; connectivity UNKNOWN. Continuity: ${view.continuity}${view.scopeChanged ? "; SCOPE CHANGED" : ""}`,
    `Inputs: work ${view.sources.work}; archive ${view.sources.archive}`, "", "INTENDED OBLIGATIONS"];
  if (!view.obligations.length) lines.push("EMPTY / UNRESOLVED: no scoped obligations available; not proof of no intended work.");
  const attempts = new Map(view.attempts.map(a => [a.executionId, a]));
  for (const o of view.obligations) {
    lines.push(`${o.obligation.id}@${o.obligation.revision} | ${o.acceptance.toUpperCase()} | ${o.activity.toUpperCase()}`,
      `  intent ${o.intent.id}@${o.intent.revision}; policy ${o.policy.id}@${o.policy.revision}`,
      `  artifact ${o.artifactCoverage}; evidence ${o.evidenceCoverage}; P01 matched receipts: ${o.receiptIds.join(", ") || "none"}`,
      `  obstacle: ${o.obstacles.join(", ") || (o.acceptance === "accepted-under-supplied-authority" ? "none under supplied snapshot authority" : "acceptance not established")}`);
    for (const id of o.attempts) {
      const a = attempts.get(id)!;
      lines.push(`  attempt ${id} (logical ${a.logicalChildId ?? "unknown"}) | P01 runtime ${a.intentRuntime} | P03 ${a.archive?.runtime ?? "unavailable"}`);
    }
    for (const ref of o.claimReferences) lines.push(`  claim source ${ref}`);
  }
  lines.push("", "EXECUTION SNAPSHOTS — NOT ACCEPTANCE");
  if (!view.attempts.length) lines.push("EMPTY: no execution attempts in these snapshots.");
  for (const a of view.attempts) {
    const e = a.archive;
    lines.push(`${a.executionId} | logical ${a.logicalChildId ?? "unknown"} | P01 ${a.intentRuntime} | P03 ${e?.runtime ?? "unavailable"}`);
    if (e) {
      lines.push(`  producer-reported exit ${e.outcome?.code ?? "unknown"}; failed control/runtime ${e.outcome?.failed ?? "unknown"}; aborted ${e.outcome?.aborted ?? "unknown"}`,
        `  parents ${e.parentExecutionIds.map(clean).join(", ") || "unknown"}; calls ${e.toolCallIds.map(clean).join(", ") || "unknown"}`,
        `  reported retained sessions ${e.retainedSessionIds.join(", ") || "none"}; ACTIVE BRANCH UNKNOWN`,
        "  check receipt detail/bytes not supplied by P03 v1; never inferred from exit status");
    }
    lines.push(`  obstacle/coverage: ${a.issues.join(", ") || "partial snapshot; freshness unknown"}`);
    for (const r of a.sourceAvailability) lines.push(`  source ${r.sha256} | ${r.state}`);
  }
  lines.push("", `Coverage gaps: ${view.issues.join("; ") || "partial snapshots; live freshness unavailable"}`,
    `Work source SHA256: ${view.sources.workSha256 ?? "missing"}`, `Archive projection SHA256: ${view.sources.archiveSha256 ?? "missing"}`,
    "P06: fixed digest profile only; arbitrary shell/model effects and aggregate CPU/memory/PID/money caps unsupported.",
    "No steering, dispatch, acceptance, session edit or recovery action is performed by this view.");
  const bounded = lines.slice(0, 300); if (lines.length > 300) bounded.push(`${lines.length - 300} additional lines omitted; full rows remain in the read-model.`);
  const columns = Number.isFinite(width) ? Math.max(20, Math.min(240, Math.floor(width))) : 100;
  return bounded.map(line => { const text = [...clean(line)]; return text.length > columns ? text.slice(0, columns - 3).join("") + "..." : text.join(""); }).join("\n");
}
