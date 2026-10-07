/** Qualified namespace runner for trusted personal-profile work, not a public shell endpoint.
 * Main-command completion is insufficient: stop the whole owned namespace before resolving exited.
 * Preserve channel bytes in streamed JSON frames/output; consumers decode, never invent a fresh run.
 */
import { constants as osConstants } from "node:os";
import { CACHE_STREAM_FRAME_BYTES, type CacheDataSink } from "../kernel/cache-data-sink.ts";
import { frozenPersonalInvocation, type PersonalCacheInvocation } from "../kernel/cache-personal-invocation.ts";
import {
  cacheOwnerMatches,
  cacheProcessTerminated,
  isCacheOwner,
  type CacheOwnerIdentity,
} from "../kernel/cache-owner.ts";
import { CacheStartFailure } from "../kernel/cache-start-failure.ts";
import { startSupervisedCache, type CacheSupervisorHandle } from "./cache-supervisor.ts";
import { observeCacheNamespace, cacheNamespaceTerminated } from "./cache-namespace-death.ts";

interface BashOutcome {
  output: string;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  signal: string | null;
  cancelled: boolean;
  timedOut: boolean;
  complete: boolean;
}
export interface PersonalBashOptions {
  owner: CacheOwnerIdentity;
  executionId: string;
  signal: AbortSignal;
  onData: CacheDataSink;
  outputBytes?: number;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function startPersonalBash(input: Readonly<PersonalCacheInvocation>, options: PersonalBashOptions) {
  const invocation = frozenPersonalInvocation(input),
    limit = options.outputBytes ?? 1048576;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8388608)
    throw Error("personal Bash output byte bound invalid");
  if (options.signal.aborted)
    throw new CacheStartFailure("personal Bash cancelled before startup", true, { cause: options.signal.reason });
  const outcome = deferred<BashOutcome>(),
    exited = deferred<void>();
  // Consumers attach after start; these observers prevent pre-admission rejection from escaping.
  outcome.promise.catch((error) => {
    fault ??= error;
  });
  exited.promise.catch((error) => {
    fault ??= error;
  });
  let handle: CacheSupervisorHandle | undefined,
    namespaceOwner: CacheOwnerIdentity | undefined,
    partial = Buffer.alloc(0),
    bytes = 0,
    retained = true,
    terminal = false,
    fault: unknown,
    finishing: Promise<void> | undefined,
    processing: Promise<void> | undefined,
    ending: Promise<void> | undefined;
  const output: Array<{ channel: "stdout" | "stderr"; bytes: string }> = [];
  let namespace: Awaited<ReturnType<typeof observeCacheNamespace>> | undefined;
  let namespaceAdmission: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  function stopOwned(): Promise<void> {
    return (stopping ??= (async () => {
      const deadline = Date.now() + 1500;
      await handle?.stop();
      await namespaceAdmission;
      if (!namespaceOwner) throw Error("personal Bash namespace identity unavailable; retain");
      if (!namespace) {
        if (!(await cacheProcessTerminated(namespaceOwner))) throw Error("namespace observation unavailable; retain");
        return;
      }
      if (namespace.closed) return;
      while (!(await cacheNamespaceTerminated(namespace))) {
        if (Date.now() >= deadline) throw Error("personal Bash namespace termination unresolved; retain");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await namespace.handle.close();
      namespace.closed = true;
    })());
  }
  async function fail(error: unknown) {
    fault ??= error;
    try {
      await stopOwned();
      exited.resolve();
    } catch (cleanup) {
      exited.reject(cleanup);
    }
    outcome.reject(fault);
  }
  function finish(row: Record<string, unknown>) {
    if (terminal) {
      void fail(Error("personal Bash duplicate terminal frame"));
      return;
    }
    terminal = true;
    if (
      Object.keys(row).length !== 6 ||
      typeof row.startedAt !== "string" ||
      typeof row.endedAt !== "string" ||
      !Number.isFinite(Date.parse(row.startedAt)) ||
      Date.parse(String(row.endedAt)) < Date.parse(row.startedAt) ||
      !(
        row.exitCode === null ||
        (Number.isInteger(row.exitCode) && Number(row.exitCode) >= 0 && Number(row.exitCode) <= 255)
      ) ||
      !(row.signal === null || (typeof row.signal === "string" && row.signal in osConstants.signals)) ||
      typeof row.timedOut !== "boolean"
    ) {
      void fail(Error("personal Bash terminal frame malformed"));
      return;
    }
    finishing = (async () => {
      try {
        await stopOwned();
        if (fault) throw fault;
        const report: BashOutcome = {
          output: JSON.stringify(output),
          startedAt: row.startedAt as string,
          endedAt: row.endedAt as string,
          exitCode: row.exitCode as number | null,
          signal: row.signal as string | null,
          timedOut: row.timedOut as boolean,
          cancelled: options.signal.aborted,
          complete: retained,
        };
        outcome.resolve(report);
        exited.resolve();
      } catch (error) {
        await fail(error);
      }
    })();
  }
  function frame(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      void fail(Error("personal Bash frame malformed"));
      return;
    }
    const row = value as Record<string, unknown>;
    if (terminal) {
      void fail(Error("personal Bash post-terminal frame"));
      return;
    }
    if (row.type === "owner") {
      if (
        namespaceOwner ||
        Object.keys(row).length !== 2 ||
        !isCacheOwner(row.owner) ||
        row.owner.pid === options.owner.pid ||
        row.owner.bootId !== options.owner.bootId
      ) {
        void fail(Error("personal Bash namespace owner malformed"));
        return;
      }
      namespaceOwner = Object.freeze({ ...row.owner });
      return;
    }
    if (row.type === "exit") {
      finish(row);
      return;
    }
    if (
      row.type !== "data" ||
      Object.keys(row).length !== 3 ||
      !["stdout", "stderr"].includes(String(row.channel)) ||
      typeof row.bytes !== "string" ||
      row.bytes.length > 131072
    ) {
      void fail(Error("personal Bash fault or incompatible frame"));
      return;
    }
    const raw = Buffer.from(row.bytes, "base64");
    if (raw.toString("base64") !== row.bytes) {
      void fail(Error("personal Bash output malformed"));
      return;
    }
    if (raw.length > limit - bytes || output.length >= 4096) retained = false;
    const data = { channel: row.channel as "stdout" | "stderr", bytes: row.bytes };
    if (retained) {
      bytes += raw.length;
      output.push(data);
    }
    return options.onData(Buffer.from(JSON.stringify(data) + "\n"));
  }
  function consume(): void {
    if (processing) return;
    while (!fault) {
      const end = partial.indexOf(10);
      if (end < 0) break;
      const line = partial.subarray(0, end);
      partial = partial.subarray(end + 1);
      try {
        const returned = frame(JSON.parse(line.toString("utf8")));
        if (returned && typeof returned.then === "function") {
          handle?.process.stdout.pause();
          const owned = Promise.resolve(returned)
            .then(
              () => {
                if (processing === owned) processing = undefined;
                consume();
              },
              (error) => fail(error),
            )
            .finally(() => {
              if (processing === owned) processing = undefined;
              if (!processing && !fault) handle?.process.stdout.resume();
            });
          processing = owned;
          void owned.catch((error) => {
            void fail(error);
          });
          return;
        }
      } catch (error) {
        void fail(error);
      }
    }
    if (fault) partial = Buffer.alloc(0);
  }
  const abort = () => {
    if (handle) void fail(Error("personal Bash request cancelled"));
  };
  try {
    handle = await startSupervisedCache({
      owner: options.owner,
      signal: options.signal,
      entry: new URL(
        import.meta.url.endsWith(".ts") ? "./cache-personal-bash-worker.ts" : "./cache-personal-bash-worker.js",
        import.meta.url,
      ),
      onData: (stream, data) => {
        if (stream === "stderr") {
          void fail(Error("personal Bash worker diagnostics"));
          return;
        }
        partial = Buffer.concat([partial, data]);
        if (partial.length > CACHE_STREAM_FRAME_BYTES) {
          void fail(Error("personal Bash frame byte bound exceeded"));
          return;
        }
        consume();
      },
    });
    namespaceAdmission = (async () => {
      if (fault || !namespaceOwner || !(await cacheOwnerMatches(namespaceOwner)))
        throw Error("personal Bash namespace admission failed");
      namespace = await observeCacheNamespace(namespaceOwner);
    })();
    options.signal.addEventListener("abort", abort, { once: true });
    await namespaceAdmission;
    if (options.signal.aborted) {
      await stopOwned();
      throw Error("personal Bash request cancelled before command");
    }
    handle.process.stdin.on("error", (error) => {
      void fail(error);
    });
    handle.process.stdin.end(JSON.stringify(invocation) + "\n");
    // Launcher/worker exit is NOT EOF: paused stdout can still hold complete data/terminal frames.
    handle.process.stdout.once("end", () => {
      ending = (async () => {
        while (processing) await processing;
        if (!terminal) await fail(Error("personal Bash namespace exited without terminal frame"));
      })();
      void ending.catch((error) => {
        void fail(error);
      });
    });
  } catch (error) {
    options.signal.removeEventListener("abort", abort);
    let cleanupVerified = false;
    try {
      await handle?.stop();
      if (handle || namespaceOwner) {
        await stopOwned();
        cleanupVerified = !(error instanceof AggregateError);
      }
    } catch (cleanup) {
      throw new CacheStartFailure("personal Bash startup termination unresolved", false, {
        cause: new AggregateError([error, cleanup]),
      });
    }
    throw new CacheStartFailure("personal Bash startup failed", cleanupVerified, { cause: error });
  }
  outcome.promise
    .finally(() => options.signal.removeEventListener("abort", abort))
    .catch((error) => {
      fault ??= error;
    });
  return {
    outcome: outcome.promise,
    exited: exited.promise,
    stop: async () => {
      await stopOwned();
      if (!terminal) await fail(Error("personal Bash execution stopped"));
      await finishing;
      while (processing) await processing;
      await ending;
    },
  };
}
