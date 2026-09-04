import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runWithFinalizers } from "./finalization.ts";
import { GovernanceRefusal, refusal } from "./refusals.ts";
import type { ValidatedWorkspace } from "./workspace.ts";

const execFileAsync = promisify(execFile);

export interface GitCandidateIdentity {
  headSha: string;
  treeSha: string;
}

/** Compute HEAD plus NON-IGNORED tracked/untracked candidate content without changing the real index.
 *
 * NOT the exact working tree: `git add -A` honours `.gitignore`, `core.excludesFile` and
 * `$GIT_DIR/info/exclude`, and records only a gitlink for a submodule. And it is not read-only — it writes
 * blob objects into the real `.git/objects`. `docs/SPEC.md` retracted the word "exact"; this comment said
 * it for one more round. */
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
  return runWithFinalizers(async () => {
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
    }
  }, [{
    label: "temporary Git index cleanup failed",
    run: () => rm(dir, { recursive: true, force: true }),
  }]);
}
