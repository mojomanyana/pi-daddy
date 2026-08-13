/**
 * Append-only grant ledger.
 *
 * Exists because pi-fabric's persisted execution trace records `args: {}` — it captures *that* a child
 * ran, not *what it was authorised to do* (docs/probes/pi-fabric-eval probe 5). Without this record
 * you cannot answer "what was this sub-agent permitted to do?" after the fact, which is the whole
 * point of a governance layer.
 *
 * `denied` is the field that earns the file: an agent repeatedly requesting capabilities it does not
 * hold is an escalation attempt, and it is invisible without a record.
 *
 * PRIVACY: capability ids, counts, and identifiers only. Never prompts, tool arguments, or results.
 *
 * ADR-0018 makes the boundary explicit rather than leaving it to be inferred, because a record now carries
 * something about the child's instructions. **`definitionDigest` is an identifier**: a SHA-256 of an
 * operator-authored file already committed to a repository, which names a version without reproducing it.
 * **The task is not recorded, anywhere, ever** — it is assembled by the model from the parent's context and
 * can carry anything the parent could see, so a ledger holding it would be a secrets sink. That half of
 * "what was this child told to do?" is out of the ledger by decision, not by omission.
 */

import { appendFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { Capability, ResolveResult } from "./resolve.ts";
import type { DefinitionDigest } from "./definitions.ts";
import type { ApprovalScope, ApprovalSource } from "./approval.ts";

export interface GrantRecord {
  ts: string;
  parentId: string;
  childId: string;
  depth: number;
  agentType?: string;
  requested: Capability[];
  parentGrant: Capability[];
  effective: Capability[];
  denied: Capability[];
  clipped: Capability[];
  gatedBlocked: Capability[];
  /** True when the spawn was refused outright rather than narrowed. */
  blocked: boolean;
  /** Present when the spawn was refused, or when resolution failed. */
  reason?: string;
  /**
   * Gated capabilities satisfied for this spawn.
   *
   * The ledger used to have ONE flavour of no. It now has three, and they call for different responses:
   *  - `denied` non-empty            -> an agent asked for more than it holds. ESCALATION ATTEMPT.
   *  - `humanDenied`                 -> a person was asked and said no. WORKING AS DESIGNED.
   *  - `gatedBlocked` with no source -> nobody was there to ask. A background run hit a gate; the fix is
   *                                     an operator pre-approving it, not an incident.
   */
  approved?: Capability[];
  approvalSource?: ApprovalSource;
  /**
   * WHERE each approved capability's yes came from — one entry per capability (R-46).
   *
   * `approvalSource` above is a single scalar and was written for a set: gate `tool:bash` and `tool:write`,
   * let a persisted entry cover `bash` while a human clicks *Allow once* for `write`, and the record read
   * `approved: ["tool:bash","tool:write"], approvalSource: "prompt"` — **asserting a human was asked about
   * `tool:bash`, which they were not.** The ledger's whole job is answering "did a human authorise this?",
   * so over-claiming in that direction is the worst available failure.
   *
   * The scalar is kept and is now written **only when every approved capability shares one source**, so a
   * reader of old and new lines alike can trust it; when sources differ it is omitted and this map carries
   * the truth. Two fields, one of which is a safe summary of the other — not two competing answers.
   */
  approvalSources?: Record<Capability, ApprovalSource>;
  /**
   * How far each prompted capability's yes reaches (F5). Same shape and same reason as `approvalSources`:
   * `approvalScope` below is a **derived summary**, emitted only when every prompted capability shares one
   * scope. This field decides propagation — `inheritApprovals` drops `once` — so a scalar that described
   * one capability while claiming to describe the set was not merely a reporting defect.
   */
  approvalScopes?: Record<Capability, ApprovalScope>;
  /** Present only when the source was a live prompt, and only when one scope covers the whole set. */
  approvalScope?: ApprovalScope;
  /** A human was asked and declined. Distinct from `denied`, which is an escalation attempt. */
  humanDenied?: boolean;
  /**
   * WHICH operator-authored instructions this child was given (ADR-0018).
   *
   * Identifies, never reproduces: matching digests prove two children ran the same text, and a digest that
   * no longer matches the file proves the definition changed since. **It says nothing about whether those
   * instructions were correct or whether the child obeyed them** — it identifies text, it does not evaluate
   * it. Absent for a `tools:`-style delegation, which has no definition.
   */
  definitionDigest?: DefinitionDigest;
}

export interface LedgerOptions {
  /** Path to the JSONL file. Parent directories are created on demand. */
  path: string;
  /**
   * When true, a ledger write failure throws instead of being swallowed.
   *
   * Default is `true` and that is deliberate: for a security control, an unrecorded grant should fail
   * closed. Set false only where the ledger is advisory.
   */
  strict?: boolean;
}

export function buildRecord(args: {
  parentId: string;
  childId: string;
  depth: number;
  agentType?: string;
  requested: Capability[];
  parentGrant: Capability[];
  result: ResolveResult;
  blocked: boolean;
  reason?: string;
  approved?: Capability[];
  approvalSources?: Record<Capability, ApprovalSource>;
  approvalScopes?: Record<Capability, ApprovalScope>;
  humanDenied?: boolean;
  definitionDigest?: DefinitionDigest;
  now: Date;
}): GrantRecord {
  // R-46: the scalar is a SUMMARY, emitted only when it cannot mislead. `buildRecord` derives it rather
  // than accepting it, so a call site cannot supply one that disagrees with the map beside it.
  const sources = args.approvalSources ?? {};
  const distinct = [...new Set(Object.values(sources))];
  const scopes = args.approvalScopes ?? {};
  const distinctScopes = [...new Set(Object.values(scopes))];
  return {
    ts: args.now.toISOString(),
    parentId: args.parentId,
    childId: args.childId,
    depth: args.depth,
    agentType: args.agentType,
    requested: args.requested,
    parentGrant: args.parentGrant,
    effective: args.result.effective,
    denied: args.result.denied,
    clipped: args.result.clipped,
    gatedBlocked: args.result.gatedBlocked,
    blocked: args.blocked,
    reason: args.reason,
    ...(args.approved && args.approved.length > 0 ? { approved: args.approved } : {}),
    ...(distinct.length === 1 ? { approvalSource: distinct[0] } : {}),
    ...(Object.keys(sources).length > 0 ? { approvalSources: sources } : {}),
    ...(distinctScopes.length === 1 ? { approvalScope: distinctScopes[0] } : {}),
    ...(Object.keys(scopes).length > 0 ? { approvalScopes: scopes } : {}),
    ...(args.humanDenied ? { humanDenied: true } : {}),
    ...(args.definitionDigest ? { definitionDigest: args.definitionDigest } : {}),
  };
}

/** How long to wait for another writer to finish before giving up. Short: failing closed beats hanging. */
export const LOCK_TIMEOUT_MS = 2000;
/** A lock older than this is treated as abandoned by a killed process and broken. */
export const STALE_LOCK_MS = 10_000;

/**
 * Serialise appends across processes with an exclusive lock file.
 *
 * **Why this exists now.** `O_APPEND` is atomic for one write to a regular file on a POSIX filesystem, and
 * for most of this package's life cardinality was bounded to one by `delegate` being blocking, so there was
 * never a second writer. Fan-out removes that: `ENV_LEDGER` propagates to children, so a subtree can have
 * many processes appending to one file — and the guarantee does **not** hold on drvfs (`/mnt/c` under WSL2)
 * or NFS, which is exactly where this project runs.
 *
 * **A lock introduces its own failure mode and it is handled deliberately.** A process killed while holding
 * the lock would otherwise block every future write forever, so a lock older than `STALE_LOCK_MS` is broken.
 * Two processes can race to break the same stale lock; whichever wins the subsequent exclusive create
 * proceeds, which is correct because only one can.
 *
 * The timeout is short *on purpose*: a delegation refused because the ledger was busy is recoverable and
 * loud, while a delegation that hangs waiting for a lock is neither. Fail closed, and quickly.
 */
async function withLedgerLock<T>(path: string, write: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") throw error;

      // Someone else holds it. Break it only if it is old enough to be abandoned.
      try {
        const held = await stat(lockPath);
        if (Date.now() - held.mtimeMs > STALE_LOCK_MS) await rm(lockPath, { force: true });
      } catch {
        /* it vanished between the check and the stat — the next attempt will simply take it */
      }

      if (Date.now() >= deadline) {
        throw new Error(`grant ledger is locked by another writer (waited ${LOCK_TIMEOUT_MS}ms)`);
      }
      await new Promise((r) => setTimeout(r, 25));
      continue;
    }

    try {
      return await write();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function appendRecord(options: LedgerOptions, record: GrantRecord): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  try {
    await mkdir(dirname(options.path), { recursive: true });
    // O_APPEND alone is not enough once several processes write to one ledger — see `withLedgerLock`.
    await withLedgerLock(options.path, () => appendFile(options.path, line, { encoding: "utf8", flag: "a" }));
  } catch (error) {
    if (options.strict ?? true) {
      throw new Error(`grant ledger write failed (failing closed): ${String(error)}`);
    }
  }
}

export interface LedgerReport {
  /** False when the file is absent — a configuration state, not damage. */
  exists: boolean;
  /** Lines that parsed as records. */
  records: number;
  /** Lines that did not, with 1-based line numbers so the report is actionable. */
  corrupt: Array<{ line: number; text: string }>;
  /** Records where an agent asked for more than it held — ADR-0008's designated signal. */
  escalationAttempts: number;
  /**
   * Every distinct set of instructions this ledger saw run, with how many spawns used it (R-51).
   *
   * ADR-0018 advertises that a record answers *"did these four children run the same instructions?"* and
   * *"has this definition changed since?"* — and until this existed **nothing read `definitionDigest` at
   * all**, so both questions required hand-written `jq` and the second was not even reproducible with
   * `sha256sum`, because the digest covers the body and not the frontmatter. A field no tool reads is a
   * field that quietly becomes decoration.
   *
   * Grouped by `name` + `sha256`, so two entries with one name are exactly the evidence that a definition
   * changed mid-ledger. Sorted by name then digest so two runs of the same fan-out produce a diffable
   * report, like the ids themselves.
   */
  definitions: Array<{ name: string; source: string; sha256: string; spawns: number }>;
  ok: boolean;
}

/**
 * Read the ledger back and report what is wrong with it.
 *
 * **This is the gap that mattered most.** `appendRecord`'s strict mode catches write *errors*, never
 * corruption, and nothing in this package had ever read a ledger back — so a torn line was silently
 * indistinguishable from a spawn that never happened. An audit trail whose damage is invisible is not a
 * compensating control, and ADR-0008 leans on the ledger as exactly that.
 *
 * Deliberately reports rather than repairs. A corrupt line is evidence; rewriting the file to make it parse
 * would destroy the one artifact an investigation has.
 */
export async function verifyLedger(path: string): Promise<LedgerReport> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { exists: false, records: 0, corrupt: [], escalationAttempts: 0, definitions: [], ok: true };
    }
    throw error;
  }

  const corrupt: Array<{ line: number; text: string }> = [];
  // Keyed by name+digest: one name with two entries is the signal that the definition changed mid-ledger.
  const digests = new Map<string, { name: string; source: string; sha256: string; spawns: number }>();
  let records = 0;
  let escalationAttempts = 0;

  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    // A trailing newline yields one empty final element, which is normal rather than damage.
    if (raw.trim().length === 0) return;
    try {
      const parsed = JSON.parse(raw) as GrantRecord;
      if (!Array.isArray(parsed.denied)) throw new Error("not a grant record");
      records += 1;
      if (isEscalationAttempt(parsed)) escalationAttempts += 1;
      const d = parsed.definitionDigest;
      if (d?.name && d.sha256) {
        const key = `${d.name}\u0000${d.sha256}`;
        const seen = digests.get(key);
        if (seen) seen.spawns += 1;
        else digests.set(key, { name: d.name, source: d.source, sha256: d.sha256, spawns: 1 });
      }
    } catch {
      corrupt.push({ line: index + 1, text: raw.slice(0, 120) });
    }
  });

  return {
    exists: true,
    records,
    corrupt,
    escalationAttempts,
    definitions: [...digests.values()].sort((a, b) => a.name.localeCompare(b.name) || a.sha256.localeCompare(b.sha256)),
    ok: corrupt.length === 0,
  };
}

/** True when this record shows an agent asking for more than it holds. */
export function isEscalationAttempt(record: GrantRecord): boolean {
  return record.denied.length > 0;
}
