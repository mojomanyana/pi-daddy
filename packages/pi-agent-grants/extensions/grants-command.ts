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
import type { GatedPlan } from "./run-delegation.ts";
import { loadApprovals, revokeAll, revokeApproval, type SubjectLookup } from "../src/approval-store.ts";
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
  /** Key → body digest, as `parseInherited` returns it (ADR-0022). Only `.size` is read here. */
  inheritedApprovals: Map<string, string | undefined>;
  /** A definition's current ceiling and body digest, for the store's confused-deputy check (ADR-0019). */
  snapshotOf: SubjectLookup;
  /**
   * What a real `delegate({agent: name})` would do, decided by the code that would do it.
   *
   * Was `delegationContext` plus a `planDelegation` call here, which shared the planner but not the
   * **approval step** — so a definition whose one gated capability was covered by a valid persisted approval
   * was listed as blocked while a spawn proceeded silently (R-38). Injecting the whole preview keeps the
   * R-28 discipline where it belongs: this command asks what would happen instead of working it out.
   */
  previewDelegation: (name: string) => Promise<GatedPlan>;
}

/**
 * How many definitions `/grants` previews. Each one runs the real planner, so this bounds work, not truth —
 * and whatever it drops is now stated rather than silently omitted (R-48).
 */
const PREVIEW_LIMIT = 12;

export const grantsCommand = {
  description:
    "Show this session's capability grant, delegation depth, and known agent-type ceilings; " +
    "/grants approvals | /grants ledger | /grants revoke <key>|--all",
handler: async (args: string, ctx: any) => {
    // Everything this command may see, named in one place. Previously these were whatever happened to be in
    // the enclosing closure — which is how a diagnostic came to disagree with the enforcer (R-28).
    const {
      cwd, governed, ownGrant, observed, depth, maxDepth, ledgerPath,
      catalog, definitions, sessionApprovals, inheritedApprovals, snapshotOf, previewDelegation,
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
      // R-51. ADR-0018 advertises that the ledger answers "did these four children run the same
      // instructions?" and "has this definition changed since?" — and nothing read `definitionDigest`, so
      // both needed hand-written jq and the second was not reproducible with `sha256sum` (the digest covers
      // the body, not the frontmatter). The comparison against disk uses the SAME `snapshotOf` the approval
      // store uses, so this listing cannot disagree with what voids an approval.
      if (report.definitions.length > 0) {
        lines.push(`  instructions ${report.definitions.length} distinct version(s) across the recorded spawns`);
        for (const d of report.definitions) {
          const here = definitions.get(d.name);
          const current = snapshotOf(d.name);
          // F4: compare the SOURCE too. A ledger path exported once in a shell profile is shared by every
          // project — nothing scopes `PI_GRANTS_LEDGER` per project — so two different `deploy` definitions
          // in two checkouts were reported as one definition that had CHANGED, and the NOTE below called it
          // a finding. `verifyLedger` has carried `source` all along; the listing simply never read it.
          const state =
            current === null
              ? "no such definition here"
              : here && here.source !== d.source
                ? "another project's definition of the same name"
                : current.bodySha256 === d.sha256
                  ? "current"
                  : "CHANGED since";
          lines.push(`    ${d.name}  ${d.sha256.slice(0, 12)}  ${d.spawns} spawn(s)  — ${state}`);
        }
        // Two rows for one name is the finding, not a formatting quirk: the same definition ran under two
        // different bodies inside this ledger.
        // Only versions of the SAME file count as "ran under more than one version" — grouping by name
        // alone turned two projects' same-named definitions into a fabricated instruction change.
        const names = report.definitions.map((d) => `${d.name}\u0000${d.source}`);
        for (const key of [...new Set(names)]) {
          const name = key.slice(0, key.indexOf("\u0000"));
          if (names.filter((n) => n === key).length > 1) {
            lines.push(`    NOTE ${name} ran under more than one version of its instructions in this ledger`);
          }
        }
      }
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
      const { valid, dropped } = await loadApprovals({ cwd, now: new Date(), snapshotOf });
      // The count says "valid", and the ignored entries are listed below it — but a reader who stops at
      // the first line would conclude the file is empty, so the ignored total goes on that same line.
      const lines = [
        `grants: ${valid.size} persisted approval${valid.size === 1 ? "" : "s"}` +
          (dropped.length > 0 ? `, ${dropped.length} ignored` : ""),
      ];
      for (const [key, entry] of valid) {
        lines.push(`  ${key}`);
        lines.push(`    approved ${entry.approvedAt}, expires ${entry.expiresAt}`);
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
          // "in this project" is not padding: the store is shared by every project on the machine, and
          // this used to clear all of them.
          ok
            ? "grants: all persisted approvals for this project revoked"
            : "grants: failed to revoke — could not write the approvals file",
          ok ? "info" : "warning",
        );
      } else if (!target) {
        ctx.ui.notify("grants: usage — /grants revoke <capability>@<agent-type> | --all", "warning");
      } else {
        const removed = await revokeApproval(cwd, target, snapshotOf, new Date());
        ctx.ui.notify(
          removed ? `grants: revoked ${target}` : `grants: no persisted approval named ${target}`,
          removed ? "info" : "warning",
        );
      }
      return;
    }

    const { valid } = await loadApprovals({ cwd, now: new Date(), snapshotOf });
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
    // Runs the REAL planner AND the real approval step over each definition, so this listing cannot
    // disagree with what a spawn would do — the R-28 lesson, kept structural rather than remembered.
    const shown = [...definitions].slice(0, PREVIEW_LIMIT);
    for (const [name] of shown) {
      const { plan, approval } = await previewDelegation(name);
      // Why it is allowed, when a standing approval is the reason. An `allow` that silently depends on a
      // 30-day entry in a file elsewhere is precisely what an operator runs this command to discover, and
      // R-38 was the version of this listing that could not have told them (it said BLOCK instead).
      // R-46: name each capability's own source, since they can differ (persisted for one, a live prompt
      // for another). The scalar this replaced picked one and applied it to the set.
      const because =
        plan.ok && approval && approval.approved.length > 0
          ? `  (${approval.approved.map((c) => `${c} approved: ${approval.sources[c] ?? "?"}`).join("; ")})`
          : "";
      lines.push(
        `    ${plan.ok ? "allow" : "BLOCK"}  ${name}` +
          (plan.ok ? `  ${plan.effective.join(", ")}${because}` : ` — ${plan.reason}`),
      );
    }
    // R-48. The cap is fine; the SILENCE was not. An operator running `/grants` to answer "what can this
    // session spawn without asking me?" — the exact question R-38 was fixed for — cannot tell a definition
    // that was omitted from one that does not exist, and the `catalog … N agent-type` line above
    // contradicts the short list with no explanation. Map order is discovery order, so the entries dropped
    // are the GLOBAL ones (`~/.pi/agent/skills`), which is the least obvious thing to lose.
    if (definitions.size > shown.length) {
      lines.push(`    … and ${definitions.size - shown.length} more not shown (first ${PREVIEW_LIMIT} only)`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
  },
};
