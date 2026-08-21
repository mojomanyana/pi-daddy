import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { GovernanceRefusal, refusal } from "./refusals.ts";
import { isWellFormedCapability, workspaceCapability } from "./capabilities.ts";

const execFileAsync = promisify(execFile);
export const ENV_WORKSPACE_REGISTRY = "PI_GRANTS_WORKSPACE_REGISTRY";


export type WorkspaceAccess = "read" | "write";

export interface WorkspaceRegistryFile {
  version: 1;
  workspaces: Record<string, { path: string }>;
}

export interface ValidatedWorkspace {
  workspaceId: string;
  /** Canonical Git worktree root and the child's validated initial CWD. Not a sandbox. */
  root: string;
  gitCommonDir: string;
}

export async function loadWorkspaceRegistry(path: string): Promise<WorkspaceRegistryFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_NOT_REGISTERED",
      `workspace registry ${path} could not be read (${String(error)})`,
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
    // ADR-0035 made a registry id the tail of a CAPABILITY id (`workspace:<id>`), which means this file is
    // now an input to the grant grammar and has to obey it. 0.18.1 was a security release for one comma:
    // grants are comma-joined and comma-split, so an operator who registered `a,b` and wrote
    // `workspace:a,b` would have got `workspace:a` **plus `tool:b`** — authority nobody typed — and still
    // could not route, because the exact id never matched. Refused at the registry, where the operator can
    // see the file, rather than at the far end of a split.
    if (!isWellFormedCapability(workspaceCapability(id))) {
      throw new GovernanceRefusal(refusal(
        "GRANT_ID_MALFORMED",
        `workspace registry id ${JSON.stringify(id)} cannot be used: since ADR-0035 an id becomes the ` +
          `capability ${JSON.stringify(workspaceCapability(id))}, and grants are comma-separated, so an id ` +
          `containing a comma or surrounding whitespace would be read as several capabilities — including ` +
          `ones nothing granted. Rename it in ${path}.`,
        { registry_path: path, workspace_id: id },
      ));
    }
  }
  return { version: 1, workspaces: structuredClone(file.workspaces) };
}

export async function resolveWorkspace(registry: WorkspaceRegistryFile, workspaceId: string): Promise<ValidatedWorkspace> {
  const registered = Object.hasOwn(registry.workspaces, workspaceId) ? registry.workspaces[workspaceId] : undefined;
  if (!registered) {
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_NOT_REGISTERED",
      `workspace ${JSON.stringify(workspaceId)} is not present in the operator-owned registry`,
      { workspace_id: workspaceId },
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
