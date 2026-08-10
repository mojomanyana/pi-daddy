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

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ceilingFor, loadAgentTypes, WILDCARD, type AgentType } from "../src/agent-types.ts";
import {
  DELEGATE_SUBJECT,
  approvalKey,
  expiryFor,
  resolveApprovals,
  shouldSeekApproval,
  type ApprovalPath,
  type ApprovalScope,
  type ApprovalSource,
} from "../src/approval.ts";
import { loadApprovals, revokeAll, revokeApproval, saveApproval } from "../src/approval-store.ts";
import { createApprovalGate, createApprovalGateProvider, timeoutMsFromEnv } from "../src/approval-prompt.ts";
import { buildCatalog, makeCatalog, type Catalog } from "../src/catalog.ts";
import { DELEGATE_CAPABILITY, planDelegation } from "../src/delegate.ts";
import { decideSpawn } from "../src/interceptor.ts";
import { appendRecord, buildRecord } from "../src/ledger.ts";
import {
  childEnv,
  depthConfig,
  deriveOwnGrant,
  mergeChildEnv,
  ENV_APPROVED,
  ENV_DEPTH,
  ENV_GATED,
  ENV_GRANT,
  ENV_LEDGER,
  ENV_MAX_DEPTH,
  observeToolNames,
  parseList,
} from "../src/propagation.ts";
import { type Capability } from "../src/resolve.ts";

const SPAWN_TOOLS = new Set(["Agent", "subagent", "spawn_agent"]);

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
  const gated = parseList(process.env[ENV_GATED]);
  const ledgerPath = process.env[ENV_LEDGER];

  /** This session's own grant. Starts as the inherited upper bound, tightened once tools are observed. */
  let ownGrant: Capability[] = deriveOwnGrant(inherited, null);
  let observed = false;
  let observedTools: string[] | null = null;
  let types = new Map<string, AgentType>();
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
  const inheritedApprovals = parseList(process.env[ENV_APPROVED]);

  /** Current ceiling for an agent type, for the confused-deputy check in the store. */
  const ceilingOf = (subject: string) => {
    const type = types.get(subject);
    return type ? ceilingFor(type) : null;
  };

  /** Capabilities (not keys) approved this session, for propagation. */
  const sessionApprovalCapabilities = (): Capability[] =>
    [...sessionApprovals].map((key) => key.slice(0, key.indexOf("@")));

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
      approved: [...inheritedApprovals, ...sessionApprovalCapabilities()],
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
      types = await loadAgentTypes(ctx.cwd);
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

  pi.on("tool_call", async (event, ctx) => {
    if (!SPAWN_TOOLS.has(event.toolName)) return undefined;

    const input = (event.input ?? {}) as Record<string, unknown>;
    // The spawn prompt, shown to the human for context and stored as an `always` entry's provenance.
    // Model-supplied, so it is never part of a key — only ever displayed and recorded.
    const spawnTask = typeof input.prompt === "string" ? input.prompt : undefined;

    let decision: ReturnType<typeof decideSpawn>;
    try {
      decision = decideSpawn(
        { subagentType: input.subagent_type ?? input.agent_type ?? input.type, isolated: input.isolated },
        { parentGrant: ownGrant, depth, maxDepth, types, gated },
      );
    } catch (error) {
      // A governance layer that errors must deny, not permit.
      return { block: true, reason: `grants: decision failed, denying (${String(error)})` };
    }

    // A gate is not a denial: ask a human for what is left, then re-run the SAME pure function with
    // `approved` filled. `src/resolve.ts` and `src/interceptor.ts` are not touched by this at all.
    let approvalOutcome: Awaited<ReturnType<typeof obtainApprovals>> | undefined;
    // `shouldSeekApproval` — not just `gatedBlocked.length > 0` — so a human is never asked about a spawn
    // this session was going to refuse anyway for an unrelated `denied`. See its doc comment.
    if (!decision.allow && shouldSeekApproval(decision.result)) {
      try {
        approvalOutcome = await obtainApprovals(
          decision.result?.gatedBlocked ?? [],
          decision.typeName,
          "interceptor",
          ctx,
          spawnTask,
          // This is the only path that writes a 30-day persisted approval, so an orphaned dialog here
          // outlives the turn that raised it. `ExtensionContext.signal` is undefined when the agent is
          // not streaming, which the gate passes straight through to `select` as "no signal".
          ctx.signal,
        );
        if (approvalOutcome.approved.length > 0) {
          // Same pure function, second call — the ONLY difference is that `approved` is now filled.
          decision = decideSpawn(
            { subagentType: decision.typeName },
            { parentGrant: ownGrant, depth, maxDepth, types, gated, approved: approvalOutcome.approved },
          );
        }
        if (!decision.allow && approvalOutcome.reason) decision.reason = approvalOutcome.reason;
      } catch (error) {
        // A governance layer that errors must deny, not permit — the original refusal already stands.
        decision.reason = `grants: approval flow failed, denying (${String(error)})`;
      }
    }

    if (ledgerPath) {
      // G6 / A-S3: `decideSpawn` now carries the result it decided from, so there is nothing to
      // recompute. The old `?? resolve({...})` fallback ran on the wildcard path and denied everything,
      // recording legitimate allowed spawns as escalation attempts.
      const result = decision.result;
      await appendRecord(
        { path: ledgerPath, strict: true },
        buildRecord({
          parentId: `d${depth}`,
          childId: `${decision.typeName}@d${decision.childDepth}`,
          depth: decision.childDepth,
          agentType: decision.typeName,
          requested: decision.requested,
          parentGrant: ownGrant,
          result,
          blocked: !decision.allow,
          reason: decision.reason,
          approved: approvalOutcome?.approved,
          approvalSource: approvalOutcome?.source,
          approvalScope: approvalOutcome?.scope,
          humanDenied: approvalOutcome?.humanDenied,
          now: new Date(),
        }),
      ).catch((error) => {
        // G6 / A-R4 + B-I2. This used to swallow silently, which contradicted `ledger.ts`'s own
        // contract that "an unrecorded grant should fail closed". Configuring a ledger is an explicit
        // act: the operator asked for an audit trail, so a spawn that cannot be recorded must not
        // proceed. Sessions with no `PI_GRANTS_LEDGER` are unaffected — they never enter this branch.
        decision = {
          ...decision,
          allow: false,
          reason: `grants: ledger write failed, denying — ${String(error)}`,
        };
      });
    }

    if (!decision.allow) {
      ctx.ui.notify(`grants: blocked spawn — ${decision.reason}`, "warning");
      return { block: true, reason: `grants: ${decision.reason}` };
    }
    // No env mutation HERE, on the allow path — that per-spawn write was the original race. Any env
    // mutation for this decision already happened inside `obtainApprovals` (session-approval case), and
    // it is safe there for the same reason: it publishes a parent-level fact, not a per-child value.
    return undefined;
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

  pi.registerTool({
    name: "delegate",
    label: "Delegate (governed)",
    description:
      "Delegate a task to a sub-agent holding ONLY the capabilities you grant it. You cannot grant what " +
      "you do not hold. Grant 'delegate' if the sub-agent must itself delegate further; withhold it to " +
      "make the sub-agent a leaf.",
    parameters: Type.Object({
      task: Type.String({ description: "The task for the sub-agent. It receives only this." }),
      tools: Type.Array(Type.String(), {
        description:
          "Capabilities to grant, e.g. [\"read\",\"grep\"] or [\"tool:read\",\"ext:pkg/tool\"]. Empty means no tools.",
      }),
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
      // pi resolves a BARE model id to an unauthenticated provider and the child dies at startup — the
      // id alone is not enough, it must be qualified with its provider (`Model<Api>` carries both).
      // Computed once and reused at both `planDelegation` call sites below so they cannot diverge.
      const defaultModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

      // Deliberately NOT pre-filling `approved` here (unlike the interceptor path's first `decideSpawn`,
      // which also omits it) — pre-filling would satisfy any inherited-approval gate silently, before
      // `gatedBlocked` ever surfaces, so `obtainApprovals` would never run and the ledger would lose the
      // `approvalSource: "inherited"` record ADR-0010 relies on as inheritance's compensating control.
      // `approved ⊆ grant` still holds regardless — this is purely about the audit trail, not privilege.
      let plan = planDelegation(
        { task: params.task, tools: params.tools, model: params.model ?? defaultModel },
        { ownGrant, depth, maxDepth, gated, ledgerPath, extensionPath, catalog: await catalogReady },
      );

      // Same fill-and-retry as the interceptor path: ask for what is gated, re-plan with `approved`
      // filled. `src/delegate.ts`'s `planDelegation` is not touched by this at all.
      let approvalOutcome: Awaited<ReturnType<typeof obtainApprovals>> | undefined;
      if (!plan.ok && shouldSeekApproval(plan.result)) {
        try {
          approvalOutcome = await obtainApprovals(
            plan.result?.gatedBlocked ?? [],
            DELEGATE_SUBJECT,
            "delegate",
            ctx,
            params.task,
            signal,
          );
          if (approvalOutcome.approved.length > 0) {
            plan = planDelegation(
              { task: params.task, tools: params.tools, model: params.model ?? defaultModel },
              {
                ownGrant,
                depth,
                maxDepth,
                gated,
                ledgerPath,
                extensionPath,
                catalog: await catalogReady,
                approved: [...inheritedApprovals, ...approvalOutcome.approved],
              },
            );
          }
          if (!plan.ok && approvalOutcome.reason) plan = { ...plan, reason: approvalOutcome.reason };
        } catch (error) {
          // A governance layer that errors must deny, not permit — the original refusal already stands.
          plan = { ...plan, reason: `grants: approval flow failed, denying (${String(error)})` };
        }
      }

      // G6 / B-I3: no `&& plan.result` guard — `planDelegation` always carries one now, and the four
      // refusals that used to lack it (disabled, too deep, no task, unknown capability) went unaudited.
      if (ledgerPath) {
        await appendRecord(
          { path: ledgerPath, strict: true },
          buildRecord({
            parentId: `d${depth}`,
            childId: `delegate@d${plan.childDepth}`,
            depth: plan.childDepth,
            agentType: "delegate",
            requested: params.tools.map((t) => (t.includes(":") ? t : `tool:${t}`)),
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
          // G6 / A-R4 + B-I2: fail closed. Unlike the interceptor path this one PROVISIONS, so an
          // unrecorded delegation would be a child running with granted capabilities and no audit line.
          plan = { ...plan, ok: false, reason: `grants: ledger write failed, denying — ${String(error)}` };
        });
      }

      if (!plan.ok) {
        return {
          content: [{ type: "text", text: `delegation refused: ${plan.reason}` }],
          details: { blocked: true, reason: plan.reason },
          isError: true,
        };
      }

      const output = await new Promise<{ code: number | null; text: string }>((settle) => {
        const child = spawn("pi", plan.args, {
          // Explicit per-child env — the parent's own grant vars must not leak in. A plain spread would
          // not achieve that: a key `plan.env` does not set is a key the parent's value survives into, so
          // `mergeChildEnv` strips every governance variable first and lets only the plan put them back.
          env: mergeChildEnv(process.env, plan.env),
          cwd: ctx.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        child.stdout.on("data", (chunk) => (text += String(chunk)));
        child.stderr.on("data", (chunk) => (text += String(chunk)));
        signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
        child.on("error", (error) => settle({ code: -1, text: `spawn failed: ${String(error)}` }));
        child.on("close", (code) => settle({ code, text }));
      });

      return {
        content: [{ type: "text", text: output.text.trim() || "(no output)" }],
        details: {
          granted: plan.effective,
          depth: plan.childDepth,
          subsumedBy: plan.result?.subsumedBy ?? [],
          exitCode: output.code,
        },
      };
    },
  });

  pi.registerCommand("grants", {
    description:
      "Show this session's capability grant, delegation depth, and known agent-type ceilings; " +
      "/grants approvals | /grants revoke <key>|--all",
    handler: async (args, ctx) => {
      const [sub, target] = args.trim().split(/\s+/).filter(Boolean);

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
          `${inheritedApprovals.length > 0 ? `, ${inheritedApprovals.length} inherited` : ""}` +
          ` — /grants approvals`,
        `  catalog    ${catalog.all.length} capabilities — ` +
          `${catalog.byKind("builtin").length} builtin, ${catalog.byKind("extension").length} extension, ` +
          `${catalog.byKind("skill").length} skill, ${catalog.byKind("agentType").length} agent-type`,
      ];
      for (const [name] of [...types].slice(0, 12)) {
        const d = decideSpawn({ subagentType: name }, { parentGrant: ownGrant, depth, maxDepth, types, gated });
        lines.push(`    ${d.allow ? "allow" : "BLOCK"}  ${name}${d.allow ? "" : ` — ${d.reason}`}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
