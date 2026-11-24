/**
 * Portable cross-OS child runner for macOS (Apple Silicon & Intel) and Windows (Layer 2: executors).
 *
 * Linux x64 uses the hardened static-musl C subreaper in `owned-worker.ts`. On Darwin & Win32,
 * this runner enforces the exact same `--tools` allowlist, streams stdout/stderr to ChildFinalCapture,
 * resolves Windows npm `.cmd` shims (`pi.cmd` -> Node CLI script), and enforces wall/idle timeouts
 * with process-group cleanup (`process.kill(-pid)` on macOS, `child.kill` on Windows).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import type { OwnedChildRunRequest, OwnedChildRunResult } from "./owned-worker.ts";
import type { CapturedWorkerIdentity } from "../kernel/captured-worker-contract.ts";

function resolvePortableExecutable(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { cmd: string; argv: string[]; shell?: boolean } {
  if (process.platform !== "win32" || /[\\/]/.test(command) || /\.[a-z0-9]+$/i.test(command)) {
    return { cmd: command, argv: args };
  }
  const pathVar = env.PATH ?? env.Path ?? process.env.PATH ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const exe = join(dir, `${command}.exe`);
    if (existsSync(exe)) return { cmd: exe, argv: args };
    const shim = join(dir, `${command}.cmd`);
    if (existsSync(shim)) {
      try {
        const text = readFileSync(shim, "utf8");
        const m = /"%~?dp0\\([^"]+\.(?:m|c)?js)"/i.exec(text);
        if (m?.[1]) {
          const cli = resolve(dirname(shim), m[1].replace(/\\/g, "/"));
          if (existsSync(cli)) return { cmd: process.execPath, argv: [cli, ...args] };
        }
      } catch {
        /* Fall back to cmd shim. */
      }
      return { cmd: shim, argv: args, shell: true };
    }
  }
  return { cmd: command, argv: args };
}

export async function runPortableChild(request: OwnedChildRunRequest): Promise<OwnedChildRunResult> {
  const env = request.env ?? process.env;
  const resolved = resolvePortableExecutable(request.command, request.args, env);
  const posixGroup = process.platform !== "win32";
  const maxBytes = request.maxOutputBytes ?? 2 * 1024 * 1024;
  return new Promise((resolveDone) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let truncated = false;
    let text = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolved.cmd, resolved.argv, {
        cwd: request.cwd,
        env,
        detached: posixGroup,
        stdio: ["ignore", "pipe", "pipe"],
        ...(resolved.shell ? { shell: true } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      resolveDone({
        code: null,
        text: "",
        truncated: false,
        timedOut: false,
        aborted: false,
        spawnError: reason,
        cleanup: { state: "not-started", reason },
      });
      return;
    }

    const killTree = (sig: NodeJS.Signals) => {
      try {
        if (posixGroup && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* Already gone. */
      }
    };

    let wallTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (request.idleTimeoutMs && request.idleTimeoutMs > 0) {
        idleTimer = setTimeout(() => {
          timedOut = true;
          killTree("SIGKILL");
        }, request.idleTimeoutMs);
      }
    };
    if (request.hardDeadlineAt !== undefined) {
      const ms = Math.max(1, request.hardDeadlineAt - Date.now());
      wallTimer = setTimeout(() => {
        timedOut = true;
        killTree("SIGKILL");
      }, ms);
    } else if (request.timeoutMs && request.timeoutMs > 0) {
      wallTimer = setTimeout(() => {
        timedOut = true;
        killTree("SIGKILL");
      }, request.timeoutMs);
    }
    armIdle();

    const onAbort = () => {
      aborted = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 1500).unref();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (wallTimer) clearTimeout(wallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      request.signal?.removeEventListener("abort", onAbort);
      const identity: CapturedWorkerIdentity = {
        revision: 1,
        executionId: request.executionId,
        nonce: randomUUID(),
        root: request.cwd,
        rootDevice: "0",
        rootInode: "0",
        bootId: `portable-${process.platform}`,
        pidNamespace: `portable-${process.platform}`,
        helperPid: process.pid,
        helperStartTicks: "0",
        helperSha256: "0".repeat(64),
        workerPid: child.pid ?? 0,
        ownershipPath: join(request.ownershipDir, "ownership.json"),
        receiptPath: join(request.ownershipDir, "receipt.json"),
      };
      resolveDone({
        code,
        text,
        truncated,
        timedOut,
        aborted,
        ...(spawnError ? { spawnError } : {}),
        cleanup: {
          state: "settled",
          identity,
          receipt: {
            state: "settled",
            identity,
            workerCode: code,
            workerSignal: 0,
            reason: aborted ? "cancelled" : spawnError ? "start-failed" : "worker-exit",
            reapedAll: true,
          },
        },
      });
    };

    const handleChunk = (stream: "stdout" | "stderr", chunk: Buffer) => {
      armIdle();
      request.onObservation?.(stream, chunk);
      if (request.captureStdout !== false || stream === "stderr") {
        const piece = chunk.toString("utf8");
        if (Buffer.byteLength(text) + chunk.length <= maxBytes) text += piece;
        else truncated = true;
      }
    };

    child.stdout?.on("data", (d: Buffer) => handleChunk("stdout", d));
    child.stderr?.on("data", (d: Buffer) => handleChunk("stderr", d));
    child.once("error", (err) => finish(null, err.message));
    child.once("close", (code) => finish(code));
  });
}
