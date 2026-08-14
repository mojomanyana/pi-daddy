/**
 * pi-daddy — the extension entry point pi loads.
 *
 * Wiring only; every decision lives in `../src/` as a pure function so it can be tested without pi. What
 * remains in *this* file is the part that is genuinely about pi: the hooks, the tripwire, and the four
 * registrations. The session state moved to `./session.ts`, the approval flow to `./approvals.ts`, the two
 * delegation tools to `./delegation.ts` and the `/grants` command to `./grants-command.ts`.
 *
 * That split is not cosmetic. Every wiring bug this package has had lived here — the G7 `NaN` bound, the
 * discarded `isError`, the unconditionally-registered `delegate` (S-5), R-28's omitted argument — and all
 * four were defects of *scope*: a value that was whatever happened to be in the closure at one call site.
 * Each module now takes the session as an argument, so what it can see is written down.
 *
 * Propagation is race-free by construction — see `../src/propagation.ts`. Nothing per-child is pushed:
 * the environment carries only parent-level facts (identical for every sibling), never a value computed
 * for one specific spawn. It is published at session start, and republished whenever this session's own
 * approvals change (a human approves something new for the session) — never per spawn, never keyed to a
 * particular child. Each republish stays safe because the value is still `ownGrant`-shaped: this
 * session's own approvals intersected with its own grant, identical for every sibling regardless of which
 * spawn triggered the human prompt, and `childEnv` clamps it to the grant again on the way out. Each
 * child derives its own grant from the tool array of its first provider request.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WILDCARD } from "../src/pi-tools.ts";
import { AGENT_WILDCARD } from "../src/resolve.ts";
import { legacyApprovalsPath, sharedApprovalsPath } from "../src/approval-store.ts";
import { buildCatalog } from "../src/catalog.ts";
import { loadDefinitions } from "../src/definitions.ts";
import { appendRecord, buildRecord, verifyLedger } from "../src/ledger.ts";
import { deriveOwnGrant, observeToolNames } from "../src/propagation.ts";
import { snapshotOf } from "./approvals.ts";
import { registerDelegationTools } from "./delegation.ts";
import { grantsCommand } from "./grants-command.ts";
import { planWithApprovals } from "./run-delegation.ts";
import { createGrantsSession } from "./session.ts";

const SPAWN_TOOLS = new Set(["Agent", "subagent", "spawn_agent"]);

export default function (pi: ExtensionAPI) {
  // The path pi loads as the extension, so a child granted `tool:delegate` can be started with `-e <this>`.
  // Only this file can say so about itself, which is why the session takes it rather than deriving it.
  const extensionPath = (() => {
    try {
      return fileURLToPath(import.meta.url);
    } catch {
      return undefined;
    }
  })();

  const session = createGrantsSession(extensionPath);

  // Filled in by `registerDelegationTools` at the bottom of this function. A holder rather than a reordering,
  // because the hooks below have to be registered before the tools and both need to call it — the tool
  // schemas describe which definitions are spawnable, and nothing knows that until a hook has run (R-39).
  const delegation = { refreshSpawnable: () => {} };

  pi.on("session_start", async (_event, ctx) => {
    session.cwd = ctx.cwd;
    try {
      // Guarded together, and guarded at all because of R-60 rather than because either one throws today:
      // both loaders swallow their own filesystem errors, so this catch is currently unreachable. The point
      // is that "currently" is not a property anyone can rely on — `verifyLedger` was also harmless until
      // the day it was not, and the cost of finding out is every control below this line, silently.
      // Discovery failing is worth its own sentence anyway: a session with no definitions can still
      // delegate by `tools:`, and an operator whose `agent:` spawns have all started failing deserves to
      // know it was the *scan* that broke rather than the grant.
      try {
        session.definitions = await loadDefinitions(ctx.cwd);
        session.catalogReady = buildCatalog({ cwd: ctx.cwd, observedTools: session.observedTools });
        session.catalog = await session.catalogReady;
      } catch (error) {
        ctx.ui.notify(
          `grants: could not read this project's definitions or capability catalog ` +
            `(${error instanceof Error ? error.message : String(error)}) — no SKILL.md definition can be ` +
            `spawned this session, and delegation by tools: is unaffected. Governance itself is unaffected: ` +
            `it is enforced by --tools when a child is spawned.`,
          "error",
        );
      }
      session.publishChildEnv();
      // The definitions now exist, so the `delegate` schema can finally name them (R-39). pi serialises a
      // tool's schema at REQUEST time, not at registration — measured — which is what makes this reach the
      // model at all.
      delegation.refreshSpawnable();
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
      if (session.governed) {
        ctx.ui.notify(
          `grants: depth ${session.depth}/${session.maxDepth}, holding [${session.ownGrant.join(", ") || "nothing"}]`,
          "info",
        );
      }
    } catch (error) {
      // Rule 8 — fail closed, and be LOUD about it. Swallowing is still right: a startup fault must not
      // reach the agent loop. Swallowing SILENTLY is what let R-60 exist, and would let the next one exist
      // too, because every control added above this line is cancelled by any throw before it with no trace.
      // Deliberately says which checks are affected rather than claiming they passed.
      try {
        ctx.ui.notify(
          `grants: session start did not complete — ${error instanceof Error ? error.message : String(error)}. ` +
            `Checks and setup after the failure did not run, so definitions may be missing and a delegation ` +
            `may refuse. The grant itself is unaffected: it is enforced by --tools when a child is spawned.`,
          "error",
        );
      } catch {
        /* a UI that cannot be notified is the one failure there is nowhere to report */
      }
    }
    return undefined;
  });

  // Observe this session's real tool surface once, and tighten the grant to it. Authoritative because
  // it is exactly what pi sent the model.
  pi.on("before_provider_request", (event) => {
    try {
      if (session.observed) return undefined;
      const names = observeToolNames(event.payload);
      if (names === null) return undefined;
      session.observed = true;
      session.observedTools = names;
      session.ownGrant = deriveOwnGrant(session.inherited, names);
      session.publishChildEnv();
      // The grant can only have narrowed, so what is spawnable can only have shrunk. Refreshed for the NEXT
      // request: this hook runs after the current payload's tools were already serialised.
      delegation.refreshSpawnable();
      // Refresh the catalog now that the real tool surface is known — this is the only moment extension
      // tools become visible, so it is the only moment `ext:`/`tool:` grants can be validated.
      // Keep the handle: a concurrent `delegate` awaits this rather than reading a half-built catalog.
      // The `catch` resolves to the CURRENT catalog rather than rejecting, so a failed refresh degrades
      // to the previous view instead of failing every delegation in the session.
      session.catalogReady = buildCatalog({ cwd: session.cwd, observedTools: names })
        .then((c) => (session.catalog = c))
        .catch(() => session.catalog);
    } catch {
      /* never throw into the agent loop */
    }
    return undefined; // inspect only — never replace the payload
  });

  /**
   * Tripwire, not a fence — ADR-0016 point 5.
   *
   * This hook used to compute what `@tintinweb/pi-subagents` would grant a child, by re-implementing
   * that package's tool-resolution rules (ADR-0013). That port is gone with this change, and so is
   * R-31: there is no longer another project's private function to keep in step, and no permissive
   * drift when it moves.
   *
   * What remains is the reason not to simply delete the hook. This package is now the spawner, so a
   * third-party spawn tool appearing in a governed session means something can create a descendant that
   * this package does not provision, does not bound by depth, and does not record. Installing one is a
   * single command. **Refusing is cheap and silence is not**, so the tripwire refuses and names itself.
   *
   * It cannot be complete, and says so rather than implying otherwise: `subagents:rpc:spawn` reaches
   * `manager.spawn()` over the event bus and never produces a `tool_call` at all (ADR-0013 Finding 6),
   * so a tool-name check cannot see it. This catches the ordinary case loudly; it is not a boundary.
   */
  pi.on("tool_call", async (event) => {
    if (!session.governed || !SPAWN_TOOLS.has(event.toolName)) return undefined;

    const reason =
      `grants: "${event.toolName}" spawns sub-agents outside this session's governance — refused. ` +
      `This session grants capabilities by spawning them itself (\`delegate\`), so a child created by ` +
      `another extension would hold whatever that extension decided, with no grant, no depth bound and ` +
      `no ledger entry. Use \`delegate\` instead. If you meant to run ungoverned, unset PI_GRANTS_GRANT.`;

    if (session.ledgerPath) {
      // Recorded like any other refusal: an audit that omits the spawns we turned away cannot answer
      // "did anything try to get around this?", which is the one question a tripwire exists to answer.
      await appendRecord(
        { path: session.ledgerPath, strict: true },
        buildRecord({
          parentId: `d${session.depth}`,
          childId: `${event.toolName}@d${session.depth + 1}`,
          depth: session.depth + 1,
          agentType: event.toolName,
          // The wildcard is the honest record: an unknown spawner was going to hand this child whatever
          // IT decided, and we have no way to know what that would have been.
          requested: [WILDCARD],
          parentGrant: session.ownGrant,
          result: { effective: [], denied: [WILDCARD], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
          blocked: true,
          reason,
          now: new Date(),
        }),
      );
    }
    return { block: true, reason };
  });

  // Governed delegation. Unlike the tripwire above this PROVISIONS: the grant is an argument, so the
  // orchestrator hands each child exactly the capabilities it should have. Registered only when this
  // session may delegate, so withholding `tool:delegate` genuinely makes a session a leaf.
  //
  // Registration necessarily happens HERE, before any hook has run, so the tools cannot yet know which
  // definitions exist — hence `refreshSpawnable`, called from both hooks above once they do. R-39 is what
  // happens without it: every model in every governed session is told `Available: none`.
  delegation.refreshSpawnable = registerDelegationTools(pi, session).refreshSpawnable;

  pi.registerCommand("grants", {
    ...grantsCommand,
    // Built per invocation and spelled out field by field, rather than passing the session whole: what a
    // read-only diagnostic may see is a decision, and `GrantsCommandContext` is where it is recorded.
    handler: (args, ctx) =>
      grantsCommand.handler(args, {
        ...ctx,
        grants: {
          cwd: session.cwd,
          governed: session.governed,
          ownGrant: session.ownGrant,
          observed: session.observed,
          depth: session.depth,
          maxDepth: session.maxDepth,
          ledgerPath: session.ledgerPath,
          catalog: session.catalog,
          definitions: session.definitions,
          sessionApprovals: session.sessionApprovals,
          inheritedApprovals: session.inheritedApprovals,
          snapshotOf: (subject: string) => snapshotOf(session, subject),
          // The REAL delegation path, minus the one thing a diagnostic must never do. `ctx: null` is what
          // says so: stored approvals count exactly as they would for a spawn, and no human is asked
          // (R-38). Passing `ctx` here would let `/grants` raise a dialog, and passing `hasUI: false` would
          // make every gated definition report "no interactive user" instead of what actually blocks it.
          previewDelegation: (name: string) =>
            planWithApprovals(session, { task: "(preview)", agent: name }, {}, null),
        },
      }),
  });
}
