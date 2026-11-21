/** Serialize opted-in writers by actual working copy. This never creates a grant or changes a worker's cwd. */
import { dirname, join } from "node:path";
import { lstat, stat, realpath } from "node:fs/promises";
import { TaskDispatch } from "../src/governance/task-dispatch.ts";
import { readRuntimeExecutionSettlement, type PrelaunchOwner } from "../src/governance/runtime-settlement.ts";
type Host = { cwd: string; sessionId: string };

async function workingCopyId(cwd: string) {
  const requested = await realpath(cwd);
  let root = requested;
  for (let cursor = requested; ; cursor = dirname(cursor)) {
    try {
      const marker = await lstat(join(cursor, ".git"));
      if (!marker.isFile() && !marker.isDirectory()) throw Error("Cannot identify the Git working copy");
      root = cursor;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    if (dirname(cursor) === cursor) break;
  }
  const identity = await stat(root, { bigint: true });
  if (!identity.isDirectory()) throw Error("Working copy is unavailable");
  return `${identity.dev}.${identity.ino}`;
}

export async function claimTaskWriter(
  directory: string,
  target: string,
  host: Host,
  executionId: string,
  beforeLaunch?: PrelaunchOwner,
) {
  const id = await workingCopyId(target);
  const store = new TaskDispatch(directory, "working-copy", id, true);
  for (const previous of store.outstanding()) {
    const receipt = await readRuntimeExecutionSettlement(
      directory,
      previous.sessionId,
      previous.cwd,
      previous.executionId,
      previous.beforeLaunch,
    ).catch(() => "unknown" as const);
    if (receipt !== "unknown") store.settle(previous.owner, previous.executionId, receipt);
  }
  // The bound session also owns live runtime state. Only its identity belongs in the writer journal.
  store.admit({
    owner: "pi-daddy",
    executionId,
    sessionId: host.sessionId,
    cwd: host.cwd,
    ...(beforeLaunch ? { beforeLaunch } : {}),
  });
  const finish = (cleanup: "settled" | "not-started") => store.settle("pi-daddy", executionId, cleanup);
  try {
    if (id !== (await workingCopyId(target))) throw Error("Working copy changed during admission");
  } catch (error) {
    finish("not-started");
    throw error;
  }
  return finish;
}
