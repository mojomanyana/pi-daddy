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

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { withFileLock } from "./file-lock.ts";
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

// R-49: the lock moved to `src/file-lock.ts` so the approvals store could use the SAME one rather than
// grow a second copy. Re-exported because `./ledger` is a published subpath and these were part of it.
export { LOCK_TIMEOUT_MS, STALE_LOCK_MS } from "./file-lock.ts";

/**
 * Serialise appends across processes.
 *
 * **Why the ledger needs it.** For most of this package's life cardinality was bounded to one by `delegate`
 * being blocking, so there was never a second writer. Fan-out removes that: `ENV_LEDGER` propagates to
 * children, so a subtree can have many processes appending to one file.
 *
 * A ledger write that cannot take the lock **fails the delegation closed** — see `appendRecord`'s `strict`
 * — because a child running with granted capabilities and no audit line is what the ledger exists to
 * prevent. That is the opposite of what the approvals store does with the same lock, and deliberately so.
 */
const withLedgerLock = <T>(path: string, write: () => Promise<T>): Promise<T> =>
  withFileLock(path, "grant ledger", write);

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
  /**
   * Where the yes came from, per approved capability, tallied across the whole ledger.
   *
   * **This is the measurement ADR-0020 asks for.** That ADR keeps the persistence layer on R-25's fatigue
   * argument with *no number behind it*, and named the evidence that would settle it: counting `persisted`
   * against `prompt` over a few weeks of real use. It also said this "needs no new machinery" — true of the
   * data and false of the answer, which required hand-written `jq`. Same shape as R-51: a field no tool
   * reads becomes decoration, and a measurement nobody can run does not get run.
   *
   * **`bySource` counts RECORDS and is an upper bound, not an answer.** Deleting the persistence layer does
   * not turn every `persisted` record back into a prompt: precedence is `inherited → session → persisted →
   * prompt`, and `session` approvals live in memory and do not depend on the store at all. So a session that
   * spawns `deploy` twenty times under one persisted entry writes twenty `persisted` records, while without
   * the store it would raise **one** prompt and satisfy the other nineteen from the session cache. Reporting
   * twenty prompts avoided would overstate the layer's value twentyfold, on the one number that decides
   * whether to keep it — the same direction of bias `unattributed` exists to avoid, arrived at a different way.
   *
   * `distinctBySource` is the closer estimate: distinct `capability@subject` pairs, which bounds the cost of
   * deletion at one prompt per pair per session. The ledger carries no session id, so the exact figure is not
   * computable from it; both numbers are printed and labelled rather than one being presented as the truth.
   *
   * Counted from `approvalSources` **only**. `approvalSource` is deliberately not used as a fallback: before
   * 0.11.1 that scalar was written for the whole set even when the sources differed (R-46), so folding it in
   * would report humans as having been asked about capabilities they were never asked about — biasing the
   * one direction this measurement must not be biased in. Those records are counted as `unattributed`
   * instead, so the sample size is visible rather than silently smaller.
   */
  approvals: {
    /** Raw record counts. An UPPER bound on prompts avoided — see above before quoting one. */
    bySource: Record<ApprovalSource, number>;
    /** Distinct `capability@subject` pairs per source. The closer estimate. */
    distinctBySource: Record<ApprovalSource, number>;
    /** Records carrying approvals from before per-capability sources existed. Not attributable; see above. */
    unattributed: number;
    /** Records where a human was asked and said no — the fatigue argument's other half. */
    humanDenied: number;
  };
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
      return {
        exists: false,
        records: 0,
        corrupt: [],
        escalationAttempts: 0,
        definitions: [],
        approvals: {
          bySource: { prompt: 0, session: 0, persisted: 0, inherited: 0 },
          distinctBySource: { prompt: 0, session: 0, persisted: 0, inherited: 0 },
          unattributed: 0,
          humanDenied: 0,
        },
        ok: true,
      };
    }
    throw error;
  }

  const corrupt: Array<{ line: number; text: string }> = [];
  // Keyed by name+digest: one name with two entries is the signal that the definition changed mid-ledger.
  const digests = new Map<string, { name: string; source: string; sha256: string; spawns: number }>();
  let records = 0;
  let escalationAttempts = 0;
  const bySource: Record<ApprovalSource, number> = { prompt: 0, session: 0, persisted: 0, inherited: 0 };
  // `capability@subject` seen per source, so the report can state a bound as well as a raw count.
  const distinct: Record<ApprovalSource, Set<string>> = {
    prompt: new Set(),
    session: new Set(),
    persisted: new Set(),
    inherited: new Set(),
  };
  let unattributed = 0;
  let humanDenied = 0;

  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    // A trailing newline yields one empty final element, which is normal rather than damage.
    if (raw.trim().length === 0) return;
    try {
      const parsed = JSON.parse(raw) as GrantRecord;
      if (!Array.isArray(parsed.denied)) throw new Error("not a grant record");
      records += 1;
      if (isEscalationAttempt(parsed)) escalationAttempts += 1;
      if (parsed.humanDenied) humanDenied += 1;
      const sources = parsed.approvalSources;
      if (sources && typeof sources === "object") {
        // The approval's subject: a definition spawn is keyed to the definition, everything else to
        // `<delegate>` — the same keying `approvalKey` uses, so the pair count means what a reader expects.
        const subject = parsed.agentType ?? "<delegate>";
        for (const [capability, source] of Object.entries(sources)) {
          // An unrecognised source is counted as unattributed rather than dropped: a tally that silently
          // ignores what it does not understand reports a smaller sample as a cleaner one.
          if (source in bySource) {
            bySource[source] += 1;
            distinct[source].add(`${capability}@${subject}`);
          } else unattributed += 1;
        }
      } else if (parsed.approved && parsed.approved.length > 0) {
        unattributed += parsed.approved.length;
      }
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
    approvals: {
      bySource,
      distinctBySource: {
        prompt: distinct.prompt.size,
        session: distinct.session.size,
        persisted: distinct.persisted.size,
        inherited: distinct.inherited.size,
      },
      unattributed,
      humanDenied,
    },
    ok: corrupt.length === 0,
  };
}

/** True when this record shows an agent asking for more than it holds. */
export function isEscalationAttempt(record: GrantRecord): boolean {
  return record.denied.length > 0;
}
