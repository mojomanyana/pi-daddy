/**
 * The session object — the one place this extension's state is named.
 *
 * Split out of `extensions/grants.ts`, which is where every wiring bug in this package has lived: the G7
 * `NaN` bound, the discarded `isError`, the unconditionally-registered `delegate` (S-5) and R-28's omitted
 * argument. Those four share a shape — a value that was *whatever happened to be in scope* at one call
 * site. A closure over a dozen `let`s cannot be reviewed as a whole; an object whose fields are written
 * down can, and it is the same move `grants-command.ts` was extracted under.
 *
 * Configuration is parsed once, at load time, and is `readonly`. The handful of genuinely mutable fields
 * are the ones the hooks in `grants.ts` update as the session learns about itself — the grant tightens when
 * the real tool surface is observed, the catalog and definitions arrive at `session_start`. Every other
 * module reads them **through this object**, live, rather than capturing a copy at load time; capturing a
 * copy of `ownGrant` before observation is exactly how a stale upper bound would become an enforced one.
 */

import { parseInherited, type InheritableApproval } from "../src/approval.ts";
import { createApprovalGateProvider } from "../src/approval-prompt.ts";
import { makeCatalog, skillPathsFromCatalog, type Catalog } from "../src/catalog.ts";
import type { SkillDefinition } from "../src/definitions.ts";
import { DELEGATE_CAPABILITY, type DelegationContext } from "../src/delegate.ts";
import { budgetFromEnv } from "../src/fanout.ts";
import { WILDCARD } from "../src/pi-tools.ts";
import {
  childEnv,
  depthConfig,
  deriveOwnGrant,
  gatedFromEnv,
  ENV_APPROVED,
  ENV_DEPTH,
  ENV_FANOUT,
  ENV_GATED,
  ENV_GRANT,
  ENV_LEDGER,
  ENV_MAX_DEPTH,
  ENV_PARENT_ID,
  parseList,
} from "../src/propagation.ts";
import type { Capability } from "../src/resolve.ts";
import { loadGrantSync, grantStorePath } from "../src/grant-store.ts";
import { republishable } from "./approvals.ts";

/**
 * Run governed children in herdr panes instead of captured child processes (ADR-0016 point 6).
 *
 * Opt-in, and deliberately not auto-detected from `herdr` being on PATH: where a governed child executes
 * is an operator decision, and a run that silently relocates because a binary appeared is exactly the kind
 * of invisible change this package exists to prevent. Both executors enforce the identical grant — the
 * plan is the same, only the place it runs differs.
 */
export const ENV_HERDR = "PI_GRANTS_HERDR";
/** herdr workspace for spawned panes. Omitted lets herdr choose. */
export const ENV_HERDR_WORKSPACE = "PI_GRANTS_HERDR_WORKSPACE";
/** Keep each child's pane after it finishes, for inspection. Off by default: fan-out would flood it. */
export const ENV_HERDR_KEEP_PANE = "PI_GRANTS_HERDR_KEEP_PANE";

export interface GrantsSession {
  /** False when `PI_GRANTS_GRANT` is unset: the session holds the wildcard and nothing is governed. */
  readonly governed: boolean;
  /** The upper bound handed down by the delegator, before this session's own tools are observed. */
  readonly inherited: Capability[];
  readonly depth: number;
  readonly maxDepth: number;
  /** Bound variables that could not be read as non-negative integers — spawning is disabled, loudly. */
  readonly malformedBounds: string[];
  readonly gated: Capability[];
  readonly ledgerPath?: string;
  readonly useHerdr: boolean;
  /** This session's ledger identity; children descend from it (F8). */
  readonly ownSpawnId: string;
  /** Descendants this subtree may still create — the cardinality bound ADR-0008 never had. */
  readonly fanoutBudget: number;
  /** Whether `delegate` / `delegate_all` are registered at all (S-5). Decided on the INHERITED grant. */
  readonly mayDelegate: boolean;
  /** Path to this extension, so a child granted `tool:delegate` can delegate in turn. */
  readonly extensionPath?: string;

  /** Approval keys approved for this session. In memory only — this dies with the process. */
  readonly sessionApprovals: Set<string>;
  /**
   * Approvals inherited from the delegator, already clamped to this session's grant upstream.
   *
   * Key → body digest (ADR-0022), where the digest is absent for `<delegate>` and for a pre-0.11 parent.
   * Deliberately kept RAW here and verified at the point of use (`storedApprovals`), because verification
   * needs `session.definitions`, which does not exist until `session_start` — and this object is built
   * before any hook has run.
   */
  readonly inheritedApprovals: Map<string, string | undefined>;
  /** ONE single-flight queue for the whole session — see `obtainApprovals` for why it lives here. */
  readonly approvalGateFor: ReturnType<typeof createApprovalGateProvider>;

  /** Set at `session_start`; `process.cwd()` until then. */
  cwd: string;
  /** This session's own grant. Starts as the inherited upper bound, tightened once tools are observed. */
  ownGrant: Capability[];
  observed: boolean;
  observedTools: string[] | null;
  /** ADR-0016: `SKILL.md` definitions, keyed by name. The format this package spawns from now. */
  definitions: Map<string, SkillDefinition>;
  catalog: Catalog;
  /**
   * The in-flight catalog build, so `delegate` can wait for it instead of racing it.
   *
   * G7 / A-R5. The refresh in `before_provider_request` was fire-and-forget, so a `delegate` call
   * early in a session could read a catalog that was still empty and refuse a perfectly valid grant
   * as an "unknown capability". It failed closed, which is why it was Important rather than Critical,
   * but non-deterministically: the same delegation succeeded or failed on timing alone.
   */
  catalogReady: Promise<Catalog>;

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
  delegationContext(approved?: InheritableApproval[]): Promise<DelegationContext>;

  /**
   * Publish what children inherit. Written once at session start, and republished whenever this
   * session's own approvals change (see `obtainApprovals`) — never once per spawn. That distinction is
   * what keeps this race-free: every value ever written here is a PARENT-level fact (this session's own
   * grant, intersected with its own approvals), identical for every sibling no matter which spawn
   * prompted the human. A value scoped to one specific child is never written to this global channel.
   */
  publishChildEnv(): void;
  /**
   * The directory whose stored grant this session read, or would read. `process.cwd()` — see the note in
   * `createGrantsSession` for why the factory cannot use `ctx.cwd`.
   */
  readonly storeCwd: string;
  /**
   * Adopt a grant decided DURING the session — `/grants init` answering a human — without a restart.
   *
   * Narrow by design: it sets the session's own grant and republishes, so the very next spawn is bounded by
   * it. It does **not** reach children that already exist; those are separate processes whose environment
   * was fixed when they started, and reaching into them is neither possible nor desirable — a child's
   * ceiling should not move under it mid-run.
   *
   * Only a human can reach this. Slash commands are user-invoked; no tool exposes it, so a model cannot
   * widen its own session's ceiling by calling something.
   */
  adoptGrant(grant: Capability[]): void;
}

/**
 * Parse the environment once and build the session every other module reads through.
 *
 * `extensionPath` is passed in rather than derived here: it must name the file **pi loads as the
 * extension**, so a child granted `tool:delegate` can be started with `-e <that file>`. `grants.ts` is that
 * file, and only `grants.ts` can say so about itself.
 */
export function createGrantsSession(extensionPath: string | undefined): GrantsSession {
  // Governance is opt-in: with PI_GRANTS_GRANT unset AND no stored grant for this directory, the session
  // holds the wildcard and nothing is blocked. This extension must never silently tighten a normal
  // workflow.
  //
  // **Two sources, and the environment always wins** (ADR-0030). The variable is how a CHILD is governed
  // and how CI is configured, so a store that could override it would let a directory quietly widen or
  // narrow a child its parent had already bounded. The store is consulted only when the variable is absent,
  // which is exactly the case it was added for: a human at a terminal who ran `/grants init` here.
  //
  // `process.cwd()` rather than `ctx.cwd`, because this runs in the extension factory — before any hook,
  // and therefore before `ctx` exists. That ordering is forced by S-5: whether `delegate` is registered at
  // all is decided here, and a grant arriving later could not inform it. `session_start` re-checks the two
  // against each other and says so if they differ, which is the only case this can get wrong.
  const grantRaw = process.env[ENV_GRANT];
  const storeCwd = process.cwd();
  const stored = grantRaw === undefined ? loadGrantSync(storeCwd) : null;
  const governed = grantRaw !== undefined || stored !== null;
  const inherited: Capability[] = grantRaw !== undefined ? parseList(grantRaw) : (stored ?? [WILDCARD]);
  // G7 / A-S4 + B-I4: strict, three-way parsing that fails CLOSED. A malformed bound used to yield
  // `NaN`, and every comparison against `NaN` is false, so depth limiting switched itself off.
  const bounds = depthConfig(process.env[ENV_DEPTH], process.env[ENV_MAX_DEPTH]);
  const { depth, maxDepth } = bounds;

  const emptyCatalog = makeCatalog([]);

  const session: GrantsSession = {
    governed,
    inherited,
    depth,
    maxDepth,
    malformedBounds: bounds.malformed,
    // ADR-0012: `bash` is gated by DEFAULT — but only in a governed session. An ungoverned one
    // (no PI_GRANTS_GRANT) still blocks nothing, so "governance is opt-in" holds exactly where it always
    // did. Inside a session the operator already chose to govern, handing a child `bash` hands it an
    // ungoverned-descendant escape hatch, and doing that silently is what changes here.
    // `PI_GRANTS_GATED=""` turns the default off; absent and empty are deliberately distinguishable.
    gated: governed ? gatedFromEnv(process.env[ENV_GATED]) : parseList(process.env[ENV_GATED]),
    ledgerPath: process.env[ENV_LEDGER],
    useHerdr: process.env[ENV_HERDR] === "1",
    // `ownSpawnId` comes from the parent (F8), so ids form one tree across process boundaries instead of
    // every level restarting at `d0` and the ledger becoming unjoinable.
    ownSpawnId: process.env[ENV_PARENT_ID]?.trim() || `d${depth}`,
    // The cardinality bound ADR-0008 never had: it attenuates downward like depth, so a subtree can never
    // create more descendants than its root was given — with no shared state, no lock and no counter file.
    fanoutBudget: budgetFromEnv(process.env[ENV_FANOUT]),
    /**
     * Review finding S-5, fixed. The comment on the tools has always claimed conditional registration; the
     * call was unconditional, `DELEGATE_CAPABILITY` was imported and never used, and "withhold it and the
     * child is a leaf" was simply untrue on this path.
     *
     * Decided on the INHERITED grant rather than `ownGrant`, because registration happens at load time,
     * before any tools are observed. An ungoverned session registers it as before.
     */
    mayDelegate: !governed || inherited.includes(DELEGATE_CAPABILITY) || inherited.includes(WILDCARD),
    extensionPath,

    sessionApprovals: new Set<string>(),
    inheritedApprovals: parseInherited(process.env[ENV_APPROVED]),
    approvalGateFor: createApprovalGateProvider(),

    cwd: process.cwd(),
    ownGrant: deriveOwnGrant(inherited, null),
    observed: false,
    observedTools: null,
    definitions: new Map<string, SkillDefinition>(),
    catalog: emptyCatalog,
    catalogReady: Promise.resolve(emptyCatalog),

    delegationContext: async (approved?: InheritableApproval[]) => ({
      ownGrant: session.ownGrant,
      depth: session.depth,
      maxDepth: session.maxDepth,
      gated: session.gated,
      ledgerPath: session.ledgerPath,
      extensionPath: session.extensionPath,
      catalog: await session.catalogReady,
      // R-32: where each granted skill lives, so `planSpawn` can pass `--skill` for those and only those.
      // Derived from the catalog's own `source`, so it cannot drift from what was discovered.
      skillPaths: skillPathsFromCatalog(await session.catalogReady),
      // ADR-0016: operator-authored SKILL.md definitions, so `delegate({agent})` can name one.
      definitions: session.definitions,
      // The herdr executor drives the child after starting it, so its plan must NOT carry `--print`.
      // Threaded through the plan rather than patched afterwards: the argv is what the ledger records, and
      // an executor quietly rewriting it would make the record describe a spawn that did not happen.
      interactive: session.useHerdr,
      ...(approved ? { approved } : {}),
    }),

    storeCwd,

    adoptGrant: (grant: Capability[]) => {
      // `governed` is not mutable on the session object, and it does not need to be: a stored grant makes
      // the session governed at creation, and `/grants init` only ever runs in a session that just wrote
      // one. What must change is the grant itself and what children inherit.
      session.ownGrant = grant;
      session.publishChildEnv();
    },

    publishChildEnv: () => {
      const env = childEnv({
        ownGrant: session.ownGrant,
        depth: session.depth,
        maxDepth: session.maxDepth,
        gated: session.gated,
        ledgerPath: session.ledgerPath,
        approved: republishable(session),
        // G7 / B-I8: an ungoverned session publishes nothing, so "governance is opt-in" holds for
        // descendants too. Previously it exported its own observed tool surface as their grant.
        governed: session.governed,
      });
      for (const [key, value] of Object.entries(env)) process.env[key] = value;
    },
  };

  return session;
}
