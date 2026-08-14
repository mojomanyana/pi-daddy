/**
 * Persistence for `always`-scoped approvals — the package's only mutable state outside the ledger.
 *
 * DESIGN NOTE, because it is easy to get backwards: this file is a CONVENIENCE CACHE, not a security
 * control. The security decision was already made by a human at the moment of approval. So a failure here
 * must never fail the work — an unwritable file downgrades the approval to session scope (see the boolean
 * return of `saveApproval`), and an unreadable one simply grants nothing.
 *
 * Read on demand, never cached at session start, so **a revoke takes effect at the next gate check** —
 * including a revoke performed from another session while this one is running.
 *
 * That sentence used to read *"takes effect immediately"* and claimed two different things, one of which was
 * false and one of which is impossible:
 *
 *  - **False, and fixed (R-49).** Every write is load → modify → write and it was unlocked, so a save could
 *    restore an entry another session had just revoked. Writes now hold the same file lock the ledger uses
 *    (`src/file-lock.ts`, `underLock` below).
 *  - **Impossible, and stated rather than fixed.** A spawn whose gate check has already passed is not
 *    retracted by a revoke arriving microseconds later. No lock closes that: the read has to finish before
 *    the spawn starts, so there is always an instant where the decision is made and the process is not yet
 *    running. Inherent to revoking anything, not a gap in this one.
 *
 * Reads deliberately take no lock. A read that loses a race sees the previous state, which is exactly what
 * "at the next gate check" already means.
 *
 * **One file per project** (ADR-0020), and **no model-authored text, ever** (ADR-0021) — see `approvalsPath`
 * and `sanitise` for why each of those is a decision rather than a detail.
 *
 * Pruning is deliberately lazy: `loadApprovals` never writes, so a read is a read. Invalid entries are
 * dropped from the file on the next `saveApproval` or `revokeApproval`.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { LockTimeoutError, withFileLock } from "./file-lock.ts";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { entryVerdict, type ApprovalEntry, type EntryVerdict, type SubjectSnapshot } from "./approval.ts";

interface ApprovalFile {
  version: 1;
  approvals: Record<string, ApprovalEntry>;
}

export interface DroppedApproval {
  key: string;
  entry: ApprovalEntry;
  verdict: EntryVerdict;
}

/**
 * Look up a subject's current ceiling AND body digest; null when the subject no longer exists.
 *
 * One snapshot rather than two callbacks (ADR-0019) — see `SubjectSnapshot`. Was `CeilingLookup`, which
 * could only ever answer half the question `entryVerdict` needs to ask.
 */
export type SubjectLookup = (subject: string) => SubjectSnapshot | null;

/**
 * Where persisted approvals live — **outside the governed workspace** (ADR-0014).
 *
 * It used to be `<cwd>/.pi/grants-approvals.json`, which was self-defeating in this package's own
 * recommended configuration: `PI_GRANTS_GATED=tool:write` means *"may use write, may not pass it down
 * without a human"*, and **a session that may use `write` can write the approvals file**. A reviewer
 * demonstrated it end to end, including authoring a matching agent-type file so `grantAtApproval`
 * compared equal — no dialog, and a ledger line reading `approvalSource: "persisted"`, indistinguishable
 * from a real human approval.
 *
 * A narrowed child does not hold write access to the user's home directory, so it cannot forge an entry
 * here. Each entry still carries its own `cwd` and `entryVerdict` still checks it — that check exists for
 * R-27 and refuses an entry copied between checkouts or machines, which per-project files do not make
 * redundant.
 *
 * **This does not defend against a child holding `bash`** — see ADR-0012, which accepts that such a
 * child can escape governance entirely. The point of this change is to close the *self-defeating* case,
 * not to claim a boundary the package does not have.
 *
 * **ONE FILE PER PROJECT since 0.11.0 (ADR-0020).** It was one shared document keyed only by
 * `capability@subject`, which produced four defects in eight lines — approving in one checkout deleted
 * another's entries (R-41), `revoke --all` cleared every project (R-43), two concurrent writes lost both
 * (R-42), and an unlocked read-modify-write could resurrect a revoked entry (R-49, fixed in 0.13.0). The
 * unfixable one was the keyspace: two checkouts holding definitions of the same name — `review`, `deploy`,
 * i.e. what happens the moment an operator reuses their own conventions — could not both hold an approval,
 * so they took turns indefinitely. Per-project files make the collision **inexpressible** rather than
 * handled, and `revoke --all` cannot name another project's file.
 *
 * The `cwd` is hashed as well as named: the basename keeps the file legible to a human reading the
 * directory, and the hash is what makes it unambiguous, since two checkouts can share a basename.
 *
 * **It took a `cwd` parameter and ignored it until 0.10.2**, which was not a harmless vestige: the unit
 * suite passed a `mkdtemp` directory to it, reasonably believed the result was hermetic, and spent every
 * `npm test` rewriting and clearing the developer's real store in `$HOME` (R-40). That was invisible while
 * the store was unwritable and became destructive the day ADR-0019 made it reachable. The parameter is now
 * real and required, which is the opposite failure mode: forgetting it is a type error.
 */
export function approvalsPath(cwd: string): string {
  const slug = (basename(cwd) || "root").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  // 16 hex = 64 bits, not the 6 this shipped with. ADR-0020 deleted the `foreign-cwd` carry-through on the
  // premise that one file means one directory — so inside a hash collision R-41 returns *with its
  // mitigation removed*: the second project's save deletes the first's entries. At 24 bits a deliberate
  // collision costs about 16.7M hashes, well under a second, and an accidental one arrives at a few
  // thousand governed directories. The premise has to be worth what was removed to rely on it.
  const hash = createHash("sha256").update(cwd, "utf8").digest("hex").slice(0, 16);
  return join(agentDir(), "grants-approvals", `${slug}-${hash}.json`);
}

/**
 * The shared single-file store, so it can be REPORTED rather than read (ADR-0020).
 *
 * Deliberately not migrated. Splitting it by each entry's own `cwd` would be mechanical and lossless — the
 * trust root is unchanged, unlike ADR-0014's move out of the workspace — but it is code that runs once, is
 * exercised on exactly one input per machine, and lives in the layer with nine recorded defects. Re-approving
 * costs a click; a migration bug costs a silently wrong approval.
 */
export function sharedApprovalsPath(): string {
  return join(agentDir(), "grants-approvals.json");
}

/**
 * The old in-workspace location, so it can be REPORTED rather than read.
 *
 * Deliberately not migrated. Importing a legacy file would import exactly the entries whose
 * trustworthiness this change exists to remove — a forged approval would survive the fix that was
 * supposed to stop it. The extension names the file and ignores it; re-approving is a few keystrokes and
 * the only honest path.
 */
export function legacyApprovalsPath(cwd: string): string {
  return join(cwd, ".pi", "grants-approvals.json");
}

/** `$PI_CODING_AGENT_DIR`, or pi's default. Matches how pi-subagents resolves the same directory. */
function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** The subject half of `capability@subject`. Capability ids contain `:` but never `@`. */
function subjectOf(key: string): string {
  return key.slice(key.indexOf("@") + 1);
}

/** Guard: reject entries that don't have the shape of an ApprovalEntry. */
function isValidEntryShape(entry: unknown): entry is ApprovalEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const obj = entry as Record<string, unknown>;
  return (
    typeof obj.approvedAt === "string" &&
    typeof obj.expiresAt === "string" &&
    typeof obj.cwd === "string" &&
    Array.isArray(obj.grantAtApproval)
  );
}

/**
 * Project every entry through its DECLARED fields on the way out (ADR-0021).
 *
 * The instance this closes: `taskAtApproval` stored the model-authored task string, which `src/ledger.ts`
 * forbids in unqualified terms — *"the task is not recorded, anywhere, ever"*. Removing the field from the
 * type is not enough on its own, because entries are parsed from JSON and a rewrite would carry any
 * undeclared property straight back to disk.
 *
 * A whitelist rather than a delete, so this closes the class: no future field can reach the store by being
 * present on a parsed object, and adding one is a deliberate edit here.
 */
function sanitise(valid: Map<string, ApprovalEntry>): Record<string, ApprovalEntry> {
  return Object.fromEntries(
    [...valid].map(([key, e]) => [
      key,
      {
        approvedAt: e.approvedAt,
        expiresAt: e.expiresAt,
        cwd: e.cwd,
        grantAtApproval: e.grantAtApproval,
        ...(e.bodyAtApproval !== undefined ? { bodyAtApproval: e.bodyAtApproval } : {}),
      },
    ]),
  );
}

async function readFileSafely(cwd: string): Promise<ApprovalFile> {
  try {
    const parsed = JSON.parse(await readFile(approvalsPath(cwd), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return { version: 1, approvals: {} };
    const file = parsed as Partial<ApprovalFile>;
    if (file.version !== 1 || !file.approvals || typeof file.approvals !== "object") {
      return { version: 1, approvals: {} };
    }
    return { version: 1, approvals: file.approvals };
  } catch {
    // Missing is normal; corrupt grants nothing. Either way the caller re-prompts, which is safe.
    return { version: 1, approvals: {} };
  }
}

export interface LoadApprovalsInput {
  cwd: string;
  now: Date;
  snapshotOf: SubjectLookup;
}

/** Load the approvals valid HERE and NOW, plus the ones that were dropped and why. */
export async function loadApprovals(
  input: LoadApprovalsInput,
): Promise<{ valid: Map<string, ApprovalEntry>; dropped: DroppedApproval[] }> {
  const file = await readFileSafely(input.cwd);
  const valid = new Map<string, ApprovalEntry>();
  const dropped: DroppedApproval[] = [];

  for (const [key, entry] of Object.entries(file.approvals)) {
    // Validate entry shape before passing to entryVerdict. Malformed entries cannot take valid ones
    // with them — one bad shape means that one entry is dropped, the rest are still evaluated.
    if (!isValidEntryShape(entry)) {
      dropped.push({ key, entry: entry as ApprovalEntry, verdict: "expired" });
      continue;
    }

    const verdict = entryVerdict({
      entry,
      cwd: input.cwd,
      now: input.now,
      current: input.snapshotOf(subjectOf(key)),
    });
    if (verdict === "valid") valid.set(key, entry);
    else dropped.push({ key, entry, verdict });
  }

  return { valid, dropped };
}

/**
 * Write the file atomically, and never through a symlink (ADR-0014).
 *
 * Two defects this closes:
 *
 *  - **B-I6** — writes followed project-controlled symlinks and were not atomic, so a crash or a
 *    concurrent writer could leave a half-written file that the next read discards entirely.
 *  - **A-R2** — a corrupt file made the next legitimate write destroy every other entry, because entries
 *    are validated on read but pruned only on write. Writing to a temp file and renaming makes the
 *    replacement all-or-nothing; `wx` on the temp refuses to follow an existing link.
 *
 * `rename` is atomic within a filesystem, and the temp file is created in the same directory precisely so
 * that holds.
 */
async function writeFileSafely(cwd: string, file: ApprovalFile): Promise<boolean> {
  const path = approvalsPath(cwd);
  // Same directory as the target: `rename` is only atomic within one filesystem.
  //
  // **Unique per CALL, not per process.** It was `${path}.${pid}.tmp`, so two concurrent `saveApproval`
  // calls in one process collided: the second's `wx` failed EEXIST, its `catch` unlinked the *first's*
  // in-flight temp, and the first's `rename` then failed ENOENT — **both returned false and nothing was
  // written**, on a perfectly writable file. Measured with two different keys, so it was not limited to
  // the shared-dialog case: any two concurrent writes lost both. `delegate_all` is exactly that shape, and
  // both callers would report "could not persist the approval — it applies for this session only", which
  // named the wrong cause.
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    // `wx` fails rather than following a pre-existing symlink or clobbering another writer's temp.
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temp, path);
    return true;
  } catch {
    try {
      await unlink(temp);
    } catch {
      /* nothing to clean up */
    }
    return false;
  }
}

/**
 * Persist one approval, pruning anything THIS session can see has become invalid.
 *
 * Returns false when the write failed. The caller must then downgrade to session scope and warn — NOT
 * refuse the delegation. The human already said yes; refusing work because a cache could not be written
 * would be failing closed on the wrong thing.
 */
export async function saveApproval(
  cwd: string,
  key: string,
  entry: ApprovalEntry,
  snapshotOf: SubjectLookup,
  now: Date,
): Promise<boolean> {
  return underLock(cwd, false, false, async () => {
    const { valid } = await loadApprovals({ cwd, now, snapshotOf });
    valid.set(key, entry);
    // ADR-0020: this file belongs to ONE project, so there is nothing here that another project could own and
    // pruning cannot reach across a boundary. The `foreign-cwd` carry-through 0.10.2 needed is gone with the
    // shared file that made it necessary.
    return writeFileSafely(cwd, { version: 1, approvals: sanitise(valid) });
  });
}

/**
 * Remove one approval, pruning any entries that have since become invalid.
 *
 * Like `saveApproval`, this filters invalid entries so a revoke takes the opportunity to clean up stale
 * ones — the lazy-pruning policy applies to both write paths.
 *
 * **Three outcomes, not two (R-49).** It returned a boolean, and the caller printed
 * *"no persisted approval named X"* for false — which was a **false statement** whenever the cause was a
 * failed write. An operator told there is nothing to revoke, while the approval they are revoking survives,
 * has been told the opposite of the truth about a security control. `"absent"` and `"failed"` are different
 * facts and now say so.
 */
/**
 * **Four, and the fourth is the first fix's own smaller copy of R-61.** `failed` asserts the approval is
 * still in effect, which is verified: we found the entry and could not remove it. A **lock timeout happens
 * before the load**, so nothing was ever looked at — reporting `failed` there asserted a fact about an entry
 * that may not exist, which is R-61's shape at lower severity. It errs alarming rather than reassuring, so
 * it is the safe direction to be wrong in; that is a reason to rank it low, not a reason to keep it.
 */
export type RevokeOutcome = "revoked" | "absent" | "failed" | "busy";

export async function revokeApproval(
  cwd: string,
  key: string,
  snapshotOf: SubjectLookup,
  now: Date,
): Promise<RevokeOutcome> {
  return underLock<RevokeOutcome>(cwd, "busy", "failed", async () => {
    const { valid } = await loadApprovals({ cwd, now, snapshotOf });
    if (!valid.has(key)) return "absent";
    valid.delete(key);
    return (await writeFileSafely(cwd, { version: 1, approvals: sanitise(valid) })) ? "revoked" : "failed";
  });
}

/**
 * Clear every approval **for this directory**. Returns false if the write failed.
 *
 * Scoped rather than global, and the old behaviour was the surprising one: `/grants revoke --all` wrote an
 * empty file, so revoking in one project silently revoked every other project's approvals too. An operator
 * running it in one checkout is answering for that checkout — there is no interface for "and everywhere
 * else", and it should not be the default reading of a command that names neither.
 */
export async function revokeAll(cwd: string): Promise<boolean> {
  return underLock(cwd, false, false, () => writeFileSafely(cwd, { version: 1, approvals: {} }));
}

/**
 * Hold the store's lock for one read-modify-write (R-49).
 *
 * **The race it closes.** Every write here is load → modify → write, and it was unlocked, so: session 1
 * loads; session 2 revokes; session 1 saves an unrelated approval and **restores the revoked entry** for the
 * rest of its 30 days, with no error and no warning. `approval-store.ts` documents that *"a revoke takes
 * effect immediately — including one performed from another session while this one is running"*, and that
 * sentence was false. Narrow (ADR-0020 scoped it to two sessions in the same directory) and cheap to close,
 * because the lock already existed for the ledger — `src/file-lock.ts`, one implementation, two callers.
 *
 * **A lock this cannot take does NOT fail the work**, which is the opposite of the ledger's choice with the
 * same lock and follows from what the two files are. The ledger is a security control: no audit line, no
 * spawn. This store is a convenience cache (ADR-0020) — the human already said yes, and refusing their work
 * because a cache was busy would be failing closed on the wrong thing. So a timeout yields `busy`, which the
 * caller reports as an ordinary write failure and downgrades to session scope.
 */
async function underLock<T>(cwd: string, onBusy: T, onError: T, work: () => Promise<T>): Promise<T> {
  const path = approvalsPath(cwd);
  try {
    // The lock lives beside the file, so its directory must exist before the lock can be taken — and on a
    // first-ever approval it does not. `writeFileSafely` creates it, which is one step too late: every
    // write failed with ENOENT on the LOCK and was reported as busy. Caught by the existing round-trip
    // tests within a minute of adding the lock, which is the argument for having them.
    await mkdir(dirname(path), { recursive: true });
    return await withFileLock(path, "approvals file", work);
  } catch (error) {
    // **The two are not the same fact**, which is why `LockTimeoutError` has its own type. "Another session
    // holds the lock" is transient and says nothing about the file; "the lock could not be created at all"
    // (EROFS, a directory replaced by a file) is a real write failure. Reporting the second as the first
    // would tell an operator to retry something that will never succeed. `work` itself never throws — both
    // write paths swallow into their own value — so everything landing here is one of these two.
    return error instanceof LockTimeoutError ? onBusy : onError;
  }
}
