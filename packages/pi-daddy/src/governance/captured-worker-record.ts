/** Independent ownership evidence; unreadable/mismatched receipts never establish settlement. */
import { constants } from "node:fs";
import { open, realpath, stat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CapturedWorkerIdentity, CapturedWorkerReceipt } from "../kernel/captured-worker-contract.ts";

const identityKeys = [
  "revision",
  "executionId",
  "nonce",
  "root",
  "rootDevice",
  "rootInode",
  "bootId",
  "pidNamespace",
  "helperPid",
  "helperStartTicks",
  "helperSha256",
  "workerPid",
  "ownershipPath",
  "receiptPath",
] as const;
export function isCapturedWorkerIdentity(value: unknown): value is CapturedWorkerIdentity {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (
    v.revision !== 1 ||
    !Number.isSafeInteger(v.helperPid) ||
    Number(v.helperPid) < 1 ||
    !Number.isSafeInteger(v.workerPid) ||
    Number(v.workerPid) < 1
  )
    return false;
  if (
    identityKeys.some(
      (key) => !["revision", "helperPid", "workerPid"].includes(key) && (typeof v[key] !== "string" || !v[key]),
    )
  )
    return false;
  if (!/^[a-f0-9]{64}$/.test(String(v.helperSha256)) || !/^\d+$/.test(String(v.helperStartTicks))) return false;
  return (
    v.ownershipPath === join(dirname(String(v.receiptPath)), "ownership.json") &&
    v.receiptPath === join(dirname(String(v.ownershipPath)), "receipt.json")
  );
}
export async function readWorkerRecord(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16384) throw new Error("worker record must be a bounded ordinary file");
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw new Error("worker record grew beyond its bound");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}
export function sameWorkerIdentity(a: CapturedWorkerIdentity, b: CapturedWorkerIdentity): boolean {
  return identityKeys.every((key) => a[key] === b[key]);
}
export async function readCapturedWorkerReceipt(
  identity: CapturedWorkerIdentity,
): Promise<CapturedWorkerReceipt | null> {
  try {
    if (!isCapturedWorkerIdentity(identity)) return null;
    const ownership = (await readWorkerRecord(identity.ownershipPath)) as { state?: unknown; identity?: unknown };
    const value = (await readWorkerRecord(identity.receiptPath)) as CapturedWorkerReceipt;
    if (
      ownership.state !== "ready" ||
      !isCapturedWorkerIdentity(ownership.identity) ||
      !sameWorkerIdentity(identity, ownership.identity)
    )
      return null;
    if (
      value.state !== "settled" ||
      value.reapedAll !== true ||
      !isCapturedWorkerIdentity(value.identity) ||
      !sameWorkerIdentity(identity, value.identity)
    )
      return null;
    if (
      value.workerCode !== null &&
      (!Number.isInteger(value.workerCode) || value.workerCode < 0 || value.workerCode > 255)
    )
      return null;
    if (!Number.isInteger(value.workerSignal) || value.workerSignal < 0 || value.workerSignal > 64) return null;
    if (
      !["worker-exit", "owner-loss", "cancelled", "helper-signal", "ownership-write-failed", "start-failed"].includes(
        value.reason,
      )
    )
      return null;
    if (value.workerSignal !== 0 && value.workerCode !== null) return null;
    return value;
  } catch {
    return null;
  }
}
/** Before release of the execution gate, validate namespace, workspace and the still-live actual helper. */
export async function validateLiveWorker(identity: CapturedWorkerIdentity, helperPath: string): Promise<void> {
  if (!isCapturedWorkerIdentity(identity)) throw new Error("malformed captured worker identity");
  const [root, rootInfo, boot, namespace, processStat, executable, packaged] = await Promise.all([
    realpath(identity.root),
    stat(identity.root, { bigint: true }),
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    import("node:fs/promises").then((fs) => fs.readlink("/proc/self/ns/pid")),
    readFile(`/proc/${identity.helperPid}/stat`, "utf8"),
    stat(`/proc/${identity.helperPid}/exe`),
    stat(helperPath),
  ]);
  const fields = processStat.slice(processStat.lastIndexOf(")") + 2).split(" ");
  if (
    root !== identity.root ||
    String(rootInfo.dev) !== identity.rootDevice ||
    String(rootInfo.ino) !== identity.rootInode ||
    boot.trim() !== identity.bootId ||
    namespace !== identity.pidNamespace ||
    fields[19] !== identity.helperStartTicks ||
    executable.dev !== packaged.dev ||
    executable.ino !== packaged.ino
  )
    throw new Error("captured worker identity differs from actual live ownership");
}

export async function matchesWorkerWorkspace(identity: CapturedWorkerIdentity, root: string): Promise<boolean> {
  try {
    const info = await stat(root, { bigint: true });
    return (
      identity.root === root &&
      (await realpath(root)) === root &&
      String(info.dev) === identity.rootDevice &&
      String(info.ino) === identity.rootInode
    );
  } catch {
    return false;
  }
}
