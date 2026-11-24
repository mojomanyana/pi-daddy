/**
 * Portable O_EXCL atomic lockfile writer lease for macOS (no GNU flock by default) and Windows.
 * Linux continues using kernel flock + subreaper helper in workspace-lease.ts.
 */
import { open, readFile, unlink } from "node:fs/promises";
import { GovernanceRefusal, refusal } from "../kernel/refusals.ts";
import type { ValidatedWorkspace } from "../kernel/workspace.ts";
import type { WorkspaceLease } from "./lease-record.ts";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function acquirePortableWriterLease(
  lockPath: string,
  workspace: ValidatedWorkspace,
  ownerId: string,
): Promise<WorkspaceLease> {
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  let recovered = false;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, ownerId })}\n`, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let stale = false;
    try {
      const prev = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
      if (typeof prev.pid === "number" && prev.pid > 0 && !isPidAlive(prev.pid)) stale = true;
    } catch {
      stale = true;
    }
    if (!stale) {
      throw new GovernanceRefusal(
        refusal(
          "WORKSPACE_WRITE_CONFLICT",
          `workspace ${workspace.workspaceId} already has an active pi-daddy-governed writer`,
          { workspace_id: workspace.workspaceId, root: workspace.root },
        ),
      );
    }
    await unlink(lockPath).catch(() => {});
    lockHandle = await open(lockPath, "wx", 0o600);
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, ownerId })}\n`, "utf8");
    recovered = true;
  }
  let released = false;
  return {
    workspace,
    access: "write",
    ownerId,
    recovered,
    attachProcess: () => {},
    attachCapturedWorker: async () => {},
    attachHerdrTab: () => {},
    markRetained: async () => (released ? "not-held" : "retained"),
    readCloseFailure: async () => null,
    lost: new Promise(() => {}),
    release: async () => {
      if (released) return "not-held";
      released = true;
      await lockHandle?.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
      return "released";
    },
  };
}
