import { lstat, realpath, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ENV_NATIVE_SESSION_ROOT } from "./native-session.ts";
export interface NativeSessionHost { /** Explicit host opt-in captured once, not model-supplied. */ readonly nativeSessionRoot?: string }
export const nativeSessionRootFromEnv=(env:NodeJS.ProcessEnv)=>env[ENV_RETAIN_NATIVE_SESSIONS]==="1"?env[ENV_NATIVE_SESSION_ROOT]??"":undefined;
export const ENV_RETAIN_NATIVE_SESSIONS = "PI_GRANTS_RETAIN_NATIVE_SESSIONS";
/** Explicit ordinary-host opt-in only. Never read a destination from tool/model parameters.
 * Allocate a fresh per-occurrence directory; no scan, existing-session takeover or transcript creation. */
export async function allocateNativeSessionTarget(root: string, executionId: string): Promise<string> {
  if (!isAbsolute(root) || resolve(root) !== root || !/^[a-zA-Z0-9:_-]{1,128}$/.test(executionId)) throw new Error("explicit native root/execution identity required");
  for (let p = root;; p = dirname(p)) {
    const s = await lstat(p); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("native target ancestor changed");
    if (p === parse(p).root) break;
  }
  const before = await lstat(root);
  if (await realpath(root) !== root || before.mode & 0o077 || before.uid !== process.getuid?.()) throw new Error("private owned native target root required");
  const directory = join(root, "execution-" + createHash("sha256").update(executionId).digest("hex"));
  await mkdir(directory, { mode: 0o700 }); // EEXIST is a refusal, never permission to append an old occurrence.
  const after = await lstat(root);
  if (before.dev !== after.dev || before.ino !== after.ino || await realpath(directory) !== directory) throw new Error("native target root replaced");
  return join(directory, "session.jsonl");
}
