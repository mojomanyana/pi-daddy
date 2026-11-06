/** Initialize default activity storage once per recorder, before observing product identity. */
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import {
  ACTIVITY_GITIGNORE_CONTENT,
  activityTimelinePath,
  piProjectDir,
  projectGitignorePath,
  projectStateDir,
} from "../kernel/project-paths.ts";

const execute = promisify(execFile);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function ordinaryDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw Error("activity storage path is not an ordinary directory; nothing followed or replaced");
}

/** Without Git, allow ordinary non-repository roles but never guess that a marked repo is safe. */
async function markerFreeNonRepository(cwd: string): Promise<boolean> {
  if (["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"].some((key) => process.env[key]?.trim()))
    return false;
  let current = await realpath(cwd);
  for (let depth = 0; depth < 128; depth++) {
    try {
      await lstat(join(current, ".git"));
      return false;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
  return false;
}

export async function prepareDefaultActivityStorage(cwd: string, path: string): Promise<void> {
  // Configured and transported locations retain their explicit existing policy.
  if (resolve(path) !== activityTimelinePath(cwd)) return;
  const root = resolve(cwd),
    ignore = projectGitignorePath(root),
    state = projectStateDir(root);
  const git = (...args: string[]) =>
    execute(
      "git",
      ["--no-optional-locks", ...(args[0] === "ls-files" ? ["--literal-pathspecs"] : []), "-C", root, ...args],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 2000,
        env: { ...process.env, LC_ALL: "C" },
      },
    );
  let repository = true;
  try {
    await git("rev-parse", "--show-toplevel");
  } catch (error) {
    const result = error as { code?: number | string; stderr?: string };
    if (
      (result.code === "ENOENT" || (result.code === 128 && result.stderr?.includes("not a git repository"))) &&
      (await markerFreeNonRepository(root))
    )
      repository = false;
    else throw Error("activity Git policy could not be checked; recording unavailable");
  }
  if (repository) {
    const tracked = await git("ls-files", "-z", "--", path, `${path}.lock`, join(state, "content"));
    if (tracked.stdout.length)
      throw Error("activity runtime files are already tracked; no index or ignore policy was changed");
  }
  await ordinaryDirectory(piProjectDir(root));
  await ordinaryDirectory(state);
  let present = true;
  try {
    const info = await lstat(ignore);
    if (!info.isFile() || info.isSymbolicLink())
      throw Error("activity ignore path is not an ordinary file; nothing followed or replaced");
  } catch (error) {
    if (missing(error)) present = false;
    else throw error;
  }
  if (!present) {
    if (repository && (await git("ls-files", "-z", "--", ignore)).stdout.length)
      throw Error("tracked ignore file is missing; recording did not recreate it");
    try {
      const file = await open(
        ignore,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await file.writeFile(ACTIVITY_GITIGNORE_CONTENT, "utf8");
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another cooperating initializer won. Preserve its file and validate its policy below.
    }
  }
  const installed = await lstat(ignore);
  if (!installed.isFile() || installed.isSymbolicLink())
    throw Error("activity ignore path changed; recording unavailable");
  if (repository) {
    // Require the directory itself to be excluded: one sample digest cannot prove that
    // custom rules cover every digest and temporary filename.
    for (const probe of [path, `${path}.lock`, `${join(state, "content")}/`]) {
      try {
        await git("check-ignore", "-q", "--", probe);
      } catch {
        throw Error(
          "existing Git policy does not exclude default activity storage; existing rules were preserved and recording is unavailable",
        );
      }
    }
  }
}
