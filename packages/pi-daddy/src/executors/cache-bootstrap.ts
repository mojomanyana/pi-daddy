/**
 * Namespace PID1 bootstrap for the session execution cache. Only the trusted package launcher uses this.
 *
 * Admission occurs after Bubblewrap has armed parent-death handling. Expected host boot/PID/start identity
 * is checked before loading an entry that could start work, and again before readiness. If the owner died
 * before bwrap initialized its parent signal, this check prevents the measured reparented-orphan startup.
 * Killing namespace PID1 causes the Linux kernel to kill all descendants, including detached descendants.
 * The host proc view is for owner checks; qualified command namespaces must NOT inherit that view.
 */
import { readlink } from "node:fs/promises";
import { cacheOwnerMatches, isCacheOwner, readCacheOwner } from "../kernel/cache-owner.ts";
import { CACHE_SUPERVISOR_GO } from "./cache-supervisor-birth.ts";

const HOST_PROC = "/run/pi-daddy-cache-host-proc";
const expected: unknown = JSON.parse(process.argv[2] ?? "null");
if (process.platform !== "linux" || process.pid !== 1 || !isCacheOwner(expected))
  throw new Error("cache bootstrap requires Linux namespace PID1 and a valid expected owner");
// Namespace PID1 needs an explicit action even during asynchronous initialization/GO waiting.
process.once("SIGTERM", () => process.exit(0));
if (!(await cacheOwnerMatches(expected, HOST_PROC))) throw new Error("cache bootstrap owner is absent or changed");
const birth = await readCacheOwner(Number(await readlink(`${HOST_PROC}/self`)), HOST_PROC);
await new Promise<void>((resolve, reject) => {
  process.stdout.write(`${JSON.stringify({ piDaddyCacheSupervisor: 1, birth })}\n`, (error) =>
    error ? reject(error) : resolve(),
  );
});
// Consume only the private GO line. Never read ahead, change application bytes or leak control to entry.
await new Promise<void>((resolve, reject) => {
  let control = "";
  const finish = (error?: Error) => {
    process.stdin.removeListener("readable", read);
    process.stdin.removeListener("end", end);
    process.stdin.removeListener("error", fault);
    process.stdin.pause();
    if (error) reject(error);
    else resolve();
  };
  const read = () => {
    let byte: Buffer | null;
    while ((byte = process.stdin.read(1) as Buffer | null) !== null) {
      control += byte.toString("latin1");
      if (control.length > CACHE_SUPERVISOR_GO.length || !CACHE_SUPERVISOR_GO.startsWith(control)) {
        finish(new Error("cache bootstrap private GO malformed"));
        return;
      }
      if (control === CACHE_SUPERVISOR_GO) {
        finish();
        return;
      }
    }
  };
  const end = () => finish(new Error("cache bootstrap private GO missing"));
  const fault = (error: Error) => finish(error);
  process.stdin.on("readable", read);
  process.stdin.once("end", end);
  process.stdin.once("error", fault);
  read();
});
if (!(await cacheOwnerMatches(expected, HOST_PROC))) throw new Error("cache bootstrap source owner died before GO");

// This is a package-selected entry, never a coordinator client's executable request.
const entry = process.argv[3];
if (!entry?.startsWith("file:")) throw new Error("cache bootstrap entry must be a package file URL");
const module = (await import(entry)) as { startCacheProcess?: (args: string[]) => Promise<void> };
if (typeof module.startCacheProcess !== "function") throw new Error("cache entry lacks startCacheProcess");
await module.startCacheProcess(process.argv.slice(4));
if (!(await cacheOwnerMatches(expected, HOST_PROC)))
  throw new Error("cache bootstrap owner died during initialization");
process.stdout.write(`${JSON.stringify({ piDaddyCacheSupervisor: 1, ready: true })}\n`);
// Normal termination exits the namespace; fine-grained requester cancellation stays with the coordinator.
