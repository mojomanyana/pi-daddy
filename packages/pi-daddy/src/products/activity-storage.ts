/** Initialize default activity storage outside the project git working copy so repos stay clean. */
import { lstat, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { activityTimelinePath } from "../kernel/project-paths.ts";

export async function prepareDefaultActivityStorage(cwd: string, path: string): Promise<void> {
  if (resolve(path) !== resolve(activityTimelinePath(cwd))) return;
  const dir = dirname(resolve(path));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw Error("activity storage path is not an ordinary directory; nothing followed or replaced");
  }
}
