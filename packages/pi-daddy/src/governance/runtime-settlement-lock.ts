/** An OS-held single-writer lock; parent pipe loss releases it without stale-age guesses. */
import { spawn } from "node:child_process";
import { constants, openSync, closeSync, fstatSync } from "node:fs";
export async function lockRuntimeSettlement(path: string): Promise<{ healthy(): boolean; release(): Promise<void> }> {
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const info = fstatSync(fd);
  if (!info.isFile() || info.uid !== process.getuid!() || info.mode & 0o077) {
    closeSync(fd);
    throw Error("runtime lock is not a private ordinary file");
  }
  const child = spawn(
    "/usr/bin/flock",
    [
      "--no-fork",
      "--wait",
      "1",
      "/proc/self/fd/3",
      process.execPath,
      "-e",
      'process.stdout.write("locked\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));',
    ],
    { stdio: ["pipe", "pipe", "ignore", fd] },
  );
  closeSync(fd);
  let healthy = false,
    line = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.stdin?.destroy();
      child.kill();
      reject(Error("runtime ownership lock timed out"));
    }, 3000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", () => {
      healthy = false;
      clearTimeout(timer);
      reject(Error("another live runtime owns this Pi session"));
    });
    child.stdout?.on("data", (bytes) => {
      line += bytes.toString();
      if (line === "locked\n") {
        healthy = true;
        clearTimeout(timer);
        resolve();
      } else if (line.length > 16) {
        clearTimeout(timer);
        child.stdin?.destroy();
        reject(Error("runtime lock returned malformed readiness"));
      }
    });
  });
  child.unref();
  (child.stdin as import("node:net").Socket).unref();
  (child.stdout as import("node:net").Socket).unref();
  let releasing: Promise<void> | undefined;
  return {
    healthy: () => healthy && child.exitCode === null && child.signalCode === null,
    release: () =>
      (releasing ??= new Promise<void>((resolve) => {
        healthy = false;
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        child.stdin?.end();
      })),
  };
}
