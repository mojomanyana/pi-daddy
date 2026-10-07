/**
 * Trusted fixed-descriptor native observation adapter. No authority/eligibility/freshness endpoint.
 * Directories cover immediate entries only; files/symlinks stay on their original physical inode.
 * Symlink watches cover inode metadata/self events, NOT the target or resolved pathname.
 * Drain ACK means only kernel EAGAIN + preceding frames processed, never a common-current-cut proof.
 * Content guards, mount view, complete coverage and qualified mutation/profile semantics are separate.
 */
import type { BigIntStats } from "node:fs";
import { cacheOwnerMatches, type CacheOwnerIdentity } from "../kernel/cache-owner.ts";
import {
  INODE_MAX_FRAME,
  INODE_MAX_OBJECTS,
  parseInodeFrame,
  type InodeWatch,
} from "../kernel/cache-inode-protocol.ts";
import { InodeEpochs } from "../kernel/cache-inode-epochs.ts";
import { startLeaseProcess } from "./cache-lease-process.ts";
export interface InodeObserverOptions {
  binary: string;
  sha256: string;
  owner: CacheOwnerIdentity;
  /** Borrowed descriptors must stay live through admission; mandatory kernel identity/type pins. */
  objects: readonly { fd: number; info: BigIntStats }[];
}
export async function startInodeObserver(options: InodeObserverOptions) {
  if (options.owner.pid !== process.pid || !(await cacheOwnerMatches(options.owner)))
    throw new Error("inode observation owner must be the actual live caller");
  if (!options.objects.length || options.objects.length > INODE_MAX_OBJECTS)
    throw new Error("inode observation object count is invalid");
  const objects = options.objects.map(({ fd, info }) => {
    if (!Number.isSafeInteger(fd) || fd < 3 || !(info.isFile() || info.isDirectory() || info.isSymbolicLink()))
      throw new Error("inode observation needs a live regular file or directory or symlink descriptor");
    return {
      fd,
      dev: String(info.dev),
      ino: String(info.ino),
      kind: info.isFile() ? ("file" as const) : info.isDirectory() ? ("directory" as const) : ("symlink" as const),
    };
  });
  const processHandle = await startLeaseProcess(
    options.binary,
    options.sha256,
    [
      String(process.pid),
      ...objects.map(
        (object) =>
          `${object.fd}:${object.dev}:${object.ino}:${object.kind === "file" ? 1 : object.kind === "directory" ? 2 : 3}`,
      ),
    ],
    false,
  );
  const child = processHandle.child;
  const watches: InodeWatch[] = [];
  let ready = false,
    armed = false,
    closing = false,
    failed: Error | undefined,
    state: InodeEpochs | undefined;
  let buffer = Buffer.alloc(0),
    startupBytes = 0,
    seq = 0,
    acknowledged = 0;
  const pending = new Map<number, { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  let admitResolve: () => void = () => {},
    admitReject: (err: Error) => void = () => {};
  const admitted = new Promise<void>((resolve, reject) => {
    admitResolve = resolve;
    admitReject = reject;
  });
  let faultResolve: (err: Error) => void = () => {};
  const faulted = new Promise<Error>((resolve) => {
    faultResolve = resolve;
  });
  let faultCleanup: Promise<void> | undefined;
  const fault = (err: Error) => {
    if (failed) return;
    failed = err;
    state?.lose(err.message);
    // Own terminal cleanup before exposing refusal; never infer death from signal delivery.
    faultCleanup = processHandle
      .stop()
      .catch((cleanupError) => {
        failed = new AggregateError([err, cleanupError], `${err.message}; ${String(cleanupError)}`);
      })
      .then(() => {
        faultResolve(failed!);
      });
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(err);
    }
    pending.clear();
    admitReject(err);
  };
  for (const [name, stream] of [
    ["input", child.stdin!],
    ["events", child.stdout!],
    ["diagnostics", child.stderr!],
  ] as const)
    stream.on("error", (err) => fault(new Error(`inode observation ${name} transport failed: ${err.message}`)));
  child.on("error", (err) => fault(new Error(`inode observation process failed: ${err.message}`)));
  // Diagnostics are drained but not interpreted as proof or retained unboundedly.
  child.stderr!.resume();
  child.stdout!.on("data", (bytes: Buffer) => {
    if (failed) return;
    try {
      if (bytes.length > 256 * 1024) throw new Error("inode observation transport chunk exceeded bound");
      if (!armed && (startupBytes += bytes.length) > 1024 * 1024)
        throw new Error("inode observation startup output exceeded bound");
      buffer = Buffer.concat([buffer, bytes]);
      let end: number;
      while ((end = buffer.indexOf(10)) !== -1) {
        const frame = buffer.subarray(0, end + 1);
        buffer = buffer.subarray(end + 1);
        const event = parseInodeFrame(frame.toString("ascii"));
        if (frame.some((byte) => byte !== 10 && (byte < 32 || byte > 126)))
          throw new Error("inode observation non-ASCII control frame");
        if (event.kind === "fault")
          throw new Error(`inode observation native refusal: ${event.reason}: ${event.errno}`);
        if (event.kind === "ready") {
          if (ready || event.count !== objects.length) throw new Error("inode observation readiness mismatch");
          ready = true;
          continue;
        }
        if (!ready) throw new Error("inode observation evidence before readiness");
        if (event.kind === "watch") {
          const expected = objects[watches.length],
            object = event.object;
          if (
            armed ||
            !expected ||
            object.index !== watches.length ||
            object.dev !== expected.dev ||
            object.ino !== expected.ino ||
            object.kind !== expected.kind
          )
            throw new Error("inode observation coverage identity mismatch");
          watches.push(object);
          if (watches.length === objects.length) state = new InodeEpochs(watches);
          continue;
        }
        if (event.kind === "armed") {
          if (armed || !state) throw new Error("inode observation incomplete or duplicate admission");
          armed = true;
          admitResolve();
          continue;
        }
        if (event.kind === "event") {
          if (!state) throw new Error("inode observation event before fixed coverage");
          state.event(event);
          continue;
        }
        const request = pending.get(event.seq);
        if (!armed || !request || event.seq !== acknowledged + 1)
          throw new Error("inode observation unsolicited or out-of-order drain acknowledgment");
        acknowledged = event.seq;
        pending.delete(event.seq);
        clearTimeout(request.timer);
        request.resolve();
      }
      if (buffer.length >= INODE_MAX_FRAME) throw new Error("inode observation frame exceeded bound");
    } catch (err) {
      fault(err instanceof Error ? err : new Error(String(err)));
    }
  });
  child.stdout!.on("end", () => {
    if (!closing) fault(new Error("inode observation event transport ended"));
  });
  void processHandle.stopped.then(({ code, signal }) => {
    state?.lose(`observer stopped (${code ?? signal})`);
    if (!closing || pending.size) fault(new Error(`inode observation helper stopped (${code ?? signal})`));
  });
  const timer = setTimeout(() => fault(new Error("inode observation admission exceeded 3000ms")), 3000);
  try {
    await admitted;
    if (failed) throw failed;
  } catch (err) {
    await faultCleanup;
    throw failed ?? err;
  } finally {
    clearTimeout(timer);
  }
  const admittedState = state!;
  return {
    pid: child.pid!,
    stopped: processHandle.stopped,
    faulted,
    manifest: () => admittedState.manifest(),
    ticket: (scope: readonly number[]) => admittedState.ticket(scope),
    observationsUnchanged: (ticket: Parameters<InodeEpochs["observationsUnchanged"]>[0]) =>
      admittedState.observationsUnchanged(ticket),
    drain(): Promise<void> {
      if (failed || closing) return Promise.reject(failed ?? new Error("inode observation is closed"));
      if (pending.size >= 64 || seq === Number.MAX_SAFE_INTEGER)
        return Promise.reject(new Error("inode observation drain admission limit reached"));
      const current = ++seq;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => fault(new Error("inode observation drain exceeded 2000ms; observations lost")),
          2000,
        );
        pending.set(current, { resolve, reject, timer: timeout });
        child.stdin!.write(`I1 D ${current}\n`);
      });
    },
    async stop() {
      closing = true;
      admittedState.lose("observer closed");
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("inode observation closed"));
      }
      pending.clear();
      await processHandle.stop();
    },
  };
}
