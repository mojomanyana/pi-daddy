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
import type { ExecutorChoice } from "../src/executor.ts";
import type { Catalog } from "../src/catalog.ts";
import type { SkillDefinition } from "../src/definitions.ts";
import type { GatedPlan } from "./run-delegation.ts";
import { loadApprovals, revokeAll, revokeApproval, type SubjectLookup } from "../src/approval-store.ts";
import { verifyLedger } from "../src/ledger.ts";

export interface GrantsCommandContext {
  cwd: string;
  governed: boolean;
  ownGrant: Capability[];
  /**
   * Which executor this session settled on, and why — ADR-0031.
   *
   * The whole `ExecutorChoice` rather than a rendered string, so this command cannot compose a different
   * sentence from the one the session banner printed. Two spellings of one fact is R-28.
   */
  executor: ExecutorChoice;
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
  /**
   * Run `/grants init`: scaffold definitions, ask about the withheld capabilities only, store the answer
   * outside the workspace, and apply it to this session (ADR-0030).
   *
   * Injected rather than imported so this module stays what it is — a read-only diagnostic that cannot
   * become a governance path by accident. The one command here that *writes* takes its ability to do so
   * from the caller, visibly.
   */
  runInit: () => Promise<void>;
}

/**
 * How many definitions `/grants` previews. Each one runs the real planner, so this bounds work, not truth —
 * and whatever it drops is now stated rather than silently omitted (R-48).
 */
const PREVIEW_LIMIT = 12;

/** The verbs `/grants` answers to. Anything else is refused rather than silently treated as no verb. */
const KNOWN_SUBCOMMANDS: readonly string[] = ["init", "ledger", "approvals", "revoke"];

export const grantsCommand = {
  description:
    "Show this session's capability grant, delegation depth, and known agent-type ceilings; " +
    "/grants approvals | /grants ledger | /grants revoke <key>|--all",
handler: async (args: string, ctx: any) => {
    // Everything this command may see, named in one place. Previously these were whatever happened to be in
    // the enclosing closure — which is how a diagnostic came to disagree with the enforcer (R-28).
    const {
      cwd, governed, ownGrant, executor, observed, depth, maxDepth, ledgerPath,
      catalog, definitions, sessionApprovals, inheritedApprovals, snapshotOf, previewDelegation,
    } = ctx.grants as GrantsCommandContext;

    const [sub, target] = args.trim().split(/\s+/).filter(Boolean);

    if (sub === "init") {
      await ctx.grants.runInit();
      return;
    }

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
      // ADR-0020's revisit trigger, made runnable. That ADR keeps the persistence layer on an ASSERTED
      // fatigue argument and named the evidence that would settle it — `persisted` against `prompt` over a
      // few weeks of real use — then said it "needs no new machinery". True of the data, false of the
      // answer: nothing counted it, so the measurement required hand-written jq and never happened. R-51's
      // shape exactly, and the reason that entry exists.
      const { bySource, distinctBySource, unattributed, humanDenied, humanDeniedPairs } = report.approvals;
      const attributed = Object.values(bySource).reduce((sum, n) => sum + n, 0);
      // **Declines are reported on their own, not folded into the approvals block.** They were rendered
      // inside this guard, so a ledger of nothing BUT declines — a session where the operator said no to
      // everything, which is the strongest possible evidence the gate is working and the most alarming
      // shape an audit can take — printed no mention of them at all. The number that argues hardest for
      // this package's gating was invisible in exactly the ledger that argues hardest.
      if (humanDenied > 0) {
        lines.push(
          `  declined   ${humanDenied} record(s) across ${humanDeniedPairs} distinct capability@subject ` +
            `pair(s) — a human was asked and said no. Pairs is the number of DECISIONS: one *Deny* under a ` +
            `fan-out writes one record per child.`,
        );
      }
      if (attributed > 0 || unattributed > 0) {
        lines.push(
          `  approvals  ${bySource.prompt} prompt · ${bySource.persisted} persisted · ${bySource.session} session · ` +
            `${bySource.inherited} inherited`,
        );
        // **Two numbers, because one of them would lie.** Counting `persisted` RECORDS as prompts avoided
        // overstates the layer twentyfold in the obvious case: precedence is inherited → session →
        // persisted → prompt, and `session` approvals are in memory and owe the store nothing, so twenty
        // spawns under one persisted entry would have been ONE prompt and nineteen session hits without it.
        // Distinct `capability@subject` pairs bounds it properly. The exact figure needs a session id the
        // ledger does not carry, so the bound is printed AS a bound rather than dressed up as an answer.
        // **Pairs against pairs.** The comparison ADR-0020 asks for is `persisted` vs `prompt`, and the
        // first version printed persisted RECORDS against a denominator of ALL records — so widening a
        // fan-out drove the ratio arbitrarily toward "delete the layer" with zero additional human
        // decisions (`inherited` and `session` are written once per CHILD). Measured: the same two human
        // approvals read as 69% at fan-out 8 and 3.8% at fan-out 512. `distinctBySource.prompt` was being
        // computed and never shown, which is the number that makes the comparison honest.
        lines.push(
          `    ADR-0020: ${distinctBySource.persisted} persisted vs ${distinctBySource.prompt} prompted ` +
            `capability@subject pair(s) — the comparison that decides Option 3.`,
        );
        lines.push(
          `    (${bySource.persisted} persisted record(s) over ${attributed} attributed. RECORDS ARE AN ` +
            `UPPER BOUND on prompts avoided, not a count: within one session only the first would have been ` +
            `a prompt, and a wide fan-out inflates every per-record figure without any extra human decision. ` +
            `Deleting the layer costs at most one prompt per pair per session.)`,
        );
        if (unattributed > 0) {
          // States what was observed, not a cause. Pre-0.11.1 lines are the COMMON reason, and a torn line,
          // a hand edit or an unrecognised source value produce the same count — asserting the version
          // would be a guess dressed as a fact, in a report whose whole value is that its numbers mean what
          // they say.
          lines.push(
            `    ${unattributed} not counted — the record named approved capabilities but no usable ` +
              `per-capability source. Usually a line written before 0.11.1, where one scalar described the ` +
              `whole set and over-claimed "prompt" (R-46); a damaged or hand-edited line reads the same.`,
          );
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
        // R-49. This was a boolean, so a FAILED write printed "no persisted approval named X" — telling an
        // operator that the thing they are revoking does not exist, while it survives. The three outcomes
        // are three different facts and the worst of them was disguised as the most reassuring.
        const outcome = await revokeApproval(cwd, target, snapshotOf, new Date());
        ctx.ui.notify(
          {
            revoked: `grants: revoked ${target}`,
            absent: `grants: no persisted approval named ${target}`,
            // Says only what was checked. `failed` found the entry and could not remove it, so "still in
            // effect" is verified; `busy` never got past the lock, so it claims nothing about the entry at
            // all — asserting it there would be R-61 again, one size smaller.
            failed:
              `grants: ${target} was NOT revoked — the approvals file could not be written. It is still in ` +
              `effect; check that the path is writable and try again.`,
            // Names no cause, because at this point none was established: a lock held by another session,
            // an exhausted file-descriptor table and a read-only path all land here identically, having
            // read nothing. Guessing "another session is writing" would be wrong for two of the three.
            busy:
              `grants: ${target} could not be checked — the approvals file could not be opened for writing ` +
              `(another session may hold it, or the path may not be writable). NOTHING was changed, and ` +
              `this says nothing about whether that approval exists.`,
          }[outcome],
          outcome === "revoked" ? "info" : outcome === "absent" ? "warning" : "error",
        );
      }
      return;
    }

    // **An unrecognised subcommand is refused, not ignored (R-74).** Every `sub` that is not a known verb
    // fell through to this status screen with the word silently dropped, so `/grants init` — a command that
    // does not exist — printed a healthy-looking report and read as though it had run. `/grants ledgr` did
    // the same. A diagnostic that answers a question nobody asked is worse than one that refuses: it is
    // indistinguishable from success, which is the shape this package spends most of its risk register on.
    if (sub !== undefined && !KNOWN_SUBCOMMANDS.includes(sub)) {
      ctx.ui.notify(
        `grants: unknown subcommand "${sub}" — did nothing. Known: ${KNOWN_SUBCOMMANDS.join(", ")}. ` +
          `Plain /grants shows this session's status.`,
        "warning",
      );
      return;
    }

    const { valid } = await loadApprovals({ cwd, now: new Date(), snapshotOf });
    const lines = [
      governed ? "grants: ACTIVE" : "grants: inactive (set PI_GRANTS_GRANT to govern this session)",
      `  holding    ${ownGrant.join(", ") || "(nothing)"}${observed ? " (observed)" : " (inherited, not yet observed)"}`,
      // ADR-0031/0032. This screen named the grant, the depth, the ledger, the approvals and the catalog, and
      // never said WHERE children run — so an operator on a machine where herdr hosts their whole workspace
      // could not discover that their children were invisible subprocesses. That gap is what produced
      // ADR-0031, and its probe is only defensible because this line exists. Placed next to `holding` so the
      // two facts about what a spawn will be sit together.
      `  executor   ${executor.disclosure}`,
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
