/**
 * The shapes `planDelegation` consumes and produces. Split out of `./delegate.ts` only to stay under the
 * 400-line module ceiling this project enforces mechanically; `./delegate.ts` re-exports all three, so
 * "the delegate module" remains one import for every caller.
 */
import type { Capability, ResolveResult } from "./resolve.ts";
import type { DefinitionDigest, SkillDefinition } from "./definitions.ts";
import type { InheritableApproval } from "./approval.ts";
import type { Catalog } from "./catalog.ts";
import type { ApprovalBinding, CorrelationMetadata } from "./correlation.ts";
import type { StructuredRefusal } from "./refusals.ts";
import type { ExecutorKind } from "./executor.ts";

export interface DelegationRequest {
  task: string;
  /**
   * Capabilities the delegator wants the child to hold.
   *
   * Optional since ADR-0016: prefer `agent`, which names an operator-authored definition. This form
   * lets the MODEL choose the capability set, which is the weaker arrangement — it is still bounded by
   * the session grant (ADR-0008), so it cannot escalate, but nothing about it was reviewed by a human.
   */
  tools?: string[];
  /**
   * Name of a `SKILL.md` definition to spawn (ADR-0016).
   *
   * When given, the definition's `allowed-tools` is the ceiling and its body is the child's system
   * prompt. The model chooses only *which* definition and *what* task; the capability set is the
   * operator's, written down in a file.
   */
  agent?: string;
  model?: string;
  provider?: string;
  thinking?: string;
  /** Optional external join metadata. It never participates in capability authority. */
  correlation?: CorrelationMetadata;
  /**
   * Trusted binding scope, supplied by the caller that actually resolved and leased the
   * workspace. Deliberately separate from `correlation`, whose values are a model-supplied
   * claim: reading the workspace id out of correlation let a bound approval be spent outside
   * the workspace it named (R-110).
   */
  boundWorkspaceId?: string;
  boundContextId?: string;
}

export interface DelegationContext {
  ownGrant: Capability[];
  depth: number;
  maxDepth: number;
  gated: Capability[];
  /**
   * Approvals in force for this delegation, with subject and scope (ADR-0014).
   *
   * One source of truth for two different questions. The **gate check here** honours every entry,
   * including `once` — that approval applies to *this* spawn, which is exactly what the human said yes
   * to. What crosses to the CHILD is `inheritApprovals`, which drops `once` and keeps the subject, so
   * the same list cannot silently authorise a subtree.
   */
  approved?: InheritableApproval[];
  ledgerPath?: string;
  /** Path to this extension, so a child granted `tool:delegate` can delegate in turn. */
  extensionPath?: string;
  /** Live capability catalog. When supplied, capabilities absent from it are refused as unknown. */
  catalog?: Catalog;
  /**
   * Absolute path per skill NAME, from the catalog's `source` field (R-32).
   *
   * Without it every granted `skill:` capability is unresolvable and the delegation is refused, which
   * is the correct direction: a caller that cannot say where a skill lives cannot honestly grant it.
   */
  skillPaths?: Record<string, string>;
  /** Let the child load `AGENTS.md` / `CLAUDE.md`. Default false — see `planSpawn`. */
  contextFiles?: boolean;
  /** Known `SKILL.md` definitions by name, for `DelegationRequest.agent` (ADR-0016). */
  definitions?: Map<string, SkillDefinition>;
  /**
   * Build an INTERACTIVE plan — no `--print` — for an executor that drives the child after starting it.
   *
   * `runHerdrPane` requires this: `--print` makes pi process the prompt and exit, so it never reaches the
   * interactive readiness `herdr agent start` waits for and the agent is never detected. Default is the
   * non-interactive plan, because a governed child should not sit waiting for a human by accident.
   */
  interactive?: boolean;
  /**
   * Total descendants this session may still create (`src/fanout.ts`). Split among children by the caller.
   *
   * Omitted means unbounded, which is the pre-fan-out behaviour and correct for a single blocking
   * delegation — the accident that used to bound cardinality to one.
   */
  fanoutBudget?: number;
  /** This session's ledger id, so a child's `parentId` names its real parent (F8). */
  spawnId?: string;
  /** Ledger id assigned to THIS child, distinguishing it from its siblings (F8). */
  childSpawnId?: string;
}

export interface Delegation {
  ok: boolean;
  reason?: string;
  /** Stable machine-readable refusal accompanying the unchanged human diagnostic. */
  refusal?: StructuredRefusal;
  args: string[];
  /** Per-child environment — never merged into the parent's process.env. */
  env: Record<string, string>;
  effective: Capability[];
  /**
   * The result this plan was made from. **Required** (B-I3): while it was optional the extension
   * guarded its ledger write with `if (ledgerPath && plan.result)`, silently dropping every refusal
   * that returned before `resolve()` ran. The type is what keeps a new early exit auditable.
   */
  result: ResolveResult;
  childDepth: number;
  /**
   * The capabilities this delegation asked for, whatever route named them.
   *
   * Carried on the plan rather than re-derived by the caller (the B-I3 lesson): with `agent`, the
   * request names a DEFINITION and the capabilities come from its `allowed-tools`, so a ledger that
   * read the tool parameters would record an empty request for every definition spawn.
   */
  requested: Capability[];
  /** Ledger id for this child, if the caller assigned one (F8). */
  childId?: string;
  /**
   * Which operator-authored instructions this spawn used (ADR-0018).
   *
   * Absent for a `tools:`-style delegation, which has no definition and therefore no instructions to
   * identify — and absent on an ADR-0017 authorisation refusal, which is decided before the file is read.
   */
  definitionDigest?: DefinitionDigest;
  /** Trusted SHA-256 of the exact model-authored task. The task text itself is never stored. */
  taskDigest: string;
  /** Non-authoritative external join metadata, snapshotted at planning time. */
  correlation?: CorrelationMetadata;
  /** Exact approval scope, present when correlation/workspace context requested task-bound approval. */
  approvalBinding?: ApprovalBinding;
}

/**
 * Plan a governed delegation. Pure: returns argv and env, spawns nothing.
 *
 * Fails closed on depth, on any requested capability the delegator does not hold, on gated capabilities
 * without approval, and on a grant that cannot narrow (a universal capability slipping through).
 */
