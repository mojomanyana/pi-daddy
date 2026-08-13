/**
 * Persistence for `always`-scoped approvals — the package's only mutable state outside the ledger.
 *
 * DESIGN NOTE, because it is easy to get backwards: this file is a CONVENIENCE CACHE, not a security
 * control. The security decision was already made by a human at the moment of approval. So a failure here
 * must never fail the work — an unwritable file downgrades the approval to session scope (see the boolean
 * return of `saveApproval`), and an unreadable one simply grants nothing.
 *
 * Read on demand, never cached at session start, so a revoke takes effect immediately — including one
 * performed from another session while this one is running. (No file locking on read-modify-write,
 * acceptable for a convenience cache; this is advisory-only state backed by real decisions already made.)
 *
 * Pruning is deliberately lazy: `loadApprovals` never writes, so a read is a read. Invalid entries are
 * dropped from the file on the next `saveApproval` or `revokeApproval`.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
 * One file for all projects; entries are scoped by their own `cwd` field, which `entryVerdict` already
 * checks (that check exists for R-27 and now does double duty). A narrowed child does not hold write
 * access to the user's home directory, so it cannot forge an entry here.
 *
 * **This does not defend against a child holding `bash`** — see ADR-0012, which accepts that such a
 * child can escape governance entirely. The point of this change is to close the *self-defeating* case,
 * not to claim a boundary the package does not have.
 *
 * **It took a `cwd` parameter until 0.10.2 and ignored it**, which was not a harmless vestige: the unit
 * suite passed a `mkdtemp` directory to it, reasonably believed the result was hermetic, and spent every
 * `npm test` rewriting and clearing the developer's real store in `$HOME`. That was invisible while the
 * store was unwritable (nothing since 0.7.0 could create an entry) and became destructive the day ADR-0019
 * made it reachable. The parameter is gone so the mistake is unspellable rather than merely fixed.
 */
export function approvalsPath(): string {
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

async function readFileSafely(): Promise<ApprovalFile> {
  try {
    const parsed = JSON.parse(await readFile(approvalsPath(), "utf8")) as unknown;
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
  const file = await readFileSafely();
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
async function writeFileSafely(file: ApprovalFile): Promise<boolean> {
  const path = approvalsPath();
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
 * Entries belonging to OTHER projects, which any write from here must carry through untouched.
 *
 * One file serves every project, so "write back the valid set" was **deleting other projects' approvals**.
 * Measured: approve `tool:bash@deploy` in `/work/api`, then approve anything at all in `/work/web`, and the
 * first entry is not merely ignored in `/work/web` — it is gone from the file, so `/work/api` prompts again.
 * Two active projects turned `always` into *"always, until I approve something anywhere else"*, which is
 * precisely the prompt fatigue ADR-0019 exists to remove.
 *
 * `entryVerdict` checks `cwd` **first**, so a `foreign-cwd` entry has not been evaluated against this
 * session's definitions at all — this session knows nothing about whether it is otherwise valid, and
 * preserving it verbatim is the only honest thing to do with it. Pruning stays limited to entries this
 * session can actually judge dead.
 */
function foreignEntries(dropped: DroppedApproval[]): Record<string, ApprovalEntry> {
  return Object.fromEntries(dropped.filter((d) => d.verdict === "foreign-cwd").map((d) => [d.key, d.entry]));
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
  const { valid, dropped } = await loadApprovals({ cwd, now, snapshotOf });
  valid.set(key, entry);
  // This project's entries win a key collision, which is the best available answer and not a good one:
  // the key is `capability@subject` with no project component, so two projects with a same-named
  // definition (`review`, `deploy` — the common case) still cannot both hold an approval. That is a
  // keyspace defect, not a pruning one, and it needs a decision about the on-disk format.
  return writeFileSafely({ version: 1, approvals: { ...foreignEntries(dropped), ...Object.fromEntries(valid) } });
}

/**
 * Remove one approval, pruning any entries that have since become invalid.
 *
 * Returns false when there was nothing to remove. Like saveApproval, this filters invalid entries
 * so a revoke takes the opportunity to clean up stale entries — the lazy-pruning policy applies
 * to both write paths.
 */
export async function revokeApproval(
  cwd: string,
  key: string,
  snapshotOf: SubjectLookup,
  now: Date,
): Promise<boolean> {
  const { valid, dropped } = await loadApprovals({ cwd, now, snapshotOf });
  if (!valid.has(key)) return false;
  valid.delete(key);
  return writeFileSafely({ version: 1, approvals: { ...foreignEntries(dropped), ...Object.fromEntries(valid) } });
}

/**
 * Clear every approval **for this directory**. Returns false if the write failed.
 *
 * Scoped rather than global, and the old behaviour was the surprising one: `/grants revoke --all` wrote an
 * empty file, so revoking in one project silently revoked every other project's approvals too. An operator
 * running it in one checkout is answering for that checkout — there is no interface for "and everywhere
 * else", and it should not be the default reading of a command that names neither.
 */
export async function revokeAll(cwd: string, snapshotOf: SubjectLookup, now: Date): Promise<boolean> {
  const { dropped } = await loadApprovals({ cwd, now, snapshotOf });
  return writeFileSafely({ version: 1, approvals: foreignEntries(dropped) });
}
