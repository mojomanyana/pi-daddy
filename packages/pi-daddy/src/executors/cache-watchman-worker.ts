/** UNTESTED (per request). Only the supervised package bootstrap loads this owned foreground service. */
import { spawn } from "node:child_process";
export async function startCacheProcess(args: string[]): Promise<void> {
  const [executable, socket] = args;
  if (
    args.length !== 2 ||
    !executable?.startsWith("/") ||
    !socket?.startsWith("/") ||
    executable.includes("\0") ||
    socket.includes("\0")
  )
    throw Error("owned Watchman arguments malformed");
  const child = spawn(
    executable,
    [
      "--foreground",
      "--no-save-state",
      "--sockname",
      socket,
      "--logfile",
      `${socket}.log`,
      "--statefile",
      `${socket}.state`,
      "--pidfile",
      `${socket}.pid`,
    ],
    { stdio: "ignore", detached: false },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  // The namespace, not this callback, owns all descendants. Exiting PID1 destroys the whole namespace.
  child.once("exit", (code) => {
    process.exitCode = code || 1;
    process.exit();
  });
  process.stdin.resume();
  process.stdin.once("end", () => process.exit());
}
