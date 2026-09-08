import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";

export const DIGEST_PROFILE = "linux-bwrap-digest-v1" as const;
export const DIGEST_WORKER = `const b=Buffer.from(process.argv[1],'base64');if(b.length>16384)process.exit(90);process.stdout.write(JSON.stringify({bytes:b.length,sha256:require('node:crypto').createHash('sha256').update(b).digest('hex')})+'\\n');`;
export interface DigestRuntime { node: string; fingerprints: Readonly<Record<string, string>> }
export async function digestRuntime(): Promise<DigestRuntime> {
  if (process.platform !== "linux") throw new Error("Linux user/mount/PID/network namespaces required");
  const node = await realpath(process.execPath), fingerprints: Record<string, string> = {};
  for (const path of [node, "/usr/bin/bwrap", "/usr/bin/prlimit"]) {
    const st = await lstat(path);
    if (!st.isFile() || (st.mode & 0o022) !== 0 || st.size > 256 * 1024 * 1024) throw new Error("unsupported mutable runtime executable");
    fingerprints[path] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  return Object.freeze({ node, fingerprints: Object.freeze(fingerprints) });
}
/** Internal fixed boundary builder. No user command/environment/workspace/destination interface. */
export function digestNamespaceArgs(runtime: DigestRuntime, code: string, args: string[], fixture?: string): string[] {
  return ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
    "--dir", "/runtime", "--ro-bind", runtime.node, "/runtime/node",
    ...(fixture ? ["--ro-bind", fixture, "/input"] : []),
    "--proc", "/proc", "--dev", "/dev", "--clearenv", "--chdir", "/", "--",
    "/usr/bin/prlimit", "--cpu=2:2", "--nofile=64:64", "--", "/runtime/node",
    // No arbitrary code enters the production worker. Permission flags are additional tripwires,
    // not a claim that Node's permission model is a hostile-JavaScript sandbox.
    ...(fixture ? [] : ["--permission"]), "--max-old-space-size=32", "-e", code, ...args];
}
