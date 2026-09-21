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
import { randomUUID } from "node:crypto";
import { parseInherited, type InheritableApproval } from "../src/kernel/approval.ts";
import type { ApprovalBinding } from "../src/kernel/correlation.ts";
import { createApprovalGateProvider } from "../src/governance/approval-prompt.ts";
import { makeCatalog, skillPathsFromCatalog, type Catalog } from "../src/kernel/catalog.ts";
import type { SkillDefinition } from "../src/kernel/definitions.ts";
import { DELEGATE_CAPABILITY, type DelegationContext } from "../src/kernel/delegate.ts";
import { budgetFromEnv } from "../src/kernel/fanout.ts";
import { chooseExecutor, ENV_HERDR, type ExecutorChoice } from "../src/executors/executor.ts";
import { WILDCARD } from "../src/kernel/pi-tools.ts";
import {
  childEnv,
  depthConfig,
  deriveOwnGrant,
  gatedFromEnv,
  ENV_APPROVED,
  ENV_DEPTH,
  ENV_EXECUTION_ID,
  ENV_FANOUT,
  ENV_GATED,
  ENV_GRANT,
  ENV_LEDGER,
  ENV_MAX_DEPTH,
  ENV_PARENT_ID,
  GRANT_ENV_KEYS,
  parseList,
} from "../src/kernel/propagation.ts";
import type { Capability } from "../src/kernel/resolve.ts";
import { loadDefinitions } from "../src/kernel/definitions.ts";
import { buildCatalog } from "../src/kernel/catalog.ts";
import { ENV_WORKSPACE_REGISTRY } from "../src/kernel/workspace.ts";
import type { GrantStoreRefusalReason } from "../src/governance/grant-store.ts";
import { republishable } from "./approvals.ts";
import { storedGrantSessionState } from "./stored-grant-session.ts";
import { nativeSessionRootFromEnv, type NativeSessionHost } from "../src/executors/native-session-target.ts";
import { ENV_ALLOW_UNRESOLVED_MODELS } from "../src/kernel/model-preflight.ts";
import type { DeclaredWorkState } from "../src/products/work-command.ts";
import { beginExtensionLifecycle, rememberChildPublication, type ReloadLifecycle } from "./reload-environment.ts";
import { reconcileSessionEnvironment } from "./session-environment.ts";
/**
 * Run governed children in herdr panes instead of captured child processes.
 *
 * **Three-state as of ADR-0031, and absent means PROBE.** It was opt-in under ADR-0016 point 6, on the
 * reasoning that *"a run that silently relocates because a binary appeared is exactly the kind of invisible
 * change this package exists to prevent"* — and that sentence is still honoured, because nothing is detected
 * from `herdr` being on `PATH`. What changed is that a **server which answers** is a different and stronger
 * test, and the "silently" half is discharged by the disclosure line ADR-0032 adds at session start and in
 * `/grants`. Both executors still enforce the identical grant: the plan is the same, only the place it runs
 * differs.
 *
 * The table itself is a pure function in `src/executors/executor.ts`; re-exported here because this is where every
 * other `PI_DADDY_*` name lives and a reader looking for it will look here.
 */
export { ENV_HERDR } from "../src/executors/executor.ts";
/**
 * herdr workspace for spawned panes — re-exported from where it is actually READ.
 *
 * It was declared here and read nowhere: `resolveWorkspace` reads the string literal, so the constant and the
 * literal could drift with nothing binding them. Re-exporting the single definition keeps this the place a reader
 * looks for a `PI_DADDY_*` name without letting two spellings exist.
 *
 * Omitting the variable no longer means "let herdr choose": it falls back to the parent's own
 * `HERDR_WORKSPACE_ID`, because a child in a different workspace from the session that spawned it makes switching
 * to it a workspace hop (ADR-0032). This name is the operator's explicit override.
 */
export { ENV_HERDR_WORKSPACE } from "../src/executors/herdr-cli.ts";
import {
  ENV_ACTIVITY_PARENT_TASK,
  ENV_ACTIVITY_PATH,
  ENV_ACTIVITY_ROOT,
  ENV_ACTIVITY_TASK,
} from "../src/products/activity-timeline.ts";
import { ENV_HERDR_KEEP_PANE, ENV_GOVERNANCE } from "../src/kernel/env-names.ts";
export { ENV_HERDR_KEEP_PANE, ENV_GOVERNANCE } from "../src/kernel/env-names.ts";
import { adoptLegacyEnvironment } from "../src/kernel/env-names.ts";

/** The activity timeline's per-child observation identity, handed to the kernel through `childEnv` (ADR-0076). */
export function activityChildEnv(activity: { rootId: string; path: string; taskId?: string } | undefined) {
  return (child: { childExecutionId?: string }): Readonly<Record<string, string>> =>
    activity?.taskId && child.childExecutionId
      ? {
          [ENV_ACTIVITY_PATH]: activity.path,
          [ENV_ACTIVITY_ROOT]: activity.rootId,
          [ENV_ACTIVITY_TASK]: child.childExecutionId,
          [ENV_ACTIVITY_PARENT_TASK]: activity.taskId,
        }
      : {};
}
/** Keep each child's pane after it finishes, for inspection. Off by default: fan-out would flood it. */
export interface VariantRunAccounting {
  runId: string;
  primaryExecutionId: string;
  shadowExecutionIds: string[];
  state: "running" | "settled";
  outcomes: null | { executionId: string; role: "primary" | "shadow"; ok: boolean; reason: string | null }[];
}
export interface GrantsSession extends NativeSessionHost {
  /** Legacy PI_GRANTS_* names adopted at construction (ADR-0076 PR 3b); the session-start warning names them. */
  readonly adoptedLegacyEnv: readonly string[];
  /** False only for the explicit PI_DADDY_GOVERNANCE opt-out; otherwise roots are observed-bound. */
  governed: boolean;
  /** The upper bound handed down by the delegator, before this session's own tools are observed. */
  inherited: Capability[];
  depth: number;
  maxDepth: number;
  /** Bound variables that could not be read as non-negative integers — spawning is disabled, loudly. */
  malformedBounds: string[];
  gated: Capability[];
  /** Resolved against the actual pi cwd at session start, then inherited verbatim by every descendant. */
  ledgerPath?: string;
  ledgerFromEnvironment: boolean;
  /**
   * Which executor runs this session's children — ADR-0031.
   *
   * **Mutable, and for ADR-0030's reason exactly.** Settling it needs a probe, the probe is async, and this
   * object is built *synchronously* in the extension factory — an ordering S-5 forces, since whether
   * `delegate` is registered at all is decided there. So it starts as the un-probed reading and is replaced by
   * `resolveExecutor` once `session_start` has probed.
   *
   * Nothing may capture a copy: read it through the session, live. A copy taken in the factory is a copy taken
   * before the probe, which is the same hazard as capturing `ownGrant` before the tool surface is observed.
   */
  executor: ExecutorChoice;
  /** This session's readable logical ledger identity; children descend from it (F8). */
  ownSpawnId: string;
  /** Unique identity when this session is itself a governed child; roots have no governed parent. */
  ownExecutionId?: string;
  /** Descendants this subtree may still create — the cardinality bound ADR-0008 never had. */
  fanoutBudget: number;
  /** Whether delegation tools are active. Reconciled against the owner-bound root at session_start. */
  mayDelegate: boolean;
  /** True only after session_start binds this instance to ctx.sessionManager. */
  ownerBound: boolean;
  /** Operator escape hatch for custom model resolution. Exact `1`, read once for the session. */
  allowUnresolvedModels: boolean;
  /** Results from pi's synchronous model catalogue, shared by every delegation in this session. */
  readonly modelResolutionCache: Map<string, boolean>;
  /** Path to this extension, so a child granted `tool:delegate` can delegate in turn. */
  readonly extensionPath?: string;
  /** Hook-only observer path for leaf children; it exposes no tools. */
  readonly observerExtensionPath?: string;
  /** Stable root identity plus current turn, used only to join local activity facts. */
  activityRootId: string;
  activity?: { rootId: string; path: string; taskId?: string };
  declaredWork?: DeclaredWorkState; // Explicit operator selection; absence leaves execution visibly unbound.
  /** Primary-return fan-outs retained by this original session; bounded and human-readable via /grants variants. */
  readonly variantRuns: Map<string, VariantRunAccounting>;
  /** Root identity keyed to ctx.sessionManager once session_start supplies it. */
  reloadLifecycle: ReloadLifecycle;
  /** Approval keys approved for this session. In memory only — this dies with the process. */
  readonly sessionApprovals: Set<string>;
  /** Exact bindings for correlated approvals; these never inherit across a delegation boundary. */
  readonly sessionApprovalBindings: Map<string, ApprovalBinding>;
  /**
   * Approvals inherited from the delegator, already clamped to this session's grant upstream.
   *
   * Key → body digest (ADR-0022), where the digest is absent for `<delegate>` and for a pre-0.11 parent.
   * Deliberately kept RAW here and verified at the point of use (`storedApprovals`), because verification
   * needs `session.definitions`, which does not exist until `session_start` — and this object is built
   * before any hook has run.
   */
  inheritedApprovals: Map<string, string | undefined>;
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
  /** Invalid stored state fails closed and is reported/ledgered during session_start. */
  grantStoreRefusal?: { reason: GrantStoreRefusalReason; path: string };
  /**
   * Adopt the project choice made DURING the session — grant plus optional default ledger — without restart.
   *
   * Narrow by design: it sets the session's own grant and republishes, so the very next spawn is bounded by
   * it. It does **not** reach children that already exist; those are separate processes whose environment
   * was fixed when they started, and reaching into them is neither possible nor desirable — a child's
   * ceiling should not move under it mid-run.
   *
   * Only a human can reach this. Slash commands are user-invoked; no tool exposes it, so a model cannot
   * widen its own session's ceiling by calling something.
   */
  adoptGrant(grant: Capability[], projectLedger?: string): void;
  reconcileEnvironment(environment: NodeJS.ProcessEnv, lifecycle: ReloadLifecycle): void;
}
/**
 * Parse the environment once and build the session every other module reads through.
 *
 * `extensionPath` is passed in rather than derived here: it must name the file **pi loads as the
 * extension**, so a child granted `tool:delegate` can be started with `-e <that file>`. `grants.ts` is that
 * file, and only `grants.ts` can say so about itself.
 */
/**
 * Load this project's definitions and capability catalog into the session.
 *
 * **One loader, two callers.** `session_start` runs it, and so does `/grants init` — which writes the very
 * files it reads, so a session that skipped this held `agent:review` while believing no definition of that
 * name existed, and the model was told `Available: none` (R-39's shape, reintroduced by the feature whose
 * selling point is "no restart"). Two copies of these three steps is how the two callers come to disagree
 * about what loading means, so there is one.
 */
export async function loadProjectDefinitions(session: GrantsSession, cwd: string): Promise<void> {
  session.definitions = await loadDefinitions(cwd);
  session.catalogReady = buildCatalog({
    cwd,
    observedTools: session.observedTools,
    // ADR-0035: `workspace:<id>` is a capability, so the registered ids belong in the catalog the same way
    // discovered definitions do — for `/grants` to list what this session may route to and for `init` to
    // scaffold them. Read live rather than cached at load, because the registry is an operator file.
    registryPath: process.env[ENV_WORKSPACE_REGISTRY],
  });
  session.catalog = await session.catalogReady;
}
export function createGrantsSession(
  extensionPath: string | undefined,
  lifecycle?: ReloadLifecycle,
  observerExtensionPath?: string,
): GrantsSession {
  // ADR-0076 PR 3b: legacy PI_GRANTS_* names are adopted BEFORE the first environment read and before the
  // reload snapshot, or an operator on the old names would get an ungoverned wildcard root (review finding).
  const adoptedLegacyEnv = adoptLegacyEnvironment(process.env);
  const started = lifecycle ? undefined : beginExtensionLifecycle();
  const activeLifecycle = lifecycle ?? started!.lifecycle;
  const environment = lifecycle ? process.env : started!.environment;
  const activityRootId = activeLifecycle.activityRootId ?? randomUUID();
  activeLifecycle.activityRootId = activityRootId;
  // Local governance is on unless PI_DADDY_GOVERNANCE opts out; explicit inherited grants still win.
  // The factory precedes ctx, so its cwd/store identity is reconciled at session_start.
  const grantRaw = environment[ENV_GRANT];
  const storeCwd = process.cwd();
  // One root-only store read supplies both decisions made by `/grants init`. A child always has ENV_GRANT,
  // so it cannot activate a ledger merely because its routed cwd happens to have a v2 store (ADR-0037).
  const storedState = storedGrantSessionState(grantRaw, storeCwd);
  const governanceOff = environment[ENV_GOVERNANCE]?.trim() === "off" || environment[ENV_GOVERNANCE]?.trim() === "0";
  const governed = governanceOff ? false : true;
  const inherited = governanceOff ? storedState.inherited : storedState.governed ? storedState.inherited : [WILDCARD];
  const grantStoreRefusal = storedState.refusal;
  const ledgerRaw = environment[ENV_LEDGER];
  // Capture provenance before publishChildEnv writes this session's derived default into process.env. A later
  // `/grants init` for ctx.cwd must not mistake our own publication for an operator override.
  const ledgerFromEnvironment = ledgerRaw !== undefined;
  const storedLedger = storedState.defaultLedger;
  // G7 / A-S4 + B-I4: strict, three-way parsing that fails CLOSED. A malformed bound used to yield
  // `NaN`, and every comparison against `NaN` is false, so depth limiting switched itself off.
  const bounds = depthConfig(environment[ENV_DEPTH], environment[ENV_MAX_DEPTH]);
  const { depth, maxDepth } = bounds;
  const emptyCatalog = makeCatalog([]);
  const session: GrantsSession = {
    adoptedLegacyEnv,
    governed,
    inherited,
    depth,
    maxDepth,
    malformedBounds: bounds.malformed,
    // ADR-0012: `bash` is gated by DEFAULT — but only in a governed session. An ungoverned one
    // (no PI_DADDY_GRANT) still blocks nothing, so "governance is opt-in" holds exactly where it always
    // did. Inside a session the operator already chose to govern, handing a child `bash` hands it an
    // ungoverned-descendant escape hatch, and doing that silently is what changes here.
    // `PI_DADDY_GATED=""` turns the default off; absent and empty are deliberately distinguishable.
    gated: governed ? gatedFromEnv(environment[ENV_GATED]) : parseList(environment[ENV_GATED]),
    // Presence wins, including an explicitly empty value for a one-run opt-out. The store is eligible only
    // when ENV_GRANT was absent above, preserving the environment as the child's single authority channel.
    ledgerPath: ledgerRaw !== undefined ? ledgerRaw : storedLedger,
    ledgerFromEnvironment,
    // The un-probed reading. `resolveExecutor` replaces it at session start; until then a `1` already reads as
    // a refusal, which is the safe direction — a delegation that somehow ran before the probe would refuse
    // rather than quietly use the wrong executor.
    executor: chooseExecutor(environment[ENV_HERDR], null),
    // `ownSpawnId` comes from the parent (F8), so ids form one tree across process boundaries instead of
    // every level restarting at `d0` and the ledger becoming unjoinable.
    ownSpawnId: environment[ENV_PARENT_ID]?.trim() || `d${depth}`,
    ownExecutionId: environment[ENV_EXECUTION_ID]?.trim() || undefined,
    // The cardinality bound ADR-0008 never had: it attenuates downward like depth, so a subtree can never
    // create more descendants than its root was given — with no shared state, no lock and no counter file.
    fanoutBudget: budgetFromEnv(environment[ENV_FANOUT]),
    /**
     * Review finding S-5, fixed. The comment on the tools has always claimed conditional registration; the
     * call was unconditional, `DELEGATE_CAPABILITY` was imported and never used, and "withhold it and the
     * child is a leaf" was simply untrue on this path.
     *
     * Provisional before owner binding; session_start recomputes it from that owner's root before activation.
     */
    mayDelegate: !governed || inherited.includes(DELEGATE_CAPABILITY) || inherited.includes(WILDCARD),
    ownerBound: false,
    allowUnresolvedModels: environment[ENV_ALLOW_UNRESOLVED_MODELS] === "1",
    nativeSessionRoot: nativeSessionRootFromEnv(process.env),
    modelResolutionCache: new Map<string, boolean>(),
    extensionPath,
    observerExtensionPath,
    activityRootId,
    variantRuns: new Map(),
    reloadLifecycle: activeLifecycle,
    sessionApprovals: new Set<string>(),
    sessionApprovalBindings: new Map<string, ApprovalBinding>(),
    inheritedApprovals: parseInherited(environment[ENV_APPROVED]),
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
      observerExtensionPath: session.observerExtensionPath,
      childEnv: activityChildEnv(session.activity),
      catalog: await session.catalogReady,
      // R-32: where each granted skill lives, so `planSpawn` can pass `--skill` for those and only those.
      // Derived from the catalog's own `source`, so it cannot drift from what was discovered.
      skillPaths: skillPathsFromCatalog(await session.catalogReady),
      // ADR-0016: operator-authored SKILL.md definitions, so `delegate({agent})` can name one.
      definitions: session.definitions,
      // The herdr executor drives the child after starting it, so its plan must NOT carry `--print`.
      // Threaded through the plan rather than patched afterwards: the argv is what the ledger records, and
      // an executor quietly rewriting it would make the record describe a spawn that did not happen.
      //
      // Read live off `session.executor` (ADR-0031) rather than a boolean captured in the factory: the probe
      // has not run when this session object is built, so a captured value would plan `--print` for a session
      // that turns out to use panes — and `runHerdrPane` refuses a plan containing `--print` by design.
      interactive: session.executor.kind === "herdr",
      ...(approved ? { approved } : {}),
    }),
    storeCwd,
    ...(grantStoreRefusal ? { grantStoreRefusal } : {}),
    adoptGrant: (grant: Capability[], projectLedger?: string) => {
      // Governed too, not just bounded. A session that starts with no grant and then runs `/grants init` is
      // governed from that moment: every spawn is bounded by what was just stored. Leaving this false made
      // `/grants` print "inactive" while holding thirteen capabilities — a status line contradicting the
      // enforcer, which is the defect R-28 is named for.
      session.governed = true;
      session.ownGrant = grant;
      // An environment ledger remains the explicit answer. Otherwise init's v2 choice becomes live now,
      // before publishChildEnv gives the same absolute path to descendants.
      if (!session.ledgerFromEnvironment && projectLedger !== undefined) {
        session.ledgerPath = projectLedger;
      }
      session.publishChildEnv();
    },
    reconcileEnvironment: (environment, lifecycle) => reconcileSessionEnvironment(session, environment, lifecycle),
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
      // Clear omitted fields: another owner's provenance must never reach this session's children.
      for (const key of GRANT_ENV_KEYS) delete process.env[key];
      for (const [key, value] of Object.entries(env)) process.env[key] = value;
      rememberChildPublication(session.reloadLifecycle);
    },
  };
  return session;
}
