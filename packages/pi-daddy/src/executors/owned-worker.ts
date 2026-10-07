/** Captured Linux execution with a gated, independently settling native subreaper owner. */
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { ChildRunRequest, ChildRunResult } from "../kernel/run-child.ts";
import { takeBytes, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, DEFAULT_KILL_GRACE_MS } from "../kernel/run-child.ts";
import type { CapturedWorkerCleanup, CapturedWorkerIdentity } from "../kernel/captured-worker-contract.ts";
import {
  isCapturedWorkerIdentity,
  readCapturedWorkerReceipt,
  validateLiveWorker,
} from "../governance/captured-worker-record.ts";
export type { CapturedWorkerCleanup, CapturedWorkerIdentity } from "../kernel/captured-worker-contract.ts";

export interface OwnedChildRunRequest extends ChildRunRequest {
  executionId: string;
  /** Fresh, caller-private directory. Existing directories are refused rather than overwritten. */
  ownershipDir: string;
  onOwnership?: (identity: CapturedWorkerIdentity) => Promise<void> | void;
  /** JSON protocol consumers observe all bytes without capturing enormous replay streams as answer text. */
  captureStdout?: boolean;
  /** Bounded diagnostics may truncate without stopping independently captured primary output. */
  stopOnOutputLimit?: boolean;
}
export interface OwnedChildRunResult extends ChildRunResult {
  cleanup: CapturedWorkerCleanup;
}
export async function runOwnedChild(request: OwnedChildRunRequest): Promise<OwnedChildRunResult> {
  const notStarted = (reason: string, aborted = false): OwnedChildRunResult => ({
    code: null,
    text: "",
    truncated: false,
    timedOut: false,
    aborted,
    ...(!aborted ? { spawnError: reason } : {}),
    cleanup: { state: "not-started", reason },
  });
  if (request.hardDeadlineAt !== undefined && request.hardDeadlineAt <= Date.now())
    return { ...notStarted("deadline elapsed before helper launch"), timedOut: true };
  if (request.signal?.aborted) return notStarted("cancelled before helper launch", true);
  if (process.platform !== "linux" || process.arch !== "x64")
    return notStarted("captured worker requires qualified Linux x64 helper");
  let helper: string, root: string, hash: string;
  const nonce = randomUUID();
  let binary: import("node:fs/promises").FileHandle | undefined;
  try {
    helper = fileURLToPath(new URL("../../native/linux-x64/worker", import.meta.url));
    const info = await lstat(helper);
    if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o111))
      throw new Error("packaged worker helper is not an ordinary executable");
    binary = await open(helper, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const pinned = await binary.stat();
    if (pinned.dev !== info.dev || pinned.ino !== info.ino) throw new Error("worker helper changed before pinning");
    hash = (await readFile(helper + ".sha256", "utf8")).trim();
    if (
      !/^[a-f0-9]{64}$/.test(hash) ||
      createHash("sha256")
        .update(await binary.readFile())
        .digest("hex") !== hash
    )
      throw new Error("packaged worker helper hash mismatch");
    root = await realpath(request.cwd);
    if (!request.executionId || request.executionId.length > 512)
      throw new Error("executionId must be bounded and nonempty");
    await mkdir(request.ownershipDir, { mode: 0o700 });
    if ((await realpath(request.ownershipDir)) !== request.ownershipDir)
      throw new Error("ownershipDir must be a canonical absolute path");
  } catch (error) {
    await binary?.close();
    return notStarted(String(error));
  }
  return new Promise((resolve) => {
    const grace = Math.min(request.killGraceMs ?? DEFAULT_KILL_GRACE_MS, 60000);
    const cleanupCeiling = grace + 5000;
    const child = spawn(
      "/proc/self/fd/5",
      [
        request.executionId,
        nonce,
        root,
        hash,
        request.ownershipDir,
        String(grace),
        String(cleanupCeiling),
        "--",
        request.command,
        ...request.args,
      ],
      {
        cwd: root,
        env: request.env,
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", binary!.fd],
        detached: true,
      },
    );
    void binary!.close();
    const control = child.stdio[3] as import("node:stream").Duplex;
    const status = child.stdio[4] as import("node:stream").Readable;
    let identity: CapturedWorkerIdentity | undefined;
    let text = "",
      count = 0,
      truncated = false,
      timedOut = false,
      aborted = false,
      idle = false;
    let failure: string | undefined,
      done = false,
      stopping = false,
      ready = "";
    let stopWatchdog: NodeJS.Timeout | undefined, idleTimer: NodeJS.Timeout | undefined;
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const timers: NodeJS.Timeout[] = [];
    const observe = (stream: "stdout" | "stderr", bytes: Buffer) => {
      armIdle();
      try {
        request.onObservation?.(stream, bytes);
      } catch {
        /* observer owns its own incomplete/error state */
      }
      if (stream === "stdout" && request.captureStdout === false) return;
      const chunk = decoders[stream].write(bytes);
      const kept = takeBytes(chunk, Math.max(0, (request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES) - count));
      count += Buffer.byteLength(kept);
      text += kept;
      try {
        if (kept) request.onOutput?.(kept);
      } catch {
        /* display only */
      }
      if (kept.length < chunk.length) {
        truncated = true;
        if (request.stopOnOutputLimit !== false) stop();
      }
    };
    const stop = (hard = false) => {
      if (hard && !done && control.writable) control.write("K");
      if (done || stopping) return;
      stopping = true;
      if (control.writable) control.write("C");
      stopWatchdog = setTimeout(() => {
        failure ??= "worker helper failed to establish cleanup before its bound";
        child.kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        status.destroy();
      }, cleanupCeiling + 1000);
    };
    function armIdle() {
      if (!request.idleTimeoutMs || done || stopping) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        idle = true;
        stop();
      }, request.idleTimeoutMs);
    }
    child.stdout?.on("data", (bytes) => observe("stdout", bytes));
    child.stderr?.on("data", (bytes) => observe("stderr", bytes));
    for (const stream of ["stdout", "stderr"] as const)
      child[stream]?.on("end", () => {
        const tail = decoders[stream].end();
        if (tail && !(stream === "stdout" && request.captureStdout === false)) {
          const kept = takeBytes(tail, Math.max(0, (request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES) - count));
          text += kept;
          count += Buffer.byteLength(kept);
        }
        try {
          request.onStreamEnd?.(stream);
        } catch {
          /* observer only */
        }
      });
    control.on("error", () => {
      /* helper close is evaluated against independent receipt */
    });
    status.on("data", (bytes: Buffer) => {
      if (identity || failure) return;
      ready += bytes.toString("utf8");
      if (ready.length > 16384) {
        failure = "oversized worker readiness";
        stop();
        return;
      }
      if (!ready.includes("\n")) return;
      void (async () => {
        try {
          const value: unknown = JSON.parse(ready.trim());
          if (
            !isCapturedWorkerIdentity(value) ||
            value.executionId !== request.executionId ||
            value.nonce !== nonce ||
            value.root !== root ||
            value.helperPid !== child.pid ||
            value.helperSha256 !== hash ||
            value.ownershipPath !== join(request.ownershipDir, "ownership.json")
          )
            throw new Error("wrong worker readiness identity");
          identity = value;
          await validateLiveWorker(identity, helper);
          await request.onOwnership?.(identity);
          if (request.hardDeadlineAt !== undefined && request.hardDeadlineAt <= Date.now()) {
            timedOut = true;
            stop(true);
          }
          if (!stopping && !done) {
            request.onSpawn?.(identity.workerPid);
            control.write("S");
          }
        } catch (error) {
          failure = String(error);
          stop();
        }
      })();
    });
    timers.push(
      setTimeout(() => {
        if (!identity) {
          failure = "worker readiness timed out";
          stop();
        }
      }, 5000),
    );
    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop();
      }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    );
    if (request.hardDeadlineAt !== undefined)
      timers.push(
        setTimeout(
          () => {
            timedOut = true;
            stop(true);
          },
          Math.max(0, request.hardDeadlineAt - Date.now()),
        ),
      );
    armIdle();
    if (request.activityProbe && request.idleTimeoutMs) {
      let previous: unknown,
        probing = false;
      timers.push(
        setInterval(() => {
          if (probing || done) return;
          probing = true;
          Promise.resolve()
            .then(() => request.activityProbe!())
            .then((value) => {
              if (value !== undefined && value !== previous) {
                previous = value;
                armIdle();
              }
            })
            .catch(() => undefined)
            .finally(() => {
              probing = false;
            });
        }, request.activityProbeIntervalMs ?? 2000),
      );
    }
    const onAbort = () => {
      aborted = true;
      stop();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.hardDeadlineAt !== undefined && request.hardDeadlineAt <= Date.now()) {
      timedOut = true;
      stop(true);
    }
    if (request.signal?.aborted) onAbort();
    child.on("error", (error) => {
      failure = String(error);
    });
    child.on("exit", () => {
      void (async () => {
        if (!identity || !(await readCapturedWorkerReceipt(identity))) {
          failure ??= "helper exited without an independent settlement receipt";
          child.stdout?.destroy();
          child.stderr?.destroy();
          status.destroy();
        }
      })();
    });
    child.on("close", () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      if (idleTimer) clearTimeout(idleTimer);
      if (stopWatchdog) clearTimeout(stopWatchdog);
      request.signal?.removeEventListener("abort", onAbort);
      control.destroy();
      void (async () => {
        const receipt = identity ? await readCapturedWorkerReceipt(identity) : null;
        const cleanup: CapturedWorkerCleanup =
          receipt && identity
            ? { state: "settled", identity, receipt }
            : {
                state: "unknown",
                ...(identity ? { identity } : {}),
                reason: failure ?? "helper closed without matching durable settlement receipt",
              };
        const signal = receipt?.workerSignal
          ? (Object.entries(osConstants.signals).find(
              ([, value]) => value === receipt.workerSignal,
            )?.[0] as NodeJS.Signals)
          : null;
        resolve({
          code: receipt?.workerCode ?? null,
          signal,
          text,
          truncated,
          timedOut,
          ...(idle ? { idle: true as const } : {}),
          aborted,
          ...(failure ? { spawnError: failure } : {}),
          cleanup,
        });
      })();
    });
  });
}
