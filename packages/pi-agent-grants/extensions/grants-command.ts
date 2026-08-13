/**
 * The `/grants` command — session status, approvals, and ledger integrity.
 *
 * Extracted from `extensions/grants.ts` because that file is where every wiring bug in this package has
 * lived (the G7 `NaN` bound, the discarded `isError`, the unconditional `delegate` registration, R-28's
 * omitted argument), and three independent reviewers flagged its size before any of them was found. A
 * read-only diagnostic is the cleanest thing to lift out: nothing calls it, so it cannot be part of a
 * governance path.
 *
 * It takes its dependencies as an **explicit context object** rather than closing over module state. That is
 * the point of the extraction: what this command can see is now written down in one interface instead of
 * being whatever happened to be in scope.
 */

import type { Capability } from "../src/resolve.ts";
import type { Catalog } from "../src/catalog.ts";
import type { SkillDefinition } from "../src/definitions.ts";
import type { InheritableApproval } from "../src/approval.ts";
import type { DelegationContext } from "../src/delegate.ts";
import { approvalKey, resolveApprovals } from "../src/approval.ts";
import { legacyApprovalsPath, loadApprovals, revokeAll, revokeApproval } from "../src/approval-store.ts";
import { planDelegation } from "../src/delegate.ts";
import { verifyLedger } from "../src/ledger.ts";

export interface GrantsCommandContext {
  cwd: string;
  governed: boolean;
  ownGrant: Capability[];
  observed: boolean;
  depth: number;
  maxDepth: number;
  ledgerPath?: string;
  catalog: Catalog;
  definitions: Map<string, SkillDefinition>;
  sessionApprovals: Set<string>;
  /** Keys, not entries — `parseInherited` returns a Set. Declared as a Map until the split, which was
   *  harmless only because the handler takes `ctx: any` and reads nothing but `.size`. */
  inheritedApprovals: Set<string>;
  /** Current ceiling for a definition, for the store's confused-deputy check. */
  ceilingOf: (subject: string) => Capability[] | null;
  /** The shared builder, so the preview cannot disagree with what a real spawn would do (R-28). */
  delegationContext: (approved?: InheritableApproval[]) => Promise<DelegationContext>;
}

export const grantsCommand = {
  description:
    "Show this session's capability grant, delegation depth, and known agent-type ceilings; " +
    "/grants approvals | /grants ledger | /grants revoke <key>|--all",
handler: async (args: string, ctx: any) => {
    // Everything this command may see, named in one place. Previously these were whatever happened to be in
    // the enclosing closure — which is how a diagnostic came to disagree with the enforcer (R-28).
    const {
      cwd, governed, ownGrant, observed, depth, maxDepth, ledgerPath,
      catalog, definitions, sessionApprovals, inheritedApprovals, ceilingOf, delegationContext,
    } = ctx.grants as GrantsCommandContext;

    const [sub, target] = args.trim().split(/\s+/).filter(Boolean);

    if (sub === "ledger") {
      // The detector, made reachable. `verifyLedger` exists because nothing in this package had ever read
      // a ledger back, so a torn line was indistinguishable from a spawn that never happened — and a
      // check an operator cannot run is not a control.
      if (!ledgerPath) {
        ctx.ui.notify("grants: no ledger — set PI_GRANTS_LEDGER to record grants and refusals.", "warning");
        return;
      }
      const report = await verifyLedger(ledgerPath);
      if (!report.exists) {
        ctx.ui.notify(`grants: ledger ${ledgerPath} does not exist yet (nothing has been delegated).`, "info");
        return;
      }
      const lines = [
        `grants: ledger ${ledgerPath}`,
        `  records    ${report.records}`,
        `  escalation ${report.escalationAttempts} attempt(s) — grants refused for exceeding what the session held`,
        `  integrity  ${report.ok ? "OK" : `${report.corrupt.length} UNPARSEABLE LINE(S)`}`,
      ];
      for (const bad of report.corrupt.slice(0, 5)) lines.push(`    line ${bad.line}: ${bad.text}`);
      if (!report.ok) {
        // Deliberately not repaired. A corrupt line is evidence; rewriting the file to make it parse
        // would destroy the one artifact an investigation has.
        lines.push("  A corrupt line is EVIDENCE and is left alone. Concurrent writers on a non-POSIX");
        lines.push("  filesystem (drvfs under /mnt, NFS) are the likely cause — move the ledger to a local path.");
      }
      ctx.ui.notify(lines.join("\n"), report.ok ? "info" : "error");
      return;
    }

    if (sub === "approvals") {
      const { valid, dropped } = await loadApprovals({ cwd, now: new Date(), ceilingOf });
      // The count says "valid", and the ignored entries are listed below it — but a reader who stops at
      // the first line would conclude the file is empty, so the ignored total goes on that same line.
      const lines = [
        `grants: ${valid.size} persisted approval${valid.size === 1 ? "" : "s"}` +
          (dropped.length > 0 ? `, ${dropped.length} ignored` : ""),
      ];
      for (const [key, entry] of valid) {
        lines.push(`  ${key}`);
        lines.push(`    approved ${entry.approvedAt}, expires ${entry.expiresAt}`);
        if (entry.taskAtApproval) lines.push(`    for: ${entry.taskAtApproval}`);
      }
      // Dropped entries are SHOWN, not silently omitted — otherwise a revoked-by-expiry approval looks
      // like one that was never given. Malformed entries are also reported as "expired" by the store
      // (a deliberate simplification so it need not extend EntryVerdict); relabel those here so a
      // corrupt entry doesn't read as a timed-out one.
      //
      // This mirrors `isValidEntryShape` in `src/approval-store.ts` (all four required fields) and
      // must be kept in step with it — it is a display-only relabeling of an entry the store already
      // dropped, not a second validity decision, so it stays here rather than moving into `src/`.
      for (const d of dropped) {
        const raw = d.entry as Partial<Record<"approvedAt" | "expiresAt" | "cwd" | "grantAtApproval", unknown>>;
        const shapeCorrupt =
          typeof raw?.approvedAt !== "string" ||
          typeof raw?.expiresAt !== "string" ||
          typeof raw?.cwd !== "string" ||
          !Array.isArray(raw?.grantAtApproval);
        const verdict = shapeCorrupt ? "malformed" : d.verdict;
        lines.push(`  (ignored) ${d.key} — ${verdict}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }

    if (sub === "revoke") {
      if (target === "--all") {
        const ok = await revokeAll(cwd);
        ctx.ui.notify(
          ok ? "grants: all persisted approvals revoked" : "grants: failed to revoke — could not write the approvals file",
          ok ? "info" : "warning",
        );
      } else if (!target) {
        ctx.ui.notify("grants: usage — /grants revoke <capability>@<agent-type> | --all", "warning");
      } else {
        const removed = await revokeApproval(cwd, target, ceilingOf, new Date());
        ctx.ui.notify(
          removed ? `grants: revoked ${target}` : `grants: no persisted approval named ${target}`,
          removed ? "info" : "warning",
        );
      }
      return;
    }

    const { valid } = await loadApprovals({ cwd, now: new Date(), ceilingOf });
    const lines = [
      governed ? "grants: ACTIVE" : "grants: inactive (set PI_GRANTS_GRANT to govern this session)",
      `  holding    ${ownGrant.join(", ") || "(nothing)"}${observed ? " (observed)" : " (inherited, not yet observed)"}`,
      `  depth      ${depth} of max ${maxDepth}${maxDepth <= 0 ? " (spawning disabled)" : ""}`,
      `  ledger     ${ledgerPath ?? "(not recording — set PI_GRANTS_LEDGER)"}`,
      `  approvals  ${sessionApprovals.size} this session, ${valid.size} persisted` +
        `${inheritedApprovals.size > 0 ? `, ${inheritedApprovals.size} inherited` : ""}` +
        ` — /grants approvals`,
      `  catalog    ${catalog.all.length} capabilities — ` +
        `${catalog.byKind("builtin").length} builtin, ${catalog.byKind("extension").length} extension, ` +
        `${catalog.byKind("skill").length} skill, ${catalog.byKind("agentType").length} agent-type`,
    ];
    // Runs the REAL planner over each definition, so this listing cannot disagree with what a spawn
    // would do — the R-28 lesson, kept structural rather than remembered.
    for (const [name] of [...definitions].slice(0, 12)) {
      const d = planDelegation({ task: "(preview)", agent: name }, await delegationContext());
      lines.push(`    ${d.ok ? "allow" : "BLOCK"}  ${name}${d.ok ? `  ${d.effective.join(", ")}` : ` — ${d.reason}`}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
  },
};
