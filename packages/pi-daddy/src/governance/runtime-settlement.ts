/** Local runtime facts for explicitly armed resume; no task text, grants, approval or model verdicts. */
import { lockRuntimeSettlement } from "./runtime-settlement-lock.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  realpathSync,
  lstatSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  constants,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { readBoundedTextSync } from "../kernel/bounded-read-sync.ts";
import type { CapturedWorkerCleanup, CapturedWorkerIdentity } from "../kernel/captured-worker-contract.ts";
import { isCapturedWorkerIdentity, readCapturedWorkerReceipt, sameWorkerIdentity } from "./captured-worker-record.ts";
const MAX_RECORD = 4 * 1024 * 1024;
interface Execution {
  id: string;
  state: "pending" | "settled" | "not-started" | "unknown";
  identity?: CapturedWorkerIdentity;
  receiptSha256?: string;
  problem?: string;
}
interface Journal {
  version: 1;
  sessionId: string;
  cwd: string;
  ownerScope: string;
  ownerId: string;
  executions: Execution[];
}
export const settlementHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ownerId = (): string => {
  const stat = readFileSync("/proc/self/stat", "utf8");
  return [
    readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    process.pid,
    stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
  ].join(":");
};
function ownerAlive(id: string): boolean {
  const [boot, pid, ticks] = id.split(":");
  if (!/^\d+$/.test(pid ?? "") || !/^\d+$/.test(ticks ?? "")) throw Error("invalid runtime journal owner");
  if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== boot) return false;
  try {
    const text = readFileSync("/proc/" + pid + "/stat", "utf8");
    return text.slice(text.lastIndexOf(")") + 2).split(" ")[19] === ticks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function validate(value: unknown, sessionId: string, cwd: string): Journal {
  const j = value as Journal;
  if (
    !j ||
    j.version !== 1 ||
    j.sessionId !== sessionId ||
    j.cwd !== cwd ||
    !/^[a-f0-9-]{36}$/.test(j.ownerScope) ||
    typeof j.ownerId !== "string" ||
    !Array.isArray(j.executions) ||
    j.executions.length > 10000
  )
    throw Error("invalid runtime journal identity");
  const ids = new Set<string>();
  for (const e of j.executions) {
    if (
      !e ||
      typeof e.id !== "string" ||
      !e.id ||
      e.id.length > 512 ||
      ids.has(e.id) ||
      !["pending", "settled", "not-started", "unknown"].includes(e.state) ||
      (e.identity !== undefined && (!isCapturedWorkerIdentity(e.identity) || e.identity.executionId !== e.id)) ||
      (e.receiptSha256 !== undefined && !/^[a-f0-9]{64}$/.test(e.receiptSha256)) ||
      (e.state === "settled" && (!e.identity || !e.receiptSha256)) ||
      (e.state === "not-started" && e.identity) ||
      (e.problem !== undefined && typeof e.problem !== "string")
    )
      throw Error("invalid runtime journal execution");
    ids.add(e.id);
  }
  return j;
}
export interface RuntimeSettlement {
  readonly ownerScope: string;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly cwd: string;
  begin(id: string): void;
  bind(identity: CapturedWorkerIdentity): void;
  finish(id: string, cleanup: CapturedWorkerCleanup, problem?: string): Promise<void>;
  snapshot(): Promise<{
    ownerScope: string;
    ownerId: string;
    evidenceDigest: string;
    state: "idle" | "busy" | "unknown";
    settledExecutionIds: string[];
    outstandingExecutionIds: string[];
    reason?: string;
  }>;
}
export async function openRuntimeSettlement(
  directory: string,
  sessionId: string,
  cwd: string,
): Promise<RuntimeSettlement> {
  if (process.platform !== "linux" || process.arch !== "x64") throw Error("runtime settlement requires Linux x64");
  if (!sessionId || sessionId.length > 512 || cwd !== realpathSync(cwd))
    throw Error("runtime session/cwd identity is unavailable");
  const root = join(realpathSync(directory), "pi-daddy", "runtime-settlement");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root) throw Error("runtime settlement root must not contain symlinks");
  const info = lstatSync(root);
  if (!info.isDirectory() || info.uid !== process.getuid!() || info.mode & 0o077)
    throw Error("runtime settlement root must be private");
  const path = join(root, settlementHash([sessionId, cwd]) + ".json");
  const lock = await lockRuntimeSettlement(path + ".lock");
  try {
    let journal: Journal;
    try {
      journal = validate(JSON.parse(readBoundedTextSync(path, { maxBytes: MAX_RECORD }).text), sessionId, cwd);
      if (ownerAlive(journal.ownerId)) throw Error("prior runtime owner is still alive");
      journal.ownerId = ownerId();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journal = { version: 1, sessionId, cwd, ownerScope: randomUUID(), ownerId: ownerId(), executions: [] };
    }
    let failed: string | undefined,
      active = new Set<string>();
    const save = () => {
      let temporary: string | undefined, fd: number | undefined;
      try {
        if (!lock.healthy()) throw Error("runtime ownership lock was lost");
        const text = JSON.stringify(journal) + "\n";
        if (Buffer.byteLength(text) > MAX_RECORD) throw Error("runtime settlement journal exceeds its bound");
        temporary = path + "." + randomUUID();
        fd = openSync(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        writeFileSync(fd, text);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, path);
        const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          fsyncSync(parent);
        } finally {
          closeSync(parent);
        }
      } catch (error) {
        failed = String(error);
        throw error;
      } finally {
        if (fd !== undefined) closeSync(fd);
        if (temporary)
          try {
            unlinkSync(temporary);
          } catch {}
      }
    };
    const entry = (id: string) => {
      const e = journal.executions.find((e) => e.id === id);
      if (!e) throw Error("runtime execution was not registered");
      return e;
    };
    save();
    return {
      ownerScope: journal.ownerScope,
      ownerId: journal.ownerId,
      sessionId,
      cwd,
      begin(id) {
        if (failed) throw Error(failed);
        if (
          typeof id !== "string" ||
          !id ||
          id.length > 512 ||
          journal.executions.some((e) => e.id === id) ||
          journal.executions.length >= 10000
        )
          throw Error("runtime execution id must be fresh and bounded");
        journal.executions.push({ id, state: "pending" });
        active.add(id);
        save();
      },
      bind(identity) {
        const e = entry(identity.executionId);
        if (e.state !== "pending" || (e.identity && !sameWorkerIdentity(e.identity, identity)))
          throw Error("runtime ownership changed");
        e.identity = { ...identity };
        save();
      },
      async finish(id, cleanup, problem) {
        const e = entry(id);
        if (problem) e.problem = problem.slice(0, 2000);
        try {
          if (cleanup.state === "not-started" && !e.identity) e.state = "not-started";
          else if (cleanup.state === "settled" && e.identity && sameWorkerIdentity(e.identity, cleanup.identity)) {
            const receipt = await readCapturedWorkerReceipt(e.identity);
            if (receipt) {
              e.state = "settled";
              e.receiptSha256 = settlementHash(receipt);
            } else e.state = "unknown";
          } else e.state = "unknown";
          save();
        } finally {
          active.delete(id);
        }
      },
      async snapshot() {
        if (!lock.healthy()) failed = "runtime ownership lock was lost";
        let changed = false;
        for (const e of journal.executions) {
          if (active.has(e.id) || !e.identity) continue;
          const receipt = await readCapturedWorkerReceipt(e.identity);
          if (!receipt || (e.receiptSha256 && e.receiptSha256 !== settlementHash(receipt))) {
            if (e.state === "settled") {
              e.state = "unknown";
              changed = true;
            }
            continue;
          }
          if (e.state !== "settled") {
            e.state = "settled";
            e.receiptSha256 = settlementHash(receipt);
            changed = true;
          }
        }
        if (changed) {
          try {
            save();
          } catch {}
        }
        const outstanding = journal.executions.filter(
          (e) => !["settled", "not-started"].includes(e.state) || e.problem,
        );
        const state =
          failed || outstanding.some((e) => !active.has(e.id))
            ? "unknown"
            : active.size
              ? "busy"
              : outstanding.length
                ? "unknown"
                : "idle";
        return {
          ownerScope: journal.ownerScope,
          ownerId: journal.ownerId,
          evidenceDigest: settlementHash({ ownerScope: journal.ownerScope, executions: journal.executions }),
          state,
          settledExecutionIds: journal.executions.filter((e) => e.state === "settled").map((e) => e.id),
          outstandingExecutionIds: outstanding.map((e) => e.id),
          ...(failed ? { reason: failed } : {}),
        };
      },
    };
  } catch (error) {
    await lock.release();
    throw error;
  }
}
