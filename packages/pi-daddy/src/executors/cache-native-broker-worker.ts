/** Trusted namespace-PID1 entry for the CP1 leaf, not an application command endpoint.
 * Broker executable/socket are selected by root composition. PID1 exits on leaf death;
 * kernel namespace teardown owns descendants. No detachment, shell wrapper or environment injection.
 */
import { spawn } from "node:child_process";
export async function startCacheProcess(args: string[]): Promise<void> {
  if (args.length !== 2 || args.some((value) => !value.startsWith("/") || value.includes("\0")))
    throw Error("cache native broker worker configuration malformed");
  const child = spawn(args[0], [args[1]], { stdio: ["pipe", "pipe", "pipe"], detached: false });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  process.stdin.pipe(child.stdin);
  const fault = (error: unknown) => {
    process.stderr.write(`cache native broker worker: ${String(error)}\n`);
    process.exit(78);
  };
  child.stdin.on("error", fault);
  child.stdout.on("error", fault);
  child.stderr.on("error", fault);
  child.once("error", fault);
  child.once("close", (code) => process.exit(code === 0 ? 0 : 78));
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}
