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

import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WILDCARD } from "../src/pi-tools.ts";
import { buildCatalog } from "../src/catalog.ts";
import { appendRecord, buildRecord } from "../src/ledger.ts";
import {
  ENV_GRANT, deriveOwnGrant, observeToolNames } from "../src/propagation.ts";
import { snapshotOf } from "./approvals.ts";
import { registerDelegationTools } from "./delegation.ts";
import { grantsCommand } from "./grants-command.ts";
import { runInit } from "./init-command.ts";
import { planWithApprovals } from "./run-delegation.ts";
import { createGrantsSession, loadProjectDefinitions, resolveExecutor, type GrantsSession } from "./session.ts";
import { reportSessionStart } from "./session-report.ts";

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
    // The one case the stored-grant lookup can get wrong (ADR-0030). The factory reads the store keyed by
    // `process.cwd()` because it runs before any hook and therefore before `ctx` exists — and S-5 forces
    // that ordering, since whether `delegate` is registered is decided there. Almost always the two agree.
    // When they do not, the session is governed by a different directory's decision than the one it is
    // working in, which is exactly the confusion a grant must never cause, so it is said out loud rather
    // than left to be inferred from a surprising refusal. Sync, so it is not the R-60 shape.
    if (session.storeCwd !== ctx.cwd && process.env[ENV_GRANT] === undefined) {
      ctx.ui.notify(
        `grants: this session's stored grant was read for ${session.storeCwd}, but pi is working in ` +
          `${ctx.cwd}. A grant belongs to a directory, so run /grants init here, or set PI_GRANTS_GRANT ` +
          `explicitly — the environment always wins.`,
        "warning",
      );
    }
    try {
      // Guarded together, and guarded at all because of R-60 rather than because either one throws today:
      // both loaders swallow their own filesystem errors, so this catch is currently unreachable. The point
      // is that "currently" is not a property anyone can rely on — `verifyLedger` was also harmless until
      // the day it was not, and the cost of finding out is every control below this line, silently.
      // Discovery failing is worth its own sentence anyway: a session with no definitions can still
      // delegate by `tools:`, and an operator whose `agent:` spawns have all started failing deserves to
      // know it was the *scan* that broke rather than the grant.
      try {
        await loadProjectDefinitions(session, ctx.cwd);
      } catch (error) {
        ctx.ui.notify(
          `grants: could not read this project's definitions or capability catalog ` +
            `(${error instanceof Error ? error.message : String(error)}) — no SKILL.md definition can be ` +
            `spawned this session, and delegation by tools: is unaffected. Governance itself is unaffected: ` +
            `it is enforced by --tools when a child is spawned.`,
          "error",
        );
      }
      // ADR-0031: probe once, HERE, before anything reports — so the disclosure line can name the executor,
      // and so a demanded-but-unreachable herdr is reported before the operator's first prompt rather than at
      // their first delegation. Its own try, because a failure here must not cancel the controls after it
      // (R-60), and `probeHerdr` is documented as never throwing precisely so this is belt-and-braces.
      try {
        await resolveExecutor(session);
      } catch (error) {
        ctx.ui.notify(
          `grants: could not settle which executor to use ` +
            `(${error instanceof Error ? error.message : String(error)}) — using the captured subprocess, ` +
            `which needs nothing installed. Set PI_GRANTS_HERDR=0 to make that explicit, or 1 to demand ` +
            `herdr panes.`,
          "warning",
        );
      }
      session.publishChildEnv();
      // The definitions now exist, so the `delegate` schema can finally name them (R-39). pi serialises a
      // tool's schema at REQUEST time, not at registration — measured — which is what makes this reach the
      // model at all.
      delegation.refreshSpawnable();
      // Everything an operator is TOLD at session start now lives in `./session-report.ts`. Lifted because
      // this file had reached 398 of the 400-line ceiling and ADR-0032 adds a control to it; the split is the
      // same move `session.ts` and `grants-command.ts` were extracted under, and the guard is obeyed rather
      // than raised.
      //
      // Its own try/catch, required by `test/session-start-guard.test.ts` and right on the merits: every
      // control inside `reportSessionStart` already has one, but a throw from the reporter ITSELF would
      // otherwise reach the blanket catch below and be reported as "session start did not complete" — which
      // would be true and useless, because nothing about the grant or its enforcement depends on any of it.
      // Naming that distinction is the difference between an operator checking their configuration and an
      // operator distrusting their governance.
      try {
        await reportSessionStart(session, ctx);
      } catch (error) {
        ctx.ui.notify(
          `grants: the session-start report could not be produced ` +
            `(${error instanceof Error ? error.message : String(error)}) — so the grant, the executor and the ` +
            `spawnable definitions were not printed. Run /grants for all three. Governance itself is ` +
            `unaffected: it is enforced by --tools when a child is spawned.`,
          "warning",
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
          executor: session.executor,
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
          runInit: () =>
            runInit(session, ctx, async () => {
              await loadProjectDefinitions(session, ctx.cwd);
              delegation.refreshSpawnable();
            }),
          previewDelegation: (name: string) =>
            planWithApprovals(session, { task: "(preview)", agent: name }, {}, null),
        },
      }),
  });
}

