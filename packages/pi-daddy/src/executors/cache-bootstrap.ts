/**
 * Namespace PID1 bootstrap for the session execution cache. Only the trusted package launcher uses this.
 *
 * Admission occurs after Bubblewrap has armed parent-death handling. Expected host boot/PID/start identity
 * is checked before loading an entry that could start work, and again before readiness. If the owner died
 * before bwrap initialized its parent signal, this check prevents the measured reparented-orphan startup.
 * Killing namespace PID1 causes the Linux kernel to kill all descendants, including detached descendants.
 * The host proc view is for owner checks; qualified command namespaces must NOT inherit that view.
 */
import { cacheOwnerMatches, isCacheOwner } from "../kernel/cache-owner.ts";

const HOST_PROC = "/run/pi-daddy-cache-host-proc";
const expected: unknown = JSON.parse(process.argv[2] ?? "null");
if (process.platform !== "linux" || process.pid !== 1 || !isCacheOwner(expected))
  throw new Error("cache bootstrap requires Linux namespace PID1 and a valid expected owner");
if (!(await cacheOwnerMatches(expected, HOST_PROC))) throw new Error("cache bootstrap owner is absent or changed");

// This is a package-selected entry, never a coordinator client's executable request.
const entry = process.argv[3];
if (!entry?.startsWith("file:")) throw new Error("cache bootstrap entry must be a package file URL");
const module = (await import(entry)) as { startCacheProcess?: (args: string[]) => Promise<void> };
if (typeof module.startCacheProcess !== "function") throw new Error("cache entry lacks startCacheProcess");
await module.startCacheProcess(process.argv.slice(4));
if (!(await cacheOwnerMatches(expected, HOST_PROC)))
  throw new Error("cache bootstrap owner died during initialization");
process.stdout.write(`${JSON.stringify({ piDaddyCacheSupervisor: 1, ready: true })}\n`);
// PID1 does not take default signal actions like ordinary processes. Normal termination exits the
// namespace; fine-grained requester cancellation remains the coordinator's responsibility.
process.once("SIGTERM", () => process.exit(0));
