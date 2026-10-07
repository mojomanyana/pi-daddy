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
import { cacheOwnerMatches, readCacheOwner, type CacheOwnerIdentity } from "../kernel/cache-owner.ts";
import { cacheNamespaceTerminated, type observeCacheNamespace } from "./cache-namespace-death.ts";
import { CacheSupervisorCleanup, CacheSupervisorTerminationError } from "./cache-supervisor-cleanup.ts";
import {
  acquireCacheSupervisorNamespace,
  cacheSupervisorBirthPorts,
  parseCacheSupervisorBirth,
  CACHE_SUPERVISOR_GO,
  CACHE_SUPERVISOR_BIRTH_BYTES,
  type CacheSupervisorBirthPorts,
} from "./cache-supervisor-birth.ts";

export interface CacheSupervisorOptions {
  owner: CacheOwnerIdentity;
  /** Trusted package-selected entry. Never supplied by a cache requester. */
  entry: URL;
  args?: string[];
  cwd?: string;
  bwrap?: string;
  initializationMs?: number;
  /** Startup cancellation joins namespace termination; after admission the caller owns stop(). */
  signal?: AbortSignal;
  /** Test synchronization and progress observation; never supplies authority. */
  onSpawn?: () => void;
  onData?: (stream: "stdout" | "stderr", bytes: Buffer) => void;
}
export interface CacheSupervisorHandle {
  process: ChildProcessWithoutNullStreams;
  owner: CacheOwnerIdentity;
  stopped: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): Promise<void>;
  /** Explicit resource retry does not change the original memoized stop failure. */
  retryCleanup(): Promise<void>;
}

/** The second argument is a trusted dependency port, never application/requester authority. */
export async function startSupervisedCache(
  options: CacheSupervisorOptions,
  namespacePorts: CacheSupervisorBirthPorts<
    Awaited<ReturnType<typeof observeCacheNamespace>>
  > = cacheSupervisorBirthPorts,
): Promise<CacheSupervisorHandle> {
  options.signal?.throwIfAborted();
  if (process.platform !== "linux")
    throw new Error("cache supervision requires Linux PID/user namespaces and Bubblewrap");
  if (options.owner.pid !== process.pid)
    throw new Error("cache supervision owner must be the actual calling root process");
  if (!(await cacheOwnerMatches(options.owner))) throw new Error("cache supervision owner is absent or changed");
  options.signal?.throwIfAborted();
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
    spawned = false,
    spawnRefused = false,
    birthReceived = false;
  let birthResolve!: (owner: CacheOwnerIdentity) => void, birthReject!: (error: unknown) => void;
  const birth = new Promise<CacheOwnerIdentity>((resolve, reject) => {
    birthResolve = resolve;
    birthReject = reject;
  });
  let launcherResolve!: (owner: CacheOwnerIdentity | PromiseLike<CacheOwnerIdentity>) => void,
    launcherReject!: (error: unknown) => void;
  const launcherBirth = new Promise<CacheOwnerIdentity>((resolve, reject) => {
    launcherResolve = resolve;
    launcherReject = reject;
  });
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
        // Node's spawn refusal with no allocated PID independently certifies that no launcher began.
        spawnRefused =
          child.pid === undefined && (error as NodeJS.ErrnoException).syscall?.startsWith("spawn") === true;
        const refusal = new Error(`cache supervision could not start: ${error.message}`);
        birthReject(refusal);
        launcherReject(refusal);
        failed(refusal);
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
  child.stdout.once("end", () => {
    if (!birthReceived) birthReject(new Error("cache bootstrap birth unavailable after control EOF; retain"));
  });
  child.stdout.on("data", (bytes: Buffer) => {
    if (!birthReceived) {
      output = Buffer.concat([output, bytes]);
      const end = output.indexOf(10);
      if (output.length > CACHE_SUPERVISOR_BIRTH_BYTES) {
        birthReceived = true;
        phase = "failed";
        output = Buffer.alloc(0);
        const error = new Error("cache bootstrap birth exceeded bound");
        birthReject(error);
        failed(error);
        return;
      }
      if (end < 0) return;
      birthReceived = true;
      try {
        birthResolve(parseCacheSupervisorBirth(output.subarray(0, end)));
      } catch (error) {
        birthReject(error);
        failed(error instanceof Error ? error : new Error(String(error)));
      }
      output = output.subarray(end + 1);
      if (output.length) {
        failed(new Error("cache bootstrap emitted bytes before GO"));
        output = Buffer.alloc(0);
      }
      return;
    }
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
    launcherResolve(readCacheOwner(child.pid!));
    options.onSpawn?.();
  });
  const send = (signal: NodeJS.Signals) => {
    if (finished) return; // Only signaling is skipped; observation/descriptor joins remain mandatory.
    if (!child.kill(signal)) controlFault ||= `${signal} was not delivered`;
    if (controlFault) throw new Error(`cache supervision process control failed: ${controlFault}`);
  };
  const cleanup = new CacheSupervisorCleanup<Awaited<ReturnType<typeof observeCacheNamespace>>>({
    acquire: async () => {
      const [actual, launcher] = await Promise.all([birth, launcherBirth]);
      return acquireCacheSupervisorNamespace(actual, options.owner, launcher, namespacePorts);
    },
    launcherStopped: stopped.then(() => {}),
    spawnRefused: () => spawnRefused,
    cancelAdmission: () => {
      phase = "failed";
    },
    stopLauncher: () => send("SIGTERM"),
    forceLauncher: () => send("SIGKILL"),
    terminated: cacheNamespaceTerminated,
    wait: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    timer: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  });
  const stop = () => cleanup.stop();
  child.stdin.on("error", (error) => {
    controlFault ||= error.message;
    failed(new Error(`cache supervision private input failed: ${error.message}`));
  });
  const admit = cleanup.acquired().then(async () => {
    if (!(await cacheOwnerMatches(options.owner))) throw new Error("cache owner died before entry admission");
    options.signal?.throwIfAborted();
    if (cleanup.admissionCancelled || phase === "failed")
      throw new Error("cache supervision initialization cancelled before GO");
    child.stdin.write(CACHE_SUPERVISOR_GO);
  });
  void admit.catch((error) => failed(error instanceof Error ? error : new Error(String(error))));
  const abort = () => {
    phase = "failed";
    failed(options.signal?.reason instanceof Error ? options.signal.reason : new Error("cache supervision initialization cancelled", { cause: options.signal?.reason }));
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(
    () => failed(new Error(`cache supervision initialization exceeded ${initializationMs}ms`)),
    initializationMs,
  );
  try {
    await readiness;
    await admit;
    if (!(await cacheOwnerMatches(options.owner))) throw new Error("cache owner died before admission");
    options.signal?.throwIfAborted();
    return { process: child, owner: options.owner, stopped, stop, retryCleanup: () => cleanup.retryCleanup() };
  } catch (error) {
    try {
      await stop();
    } catch (termination) {
      throw new CacheSupervisorTerminationError(
        [error, termination],
        () => cleanup.retryCleanup(),
        () => cleanup.retainedOwners,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
