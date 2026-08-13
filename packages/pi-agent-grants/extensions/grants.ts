/**
 * pi-agent-grants — intercepts sub-agent spawns and blocks capability escalation.
 *
 * Wiring only; every decision lives in `../src/` as a pure function so it can be tested without pi.
 *
 * Mechanism: pi lets an extension inspect a `tool_call` and return `{ block: true, reason }`. We hook
 * the spawn tools of `@tintinweb/pi-subagents` (`Agent`) and refuse any spawn whose agent type would
 * hold more than this session holds, or that exceeds the depth bound.
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
import { Type } from "typebox";
import { PI_BUILTIN_TOOLS, WILDCARD } from "../src/pi-tools.ts";
import {
  DELEGATE_SUBJECT,
  approvalKey,
  expiryFor,
  parseInherited,
  type InheritableApproval,
  resolveApprovals,
  shouldSeekApproval,
  type ApprovalPath,
  type ApprovalScope,
  type ApprovalSource,
} from "../src/approval.ts";
import { legacyApprovalsPath, loadApprovals, saveApproval } from "../src/approval-store.ts";
import { createApprovalGate, createApprovalGateProvider, timeoutMsFromEnv } from "../src/approval-prompt.ts";
import { buildCatalog, makeCatalog, skillPathsFromCatalog, type Catalog } from "../src/catalog.ts";
import { ceilingForDefinition, loadDefinitions, type SkillDefinition } from "../src/definitions.ts";
import { DELEGATE_CAPABILITY, planDelegation } from "../src/delegate.ts";
import { ENV_CHILD_TIMEOUT, runChild, timeoutFromEnv } from "../src/run-child.ts";
import { runHerdrPane } from "../src/run-herdr.ts";
import { grantsCommand } from "./grants-command.ts";
import { MAX_CHILDREN_PER_CALL, budgetFromEnv, childSpawnId, splitBudget } from "../src/fanout.ts";
import { appendRecord, buildRecord } from "../src/ledger.ts";
import {
  childEnv,
  depthConfig,
  deriveOwnGrant,
  gatedFromEnv,
  mergeChildEnv,
  ENV_APPROVED,
  ENV_DEPTH,
  ENV_GATED,
  ENV_GRANT,
  ENV_FANOUT,
  ENV_LEDGER,
  ENV_MAX_DEPTH,
  ENV_PARENT_ID,
  observeToolNames,
  parseList,
} from "../src/propagation.ts";
import { type Capability } from "../src/resolve.ts";

const SPAWN_TOOLS = new Set(["Agent", "subagent", "spawn_agent"]);

/**
 * Run governed children in herdr panes instead of captured child processes (ADR-0016 point 6).
 *
 * Opt-in, and deliberately not auto-detected from `herdr` being on PATH: where a governed child executes
 * is an operator decision, and a run that silently relocates because a binary appeared is exactly the kind
 * of invisible change this package exists to prevent. Both executors enforce the identical grant — the
 * plan is the same, only the place it runs differs.
 */
const ENV_HERDR = "PI_GRANTS_HERDR";
/** herdr workspace for spawned panes. Omitted lets herdr choose. */
const ENV_HERDR_WORKSPACE = "PI_GRANTS_HERDR_WORKSPACE";
/** Keep each child's pane after it finishes, for inspection. Off by default: fan-out would flood it. */
const ENV_HERDR_KEEP_PANE = "PI_GRANTS_HERDR_KEEP_PANE";

export default function (pi: ExtensionAPI) {
  // Governance is opt-in: with PI_GRANTS_GRANT unset the session holds the wildcard and nothing is
  // blocked. This extension must never silently tighten a normal workflow.
  const grantRaw = process.env[ENV_GRANT];
  const governed = grantRaw !== undefined;
  const inherited: Capability[] = governed ? parseList(grantRaw) : [WILDCARD];
  // G7 / A-S4 + B-I4: strict, three-way parsing that fails CLOSED. A malformed bound used to yield
  // `NaN`, and every comparison against `NaN` is false, so depth limiting switched itself off.
  const bounds = depthConfig(process.env[ENV_DEPTH], process.env[ENV_MAX_DEPTH]);
  const { depth, maxDepth } = bounds;
  // ADR-0012: `bash` is gated by DEFAULT — but only in a governed session. An ungoverned one
  // (no PI_GRANTS_GRANT) still blocks nothing, so "governance is opt-in" holds exactly where it always
  // did. Inside a session the operator already chose to govern, handing a child `bash` hands it an
  // ungoverned-descendant escape hatch, and doing that silently is what changes here.
  // `PI_GRANTS_GATED=""` turns the default off; absent and empty are deliberately distinguishable.
  const gated = governed ? gatedFromEnv(process.env[ENV_GATED]) : parseList(process.env[ENV_GATED]);
  const ledgerPath = process.env[ENV_LEDGER];
  const useHerdr = process.env[ENV_HERDR] === "1";
  /**
   * This session's ledger identity, and the descendants it may still create.
   *
   * `ownSpawnId` comes from the parent (F8), so ids form one tree across process boundaries instead of
   * every level restarting at `d0` and the ledger becoming unjoinable. `fanoutBudget` is the cardinality
   * bound ADR-0008 never had: it attenuates downward like depth, so a subtree can never create more
   * descendants than its root was given — with no shared state, no lock and no counter file.
   */
  const ownSpawnId = process.env[ENV_PARENT_ID]?.trim() || `d${depth}`;
  const fanoutBudget = budgetFromEnv(process.env[ENV_FANOUT]);

  /** This session's own grant. Starts as the inherited upper bound, tightened once tools are observed. */
  let ownGrant: Capability[] = deriveOwnGrant(inherited, null);
  let observed = false;
  let observedTools: string[] | null = null;
  /** ADR-0016: `SKILL.md` definitions, keyed by name. The format this package spawns from now. */
  let definitions = new Map<string, SkillDefinition>();
  let catalog: Catalog = makeCatalog([]);
  /**
   * The in-flight catalog build, so `delegate` can wait for it instead of racing it.
   *
   * G7 / A-R5. The refresh in `before_provider_request` was fire-and-forget, so a `delegate` call
   * early in a session could read a catalog that was still empty and refuse a perfectly valid grant
   * as an "unknown capability". It failed closed, which is why it was Important rather than Critical,
   * but non-deterministically: the same delegation succeeded or failed on timing alone.
   */
  let catalogReady: Promise<Catalog> = Promise.resolve(catalog);

  /** Approval keys approved for this session. In memory only — this dies with the process. */
  const sessionApprovals = new Set<string>();
  /** Approvals inherited from the delegator, already clamped to this session's grant upstream. */
  const inheritedApprovals = parseInherited(process.env[ENV_APPROVED]);

  /**
   * Current ceiling for a definition, for the confused-deputy check in the approval store.
   *
   * ADR-0010's property is unchanged: an `always` approval is void once the thing it was granted for
   * has changed. Only the source moved — a `SKILL.md`'s `allowed-tools` rather than an agent type's
   * frontmatter. An undeclared definition yields an EMPTY ceiling, not a wildcard, so a stored approval
   * for it can never be revalidated by accident.
   */
  const ceilingOf = (subject: string) => {
    const definition = definitions.get(subject);
    return definition ? ceilingForDefinition(definition).capabilities : null;
  };

  /**
   * The one place a delegation context is built — and therefore the one place each field is spelled.
   *
   * R-28 is why this is a builder rather than an object literal at each call site. On the path this
   * replaced, three call sites passed `extensionTools` and the one that ENFORCED did not, so every
   * ordinary narrow definition was refused with a reason that misstated the file, while `/grants`
   * cheerfully reported the opposite. The defect was in an argument list, and nothing tested argument
   * lists. A builder makes the omission unspellable instead of merely corrected.
   *
   * `/grants` uses it too, deliberately: the listing runs the REAL planner over the REAL context, so a
   * diagnostic that disagrees with enforcement is not expressible.
   */
  const delegationContext = async (approved?: InheritableApproval[]) => ({
    ownGrant,
    depth,
    maxDepth,
    gated,
    ledgerPath,
    extensionPath,
    catalog: await catalogReady,
    // R-32: where each granted skill lives, so `planSpawn` can pass `--skill` for those and only those.
    // Derived from the catalog's own `source`, so it cannot drift from what was discovered.
    skillPaths: skillPathsFromCatalog(await catalogReady),
    // ADR-0016: operator-authored SKILL.md definitions, so `delegate({agent})` can name one.
    definitions,
    // The herdr executor drives the child after starting it, so its plan must NOT carry `--print`.
    // Threaded through the plan rather than patched afterwards: the argv is what the ledger records, and
    // an executor quietly rewriting it would make the record describe a spawn that did not happen.
    interactive: useHerdr,
    ...(approved ? { approved } : {}),
  });


  /**
   * The extension tools this session actually has, as capabilities (ADR-0013).
   *
   * Derived from the observed tool array minus pi's built-ins: an agent type that inherits extensions
   * receives exactly these, so they belong in its ceiling. `null` until the first provider request,
   * which `ceilingFor` reads as "unknown" and fails closed on.
   */
  const extensionCapabilities = (): Capability[] | undefined => {
    // `pi.getAllTools()` is authoritative and available immediately — unlike `observedTools`, which only
    // exists after the first provider request. That distinction is not academic: `/grants` runs before any
    // provider call, so deriving this from observation alone made every inheriting type resolve to the
    // wildcard and the command reported BLOCK for everything at session start.
    try {
      const all = pi.getAllTools?.();
      if (all) {
        return all
          .map((t) => String(t.name))
          .filter((n) => !PI_BUILTIN_TOOLS.includes(n as never))
          .map((n) => `tool:${n}`)
          .sort();
      }
    } catch {
      /* fall through to the observed surface */
    }
    return observedTools === null
      ? undefined
      : observedTools.filter((t) => !PI_BUILTIN_TOOLS.includes(t as never)).map((t) => `tool:${t}`);
  };

  /**
   * What this session may republish to children (ADR-0014).
   *
   * Two changes from the version that published bare capability names. Each entry keeps its **subject**,
   * so an approval given for one agent type cannot satisfy another; and each keeps its **scope**, so
   * `inheritApprovals` can drop `once` rather than handing a whole subtree an approval a human gave for
   * a single spawn.
   *
   * `once` never enters `sessionApprovals` in the first place, so everything here is `session` or
   * `always` — but the scope is carried rather than assumed, because assuming it is what went wrong.
   */
  const republishable = (): InheritableApproval[] => [
    // Inherited keys arrive already clamped and already `once`-free from the level above.
    ...[...inheritedApprovals].map((key) => ({
      capability: key.slice(0, key.indexOf("@")),
      subject: key.slice(key.indexOf("@") + 1),
      scope: "session" as const,
    })),
    ...[...sessionApprovals].map((key) => ({
      capability: key.slice(0, key.indexOf("@")),
      subject: key.slice(key.indexOf("@") + 1),
      scope: "session" as const,
    })),
  ];

  /**
   * Publish what children inherit. Written once at session start, and republished whenever this
   * session's own approvals change (see `obtainApprovals`) — never once per spawn. That distinction is
   * what keeps this race-free: every value ever written here is a PARENT-level fact (this session's own
   * grant, intersected with its own approvals), identical for every sibling no matter which spawn
   * prompted the human. A value scoped to one specific child is never written to this global channel.
   */
  const publishChildEnv = () => {
    const env = childEnv({
      ownGrant,
      depth,
      maxDepth,
      gated,
      ledgerPath,
      approved: republishable(),
      // G7 / B-I8: an ungoverned session publishes nothing, so "governance is opt-in" holds for
      // descendants too. Previously it exported its own observed tool surface as their grant.
      governed,
    });
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
  };

  let cwd = process.cwd();

  /**
   * ONE single-flight queue for the whole session.
   *
   * `obtainApprovals` runs once per `tool_call` and once per `delegate.execute`, and the gate's options
   * come from that call's `ExtensionContext` — so a gate built inside `obtainApprovals` that owned its own
   * queue would start empty every time and de-duplicate nothing. Two concurrent delegations would stack two
   * dialogs asking the identical question, which is precisely what spec §6.1 exists to prevent. The
   * provider keeps the options per-call and the queue session-long.
   */
  const approvalGateFor = createApprovalGateProvider();

  /**
   * Satisfy as many gated capabilities as possible, asking a human only for what is left.
   *
   * Returns what was approved and how, so the caller can re-resolve with the same pure `resolve()` and
   * the ledger can record which of the three flavours of "no" applies (see `ledger.ts`'s `GrantRecord`).
   */
  const obtainApprovals = async (
    gatedBlocked: Capability[],
    subject: string,
    path: ApprovalPath,
    ctx: { ui: Parameters<typeof createApprovalGate>[0]["ui"]; hasUI: boolean; mode: string },
    task?: string,
    signal?: AbortSignal,
  ): Promise<{
    approved: Capability[];
    source?: ApprovalSource;
    scope?: ApprovalScope;
    humanDenied: boolean;
    reason?: string;
  }> => {
    const { valid } = await loadApprovals({ cwd, now: new Date(), ceilingOf });
    const pre = resolveApprovals({
      gated: gatedBlocked,
      subject,
      sessionApprovals,
      persisted: valid,
      inherited: inheritedApprovals,
    });
    if (pre.needsPrompt.length === 0) {
      return {
        approved: pre.approved,
        source: pre.approved.length > 0 ? pre.sources[pre.approved[0]] : undefined,
        humanDenied: false,
      };
    }

    const gate = approvalGateFor({
      ui: ctx.ui,
      hasUI: ctx.hasUI,
      mode: ctx.mode,
      timeoutMs: timeoutMsFromEnv(process.env.PI_GRANTS_APPROVAL_TIMEOUT),
    });

    const approved = [...pre.approved];
    let scope: ApprovalScope | undefined;
    let humanDenied = false;
    let reason: string | undefined;

    for (const capability of pre.needsPrompt) {
      const outcome = await gate.request({ capability, subject, path, task, signal });
      if (outcome.scope === null) {
        // Forward the gate's own discriminant rather than re-deriving it from `hasUI`: `hasUI` is true in
        // RPC mode too, so an automated client's timeout or dismissal there would misreport as "a human
        // declined" if we asked `ctx.hasUI` instead. Only `kind === "declined"` means a person said no.
        humanDenied = outcome.kind === "declined";
        reason = outcome.reason;
        break;
      }
      approved.push(capability);
      scope = outcome.scope;

      if (outcome.scope === "session" || outcome.scope === "always") {
        sessionApprovals.add(approvalKey(capability, subject));
      }
      if (outcome.scope === "always") {
        const now = new Date();
        const currentCeiling = ceilingOf(subject);
        // No readable ceiling means the entry would carry `grantAtApproval: []`, which `entryVerdict`
        // compares against the type's ceiling on every load — so it could only ever come back
        // "type-missing" or "type-changed". Writing it is not unsafe (it fails closed), it is simply a
        // dead entry that silently accumulates in the file. Skip it and say so, taking the same
        // downgrade-to-session path as a failed write below: the human's yes still stands.
        const written =
          currentCeiling === null
            ? false
            : await saveApproval(
                cwd,
                approvalKey(capability, subject),
                {
                  approvedAt: now.toISOString(),
                  expiresAt: expiryFor(now),
                  cwd,
                  grantAtApproval: currentCeiling,
                  taskAtApproval: task,
                },
                ceilingOf,
                now,
              );
        if (!written) {
          // The human already said yes; the security decision stands. Only the convenience cache
          // failed, so this downgrades scope rather than refusing the delegation (see approval-store.ts).
          ctx.ui.notify(
            currentCeiling === null
              ? `grants: cannot persist the approval for ${capability} — no agent type named ${subject} is ` +
                  `readable here, so a stored entry could never be valid; it applies for this session only`
              : `grants: could not persist the approval for ${capability} — it applies for this session only`,
            "warning",
          );
          scope = "session";
        }
      }
      publishChildEnv(); // a new session approval widens what children may inherit — republish now
    }

    return {
      approved,
      source: approved.length > 0 ? (scope ? "prompt" : pre.sources[approved[0]]) : undefined,
      scope,
      humanDenied,
      reason,
    };
  };

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    try {
      definitions = await loadDefinitions(ctx.cwd);
      catalogReady = buildCatalog({ cwd: ctx.cwd, observedTools });
      catalog = await catalogReady;
      publishChildEnv();
      // A malformed bound is now loud as well as safe. Silently disabling spawning would be just as
      // confusing as silently disabling the limit was dangerous — the operator set the variable, so
      // they need to know it did not take effect (G7 / A-S4).
      if (bounds.malformed.length > 0) {
        ctx.ui.notify(
          `grants: ${bounds.malformed.join(" and ")} could not be read as a non-negative integer — ` +
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
      if (governed) {
        ctx.ui.notify(
          `grants: depth ${depth}/${maxDepth}, holding [${ownGrant.join(", ") || "nothing"}]`,
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
      if (observed) return undefined;
      const names = observeToolNames(event.payload);
      if (names === null) return undefined;
      observed = true;
      observedTools = names;
      ownGrant = deriveOwnGrant(inherited, names);
      publishChildEnv();
      // Refresh the catalog now that the real tool surface is known — this is the only moment extension
      // tools become visible, so it is the only moment `ext:`/`tool:` grants can be validated.
      // Keep the handle: a concurrent `delegate` awaits this rather than reading a half-built catalog.
      // The `catch` resolves to the CURRENT catalog rather than rejecting, so a failed refresh degrades
      // to the previous view instead of failing every delegation in the session.
      catalogReady = buildCatalog({ cwd, observedTools: names })
        .then((c) => (catalog = c))
        .catch(() => catalog);
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
    if (!governed || !SPAWN_TOOLS.has(event.toolName)) return undefined;

    const reason =
      `grants: "${event.toolName}" spawns sub-agents outside this session's governance — refused. ` +
      `This session grants capabilities by spawning them itself (\`delegate\`), so a child created by ` +
      `another extension would hold whatever that extension decided, with no grant, no depth bound and ` +
      `no ledger entry. Use \`delegate\` instead. If you meant to run ungoverned, unset PI_GRANTS_GRANT.`;

    if (ledgerPath) {
      // Recorded like any other refusal: an audit that omits the spawns we turned away cannot answer
      // "did anything try to get around this?", which is the one question a tripwire exists to answer.
      await appendRecord(
        { path: ledgerPath, strict: true },
        buildRecord({
          parentId: `d${depth}`,
          childId: `${event.toolName}@d${depth + 1}`,
          depth: depth + 1,
          agentType: event.toolName,
          // The wildcard is the honest record: an unknown spawner was going to hand this child whatever
          // IT decided, and we have no way to know what that would have been.
          requested: [WILDCARD],
          parentGrant: ownGrant,
          result: { effective: [], denied: [WILDCARD], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
          blocked: true,
          reason,
          now: new Date(),
        }),
      );
    }
    return { block: true, reason };
  });

  // Governed delegation. Unlike the interceptor above this PROVISIONS: the grant is an argument, so the
  // orchestrator hands each child exactly the capabilities it should have. Registered only when this
  // session may delegate, so withholding `tool:delegate` genuinely makes a session a leaf.
  const extensionPath = (() => {
    try {
      return fileURLToPath(import.meta.url);
    } catch {
      return undefined;
    }
  })();

  /**
   * Review finding S-5, fixed. The comment above has always claimed conditional registration; the call
   * was unconditional, `DELEGATE_CAPABILITY` was imported and never used, and "withhold it and the child
   * is a leaf" was simply untrue on this path.
   *
   * ADR-0013's faithful ceiling is what forced it. Once a type's ceiling honestly includes the extension
   * tools it inherits, an unconditionally-registered `delegate` appears in EVERY child's ceiling — so a
   * delegator without it was told every single agent type "requires tool:delegate". That was a correct
   * reading of an incorrect situation: in-process children really do inherit our tool registry.
   *
   * Decided on the INHERITED grant rather than `ownGrant`, because registration happens at load time,
   * before any tools are observed. An ungoverned session registers it as before.
   */
  const mayDelegate =
    !governed || inherited.includes(DELEGATE_CAPABILITY) || inherited.includes(WILDCARD);

  /**
   * Plan, gate, audit and run ONE governed child. Shared by `delegate` and `delegate_all`.
   *
   * Extracted rather than copied, for the reason R-28 exists: this is where the grant is resolved, the
   * human is asked, and the ledger is written, and two call sites spelling that out separately is how one
   * of them comes to omit a step. `delegate_all` differs from `delegate` only in running several of these
   * concurrently and reporting each outcome — not in any governance rule.
   *
   * Returns an outcome instead of throwing, because a fan-out must be able to report "three succeeded, one
   * was refused". `delegate` converts a failure back into a throw to keep its own contract, which matters:
   * `AgentToolResult` has no `isError` field, so a returned error is silently discarded by pi.
   */
  const runOneDelegation = async (
    spec: { task: string; agent?: string; tools?: string[]; model?: string },
    ids: { parentId: string; childId: string },
    budget: number | undefined,
    ctx: { cwd: string; model?: { provider: string; id: string } },
    signal: AbortSignal | undefined,
  ): Promise<{ ok: boolean; text: string; reason?: string; granted: Capability[]; depth: number; exitCode: number | null }> => {
    // pi resolves a BARE model id to an unauthenticated provider and the child dies at startup — the id
    // alone is not enough, it must be qualified with its provider (`Model<Api>` carries both).
    const defaultModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const request = { task: spec.task, agent: spec.agent, tools: spec.tools, model: spec.model ?? defaultModel };
    const extra = { fanoutBudget: budget, spawnId: ids.parentId, childSpawnId: ids.childId };

    // Deliberately NOT pre-filling `approved` here — pre-filling would satisfy any inherited-approval gate
    // silently, before `gatedBlocked` ever surfaces, so `obtainApprovals` would never run and the ledger
    // would lose the `approvalSource: "inherited"` record ADR-0010 relies on as inheritance's compensating
    // control. `approved ⊆ grant` still holds regardless — this is about the audit trail, not privilege.
    let plan = planDelegation(request, { ...(await delegationContext()), ...extra });

    let approvalOutcome: Awaited<ReturnType<typeof obtainApprovals>> | undefined;
    if (!plan.ok && shouldSeekApproval(plan.result)) {
      try {
        approvalOutcome = await obtainApprovals(
          plan.result?.gatedBlocked ?? [],
          DELEGATE_SUBJECT,
          "delegate",
          ctx as never,
          spec.task,
          signal,
        );
        const outcome = approvalOutcome;
        if (outcome.approved.length > 0) {
          plan = planDelegation(request, {
            // The scope is the REAL one: a `once` approval still authorises this spawn, and
            // `inheritApprovals` then keeps it from reaching the child. See ADR-0014. R-29 is what makes
            // this safe under fan-out: a `once` is consumed by exactly one concurrent caller.
            ...(await delegationContext([
              ...republishable(),
              ...outcome.approved.map((capability) => ({
                capability,
                subject: DELEGATE_SUBJECT,
                scope: outcome.scope ?? ("once" as const),
              })),
            ])),
            ...extra,
          });
        }
        if (!plan.ok && approvalOutcome.reason) plan = { ...plan, reason: approvalOutcome.reason };
      } catch (error) {
        plan = { ...plan, reason: `grants: approval flow failed, denying (${String(error)})` };
      }
    }

    // G6 / B-I3: no `&& plan.result` guard — `planDelegation` always carries one now.
    if (ledgerPath) {
      await appendRecord(
        { path: ledgerPath, strict: true },
        buildRecord({
          // F8: real ids, not depth labels. Four concurrent siblings used to produce four lines identical
          // except `ts`, so the ledger could not be joined to a result, a process, or the child's own
          // lines one level down.
          parentId: ids.parentId,
          childId: ids.childId,
          depth: plan.childDepth,
          agentType: spec.agent ?? "delegate",
          requested: plan.requested,
          parentGrant: ownGrant,
          result: plan.result,
          blocked: !plan.ok,
          reason: plan.reason,
          approved: approvalOutcome?.approved,
          approvalSource: approvalOutcome?.source,
          approvalScope: approvalOutcome?.scope,
          humanDenied: approvalOutcome?.humanDenied,
          now: new Date(),
        }),
      ).catch((error) => {
        // G6 / A-R4 + B-I2: fail closed. This path PROVISIONS, so an unrecorded delegation would be a
        // child running with granted capabilities and no audit line.
        plan = { ...plan, ok: false, reason: `grants: ledger write failed, denying — ${String(error)}` };
      });
    }

    if (!plan.ok) {
      return { ok: false, text: "", reason: plan.reason, granted: [], depth: plan.childDepth, exitCode: null };
    }

    // G8: bounded output, a wall-clock timeout with SIGTERM->SIGKILL escalation, and an abort observed
    // even if it happened before we got here. See src/run-child.ts for why each one exists.
    //
    // ADR-0016 point 6: two executors, one plan. `runChild` is the default because it needs nothing
    // installed; herdr gives the same governed argv a VISIBLE, attachable pane. Opt-in per session rather
    // than auto-detected — a governed run must not silently relocate because a binary is on PATH.
    const output = useHerdr
      ? await runHerdrPane({
          args: plan.args.slice(0, -1),
          // The task is delivered as a prompt, so it never reaches argv at all. `plan.args` still ends
          // with the neutralised task (planSpawn is executor-agnostic), hence the slice — and the leading
          // space `neutralisePrompt` added is stripped because there is no parser to defend against here.
          prompt: plan.args[plan.args.length - 1].trimStart(),
          // Grant/depth/ledger go on the PANE: `herdr agent start` has no --env, but a pane's environment
          // reaches the shell that launches the agent (docs/probes/g16-herdr).
          env: plan.env,
          cwd: ctx.cwd,
          name: `${spec.agent ?? "delegate"}-${ids.childId}`,
          workspace: process.env[ENV_HERDR_WORKSPACE],
          signal,
          timeoutMs: timeoutFromEnv(process.env[ENV_CHILD_TIMEOUT]),
          keepPane: process.env[ENV_HERDR_KEEP_PANE] === "1",
        })
      : await runChild({
          command: "pi",
          args: plan.args,
          // Explicit per-child env — the parent's own grant vars must not leak in. A plain spread would
          // not achieve that: a key `plan.env` does not set is a key the parent's value survives into, so
          // `mergeChildEnv` strips every governance variable first and lets only the plan put them back.
          env: mergeChildEnv(process.env, plan.env),
          cwd: ctx.cwd,
          signal,
          timeoutMs: timeoutFromEnv(process.env[ENV_CHILD_TIMEOUT]),
        });

    // G8: a child that failed is reported as a failure. A non-zero exit, a timeout and a truncated flood
    // all used to come back as ordinary tool results, so the orchestrator read them as answers.
    if (output.spawnError || output.aborted || output.timedOut || output.code !== 0) {
      const why = output.spawnError
        ? `could not be started: ${output.spawnError}`
        : output.aborted
          ? "was cancelled"
          : output.timedOut
            ? "exceeded its time limit and was killed"
            : `exited with code ${output.code}`;
      return {
        ok: false,
        text: output.text.trim(),
        reason: `the sub-agent ${why}`,
        granted: plan.effective,
        depth: plan.childDepth,
        exitCode: output.code,
      };
    }

    return {
      ok: true,
      text: output.text.trim(),
      granted: plan.effective,
      depth: plan.childDepth,
      exitCode: output.code,
    };
  };
  if (mayDelegate) pi.registerTool({
    name: "delegate",
    label: "Delegate (governed)",
    description:
      "Delegate a task to a sub-agent holding ONLY the capabilities you grant it. You cannot grant what " +
      "you do not hold. Prefer 'agent' — it spawns a definition whose capabilities and instructions were " +
      "written by the operator. Use 'tools' only when no definition fits. Grant 'delegate' if the " +
      "sub-agent must itself delegate further; withhold it to make the sub-agent a leaf.",
    parameters: Type.Object({
      task: Type.String({ description: "The task for the sub-agent. It receives only this." }),
      agent: Type.Optional(
        Type.String({
          description:
            `Name of a definition to spawn — its allowed-tools become the grant and its instructions ` +
            `become the sub-agent's system prompt. Available: ${[...definitions.keys()].sort().join(", ") || "none"}.`,
        }),
      ),
      tools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Capabilities to grant when no 'agent' is named, e.g. [\"read\",\"grep\"] or " +
            "[\"tool:read\",\"ext:pkg/tool\"]. Empty means no tools. Ignored when 'agent' is given.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          // A bare id resolves across all known providers and can land on one there is no key for, so the
          // form is named rather than implied — see the "Verified live" defect in the README.
          description:
            "Model for the sub-agent as provider/id, e.g. \"openai-codex/gpt-5.6-sol\". " +
            "Defaults to this session's model, already provider-qualified.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const outcome = await runOneDelegation(
        { task: params.task, agent: params.agent, tools: params.tools, model: params.model },
        { parentId: ownSpawnId, childId: childSpawnId(ownSpawnId, 0) },
        // A single blocking delegation spends nothing from the subtree budget: cardinality is already
        // bounded to one by the call being blocking, which is the accident fan-out removes. Passing the
        // budget through unchanged means a child can still fan out with what this session was given.
        fanoutBudget,
        ctx,
        signal,
      );

      if (!outcome.ok) {
        // THROW, do not return. `AgentToolResult` has no `isError` field: pi sets it only when `execute`
        // throws (`pi-agent-core/dist/agent-loop.js` — a normal return is hardcoded `isError: false`).
        // Returning `isError: true` was silently discarded, so every refusal this package made was
        // recorded by pi as a SUCCESSFUL tool call. Found by the integration suite on its first run.
        const detail = outcome.text ? `\n\n${outcome.text}` : "";
        throw new Error(`delegation refused: ${outcome.reason}${detail}`);
      }

      return {
        content: [{ type: "text", text: outcome.text || "(no output)" }],
        details: { granted: outcome.granted, depth: outcome.depth, exitCode: outcome.exitCode },
      };
    },
  });

  /**
   * Bounded SYNCHRONOUS fan-out — ADR-0015's option A′.
   *
   * One call spawns several governed children concurrently and returns when the last one finishes. There is
   * deliberately no background mode, no result-by-id and no child registry, and that scoping is the whole
   * design: **fan-out and background are separable, fan-out carries most of the value, and background
   * carries nearly all of the state-machine holes.** Because the turn still owns the children, the parent
   * cannot exit before them, the tool-call signal is still live, the timeout still outlives every child,
   * results are returned rather than stored, and there are no ids to dangle across a compaction.
   *
   * Every child goes through `runOneDelegation`, so each one is planned, gated, audited and bounded by
   * exactly the same rules as a single `delegate`. What fan-out adds is a **cardinality bound** (the
   * budget) and **sibling identity** (F8) — the two things ADR-0008 never had, because a blocking
   * `delegate` bounded cardinality to one by accident.
   */
  if (mayDelegate) pi.registerTool({
    name: "delegate_all",
    label: "Delegate to several sub-agents (governed, parallel)",
    description:
      "Run several sub-agents CONCURRENTLY and return all their results. Each child is governed exactly " +
      "as with `delegate`: it holds only what you grant it, and you cannot grant what you do not hold. " +
      `At most ${MAX_CHILDREN_PER_CALL} children per call, and a session-wide budget bounds the total ` +
      "across the whole delegation subtree. Children cannot see each other or share context. Use this " +
      "when independent tasks can proceed in parallel — several reviewers over one diff, say — and read " +
      "every child's outcome, because one can be refused while the others succeed.",
    parameters: Type.Object({
      children: Type.Array(
        Type.Object({
          task: Type.String({ description: "The task for this sub-agent. It receives only this." }),
          agent: Type.Optional(Type.String({ description: "Definition to spawn; its allowed-tools become the grant." })),
          tools: Type.Optional(Type.Array(Type.String(), { description: "Capabilities, when no 'agent' fits." })),
          model: Type.Optional(Type.String({ description: "Model as provider/id. Defaults to this session's." })),
        }),
        {
          minItems: 1,
          maxItems: MAX_CHILDREN_PER_CALL,
          description: "The sub-agents to run concurrently. Each is independent and unaware of the others.",
        },
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const children = params.children ?? [];
      const split = splitBudget(fanoutBudget, children.length);
      if (!split.ok) {
        // Thrown, not returned: a returned `isError` is discarded by pi, so a refusal that came back as a
        // normal result would read to the orchestrator as a successful fan-out of zero children.
        throw new Error(`fan-out refused: ${split.reason}`);
      }

      // Concurrent by construction. Each child gets its own budget share and its own ledger id, so the
      // records form a tree and two siblings can never be confused for one another.
      const outcomes = await Promise.all(
        children.map((child, index) =>
          runOneDelegation(
            child,
            { parentId: ownSpawnId, childId: childSpawnId(ownSpawnId, index) },
            split.perChild,
            ctx,
            signal,
          ),
        ),
      );

      const failed = outcomes.filter((o) => !o.ok);
      // Every child is reported, including the ones that failed. R-03's rule: a missing result must never
      // be indistinguishable from an empty one, and a fan-out that hid its refusals would let an
      // orchestrator summarise four reviews when only three happened.
      const report = outcomes
        .map((outcome, index) => {
          const label = `### child ${index + 1}${children[index].agent ? ` (${children[index].agent})` : ""}`;
          return outcome.ok
            ? `${label} — completed\n\n${outcome.text || "(no output)"}`
            : `${label} — FAILED: ${outcome.reason}${outcome.text ? `\n\n${outcome.text}` : ""}`;
        })
        .join("\n\n---\n\n");

      if (failed.length === children.length) {
        // All of them failed, so there is no partial result to hand back — and a tool that returns text
        // when nothing ran is exactly how a wrong summary gets written.
        throw new Error(`fan-out failed: every child was refused or failed.\n\n${report}`);
      }

      return {
        content: [{ type: "text", text: report }],
        details: {
          children: outcomes.length,
          failed: failed.length,
          budgetPerChild: split.perChild,
          granted: outcomes.map((o) => o.granted),
        },
      };
    },
  });

  pi.registerCommand("grants", {
    ...grantsCommand,
    handler: (args, ctx) =>
      grantsCommand.handler(args, {
        ...ctx,
        grants: {
          cwd,
          governed,
          ownGrant,
          observed,
          depth,
          maxDepth,
          ledgerPath,
          catalog,
          definitions,
          sessionApprovals,
          inheritedApprovals,
          ceilingOf,
          delegationContext,
        },
      }),
  });
}
