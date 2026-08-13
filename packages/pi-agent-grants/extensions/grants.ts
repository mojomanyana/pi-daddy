/**
 * pi-agent-grants — the extension entry point pi loads.
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
import { legacyApprovalsPath } from "../src/approval-store.ts";
import { buildCatalog } from "../src/catalog.ts";
import { loadDefinitions } from "../src/definitions.ts";
import { appendRecord, buildRecord } from "../src/ledger.ts";
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
      session.definitions = await loadDefinitions(ctx.cwd);
      session.catalogReady = buildCatalog({ cwd: ctx.cwd, observedTools: session.observedTools });
      session.catalog = await session.catalogReady;
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
      if (session.governed) {
        ctx.ui.notify(
          `grants: depth ${session.depth}/${session.maxDepth}, holding [${session.ownGrant.join(", ") || "nothing"}]`,
          "info",
        );
      }
    } catch {
      /* never throw into the agent loop */
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
