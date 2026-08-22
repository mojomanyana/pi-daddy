import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { GovernanceRefusal, refusal } from "./refusals.ts";
import { isSafeWorkspaceId, workspaceCapability } from "./capabilities.ts";

const execFileAsync = promisify(execFile);
export const ENV_WORKSPACE_REGISTRY = "PI_GRANTS_WORKSPACE_REGISTRY";


export type WorkspaceAccess = "read" | "write";

export interface WorkspaceRegistryFile {
  version: 1;
  workspaces: Record<string, { path: string }>;
  /**
   * Where this was loaded from, carried so a refusal can NAME it.
   *
   * `docs/SPEC.md` claimed an unregistered id is refused "with `WORKSPACE_NOT_REGISTERED`, which names the
   * file", and `catalog.ts` justified exempting the whole namespace from the unknown check on the strength of
   * that — *"a second, weaker check here can only turn that precise refusal into a misleading one"*. The
   * refusal named no file: the registry object had no idea where it came from. Carried on the object rather
   * than passed per call so a caller cannot forget it. Optional because a hand-built literal (tests,
   * `workspaceEntries` fixtures) has no source.
   */
  source?: string;
}

export interface ValidatedWorkspace {
  workspaceId: string;
  /** Canonical Git worktree root and the child's validated initial CWD. Not a sandbox. */
  root: string;
  gitCommonDir: string;
}

/**
 * How long a registry read may take before it is a refusal rather than a wait.
 *
 * **R-79's defect class, and this reader reintroduced it.** That entry records a probe that hung forever on
 * a FIFO with "no timeout anywhere in the path". This function used a bare `readFile`, which was survivable
 * while it ran only at spawn time — and stopped being survivable when 0.19.0 began reading the registry from
 * `buildCatalog` and `registeredWorkspaceIds`, both awaited inside `session_start`. Measured on `52135ca`:
 * `PI_GRANTS_WORKSPACE_REGISTRY` pointing at a FIFO blocked session start indefinitely, so the session never
 * reached the `holding [...]` line, the executor probe, or any control after it — and `delegate` awaits the
 * same promise, so delegation hung too. A blocking special file, an unresponsive network mount or a hostile
 * `mkfifo` all reach it.
 *
 * Two seconds because this is an operator-authored local JSON file: any legitimate one is a single-digit
 * millisecond read (measured: 8ms), so the bound is three orders of magnitude of headroom and still bounded.
 */
const REGISTRY_READ_TIMEOUT_MS = 2_000;

/** A registry is an operator-authored JSON file; anything approaching this is not one. */
const REGISTRY_MAX_BYTES = 1 << 20;

export async function loadWorkspaceRegistry(path: string): Promise<WorkspaceRegistryFile> {
  // **One handle, opened non-blocking, and every check made against THAT handle.** Three defects made this
  // the shape rather than `stat`-then-`readFile`:
  //
  //  - `AbortSignal.timeout` cannot rescue a FIFO: a signal is observed between chunks, while a FIFO blocks
  //    inside `open(2)` before any read begins. `O_NONBLOCK` makes the open itself return instead (measured:
  //    1ms), which is what actually bounds this path. R-79's defect class, and R-136's.
  //  - `stat` by name followed by `readFile` by name is a TOCTOU: swapping a regular file for a FIFO between
  //    the two hung the loader indefinitely, and the attacker is any process at the same uid — precisely the
  //    actor the mode check below cannot exclude. Measured, 5 of 6 iterations completing in ~1ms and the
  //    sixth never returning. `fstat` on a held descriptor has no name to re-resolve.
  //  - a second reader (the ADR-0035 registry pin, since reverted to its own PR) reimplemented the guards and
  //    got them wrong. One reader is why that cannot happen again.
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_NOT_REGISTERED",
      `workspace registry ${path} could not be opened (${String(error)})`,
      { registry_path: path },
    ));
  }
  let raw: string;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new GovernanceRefusal(refusal(
        "WORKSPACE_NOT_REGISTERED",
        `workspace registry ${path} is not a regular file — refusing to read it. A FIFO, device or socket ` +
          `at ${ENV_WORKSPACE_REGISTRY} would block session start rather than fail, because opening one ` +
          `waits for a writer that may never come.`,
        { registry_path: path },
      ));
    }
    if (info.size > REGISTRY_MAX_BYTES) {
      throw new GovernanceRefusal(refusal(
        "WORKSPACE_NOT_REGISTERED",
        `workspace registry ${path} is ${info.size} bytes, over the ${REGISTRY_MAX_BYTES} limit — refusing ` +
          `rather than reading it into memory at session start.`,
        { registry_path: path },
      ));
    }
    // ADR-0035 asserts the registry is "operator-owned" and nothing checked it. This checks one narrow half
    // of that, and the narrowness is the point — an earlier version of this comment claimed it established
    // "nobody ELSE may rewrite it", which is false twice over:
    //
    //  - it inspects the FILE and never its parent directory, and `rename(2)`/`unlink(2)` need only directory
    //    write. Measured: a 0600 registry in a world-writable non-sticky directory was accepted and then
    //    atomically replaced. `/tmp` is saved by its sticky bit; a shared project directory at 0775 is not.
    //  - it cannot see a same-uid child at all, which is the attack R-137 records and which is now OPEN
    //    rather than half-blocked.
    //
    // What it does buy: a registry any local user can write in place is refused rather than trusted.
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && info.uid !== uid && info.uid !== 0) {
      throw new GovernanceRefusal(refusal(
        "WORKSPACE_NOT_REGISTERED",
        `workspace registry ${path} is owned by uid ${info.uid}, not by this user (${uid}) or root — ` +
          `refusing. It decides which worktrees a delegation may be routed to.`,
        { registry_path: path },
      ));
    }
    // WORLD-writable only. Group-writable is deliberately allowed: `umask 002` with per-user groups
    // (Debian/Ubuntu `USERGROUPS_ENAB`) makes 0664 the default for every file an operator creates, so
    // refusing it broke a configuration published 0.18.1 accepted while exposing nothing — that group has one
    // member. A genuinely shared group is a deliberate choice this cannot distinguish, and is not checked.
    if ((info.mode & 0o002) !== 0) {
      throw new GovernanceRefusal(refusal(
        "WORKSPACE_NOT_REGISTERED",
        `workspace registry ${path} is world-writable (mode ${(info.mode & 0o777).toString(8)}) — refusing. ` +
          `Any local user could redirect a governed child into a worktree nobody authorised. chmod o-w it.`,
        { registry_path: path },
      ));
    }
    // Bounded for a regular file on a slow or wedged mount, where the read can stall between chunks. It does
    // NOT cover a stalled open — `O_NONBLOCK` returns for a FIFO, but an unresponsive network mount blocks
    // the open itself and no in-process timeout can reach that. Stated, not fixed.
    raw = await handle.readFile({ encoding: "utf8", signal: AbortSignal.timeout(REGISTRY_READ_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof GovernanceRefusal) throw error;
    const timedOut = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_NOT_REGISTERED",
      timedOut
        ? `workspace registry ${path} did not return within ${REGISTRY_READ_TIMEOUT_MS}ms — refusing rather ` +
          `than waiting, because session start awaits this read.`
        : `workspace registry ${path} could not be read (${String(error)})`,
      { registry_path: path },
    ));
  } finally {
    await handle.close().catch(() => {});
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_NOT_REGISTERED",
      `workspace registry ${path} is not valid JSON (${String(error)})`,
      { registry_path: path },
    ));
  }
  const file = parsed as Partial<WorkspaceRegistryFile>;
  if (file?.version !== 1 || !file.workspaces || typeof file.workspaces !== "object" || Array.isArray(file.workspaces)) {
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_NOT_REGISTERED",
      `workspace registry ${path} must contain {version:1, workspaces:{id:{path}}}`,
      { registry_path: path },
    ));
  }
  for (const [id, value] of Object.entries(file.workspaces)) {
    if (!id || !value || typeof value.path !== "string" || !isAbsolute(value.path)) {
      throw new GovernanceRefusal(refusal(
        "WORKSPACE_NOT_REGISTERED",
        `workspace registry entry ${JSON.stringify(id)} must name an absolute path`,
        { registry_path: path, workspace_id: id },
      ));
    }
    // ADR-0035 made a registry id the tail of a CAPABILITY id (`workspace:<id>`), so this file is an input
    // to the grant grammar and has to obey it — the STRICT one. This shipped with the loose
    // `isWellFormedCapability` blocklist, and review measured what that let through: an id of `*` minted
    // `WORKSPACE_WILDCARD` (an operator naming one worktree held routing over all of them), an id with a
    // space became two capabilities because `ceilingForDefinition` splits on `[\s,]+`, and quote/`$()` ids
    // reached a generated file whose own instructions say to paste them into `PI_GRANTS_GRANT`. See
    // `isSafeCapability`, which is now the one grammar for both channels into that file.
    if (!isSafeWorkspaceId(id)) {
      throw new GovernanceRefusal(refusal(
        "GRANT_ID_MALFORMED",
        `workspace registry id ${JSON.stringify(id)} cannot be used: since ADR-0035 an id becomes the ` +
          `capability ${JSON.stringify(workspaceCapability(id))}, and an id must match ` +
          `[A-Za-z0-9][A-Za-z0-9._/-]* — slashes and dots are fine (a worktree named after its branch ` +
          `works), but not spaces, quotes, commas, wildcards, shell metacharacters or non-ASCII, each of ` +
          `which either splits into several capabilities or reaches a file you are told to source. ` +
          `Rename it in ${path}.`,
        { registry_path: path, workspace_id: id },
      ));
    }
  }
  return { version: 1, workspaces: structuredClone(file.workspaces), source: path };
}

/**
 * The registered workspace ids, for `planInit` to scaffold and `/grants` to list. `[]` when there is no registry or it is broken.
 *
 * Fails SOFT, and only because nothing here is an authority: this decides which ids appear as COMMENTS in a
 * generated file. `loadWorkspaceRegistry` throws a GovernanceRefusal naming the file, and that refusal is
 * the operator's signal at the point of use, where routing genuinely depends on it. Swallowing it there
 * would be unsafe; swallowing it here costs a suggestion. Same argument as `buildCatalog`'s.
 *
 * Lives here rather than in `init.ts` because it reads the filesystem, and `planInit` — the centrepiece of
 * that module — documents itself as "Pure: no filesystem". It is a registry concern; this is where the
 * registry lives. Moved when `init.ts` crossed the 400-line ceiling, which this project splits for rather
 * than raising (`delegate.ts` at 413, `grants.ts` at 398).
 */
export async function registeredWorkspaceIds(registryPath = process.env[ENV_WORKSPACE_REGISTRY]): Promise<string[]> {
  if (!registryPath) return [];
  try {
    return Object.keys((await loadWorkspaceRegistry(registryPath)).workspaces).sort();
  } catch {
    return [];
  }
}

export async function resolveWorkspace(registry: WorkspaceRegistryFile, workspaceId: string): Promise<ValidatedWorkspace> {
  const registered = Object.hasOwn(registry.workspaces, workspaceId) ? registry.workspaces[workspaceId] : undefined;
  const known = Object.keys(registry.workspaces).sort();
  if (!registered) {
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_NOT_REGISTERED",
      `workspace ${JSON.stringify(workspaceId)} is not present in the operator-owned registry` +
        (registry.source ? ` ${registry.source}` : "") +
        (known.length > 0 ? ` — it lists: ${known.join(", ")}` : " — it lists nothing"),
      { workspace_id: workspaceId, ...(registry.source ? { registry_path: registry.source } : {}) },
    ));
  }
  return validateRegisteredWorkspace({ workspaceId, registeredRoot: registered.path });
}

/**
 * Canonicalize and validate the initial workspace against Git's registered worktree list.
 * This prevents accidental misrouting. It does not constrain any path a child accesses after spawn.
 */
export async function validateRegisteredWorkspace(input: {
  workspaceId: string;
  registeredRoot: string;
  suppliedRoot?: string;
}): Promise<ValidatedWorkspace> {
  let registered: string;
  let supplied: string;
  try {
    registered = await realpath(input.registeredRoot);
    supplied = await realpath(input.suppliedRoot ?? input.registeredRoot);
    if (!(await stat(registered)).isDirectory()) throw new Error("registered root is not a directory");
  } catch (error) {
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_NOT_REGISTERED",
      `workspace ${input.workspaceId} root could not be canonicalized (${String(error)})`,
      { workspace_id: input.workspaceId },
    ));
  }
  if (registered !== supplied) {
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_NOT_REGISTERED",
      `workspace ${input.workspaceId} resolved to ${supplied}, not its registered worktree ${registered}`,
      { workspace_id: input.workspaceId, supplied_root: supplied, registered_root: registered },
    ));
  }

  try {
    const top = (await execFileAsync("git", ["-C", registered, "rev-parse", "--show-toplevel"], { encoding: "utf8" })).stdout.trim();
    const canonicalTop = await realpath(top);
    if (canonicalTop !== registered) throw new Error(`path is inside worktree ${canonicalTop}, not its root`);
    const commonRaw = (await execFileAsync("git", ["-C", registered, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" })).stdout.trim();
    const gitCommonDir = await realpath(commonRaw);
    const list = (await execFileAsync("git", ["-C", registered, "worktree", "list", "--porcelain"], { encoding: "utf8" })).stdout;
    const registeredWorktrees = await Promise.all(
      list.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => realpath(line.slice(9))),
    );
    if (!registeredWorktrees.includes(registered)) throw new Error("Git does not list this path as a worktree");
    return { workspaceId: input.workspaceId, root: registered, gitCommonDir };
  } catch (error) {
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_NOT_REGISTERED",
      `workspace ${input.workspaceId} is not the registered Git worktree it claims to be (${String(error)})`,
      { workspace_id: input.workspaceId, registered_root: registered },
    ));
  }
}

/**
 * The governed-writer lease lives in `./workspace-lease.ts` and is re-exported here so that
 * "the workspace module" remains one import for callers. Split only to stay under the 400-line
 * module ceiling this project enforces mechanically.
 */
export {
  ENV_WORKSPACE_LEASE_DIR,
  acquireWorkspaceLease,
  defaultWorkspaceLeaseDir,
  leaseAcquisitionOutcome,
  leaseReleaseLedgerOutcome,
  type LeaseReleaseOutcome,
  type WorkspaceLease,
} from "./workspace-lease.ts";
