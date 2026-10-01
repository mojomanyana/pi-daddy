/**
 * Own one descriptor-only native leaf process OUTSIDE the coordinator user namespace. CAP_LEASE
 * in a descendant user namespace cannot protect initial-namespace, root-owned runtime files.
 * Native PDEATHSIG follows the actual spawning root; a pidfd also observes the coordinator peer.
 * Never confer a capability here: optional installation is a separate, reviewed operator action.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute } from "node:path";

export async function startLeaseProcess(binary: string, sha256: string, args: string[], requirePrivilege: boolean) {
  if (process.platform !== "linux") throw new Error("cache lease bridge requires Linux");
  if (!isAbsolute(binary) || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error("cache lease binary requires absolute path and trusted SHA256");
  if (requirePrivilege) {
    if ((await realpath(binary)) !== binary)
      throw new Error(`cache lease privileged path must be canonical: ${binary}`);
    let directory = dirname(binary);
    for (;;) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.uid !== 0 || info.mode & 0o022)
        throw new Error(`cache lease privileged ancestor is not root-owned and protected: ${directory}`);
      if (directory === "/") break;
      directory = dirname(directory);
    }
  }
  const executable = await open(binary, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await executable.stat();
    if (!info.isFile() || info.size <= 0 || info.size > 4 * 1024 * 1024 || !(info.mode & 0o111) || info.mode & 0o6000)
      throw new Error(`cache lease helper is not a bounded executable regular file: ${binary}`);
    if (requirePrivilege && (info.uid !== 0 || info.mode & 0o022 || info.nlink !== 1))
      throw new Error(`cache lease privileged binary is not root-owned and protected: ${binary}`);
    const bytes = Buffer.alloc(info.size + 1);
    let filled = 0;
    const deadline = performance.now() + 2000;
    while (filled < bytes.length) {
      if (performance.now() > deadline) throw new Error(`cache lease binary hash exceeded 2000ms: ${binary}`);
      const read = await executable.read(bytes, filled, bytes.length - filled, filled);
      if (!read.bytesRead) break;
      filled += read.bytesRead;
    }
    if (filled !== info.size || createHash("sha256").update(bytes.subarray(0, filled)).digest("hex") !== sha256)
      throw new Error(`cache lease binary identity changed or mismatched: ${binary}`);
    const child = spawn("/proc/self/fd/3", args, {
      detached: false,
      stdio: ["pipe", "pipe", "pipe", executable.fd],
      env: { LANG: "C", PATH: "/usr/bin:/bin" },
    });
    let spawned = false,
      finished = false,
      controlFault = "";
    const stopped = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("spawn", () => {
        spawned = true;
      });
      child.on("error", (error) => {
        controlFault = error.message;
        if (!spawned) {
          finished = true;
          resolve({ code: null, signal: null });
        }
      });
      child.once("exit", (code, signal) => {
        finished = true;
        resolve({ code, signal });
      });
    });
    let stopping: Promise<void> | undefined;
    const send = (signal: NodeJS.Signals) => {
      if (!child.kill(signal)) controlFault ||= `${signal} not delivered`;
    };
    const stop = () =>
      (stopping ??= (async () => {
        if (finished) return;
        child.stdin!.end();
        const term = setTimeout(() => send("SIGTERM"), 250),
          kill = setTimeout(() => send("SIGKILL"), 500);
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            stopped,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`cache lease termination unresolved after 1500ms: ${controlFault}`)),
                1500,
              );
            }),
          ]);
        } finally {
          clearTimeout(term);
          clearTimeout(kill);
          clearTimeout(timer);
        }
      })());
    return { child, stopped, stop };
  } finally {
    await executable.close();
  }
}
