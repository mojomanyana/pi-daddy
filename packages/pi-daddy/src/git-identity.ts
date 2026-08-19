import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GovernanceRefusal, refusal } from "./refusals.ts";
import type { ValidatedWorkspace } from "./workspace.ts";

const execFileAsync = promisify(execFile);

export interface GitCandidateIdentity {
  headSha: string;
  treeSha: string;
}

/** Compute HEAD plus exact tracked/untracked candidate content without changing the real index. */
export async function computeGitCandidateIdentity(workspace: ValidatedWorkspace): Promise<GitCandidateIdentity> {
  const dir = await mkdtemp(join(tmpdir(), "pi-daddy-index-"));
  const index = join(dir, "index");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR,
    GIT_INDEX_FILE: index,
  };
  const git = async (args: string[]) => (await execFileAsync("git", ["-C", workspace.root, ...args], {
    env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  })).stdout.trim();
  try {
    const headSha = await git(["rev-parse", "HEAD"]);
    await git(["read-tree", "HEAD"]);
    await git(["add", "-A"]);
    const treeSha = await git(["write-tree"]);
    if (!/^[a-f0-9]{40,64}$/i.test(headSha) || !/^[a-f0-9]{40,64}$/i.test(treeSha)) throw new Error("Git returned an invalid object id");
    return { headSha, treeSha };
  } catch (error) {
    throw new GovernanceRefusal(refusal(
      "CHECK_IDENTITY_UNAVAILABLE",
      `could not compute exact Git head/candidate-tree identity for workspace ${workspace.workspaceId} (${String(error)})`,
      { workspace_id: workspace.workspaceId },
    ));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
