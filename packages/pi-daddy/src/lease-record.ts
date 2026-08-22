/**
 * The lease's RECORD: what a workspace lease writes down about who holds it and how they let it go.
 *
 * Split from `./workspace-lease.ts` to stay under the 400-line module ceiling, along the seam this
 * review round kept finding defects on — absent vs unreadable metadata, a swallowed handover write, a
 * successor's token — all of which are about what the record SAYS rather than about the kernel lock.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ValidatedWorkspace, WorkspaceAccess } from "./workspace.ts";

export interface LeaseMetadata {
  version: 1;
  state: "active" | "released";
  token: string;
  owner_id: string;
  workspace_id: string;
  root: string;
  pid: number;
  acquired_at: string;
  released_at?: string;
  release_reason?: string;
}

export interface WorkspaceLease {
  workspace: ValidatedWorkspace;
  access: WorkspaceAccess;
  ownerId: string;
  /**
   * `true` only when the kernel lock was free but metadata said the prior owner never released.
   * `"unknown"` when the prior owner's record could not be read at all — that is not evidence of a
   * clean handover and must not be recorded as one (R-100).
   */
  recovered: boolean | "unknown";
  /** Attach the governed resource so parent death cleans it before the kernel lock is released. */
  attachProcess(pid: number): void;
  attachHerdrTab(tabId: string): void;
  /** Resolves only when the kernel-lock helper exits before explicit release. */
  lost: Promise<Error>;
  /**
   * NEVER throws. A cleanup function that can throw destroys its caller's return value — a completed
   * child's entire output was discarded this way (R-99) — so the outcome is a VALUE the caller records:
   *   `"released"`            the kernel lock was handed back and the handover recorded;
   *   `"released-unrecorded"` the lock was handed back but the record failed, so the NEXT owner will
   *                           report a recovery that did not happen unless this is ledgered;
   *   `"lost"`                the helper was already gone, so this owner never released anything.
   */
  release(reason?: string): Promise<LeaseReleaseOutcome>;
  /**
   * Record that this lease is being kept deliberately, WITHOUT releasing the kernel lock.
   *
   * Needed because a retained lease never calls `release()`, so the metadata stays `state: "active"` and
   * whoever acquires next reports `recovered: true` — blaming a crash on a known-good path.
   */
  markRetained(reason?: string): Promise<void>;
  /** Reads the give-up marker the helper leaves when it could not close a herdr writer tab. */
  readCloseFailure(): Promise<{ reason: string; herdr_tab?: string } | null>;
}

/**
 * What a release actually did. Five members rather than three, because the first version conflated facts
 * that call for different responses — and one of them is an alarm:
 *   `released`             the lock went back and THIS owner wrote its own handover;
 *   `released-unrecorded`  the lock went back and the record does not say so, so the next owner will report
 *                          a recovery that never happened unless the caller ledgers this. **The alarm.**
 *   `released-superseded`  the lock went back and a successor already owns the metadata, so we correctly
 *                          declined to overwrite it. Healthy, and previously indistinguishable from the
 *                          alarm above;
 *   `not-held`             a read lease, which never took a kernel lock — recording it as `released`
 *                          overstated how many handovers the kernel performed, which is R-105 on the
 *                          release side of the same defect;
 *   `lost`                 the helper was already gone; this owner released nothing.
 */
export type LeaseReleaseOutcome =
  | "released"
  | "released-unrecorded"
  | "released-superseded"
  | "not-held"
  | "lost"
  /**
   * The lease was RETAINED and is therefore already settled — `release()` after `markRetained()` answers
   * this instead of running the clean handshake (R-146). It was previously expressible only as the
   * `| "retained"` bolted onto two signatures, which is why `release()` could not say it and claimed
   * `released` instead: a clean handover for a lease kept precisely because a pane would not close.
   */
  | "retained";

export function leasePaths(leaseDir: string, root: string) {
  // Canonical root, never caller-chosen workspace ID: aliases for one worktree must contend.
  const key = createHash("sha256").update(root, "utf8").digest("hex");
  return {
    lock: join(leaseDir, `${key}.lock`),
    metadata: join(leaseDir, `${key}.json`),
    marker: join(leaseDir, `${key}.close-failed.json`),
  };
}

export async function atomicMetadata(path: string, value: LeaseMetadata): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temp, path);
}

/**
 * `null` means no prior owner was recorded. `"malformed"` means a record exists and cannot be read,
 * which is strictly LESS evidence than a readable "active" one and must never read as a clean handover
 * (R-100). Absent and unreadable are different facts; conflating them silently erases a real recovery.
 */
export async function readMetadata(path: string): Promise<LeaseMetadata | null | "malformed"> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? null : "malformed";
  }
  try {
    const value = JSON.parse(raw) as Partial<LeaseMetadata>;
    if (value?.version !== 1) return "malformed";
    if (value.state !== "active" && value.state !== "released") return "malformed";
    if (typeof value.token !== "string" || !value.token) return "malformed";
    return value as LeaseMetadata;
  } catch {
    return "malformed";
  }
}
