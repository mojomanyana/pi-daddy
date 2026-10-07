/** Owned trusted CP1 startup, not native-image/source/ABI qualification or cache policy.
 * Root supplies an already qualified broker executable and private socket pathname.
 * Socket parent/path storage remains caller-owned; never unlink a stale pathname here.
 */
import type { CacheOwnerIdentity } from "../kernel/cache-owner.ts";
import { startSupervisedCache } from "./cache-supervisor.ts";
export interface CacheNativeBrokerOptions {
  parent: CacheOwnerIdentity;
  executable: string;
  socket: string;
  initializationMs: number;
  signal?: AbortSignal;
  onData(bytes: Buffer): void;
  onEnd(error: Error): void;
}
export interface CacheNativeBrokerHandle {
  write(frame: string): void;
  stop(): Promise<void>;
  /** Actual supervisor resource capability; never changes the original failed stop. */
  retryCleanup?(): Promise<void>;
}
export async function startCacheNativeBroker(options: CacheNativeBrokerOptions): Promise<CacheNativeBrokerHandle> {
  if (!options.executable.startsWith("/") || options.executable.includes("\0") || options.executable.length > 4096)
    throw Error("cache native broker executable malformed");
  const entry = new URL(
    import.meta.url.endsWith(".ts") ? "./cache-native-broker-worker.ts" : "./cache-native-broker-worker.js",
    import.meta.url,
  );
  const handle = await startSupervisedCache({
    owner: options.parent,
    entry,
    args: [options.executable, options.socket],
    signal: options.signal,
    initializationMs: options.initializationMs,
    onData: (stream, bytes) => {
      if (stream === "stdout") options.onData(bytes);
    },
  });
  let intentionalStop = false;
  const ended = (error: Error) => { if (!intentionalStop) options.onEnd(error); };
  handle.process.stdin.on("error", options.onEnd);
  handle.process.stdout.on("error", options.onEnd);
  handle.process.stdout.once("end", () => ended(Error("cache native broker control EOF")));
  void handle.stopped.then((result) =>
    ended(Error(`cache native broker stopped (${result.code ?? result.signal})`)),
  );
  return {
    write: (frame) => {
      if (handle.process.stdin.destroyed || !handle.process.stdin.writable)
        throw Error("cache native broker private input unavailable");
      handle.process.stdin.write(frame);
    },
    stop: () => {
      intentionalStop = true; // Publish before termination/EOF; physical stop errors still reject to the owner.
      return handle.stop();
    },
    retryCleanup: handle.retryCleanup,
  };
}
