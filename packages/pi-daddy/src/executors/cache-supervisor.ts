/**
 * Linux kernel-backed lifetime for a cache coordinator, not an independently surviving service.
 *
 * Node starts Bubblewrap without detaching. Its command is the trusted Node bootstrap as namespace PID1;
 * --die-with-parent handles normal/crash/SIGKILL owner death once armed, and bootstrap's host identity
 * validation closes death before arming. Coordinator death destroys the namespace and every descendant.
 * No fallback to plain Node spawn is permitted. Runtime namespace failure disables caching loudly.
 * This layer owns processes only. It does not grant access, qualify inputs or claim agent containment.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cacheOwnerMatches, type CacheOwnerIdentity } from "../kernel/cache-owner.ts";

export interface CacheSupervisorOptions {
  owner: CacheOwnerIdentity;
  /** Trusted package-selected entry. Never supplied by a cache requester. */
  entry: URL;
  args?: string[];
  cwd?: string;
  bwrap?: string;
  initializationMs?: number;
  /** Test synchronization and progress observation; never supplies authority. */
  onSpawn?: () => void;
  onData?: (stream: "stdout" | "stderr", bytes: Buffer) => void;
}
export interface CacheSupervisorHandle {
  process: ChildProcessWithoutNullStreams;
  owner: CacheOwnerIdentity;
  stopped: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): Promise<void>;
}

export async function startSupervisedCache(options: CacheSupervisorOptions): Promise<CacheSupervisorHandle> {
  if (process.platform !== "linux")
    throw new Error("cache supervision requires Linux PID/user namespaces and Bubblewrap");
  if (options.owner.pid !== process.pid)
    throw new Error("cache supervision owner must be the actual calling root process");
  if (!(await cacheOwnerMatches(options.owner))) throw new Error("cache supervision owner is absent or changed");
  const initializationMs = options.initializationMs ?? 3000;
  if (!Number.isSafeInteger(initializationMs) || initializationMs <= 0 || initializationMs > 30000)
    throw new Error("cache initialization timeout must be 1..30000 milliseconds");
  const bootstrap = fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "./cache-bootstrap.ts" : "./cache-bootstrap.js", import.meta.url),
  );
  const child = spawn(
    options.bwrap ?? "bwrap",
    [
      "--unshare-user",
      "--unshare-pid",
      "--die-with-parent",
      "--as-pid-1",
      // Coordinator needs the root's filesystem to watch/capture declared inputs and record history.
      // Execution input isolation is a SEPARATE worker namespace, never this live host mount.
      "--bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/run",
      "--ro-bind",
      "/proc",
      "/run/pi-daddy-cache-host-proc",
      "--",
      process.execPath,
      bootstrap,
      JSON.stringify(options.owner),
      options.entry.href,
      ...(options.args ?? []),
    ],
    { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], detached: false },
  );
  let diagnostics = "",
    controlFault = "",
    finished = false,
    spawned = false;
  let output: Buffer = Buffer.alloc(0),
    startupBytes = 0;
  let phase: "starting" | "ready" | "failed" = "starting";
  let ready: () => void = () => {};
  let failed: (error: Error) => void = () => {};
  const readiness = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const stopped = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", (error) => {
      if (!spawned) {
        finished = true;
        failed(new Error(`cache supervision could not start: ${error.message}`));
        resolve({ code: null, signal: null });
      } else {
        // A failed kill is not an exit. Only the exit event can establish cleanup of a spawned process.
        controlFault = error.message;
        failed(new Error(`cache supervision process control failed: ${error.message}`));
      }
    });
    child.once("exit", (code, signal) => {
      finished = true;
      failed(new Error(`cache supervision exited before readiness (${code ?? signal}): ${diagnostics}`));
      resolve({ code, signal });
    });
  });
  const startupOverflow = () => {
    phase = "failed";
    output = Buffer.alloc(0);
    failed(new Error("cache startup output exceeded 64 KiB"));
  };
  child.stderr.on("data", (bytes: Buffer) => {
    diagnostics = (diagnostics + bytes.toString("utf8")).slice(-8192);
    if (phase === "failed") return;
    if (phase === "starting") {
      startupBytes += bytes.length;
      if (startupBytes + output.length > 65536) {
        startupOverflow();
        return;
      }
    }
    options.onData?.("stderr", bytes);
  });
  child.stdout.on("data", (bytes: Buffer) => {
    if (phase === "failed") return;
    if (phase === "ready") {
      options.onData?.("stdout", bytes);
      return;
    }
    output = Buffer.concat([output, bytes]);
    let newline: number;
    while ((newline = output.indexOf(0x0a)) !== -1) {
      startupBytes += newline + 1;
      if (startupBytes > 65536) {
        startupOverflow();
        return;
      }
      const line = output.subarray(0, newline);
      const framed = output.subarray(0, newline + 1);
      output = output.subarray(newline + 1);
      if (line.equals(Buffer.from('{"piDaddyCacheSupervisor":1,"ready":true}'))) {
        phase = "ready";
        ready();
        if (output.length > 0) options.onData?.("stdout", output);
        output = Buffer.alloc(0);
        return;
      }
      options.onData?.("stdout", framed);
    }
    if (startupBytes + output.length > 65536) startupOverflow();
  });
  child.once("spawn", () => {
    spawned = true;
    options.onSpawn?.();
  });
  let stopping: Promise<void> | undefined;
  const send = (signal: NodeJS.Signals) => {
    if (!child.kill(signal)) controlFault ||= `${signal} was not delivered`;
  };
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      if (finished) return;
      send("SIGTERM");
      const force = setTimeout(() => send("SIGKILL"), 500);
      let deadline: NodeJS.Timeout | undefined;
      const expired = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          send("SIGKILL");
          reject(new Error(`cache termination unresolved after 1500ms${controlFault ? `: ${controlFault}` : ""}`));
        }, 1500);
      });
      try {
        await Promise.race([stopped, expired]);
      } finally {
        clearTimeout(force);
        clearTimeout(deadline);
      }
    })());
  const timeout = setTimeout(
    () => failed(new Error(`cache supervision initialization exceeded ${initializationMs}ms`)),
    initializationMs,
  );
  try {
    await readiness;
    if (!(await cacheOwnerMatches(options.owner))) throw new Error("cache owner died before admission");
    return { process: child, owner: options.owner, stopped, stop };
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "cache startup failed; termination unresolved");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
