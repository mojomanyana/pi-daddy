/**
 * Everything this extension says at session start.
 *
 * Lifted out of `extensions/grants.ts` for the reason `grants-command.ts` and `session.ts` were: that file is
 * where every wiring bug in this package has lived, and it had reached **398 of the 400-line ceiling**
 * `test/file-size.test.ts` enforces. ADR-0032 adds a control there, so the file had to be split before it
 * could be added — the alternative was raising the cap, which is how a guard stops guarding. This project
 * split `delegate.ts` at 413 rather than raise it, and that precedent is the whole argument.
 *
 * The seam is the same one twice over: `grants.ts` keeps the HOOKS and the wiring; this module decides what an
 * operator is **told**. Nothing here returns a value or mutates the session, which is what makes it safe to
 * lift — a reporter cannot become a governance path by accident.
 *
 * **Each control keeps its own `try`.** That is R-60's lesson rather than tidiness: one added `await` inside a
 * shared `catch` cancels every control below it with no trace, and that is exactly how an unreadable ledger
 * came to silence the `holding [...]` line too.
 */

import { existsSync } from "node:fs";
import { legacyApprovalsPath, sharedApprovalsPath } from "../src/approval-store.ts";
import { verifyLedger } from "../src/ledger.ts";
import { AGENT_WILDCARD } from "../src/resolve.ts";
import { planWithApprovals } from "./run-delegation.ts";
import type { GrantsSession } from "./session.ts";
import { renderSpawnableSummary, summariseSpawnable } from "./spawn-summary.ts";

/**
 * The slice of pi's context this module needs: a working directory and somewhere to speak.
 *
 * Named explicitly rather than taking `ExtensionContext` whole, for `grants-command.ts`'s reason — what a
 * read-only reporter may see is a decision, and it belongs in a type rather than in whatever happened to be
 * in scope.
 */
export interface SessionReportContext {
  cwd: string;
  ui: { notify(message: string, level: "info" | "warning" | "error"): void };
}

export async function reportSessionStart(session: GrantsSession, ctx: SessionReportContext): Promise<void> {
  // A malformed bound is now loud as well as safe. Silently disabling spawning would be just as
  // confusing as silently disabling the limit was dangerous — the operator set the variable, so
  // they need to know it did not take effect (G7 / A-S4).
  if (session.malformedBounds.length > 0) {
    ctx.ui.notify(
      `grants: ${session.malformedBounds.join(" and ")} could not be read as a non-negative integer — ` +
        `spawning is disabled for this session (failing closed)`,
      "warning",
    );
  }
  // ADR-0014: a pre-0.6 in-workspace approvals file is IGNORED, not migrated — importing it would
  // import exactly the entries whose trustworthiness the move exists to remove. Say so, because an
  // operator whose approvals silently stopped applying deserves to know why.
  // ADR-0020: the pre-0.11 single shared store is ignored, not migrated. Same reasoning shape as the
  // legacy file below — an operator whose approvals silently stopped applying must be told why — but a
  // different reason for not migrating: splitting it by `cwd` would be lossless, and it is still declined
  // because one-shot migration code in the layer with nine defects buys less than one re-approval costs.
  try {
    if (existsSync(sharedApprovalsPath())) {
      ctx.ui.notify(
        `grants: ignoring ${sharedApprovalsPath()} — approvals are now stored one file per governed ` +
          `directory (ADR-0020), because a single shared file could not hold two projects' approvals ` +
          `for a same-named definition. Re-approve when next asked. **Deleting the old file is ` +
          `recommended, not merely safe**: entries written by 0.10.x may contain the task text a model ` +
          `composed at approval time, which this version no longer stores anywhere (ADR-0021).`,
        "warning",
      );
    }
  } catch {
    /* never throw into the agent loop */
  }
  try {
    if (existsSync(legacyApprovalsPath(ctx.cwd))) {
      ctx.ui.notify(
        `grants: ignoring ${legacyApprovalsPath(ctx.cwd)} — approvals now live outside the workspace ` +
          `(it was writable by the very agents it gated). Re-approve when next asked; the old file is ` +
          `safe to delete.`,
        "warning",
      );
    }
  } catch {
    /* never throw into the agent loop */
  }
  // R-47. `gatedBlocked` filters `requested`, and for a definition spawn `requested` is that
  // definition's CEILING — which never contains `agent:<name>`, because the authorisation check
  // (ADR-0017) is a separate, ungated branch. So `PI_GRANTS_GATED=agent:deploy`, written by an operator
  // who read "it attenuates like any other capability" and meant "ask me before deploy runs", produces
  // no dialog and no warning. It DOES bite when a definition passes the id down in its own
  // `allowed-tools`, so the flag half-works — which is worse than not working, and is R-25's shape in
  // the namespace ADR-0017 just promoted out of exactly that state.
  //
  // Warned rather than enforced: making it gate the spawn is a behaviour change and wants a decision.
  // Silence is the part that is indefensible either way.
  // `agent:*` grants no tools, but it authorises every definition in BOTH skill roots — including
  // `~/.pi/agent/skills/`, which other software installs into, so ADR-0017's "an operator-authored
  // file" is not true of everything it covers. Paired with a shell that is every body on disk running
  // with `bash`. `docs/SPEC.md` calls the combination poor and nothing detected it, which is R-47's
  // shape in a control shipped one day later.
  if (session.ownGrant.includes(AGENT_WILDCARD) && session.gated.length === 0 && session.ownGrant.includes("tool:bash")) {
    ctx.ui.notify(
      `grants: PI_GRANTS_GRANT pairs agent:* with tool:bash and gates nothing — every SKILL.md in ` +
        `this project AND in ~/.pi/agent/skills (which other tools install into) may run with a shell. ` +
        `Enumerate the agent: ids you mean, or leave PI_GRANTS_GATED at its default so bash is asked for.`,
      "warning",
    );
  }
  const inertGates = session.gated.filter((c) => c.startsWith("agent:"));
  if (inertGates.length > 0) {
    ctx.ui.notify(
      `grants: ${inertGates.join(", ")} in PI_GRANTS_GATED does NOT gate spawning that definition — ` +
        `the authorisation check for a definition is separate and ungated, so a human is never asked. ` +
        `It applies only where a definition passes the id down in its own allowed-tools. To control ` +
        `which definitions may run, withhold the agent: capability from PI_GRANTS_GRANT instead.`,
      "warning",
    );
  }
  // R-34. `verifyLedger` existed and nothing ran it, so a torn line was detectable and undetected —
  // and a check an operator has to know to run is not a control, it is a feature. Setting
  // `PI_GRANTS_LEDGER` already means "I want an audit trail"; noticing that the trail is damaged is
  // part of keeping one.
  //
  // Corruption only, deliberately. The escalation count is a *query* — `/grants ledger` answers it —
  // and reporting historical attempts unprompted at every start is the fatigue shape R-25 names, which
  // ends with the operator ignoring the line that matters.
  //
  // Awaited rather than fired and forgotten: it is one read, on a path that already awaits two
  // directory scans, and awaiting is what guarantees the warning reaches a live `ctx.ui`.
  //
  // R-60. `verifyLedger` RETHROWS every read error that is not ENOENT — right for `/grants ledger`,
  // where an operator asked a direct question and deserves the failure — and this call is the only one
  // that makes it inside the blanket catch below. So an unreadable ledger threw here and cancelled every
  // remaining control **in silence**: no alarm, and not even the `holding [...]` line that is the one
  // sign governance is on. Confirmed by execution — `PI_GRANTS_LEDGER` naming a directory produced ZERO
  // notifications from a governed session. A trail that cannot be read at all is a worse failure than a
  // torn line, and it was the one case this control said nothing about.
  if (session.ledgerPath) {
    try {
      const report = await verifyLedger(session.ledgerPath);
      if (report.exists && !report.ok) {
        ctx.ui.notify(
          `grants: ledger ${session.ledgerPath} has ${report.corrupt.length} unparseable line(s) — ` +
            `first at line ${report.corrupt[0]?.line}. A torn line is indistinguishable from a spawn that ` +
            `never happened, so this audit trail is incomplete. Run /grants ledger for detail; the file is ` +
            `left alone because a corrupt line is evidence.`,
          "error",
        );
      }
    } catch (error) {
      ctx.ui.notify(
        `grants: ledger ${session.ledgerPath} could not be read ` +
          `(${(error as { code?: string }).code ?? String(error)}) — nothing can be verified about this ` +
          `audit trail, and the first spawn will refuse rather than proceed unrecorded. Check that ` +
          `PI_GRANTS_LEDGER names a writable FILE.`,
        "error",
      );
    }
  }
  // ADR-0031 rests on this line existing: an executor chosen by a probe is only defensible if it is announced.
  //
  // **`mayDelegate`, not `governed`** — and that distinction is a defect caught in review before it shipped.
  // An UNGOVERNED session still registers `delegate` and still spawns (`mayDelegate` is true when
  // `!governed`), so gating this on `governed` would have relocated an ungoverned session's children into
  // herdr panes and said nothing about it. That is precisely the "silently" objection ADR-0031 claims to have
  // discharged, reappearing inside the fix for it — R-28's shape, in the one configuration nobody tests.
  //
  // The guard is not simply dropped because a session that cannot spawn at all has no executor worth naming.
  // **Every `info` line is joined into ONE notify, and that is a fix rather than formatting.**
  //
  // Measured against real pi 0.84.2 in a pty: `notify(…, "info")` maps to `showStatus`, which **replaces the
  // previous status text in place** when the last two transcript children are the pair it created — which is
  // exactly the case for back-to-back notifies. So consecutive `info` calls overwrite each other, and only the
  // last survives. In a governed session with definitions that meant the executor line AND the
  // `holding [...]` line were both gone, leaving only the spawnable summary — and `grants.ts` calls
  // `holding [...]` "the one sign governance is on". **That half is a pre-existing defect**, true since the
  // spawnable summary was added; ADR-0031's disclosure merely became its third victim.
  //
  // Six tests asserted these lines were *composed*. None asserted they were *delivered*: the unit harness
  // pushes to an array and the integration harness runs `--mode rpc`, where each notify is its own JSON line.
  // Both are replace-free, so neither could see this.
  //
  // Warnings and errors are NOT folded in — they go to different components (`showError`), survive on their
  // own, and each says something an operator may need to act on separately.
  const info: string[] = [];

  if (session.mayDelegate && !session.executor.refusal) {
    info.push(`grants: executor — ${session.executor.disclosure}`);
  }
  if (session.mayDelegate && session.executor.refusal) {
    // An error, not an FYI: every delegation in this session will refuse. Emitted separately because `error`
    // routes elsewhere and therefore is not at risk of being overwritten.
    ctx.ui.notify(`grants: executor — ${session.executor.disclosure}`, "error");
  }

  if (session.governed) {
    info.push(
      `grants: depth ${session.depth}/${session.maxDepth}, holding [${session.ownGrant.join(", ") || "nothing"}]`,
    );
    // B1 / P4. The grant alone never named the definitions, never said where they came from, and never
    // said which ones were being WITHHELD — so an operator who had just installed a package of
    // `SKILL.md` files could not tell governance-is-working from did-the-install-fail. Classified by the
    // real planner (see `./spawn-summary.ts`), never by a second reading of the rules.
    //
    // Its own try/catch, and not because `summariseSpawnable` throws today: this is the R-60 shape
    // exactly — one added `await` inside the blanket catch cancelling every control below it in
    // silence.
    try {
      const line = renderSpawnableSummary(
        await summariseSpawnable(
          session.definitions,
          (name) => planWithApprovals(session, { task: "(preview)", agent: name }, {}, null),
          // The session facts that make every per-definition verdict identical. `mayDelegate` in
          // particular: without `tool:delegate` there is no delegate tool at all, and the line used to
          // report definitions as spawnable in the one session where nothing can ever be spawned.
          { mayDelegate: session.mayDelegate, depth: session.depth, maxDepth: session.maxDepth },
        ),
        session.definitions.size,
      );
      if (line) info.push(line);
    } catch (error) {
      ctx.ui.notify(
        `grants: could not work out which definitions are spawnable ` +
          `(${error instanceof Error ? error.message : String(error)}) — run /grants for the per-definition ` +
          `verdict. Nothing about the grant or its enforcement depends on this line.`,
        "warning",
      );
    }
  }

  // One call, so nothing can overwrite anything else. `/grants` already worked this way, which is why its
  // multi-line status screen has always survived while these separate lines did not.
  if (info.length > 0) ctx.ui.notify(info.join("\n"), "info");
}
