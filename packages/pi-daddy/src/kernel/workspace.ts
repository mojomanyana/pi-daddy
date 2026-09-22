import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { readBoundedFile } from "./bounded-read.ts";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { GovernanceRefusal, refusal } from "./refusals.ts";
import { isSafeWorkspaceId, workspaceCapability } from "./capabilities.ts";
import { ENV_WORKSPACE_REGISTRY } from "./env-names.ts";
export { ENV_WORKSPACE_REGISTRY } from "./env-names.ts";

const execFileAsync = promisify(execFile);

export type WorkspaceAccess = "read" | "write";

export interface WorkspaceRegistryFile {
  version: 1;
  workspaces: Record<string, { path: string }>;
  /**
   * Where this was loaded from, carried so a refusal can NAME it.
   *
   * The README claimed an unregistered id is refused "with `WORKSPACE_NOT_REGISTERED`, which names the
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
 * `PI_DADDY_WORKSPACE_REGISTRY` pointing at a FIFO blocked session start indefinitely, so the session never
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
  // The guards this call carries — non-blocking open, every check on the held descriptor, a deadline between
  // chunks, the size bound checked twice — were worked out HERE and now live in `bounded-read.ts`, because a
  // second session-start reader went on using a bare `readFile` rather than copying them. The mapping from a
  // reason to a refusal stays here: only this caller knows that an unreadable registry is a governance
  // refusal naming the file, and its messages are unchanged.
  const read = await readBoundedFile(path, {
    maxBytes: REGISTRY_MAX_BYTES,
    timeoutMs: REGISTRY_READ_TIMEOUT_MS,
  });
  if (!read.ok) {
    const message =
      read.why === "not-a-regular-file"
        ? `workspace registry ${path} is not a regular file — refusing to read it. A FIFO, device or socket ` +
          `at ${ENV_WORKSPACE_REGISTRY} would block session start rather than fail, because opening one ` +
          `waits for a writer that may never come.`
        : read.why === "too-large"
          ? `workspace registry ${path} is ${read.size} bytes, over the ${REGISTRY_MAX_BYTES} limit — ` +
            `refusing rather than reading it into memory at session start.`
          : read.why === "grew-while-reading"
            ? `workspace registry ${path} exceeded the ${REGISTRY_MAX_BYTES} limit while being read — it ` +
              `grew after its size was checked. Refusing rather than allocating it.`
            : read.why === "timed-out"
              ? `workspace registry ${path} did not finish reading within ${REGISTRY_READ_TIMEOUT_MS}ms — ` +
                `refusing rather than waiting, because session start awaits this read.`
              : read.why === "unopenable"
                ? `workspace registry ${path} could not be opened (${read.detail})`
                : `workspace registry ${path} could not be read (${read.detail})`;
    throw new GovernanceRefusal(refusal("WORKSPACE_NOT_REGISTERED", message, { registry_path: path }));
  }
  const raw = read.text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new GovernanceRefusal(
      refusal("WORKSPACE_NOT_REGISTERED", `workspace registry ${path} is not valid JSON (${String(error)})`, {
        registry_path: path,
      }),
    );
  }
  const file = parsed as Partial<WorkspaceRegistryFile>;
  if (
    file?.version !== 1 ||
    !file.workspaces ||
    typeof file.workspaces !== "object" ||
    Array.isArray(file.workspaces)
  ) {
    throw new GovernanceRefusal(
      refusal(
        "WORKSPACE_NOT_REGISTERED",
        `workspace registry ${path} must contain {version:1, workspaces:{id:{path}}}`,
        { registry_path: path },
      ),
    );
  }
  for (const [id, value] of Object.entries(file.workspaces)) {
    if (!id || !value || typeof value.path !== "string" || !isAbsolute(value.path)) {
      throw new GovernanceRefusal(
        refusal(
          "WORKSPACE_NOT_REGISTERED",
          `workspace registry entry ${JSON.stringify(id)} must name an absolute path`,
          { registry_path: path, workspace_id: id },
        ),
      );
    }
    // ADR-0035 made a registry id the tail of a CAPABILITY id (`workspace:<id>`), so this file is an input
    // to the grant grammar and has to obey it — the STRICT one. This shipped with the loose
    // `isWellFormedCapability` blocklist, and review measured what that let through: an id of `*` minted
    // `WORKSPACE_WILDCARD` (an operator naming one worktree held routing over all of them), an id with a
    // space became two capabilities because `ceilingForDefinition` splits on `[\s,]+`, and quote/`$()` ids
    // reached a generated file whose own instructions say to paste them into `PI_DADDY_GRANT`. See
    // `isSafeCapability`, which is now the one grammar for both channels into that file.
    if (!isSafeWorkspaceId(id)) {
      throw new GovernanceRefusal(
        refusal(
          "GRANT_ID_MALFORMED",
          `workspace registry id ${JSON.stringify(id)} cannot be used: since ADR-0035 an id becomes the ` +
            `capability ${JSON.stringify(workspaceCapability(id))}, and an id must match ` +
            `[A-Za-z0-9][A-Za-z0-9._/-]* — slashes and dots are fine (a worktree named after its branch ` +
            `works), but not spaces, quotes, commas, wildcards, shell metacharacters or non-ASCII, each of ` +
            `which either splits into several capabilities or reaches a file you are told to source. ` +
            `Rename it in ${path}.`,
          { registry_path: path, workspace_id: id },
        ),
      );
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
 *
 * **`onRefusal` exists because `catch { return [] }` was rule 8's silent safe-mode.** A malformed registry
 * made `pi-daddy init` scaffold with no workspace capabilities at all and say nothing about why, which an
 * operator cannot tell apart from having registered none. Failing soft stays — `init` must work without a
 * registry — but the reason is handed to the caller instead of discarded. A caller that passes nothing keeps
 * the old behaviour, which is why this is an optional parameter and not a changed return type.
 */
export async function registeredWorkspaceIds(
  registryPath = process.env[ENV_WORKSPACE_REGISTRY],
  onRefusal?: (reason: string) => void,
): Promise<string[]> {
  if (!registryPath) return [];
  try {
    return Object.keys((await loadWorkspaceRegistry(registryPath)).workspaces).sort();
  } catch (error) {
    onRefusal?.(error instanceof Error ? error.message : String(error));
    return [];
  }
}

export async function resolveWorkspace(
  registry: WorkspaceRegistryFile,
  workspaceId: string,
): Promise<ValidatedWorkspace> {
  const registered = Object.hasOwn(registry.workspaces, workspaceId) ? registry.workspaces[workspaceId] : undefined;
  const known = Object.keys(registry.workspaces).sort();
  if (!registered) {
    throw new GovernanceRefusal(
      refusal(
        "WORKSPACE_NOT_REGISTERED",
        `workspace ${JSON.stringify(workspaceId)} is not present in the operator-owned registry` +
          (registry.source ? ` ${registry.source}` : "") +
          (known.length > 0 ? ` — it lists: ${known.join(", ")}` : " — it lists nothing"),
        { workspace_id: workspaceId, ...(registry.source ? { registry_path: registry.source } : {}) },
      ),
    );
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
    throw new GovernanceRefusal(
      refusal(
        "WORKSPACE_NOT_REGISTERED",
        `workspace ${input.workspaceId} root could not be canonicalized (${String(error)})`,
        { workspace_id: input.workspaceId },
      ),
    );
  }
  if (registered !== supplied) {
    throw new GovernanceRefusal(
      refusal(
        "WORKSPACE_NOT_REGISTERED",
        `workspace ${input.workspaceId} resolved to ${supplied}, not its registered worktree ${registered}`,
        { workspace_id: input.workspaceId, supplied_root: supplied, registered_root: registered },
      ),
    );
  }

  try {
    const top = (
      await execFileAsync("git", ["-C", registered, "rev-parse", "--show-toplevel"], { encoding: "utf8" })
    ).stdout.trim();
    const canonicalTop = await realpath(top);
    if (canonicalTop !== registered) throw new Error(`path is inside worktree ${canonicalTop}, not its root`);
    const commonRaw = (
      await execFileAsync("git", ["-C", registered, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
        encoding: "utf8",
      })
    ).stdout.trim();
    const gitCommonDir = await realpath(commonRaw);
    const list = (
      await execFileAsync("git", ["-C", registered, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    ).stdout;
    const registeredWorktrees = await Promise.all(
      list
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => realpath(line.slice(9))),
    );
    if (!registeredWorktrees.includes(registered)) throw new Error("Git does not list this path as a worktree");
    return { workspaceId: input.workspaceId, root: registered, gitCommonDir };
  } catch (error) {
    throw new GovernanceRefusal(
      refusal(
        "WORKSPACE_NOT_REGISTERED",
        `workspace ${input.workspaceId} is not the registered Git worktree it claims to be (${String(error)})`,
        { workspace_id: input.workspaceId, registered_root: registered },
      ),
    );
  }
}
