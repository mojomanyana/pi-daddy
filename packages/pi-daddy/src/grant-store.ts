/**
 * The grant for a directory, stored **outside** it.
 *
 * `PI_GRANTS_GRANT` is the propagation channel to children and stays exactly as it was — a parent writes
 * it once per session and every child inherits it. What this adds is a second *source* for the root
 * session's own grant, so an operator does not have to `source` a file and restart pi to be governed.
 *
 * **Outside the workspace, and that is the whole design.** A grant is a ceiling; a ceiling a governed child
 * can rewrite is not a ceiling. `<cwd>/.pi/grants.env` is writable by any child holding `tool:write`, so
 * storing the live grant there would let a child widen the *next* session's ceiling — ADR-0014's
 * self-defeating case verbatim, which is why persisted approvals were moved out of the workspace in the
 * first place. This reuses that pattern exactly: `$PI_CODING_AGENT_DIR/grants/<slug>-<hash>.json`, keyed by
 * the directory, unwritable by a narrowed child because a narrowed child holds no write access to `$HOME`.
 *
 * **It does not defend against a child holding `bash`** (ADR-0012). Nothing here does.
 *
 * `.pi/grants.env` is still written by `init` and is still worth committing — it is the *reviewable record*
 * of the decision, diffable in a PR. It is simply no longer the thing the enforcer reads.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { withFileLock, LockTimeoutError } from "./file-lock.ts";
import type { Capability } from "./resolve.ts";

interface GrantFile {
  version: 1;
  /** The directory this grant is for. Checked on read — an entry copied elsewhere is refused (R-27). */
  cwd: string;
  grant: Capability[];
  /** When `/grants init` wrote it. Informational; nothing expires. */
  writtenAt: string;
}

/** `$PI_CODING_AGENT_DIR`, or pi's default. Same resolution as the approval store. */
function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Where this directory's grant lives.
 *
 * Slug plus a 64-bit hash, exactly as `approvalsPath` does it and for the same two reasons: the basename
 * keeps the directory legible to a human reading it, and the hash is what makes it unambiguous, since two
 * checkouts can share a basename.
 */
export function grantStorePath(cwd: string): string {
  const slug = (basename(cwd) || "root").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  const hash = createHash("sha256").update(cwd, "utf8").digest("hex").slice(0, 16);
  return join(agentDir(), "grants", `${slug}-${hash}.json`);
}

/**
 * Parse a store file's text into a grant, or null.
 *
 * Split out from the readers so the **one** validation lives in one place: both the sync and async paths
 * must agree, and two parsers is how they come to disagree.
 *
 * Fails closed on every doubt — a malformed file grants nothing rather than something. The `cwd` check is
 * R-27's: a file copied to another machine or another checkout describes a directory that is not this one,
 * and honouring it would let a grant travel somewhere nobody authorised it for.
 */
export function parseGrantFile(text: string, cwd: string): Capability[] | null {
  try {
    const parsed = JSON.parse(text) as Partial<GrantFile>;
    if (parsed.version !== 1) return null;
    if (parsed.cwd !== cwd) return null;
    if (!Array.isArray(parsed.grant)) return null;
    if (!parsed.grant.every((c) => typeof c === "string" && c.length > 0)) return null;
    return parsed.grant as Capability[];
  } catch {
    return null;
  }
}

/**
 * Read this directory's stored grant, synchronously.
 *
 * **Sync on purpose, and this is the constraint that shapes the feature.** Whether `delegate` is registered
 * at all is decided when the extension factory runs (S-5: a session without `tool:delegate` must not be
 * offered the tool), and that is before any `await` is possible. An async read would resolve after the
 * decision it exists to inform, so the store would silently fail to grant delegation — the exact class of
 * defect R-38 and R-39 were.
 */
export function loadGrantSync(cwd: string): Capability[] | null {
  try {
    return parseGrantFile(readFileSync(grantStorePath(cwd), "utf8"), cwd);
  } catch {
    return null;
  }
}

/** Async twin, for callers that already have one. Same parser, so they cannot disagree. */
export async function loadGrant(cwd: string): Promise<Capability[] | null> {
  try {
    return parseGrantFile(await readFile(grantStorePath(cwd), "utf8"), cwd);
  } catch {
    return null;
  }
}

export type SaveOutcome = "saved" | "failed" | "busy";

/**
 * Write this directory's grant.
 *
 * Locked with the same lock the ledger and the approval store use, for the same reason: two sessions in one
 * directory running `/grants init` concurrently must not interleave. A lock this cannot take yields `busy`
 * and changes nothing — the caller reports it and the operator retries, which is the honest outcome for a
 * write that never looked at the file (R-68).
 *
 * `wx` on the temp file refuses to follow a pre-existing symlink, and `rename` is atomic within a
 * filesystem, so a reader never sees a half-written grant. Both copied from `writeFileSafely`, deliberately
 * — a second, subtly different atomic-write is how the two come to disagree about what "safe" meant.
 */
export async function saveGrant(cwd: string, grant: Capability[]): Promise<SaveOutcome> {
  const path = grantStorePath(cwd);
  const file: GrantFile = { version: 1, cwd, grant: [...grant].sort(), writtenAt: new Date().toISOString() };
  try {
    await mkdir(dirname(path), { recursive: true });
    return await withFileLock(path, "grant store", async () => {
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await rename(temp, path);
        return "saved" as const;
      } catch {
        await unlink(temp).catch(() => undefined);
        return "failed" as const;
      }
    });
  } catch (error) {
    return error instanceof LockTimeoutError ? "busy" : "failed";
  }
}

/** Remove this directory's stored grant. True when a file was there to remove. */
export async function clearGrant(cwd: string): Promise<boolean> {
  const path = grantStorePath(cwd);
  try {
    await readFile(path, "utf8");
  } catch {
    return false;
  }
  await rm(path, { force: true }).catch(() => undefined);
  return true;
}
