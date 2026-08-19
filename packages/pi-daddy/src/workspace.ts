import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { GovernanceRefusal, refusal } from "./refusals.ts";

const execFileAsync = promisify(execFile);
const LEASE_READY = "PI_DADDY_LEASE_READY";
// The lock holder also owns crash cleanup for the governed child. If the parent dies, stdin closes;
// the helper terminates the attached process or herdr tab before releasing flock. A raw descendant
// deliberately detached by bash remains ADR-0012's OS-containment boundary, not a lease guarantee.
const HELPER_SOURCE = `
import { execFile } from "node:child_process";
let clean=false, target=null, buffered="";
process.stdout.write(${JSON.stringify(`${LEASE_READY}:`)}+process.pid+"\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data",chunk=>{buffered+=chunk;for(;;){const i=buffered.indexOf("\\n");if(i<0)break;const line=buffered.slice(0,i);buffered=buffered.slice(i+1);try{const value=JSON.parse(line);if(value.release)clean=true;else if(value.process_pid)target={process_pid:value.process_pid};else if(value.herdr_tab)target={herdr_tab:value.herdr_tab};}catch{}}});
process.stdin.on("end",()=>{if(clean||!target)return process.exit(0);if(target.process_pid){try{process.kill(target.process_pid,"SIGTERM")}catch{return process.exit(0)}setTimeout(()=>{try{process.kill(target.process_pid,"SIGKILL")}catch{}},500);return setTimeout(()=>process.exit(0),750);}const close=()=>execFile("herdr",["tab","close",target.herdr_tab],error=>error?setTimeout(close,1000):process.exit(0));close();});
process.stdin.resume();`;

export const ENV_WORKSPACE_REGISTRY = "PI_GRANTS_WORKSPACE_REGISTRY";
export const ENV_WORKSPACE_LEASE_DIR = "PI_GRANTS_WORKSPACE_LEASE_DIR";

export function defaultWorkspaceLeaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return env[ENV_WORKSPACE_LEASE_DIR] ?? join(agentDir, "pi-daddy", "workspace-leases");
}

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

interface LeaseMetadata {
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
  /** True only when the kernel lock was free but metadata said the prior owner never released. */
  recovered: boolean;
  /** Attach the governed resource so parent death cleans it before the kernel lock is released. */
  attachProcess(pid: number): void;
  attachHerdrTab(tabId: string): void;
  /** Resolves only when the kernel-lock helper exits before explicit release. */
  lost: Promise<Error>;
  release(reason?: string): Promise<void>;
}

function leasePaths(leaseDir: string, root: string) {
  // Canonical root, never caller-chosen workspace ID: aliases for one worktree must contend.
  const key = createHash("sha256").update(root, "utf8").digest("hex");
  return { lock: join(leaseDir, `${key}.lock`), metadata: join(leaseDir, `${key}.json`) };
}

async function atomicMetadata(path: string, value: LeaseMetadata): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temp, path);
}

async function readMetadata(path: string): Promise<LeaseMetadata | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as LeaseMetadata;
    return value?.version === 1 ? value : null;
  } catch {
    return null;
  }
}

export async function acquireWorkspaceLease(input: {
  workspace: ValidatedWorkspace;
  access: WorkspaceAccess;
  leaseDir: string;
  ownerId: string;
  signal?: AbortSignal;
  flockCommand?: string;
  acquisitionTimeoutMs?: number;
}): Promise<WorkspaceLease> {
  if (input.access === "read") {
    return {
      workspace: input.workspace,
      access: "read",
      ownerId: input.ownerId,
      recovered: false,
      attachProcess: () => {},
      attachHerdrTab: () => {},
      lost: new Promise(() => {}),
      release: async () => {},
    };
  }
  if (input.signal?.aborted) {
    throw new GovernanceRefusal(refusal("WORKSPACE_WRITE_CONFLICT", `writer lease for ${input.workspace.workspaceId} was cancelled before acquisition`));
  }

  await mkdir(input.leaseDir, { recursive: true, mode: 0o700 });
  const paths = leasePaths(input.leaseDir, input.workspace.root);
  const { spawn } = await import("node:child_process");
  const holder = spawn(input.flockCommand ?? "flock", [
    "--exclusive", "--nonblock", "--conflict-exit-code", "73", paths.lock,
    process.execPath, "--input-type=module", "-e", HELPER_SOURCE,
  ], { stdio: ["pipe", "pipe", "pipe"] });

  const timeoutMs = input.acquisitionTimeoutMs ?? 2000;
  let ready = false;
  let helperPid: number | undefined;
  let stderr = "";
  holder.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new GovernanceRefusal(refusal(
        "WORKSPACE_LEASE_STALE", `writer lease helper did not become ready within ${timeoutMs}ms`,
      ))), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => rejectReady(new GovernanceRefusal(refusal(
        "WORKSPACE_WRITE_CONFLICT", `writer lease for ${input.workspace.workspaceId} was cancelled before acquisition`,
      )));
      input.signal?.addEventListener("abort", onAbort, { once: true });
      holder.once("error", (error) => {
        cleanup();
        rejectReady(new GovernanceRefusal(refusal(
          "WORKSPACE_LEASE_STALE", `workspace writer leases require a working flock command (${String(error)})`,
        )));
      });
      holder.once("close", (code) => {
        if (ready) return;
        cleanup();
        const codeName = code === 73 ? "WORKSPACE_WRITE_CONFLICT" : "WORKSPACE_LEASE_STALE";
        rejectReady(new GovernanceRefusal(refusal(
          codeName,
          code === 73
            ? `workspace ${input.workspace.workspaceId} already has an active pi-daddy-governed writer`
            : `workspace lease helper exited before acquisition${stderr ? ` (${stderr.trim()})` : ""}`,
          { workspace_id: input.workspace.workspaceId, root: input.workspace.root },
        )));
      });
      holder.stdout?.on("data", (chunk) => {
        const output = String(chunk);
        if (!output.includes(LEASE_READY) || ready) return;
        helperPid = Number(output.match(new RegExp(`${LEASE_READY}:(\\d+)`))?.[1]);
        ready = true;
        cleanup();
        resolveReady();
      });
    });
  } catch (error) {
    holder.kill("SIGKILL");
    throw error;
  }

  const previous = await readMetadata(paths.metadata);
  const recovered = previous?.state === "active";
  const token = randomUUID();
  const metadata: LeaseMetadata = {
    version: 1,
    state: "active",
    token,
    owner_id: input.ownerId,
    workspace_id: input.workspace.workspaceId,
    root: input.workspace.root,
    pid: Number.isInteger(helperPid) ? helperPid! : (holder.pid ?? process.pid),
    acquired_at: new Date().toISOString(),
  };
  try {
    await atomicMetadata(paths.metadata, metadata);
  } catch (error) {
    holder.stdin?.end();
    throw new GovernanceRefusal(refusal(
      "WORKSPACE_LEASE_STALE", `acquired the kernel writer lock but could not record its owner (${String(error)})`,
      { workspace_id: input.workspace.workspaceId, root: input.workspace.root },
    ));
  }

  let released = false;
  let lose!: (error: Error) => void;
  const lost = new Promise<Error>((resolveLost) => { lose = resolveLost; });
  const lostError = () => new Error(`workspace writer lease helper exited for ${input.workspace.workspaceId}`);
  holder.once("close", () => { if (!released) lose(lostError()); });
  if (holder.exitCode !== null || holder.signalCode !== null) queueMicrotask(() => lose(lostError()));
  const attach = (value: { process_pid: number } | { herdr_tab: string }) => {
    if (released || holder.exitCode !== null || holder.signalCode !== null || !holder.stdin?.writable) {
      throw new GovernanceRefusal(refusal(
        "WORKSPACE_LEASE_STALE", `writer lease for ${input.workspace.workspaceId} was lost before child attachment`,
      ));
    }
    holder.stdin.write(`${JSON.stringify(value)}\n`);
  };
  return {
    workspace: input.workspace,
    access: "write",
    ownerId: input.ownerId,
    recovered,
    attachProcess(pid) { attach({ process_pid: pid }); },
    attachHerdrTab(tabId) { attach({ herdr_tab: tabId }); },
    lost,
    async release(reason = "completed") {
      if (released) return;
      if (holder.exitCode !== null || holder.signalCode !== null) {
        throw new GovernanceRefusal(refusal(
          "WORKSPACE_LEASE_STALE", `writer lease for ${input.workspace.workspaceId} was lost before release`,
        ));
      }
      released = true;
      const current = await readMetadata(paths.metadata);
      if (current?.token === token) {
        await atomicMetadata(paths.metadata, {
          ...metadata,
          state: "released",
          released_at: new Date().toISOString(),
          release_reason: reason,
        }).catch(() => undefined);
      }
      holder.stdin?.write(`${JSON.stringify({ release: true })}\n`);
      holder.stdin?.end();
      if (holder.exitCode === null && holder.signalCode === null) {
        await Promise.race([once(holder, "close"), new Promise((resolveWait) => setTimeout(resolveWait, 1000))]);
      }
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    },
  };
}
