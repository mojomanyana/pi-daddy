/** Read the immutable target of an owned O_PATH symlink pin, not a second name lookup.
 * Internal OS primitive only: NOT coherent name/access metadata, freshness or eligibility.
 * Each call launches one unprivileged leaf; output is accepted only after strict framing,
 * stream closure, successful exit and known boot/PID/start death. No installation/cap grant.
 */
import { startLeaseProcess } from "./cache-lease-process.ts";
import { readCacheOwner, cacheProcessTerminated } from "../kernel/cache-owner.ts";
export interface HeldSymlinkOptions {
  binary: string;
  sha256: string;
  input: { fd: number; dev: bigint; ino: bigint };
  maxTargetBytes: number;
  signal?: AbortSignal;
}
export class HeldSymlinkCleanupError extends AggregateError {
  readonly stop: () => Promise<void>;
  constructor(errors: unknown[], stop: () => Promise<void>) {
    super(errors, "held symlink cleanup unresolved; owned retry required");
    this.stop = stop;
  }
}
export async function readHeldSymlink(options: HeldSymlinkOptions): Promise<Buffer> {
  const { binary, sha256, maxTargetBytes, signal } = options,
    { fd, dev, ino } = options.input;
  if (!Number.isSafeInteger(maxTargetBytes) || maxTargetBytes < 1 || maxTargetBytes > 4096)
    throw new Error("held symlink invalid maxTargetBytes");
  if (
    !Number.isSafeInteger(fd) ||
    fd < 3 ||
    fd > 0x7fffffff ||
    typeof dev !== "bigint" ||
    typeof ino !== "bigint" ||
    dev < 0n ||
    ino < 0n ||
    dev > 0xffffffffffffffffn ||
    ino > 0xffffffffffffffffn
  )
    throw new Error("held symlink invalid descriptor identity");
  if (signal?.aborted) throw new Error("held symlink aborted before launch");
  const leaf = await startLeaseProcess(
    binary,
    sha256,
    [String(process.pid), String(fd), String(dev), String(ino), String(maxTargetBytes)],
    false,
  );
  let stage: "ready" | "pin" | "pinned" | "read" | "done" = "ready",
    partial = "",
    used = 0,
    failure: Error | undefined,
    payload: Buffer | undefined;
  let ready!: () => void;
  const admission = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let notifyFailure!: () => void;
  const failed = new Promise<void>((resolve) => {
    notifyFailure = resolve;
  });
  const fail = (error: Error) => {
    failure ||= error;
    ready();
    notifyFailure();
  };
  const closed = new Promise<void>((resolve) => {
    leaf.child.once("close", () => {
      failIfIncomplete();
      resolve();
    });
    // startLeaseProcess awaits executable close; an early exit can precede listener setup.
    void leaf.stopped.then(() => {
      if (leaf.child.stdout!.destroyed && leaf.child.stderr!.destroyed) {
        failIfIncomplete();
        resolve();
      }
    });
  });
  const failIfIncomplete = () => {
    if (stage !== "done") fail(new Error("held symlink helper stopped before complete payload"));
  };
  leaf.child.stdout!.on("data", (chunk: Buffer) => {
    used += chunk.length;
    if (used > 2 * maxTargetBytes + 256 || [...chunk].some((b) => b < 10 || b > 126 || (b > 10 && b < 32))) {
      fail(new Error("held symlink output exceeds bounds or framing"));
      return;
    }
    partial += chunk.toString("ascii");
    for (;;) {
      const end = partial.indexOf("\n");
      if (end < 0) break;
      const line = partial.slice(0, end);
      partial = partial.slice(end + 1);
      if (failure) continue;
      if (line === "S1 READY" && stage === "ready") {
        stage = "pin";
        ready();
      } else if (line === "S1 PINNED" && stage === "pinned") {
        stage = "read";
        leaf.child.stdin!.end("R\n");
      } else if (line.startsWith("S1 F ")) fail(new Error(`held symlink native refusal: ${line.slice(5)}`));
      else {
        const fields = /^S1 LINK (0|[1-9][0-9]*) (0|[1-9][0-9]*) ((?:[0-9a-f]{2})+)$/.exec(line);
        if (
          stage !== "read" ||
          !fields ||
          fields[1] !== String(dev) ||
          fields[2] !== String(ino) ||
          fields[3].length > maxTargetBytes * 2 ||
          fields[3].match(/../g)!.includes("00")
        )
          fail(new Error("held symlink incompatible, duplicate or oversized frame"));
        else {
          payload = Buffer.from(fields[3], "hex");
          stage = "done";
        }
      }
    }
  });
  leaf.child.stderr!.on("data", (b: Buffer) => {
    if (b.length) fail(new Error("held symlink unexpected diagnostic output"));
  });
  for (const stream of [leaf.child.stdin!, leaf.child.stdout!, leaf.child.stderr!])
    stream.on("error", (error) => fail(new Error("held symlink control failed", { cause: error })));
  leaf.child.on("error", (error) => fail(new Error("held symlink spawn failed", { cause: error })));
  let timer: NodeJS.Timeout | undefined;
  const abort = () => fail(new Error("held symlink aborted"));
  let owner: Awaited<ReturnType<typeof readCacheOwner>> | undefined;
  const awaitClosed = async () => {
    let deadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("held symlink stream closure unresolved after 1500ms")), 1500);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  };
  const cleanup = async () => {
    // A prior stop timeout is cached by the shared leaf launcher. Reconcile known death on retry.
    if (!owner || !(await cacheProcessTerminated(owner))) await leaf.stop();
    await awaitClosed();
    if (!owner || !(await cacheProcessTerminated(owner)))
      throw new Error("held symlink identity/termination unproved; retain ownership");
  };
  try {
    // Real leaf cannot proceed to descriptor access until this actual identity is admitted.
    owner = await readCacheOwner(leaf.child.pid!);
    const interrupted = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        fail(new Error("held symlink exceeded 3000ms"));
        resolve();
      }, 3000);
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    await Promise.race([admission, interrupted]);
    if (failure) throw failure;
    stage = "pinned";
    leaf.child.stdin!.write("P\n");
    // Event failures must stop ownership promptly, even if the helper is waiting on stdin.
    await Promise.race([closed, failed, interrupted]);
    if (failure) throw failure;
    if (partial) throw new Error("held symlink trailing incomplete frame");
    const exit = await leaf.stopped;
    if (exit.code !== 0 || exit.signal) throw new Error(`held symlink helper stopped (${exit.code ?? exit.signal})`);
    if (!payload) throw new Error("held symlink missing target");
    if (!(await cacheProcessTerminated(owner))) throw new Error("held symlink termination unproved");
    return payload;
  } catch (error) {
    try {
      await cleanup();
    } catch (stopError) {
      throw new HeldSymlinkCleanupError([error, stopError], cleanup);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
