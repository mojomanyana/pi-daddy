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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { entryVerdict, type ApprovalEntry, type EntryVerdict } from "./approval.ts";
import type { Capability } from "./resolve.ts";

interface ApprovalFile {
  version: 1;
  approvals: Record<string, ApprovalEntry>;
}

export interface DroppedApproval {
  key: string;
  entry: ApprovalEntry;
  verdict: EntryVerdict;
}

/** Look up an agent type's current ceiling by subject; null when the type no longer exists. */
export type CeilingLookup = (subject: string) => Capability[] | null;

export function approvalsPath(cwd: string): string {
  return join(cwd, ".pi", "grants-approvals.json");
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
  ceilingOf: CeilingLookup;
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
      currentCeiling: input.ceilingOf(subjectOf(key)),
    });
    if (verdict === "valid") valid.set(key, entry);
    else dropped.push({ key, entry, verdict });
  }

  return { valid, dropped };
}

async function writeFileSafely(cwd: string, file: ApprovalFile): Promise<boolean> {
  try {
    await mkdir(dirname(approvalsPath(cwd)), { recursive: true });
    await writeFile(approvalsPath(cwd), `${JSON.stringify(file, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist one approval, pruning anything that has since become invalid.
 *
 * Returns false when the write failed. The caller must then downgrade to session scope and warn — NOT
 * refuse the delegation. The human already said yes; refusing work because a cache could not be written
 * would be failing closed on the wrong thing.
 */
export async function saveApproval(
  cwd: string,
  key: string,
  entry: ApprovalEntry,
  ceilingOf: CeilingLookup,
  now: Date,
): Promise<boolean> {
  const { valid } = await loadApprovals({ cwd, now, ceilingOf });
  valid.set(key, entry);
  return writeFileSafely(cwd, { version: 1, approvals: Object.fromEntries(valid) });
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
  ceilingOf: CeilingLookup,
  now: Date,
): Promise<boolean> {
  const { valid } = await loadApprovals({ cwd, now, ceilingOf });
  if (!valid.has(key)) return false;
  valid.delete(key);
  return writeFileSafely(cwd, { version: 1, approvals: Object.fromEntries(valid) });
}

/** Clear all approvals. Returns false if the write failed. */
export async function revokeAll(cwd: string): Promise<boolean> {
  return writeFileSafely(cwd, { version: 1, approvals: {} });
}
