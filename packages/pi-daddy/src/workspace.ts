import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { GovernanceRefusal, refusal } from "./refusals.ts";
import { isSafeCapability, workspaceCapability } from "./capabilities.ts";

const execFileAsync = promisify(execFile);
export const ENV_WORKSPACE_REGISTRY = "PI_GRANTS_WORKSPACE_REGISTRY";
/**
 * The registry digest the ROOT of this delegation tree pinned. Inherited verbatim, never recomputed.
 *
 * Deliberately NOT in `GRANT_ENV_KEYS`: that list is capability state that must attenuate downward, and this
 * is the opposite — a fact about the operator's file that must survive unchanged. See `registryDigest`.
 */
export const ENV_WORKSPACE_PIN = "PI_GRANTS_WORKSPACE_PIN";


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

export async function loadWorkspaceRegistry(
  path: string,
  /**
   * The pin to verify against. Defaults to the inherited one, so **every** reader gets the check without
   * having to remember it — the catalog, `init`'s scaffold, and the routing path alike. A root passes
   * `undefined` because it has nothing to compare against and is the session that establishes the pin.
   */
  pin: string | undefined = process.env[ENV_WORKSPACE_PIN],
): Promise<WorkspaceRegistryFile> {
  // **`stat` before `open`, and that ordering is the whole fix.** `AbortSignal.timeout` does NOT rescue this:
  // a signal is only observed between chunks, while a FIFO blocks inside `open(2)` before any read begins, so
  // the abort never fires. Measured — the first version of this guard used a signal alone and still hung
  // indefinitely. `stat` does not open the file, returns in 0ms on a FIFO, and names what it found.
  //
  // Refusing a non-regular file is also the honest rule rather than a workaround: a registry is a file an
  // operator writes and reviews. A FIFO or a device at that path is either a mistake or someone arranging for
  // session start to block, and it must not be treated as an empty registry either — that would silently
  // disable routing (`resolveWorkspace` would report every id unregistered) which is a confusing safe-mode of
  // exactly the kind rule 8 says to be loud about.
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new GovernanceRefusal(refusal(
        "WORKSPACE_NOT_REGISTERED",
        `workspace registry ${path} is not a regular file — refusing to read it. A FIFO, device or socket ` +
          `at ${ENV_WORKSPACE_REGISTRY} would block session start indefinitely rather than fail, because ` +
          `opening one waits for a writer that may never come.`,
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
    // ADR-0035 asserts the registry is "operator-owned" and nothing checked it. This checks the half that
    // Unix can express: nobody ELSE may rewrite it.
    //
    // **What this does NOT close, stated here because the claim it supports is narrow.** A governed child
    // runs as the same uid as its parent, so no file mode can distinguish them — a child holding `tool:write`
    // can still rewrite a registry that passes every check below. That is what `assertRegistryUnchanged`
    // exists for; this guard and that one are two different threats and neither subsumes the other.
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && info.uid !== uid && info.uid !== 0) {
      throw new GovernanceRefusal(refusal(
        "WORKSPACE_NOT_REGISTERED",
        `workspace registry ${path} is owned by uid ${info.uid}, not by this user (${uid}) or root — ` +
          `refusing. It decides which worktrees a delegation may be routed to, so somebody else being able ` +
          `to rewrite it would decide that for you.`,
        { registry_path: path },
      ));
    }
    if ((info.mode & 0o022) !== 0) {
      throw new GovernanceRefusal(refusal(
        "WORKSPACE_NOT_REGISTERED",
        `workspace registry ${path} is group- or world-writable (mode ${(info.mode & 0o777).toString(8)}) — ` +
          `refusing. Any local user could redirect a governed child into a worktree nobody authorised. ` +
          `chmod 600 or 644 it.`,
        { registry_path: path },
      ));
    }
  } catch (error) {
    if (error instanceof GovernanceRefusal) throw error;
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_NOT_REGISTERED",
      `workspace registry ${path} could not be inspected (${String(error)})`,
      { registry_path: path },
    ));
  }
  let raw: string;
  try {
    // The signal remains as defence-in-depth for a regular file on a slow or wedged mount, where the read
    // itself can stall between chunks. It does NOT cover a stalled `open`, which no in-process timeout can:
    // an unresponsive network mount blocks the `stat` above just as hard. That limit is stated, not fixed.
    raw = await readFile(path, { encoding: "utf8", signal: AbortSignal.timeout(REGISTRY_READ_TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_NOT_REGISTERED",
      timedOut
        ? `workspace registry ${path} did not return within ${REGISTRY_READ_TIMEOUT_MS}ms — refusing rather ` +
          `than waiting, because session start awaits this read.`
        : `workspace registry ${path} could not be read (${String(error)})`,
      { registry_path: path },
    ));
  }
  // Before parsing, and before any id is trusted: the bytes must be the bytes this tree was authorised
  // against. Checked here rather than at each call site so no reader can forget it.
  assertRegistryUnchanged({ path, raw, pin });
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
    if (!isSafeCapability(workspaceCapability(id))) {
      throw new GovernanceRefusal(refusal(
        "GRANT_ID_MALFORMED",
        `workspace registry id ${JSON.stringify(id)} cannot be used: since ADR-0035 an id becomes the ` +
          `capability ${JSON.stringify(workspaceCapability(id))}, which must match [A-Za-z0-9][A-Za-z0-9._-]* ` +
          `— so no spaces, quotes, commas, wildcards or shell metacharacters. An id outside that either ` +
          `splits into several capabilities or reaches a file you are told to source. Rename it in ${path}.`,
        { registry_path: path, workspace_id: id },
      ));
    }
  }
  return { version: 1, workspaces: structuredClone(file.workspaces), source: path };
}

/**
 * The registry's content, as a digest, so a descendant cannot change where routing goes.
 *
 * **The threat the mode check above cannot reach.** ADR-0035 attenuated *which id* a descendant may name and
 * left the id→path mapping in a mutable file. A child holding `workspace:staging` and `tool:write` — not
 * `bash`, so squarely inside ADR-0012's scope — could repoint the `staging` entry at any other Git worktree
 * and route its grandchild there with a real exclusive write lease. Routing attenuated by id and not by
 * destination, which meant the capability named something the child could redefine. Measured in review.
 *
 * The root pins this and every descendant inherits the pinned value **verbatim**. That "verbatim" is the
 * whole mechanism: a child that recomputed the digest would simply re-pin its own tampering, so
 * `PI_GRANTS_WORKSPACE_PIN` is passed through and is deliberately NOT in `GRANT_ENV_KEYS` — it is not
 * capability state that attenuates, it is a fact about the operator's file that must survive unchanged, like
 * `PI_GRANTS_MAX_DEPTH`.
 *
 * Detection, not prevention: the file can still be rewritten, and the next spawn refuses instead of routing
 * somewhere nobody authorised. An operator editing the registry mid-session gets the same refusal, which is
 * correct — the tree below them was authorised against the old contents.
 */
export function registryDigest(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * A pin names the FILE as well as its contents: `<sha256 of path>:<sha256 of contents>`.
 *
 * The first version pinned contents alone, and a test caught what that costs — a pin established for one
 * registry was then enforced against a *different* path read later in the same process, refusing a file it
 * had never made any claim about. A pin has to say which file it is a pin *of*.
 *
 * The path half means a pin simply does not apply to another file rather than refusing it. That is a real
 * narrowing and it is safe for the reason it is safe: `PI_GRANTS_WORKSPACE_REGISTRY` reaches a child through
 * `mergeChildEnv` and is fixed at spawn, so a descendant cannot point itself at a different registry without
 * an execution primitive — and holding one of those is ADR-0012's accepted escape, measured separately.
 */
export function registryPin(path: string, raw: string): string {
  return `${createHash("sha256").update(path, "utf8").digest("hex")}:${registryDigest(raw)}`;
}

/**
 * Refuse if the registry no longer matches what the root of this tree pinned.
 *
 * `pin` absent means this session IS the root: nothing to compare against, and the caller pins the value it
 * just computed for its children. Never falls back to "no pin, so allow" for a descendant, because that is
 * the whole exploit — see `assertRegistryUnchanged`'s callers.
 */
export function assertRegistryUnchanged(input: { path: string; raw: string; pin: string | undefined }): void {
  if (input.pin === undefined) return;
  const actual = registryPin(input.path, input.raw);
  if (actual === input.pin) return;
  // A pin for a DIFFERENT file says nothing about this one — see `registryPin`. Silent rather than a
  // refusal, deliberately: refusing here would break any caller that legitimately reads another registry.
  if (input.pin.split(":")[0] !== actual.split(":")[0]) return;
  throw new GovernanceRefusal(refusal(
    "WORKSPACE_REGISTRY_CHANGED",
    `workspace registry ${input.path} has changed since this delegation tree started (pinned ` +
      `${input.pin.slice(-64, -52)}, now ${actual.slice(-64, -52)}) — refusing to route. The registry ` +
      `decides which worktree a child starts in, so a descendant that can write files could otherwise ` +
      `repoint an id it legitimately holds at a worktree nobody authorised. If you edited it deliberately, ` +
      `start a new session; the agents already running were authorised against the old contents.`,
    { registry_path: input.path, pinned: input.pin, actual },
  ));
}

/**
 * Establish the pin, once, at the root of a delegation tree. A no-op in every descendant.
 *
 * `mergeChildEnv` deletes only `GRANT_ENV_KEYS` from a parent's environment, and the pin is deliberately not
 * one of them — so once this is set it reaches every descendant verbatim with no further wiring, and the
 * `!== undefined` guard below is what stops a descendant re-minting it over its own tampering.
 *
 * Silent on a registry that cannot be read: no pin means no *new* constraint, and the reader that actually
 * needs the file refuses loudly at the point of use. Establishing a pin from a file we failed to read would
 * be worse than none.
 */
export async function establishRegistryPin(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = env[ENV_WORKSPACE_REGISTRY];
  if (!path || env[ENV_WORKSPACE_PIN] !== undefined) return;
  try {
    const raw = await readFile(path, { encoding: "utf8", signal: AbortSignal.timeout(REGISTRY_READ_TIMEOUT_MS) });
    env[ENV_WORKSPACE_PIN] = registryPin(path, raw);
  } catch {
    /* the reader that needs it refuses; see above */
  }
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
