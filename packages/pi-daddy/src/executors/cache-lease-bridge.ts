/**
 * Node protocol/lifetime adapter for the OS-only read-lease leaf. It never authorizes a caller,
 * constructs a cache key, or infers determinism. Refused/invalid/lost evidence cannot become validity.
 * Numeric incarnation IDs are never reused, including when the caller's descriptor number is reused.
 * Required capabilities are reported, not installed or inherited into Pi or executed commands.
 */
import type { BigIntStats } from "node:fs";
import { cacheOwnerMatches, type CacheOwnerIdentity } from "../kernel/cache-owner.ts";
import {
  CACHE_LEASE_CAPACITY,
  CACHE_LEASE_FRAME_BYTES,
  parseCacheLeaseFrame,
  type CacheLeaseReply,
} from "../kernel/cache-lease-protocol.ts";
import { startLeaseProcess } from "./cache-lease-process.ts";

export interface CacheLeaseOptions {
  binary: string;
  binarySha256: string;
  owner: CacheOwnerIdentity;
  /** Host identity of coordinator; pidfd loss closes the helper even if its root parent survives. */
  peer: CacheOwnerIdentity;
  requirePrivilege?: boolean;
  onLoss: (id: string | undefined, reason: string) => void;
}
export interface CacheContentLease {
  id: string;
  check(): Promise<boolean>;
  release(): Promise<void>;
}
export type CacheLeaseAcquisition = { ok: true; lease: CacheContentLease } | { ok: false; reason: string };

export async function startCacheLeaseBridge(options: CacheLeaseOptions) {
  if (options.owner.pid !== process.pid) throw new Error("cache lease owner must be the actual calling root process");
  if (!(await cacheOwnerMatches(options.owner))) throw new Error("cache lease owner identity is absent or changed");
  if (!(await cacheOwnerMatches(options.peer)) || options.peer.bootId !== options.owner.bootId)
    throw new Error("cache lease peer identity is absent or changed");
  const processHandle = await startLeaseProcess(
    options.binary,
    options.binarySha256,
    [String(process.pid), String(options.peer.pid), options.peer.startTicks, options.peer.bootId],
    options.requirePrivilege === true,
  );
  const child = processHandle.child;
  const active = new Map<string, { valid: boolean }>();
  const pending = new Map<
    number,
    { id: string; resolve: (reply: CacheLeaseReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  let seq = 0,
    incarnation = 0,
    failed: Error | undefined,
    closing = false,
    privileged = false;
  let framing: Buffer = Buffer.alloc(0),
    diagnostics = "";
  let readyResolve: () => void = () => {},
    readyReject: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let terminalResolve: (error: Error) => void = () => {};
  const faulted = new Promise<Error>((resolve) => {
    terminalResolve = resolve;
  });
  let faultCleanup: Promise<void> | undefined;
  const fault = (error: Error, notify = true) => {
    if (failed) return;
    failed = error;
    for (const state of active.values()) state.valid = false;
    // Start owned cleanup BEFORE any callback, including callbacks that throw.
    faultCleanup = processHandle
      .stop()
      .then(
        () => {
          active.clear();
        },
        (cleanupError) => {
          failed = new AggregateError([failed, cleanupError], `${failed!.message}; ${String(cleanupError)}`);
        },
      )
      .then(() => {
        terminalResolve(failed!);
      });
    if (notify) {
      try {
        options.onLoss(undefined, error.message);
      } catch (callbackError) {
        failed = new AggregateError(
          [error, callbackError],
          `${error.message}; loss callback failed: ${String(callbackError)}`,
        );
      }
    }
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(failed);
    }
    pending.clear();
    readyReject(failed);
  };
  const loss = (id: string | undefined, reason: string) => {
    if (id) {
      const entry = active.get(id);
      if (entry) entry.valid = false;
    } else for (const entry of active.values()) entry.valid = false;
    try {
      options.onLoss(id, reason);
    } catch (error) {
      fault(new Error(`cache lease loss callback failed: ${String(error)}`, { cause: error }), false);
    }
  };
  child.on("error", (error) => fault(new Error(`cache lease process control failed: ${error.message}`)));
  child.stdin!.on("error", (error) => fault(new Error(`cache lease input failed: ${error.message}`)));
  child.stdout!.on("error", (error) => fault(new Error(`cache lease evidence control failed: ${error.message}`)));
  child.stderr!.on("error", (error) => fault(new Error(`cache lease diagnostic control failed: ${error.message}`)));
  child.stderr!.on("data", (bytes: Buffer) => {
    diagnostics = (diagnostics + bytes.toString("utf8")).slice(-8192);
  });
  let admitted = false;
  child.stdout!.on("data", (bytes: Buffer) => {
    if (failed) return;
    framing = Buffer.concat([framing, bytes]);
    try {
      let end: number;
      while ((end = framing.indexOf(10)) !== -1) {
        const frame = framing.subarray(0, end + 1);
        framing = framing.subarray(end + 1);
        if (frame.length > CACHE_LEASE_FRAME_BYTES || frame.some((byte) => byte !== 10 && (byte < 32 || byte > 126)))
          throw new Error("cache lease protocol invalid bytes or frame size");
        const event = parseCacheLeaseFrame(frame.toString("ascii"));
        if (event.kind === "fatal") throw new Error(`cache lease native refusal: ${event.reason}`);
        if (event.kind === "ready") {
          if (admitted || event.parent !== process.pid || event.uid !== process.getuid!())
            throw new Error("cache lease readiness identity mismatch");
          if (options.requirePrivilege && !event.privileged)
            throw new Error("cache lease helper lacks required CAP_LEASE; explicit setup is needed");
          admitted = true;
          privileged = event.privileged;
          readyResolve();
          continue;
        }
        if (!admitted) throw new Error("cache lease evidence before readiness");
        if (event.kind === "break" || event.kind === "loss") {
          if (BigInt(event.id) > BigInt(incarnation)) throw new Error("cache lease unsolicited incarnation");
          loss(event.id, event.kind === "break" ? "content lease breaking" : `${event.reason}: ${event.errno}`);
          continue;
        }
        const request = pending.get(event.seq);
        if (!request || event.id !== request.id) throw new Error("cache lease unsolicited or mismatched reply");
        pending.delete(event.seq);
        clearTimeout(request.timer);
        request.resolve(event);
      }
      if (framing.length >= CACHE_LEASE_FRAME_BYTES) throw new Error("cache lease protocol frame exceeded bound");
    } catch (error) {
      fault(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.stdout!.on("end", () => {
    if (!closing) fault(new Error("cache lease evidence transport ended"));
  });
  void processHandle.stopped.then(({ code, signal }) => {
    if (!closing || pending.size) fault(new Error(`cache lease helper exited (${code ?? signal}): ${diagnostics}`));
    else for (const state of active.values()) state.valid = false;
  });
  const initialization = setTimeout(() => fault(new Error("cache lease initialization exceeded 3000ms")), 3000);
  try {
    await ready;
  } catch (error) {
    await faultCleanup;
    throw failed ?? error;
  } finally {
    clearTimeout(initialization);
  }

  const command = (id: string, body: string): Promise<CacheLeaseReply> => {
    if (failed || closing) return Promise.reject(failed ?? new Error("cache lease bridge is closed"));
    if (pending.size >= 64 || seq === Number.MAX_SAFE_INTEGER)
      return Promise.reject(new Error("cache lease request limit reached"));
    const requestSeq = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fault(new Error("cache lease response exceeded 2000ms; proof lost")), 2000);
      pending.set(requestSeq, { id, resolve, reject, timer });
      child.stdin!.write(`L2 ${requestSeq} ${body}\n`);
    });
  };
  return {
    privileged,
    pid: child.pid!,
    stopped: processHandle.stopped,
    /** Resolves after terminal cleanup; contains callback/control/termination failures rather than hiding them. */
    faulted,
    async acquire(fd: number, info: BigIntStats): Promise<CacheLeaseAcquisition> {
      if (!Number.isSafeInteger(fd) || fd < 3 || !info.isFile())
        throw new Error("cache lease acquisition needs a live regular descriptor");
      if (active.size >= CACHE_LEASE_CAPACITY || incarnation === Number.MAX_SAFE_INTEGER)
        return { ok: false, reason: "lease capacity reached" };
      const id = String(++incarnation),
        state = { valid: true };
      active.set(id, state);
      let reply: CacheLeaseReply;
      try {
        reply = await command(id, `ACQUIRE ${id} ${fd} ${info.dev} ${info.ino}`);
      } catch (error) {
        active.delete(id);
        throw error;
      }
      if (reply.status === "refused") {
        active.delete(id);
        return { ok: false, reason: `${reply.reason}: ${reply.errno}` };
      }
      if (reply.status !== "acquired" || reply.dev !== String(info.dev) || reply.ino !== String(info.ino)) {
        fault(new Error("cache lease acquisition evidence mismatched"));
        throw failed!;
      }
      const lease: CacheContentLease = {
        id,
        async check() {
          if (!state.valid || failed || closing) return false;
          const checked = await command(id, `CHECK ${id}`);
          if (checked.status === "invalid") {
            loss(id, checked.reason);
            return false;
          }
          if (checked.status !== "valid") {
            fault(new Error("cache lease validity evidence mismatched"));
            throw failed!;
          }
          return state.valid && !failed && !closing;
        },
        async release() {
          if (!active.has(id)) return;
          state.valid = false;
          try {
            const released = await command(id, `RELEASE ${id}`);
            if (released.status !== "released" && !(released.status === "invalid" && released.reason === "UNKNOWN"))
              throw new Error("cache lease release evidence mismatched");
            active.delete(id); // Affirmative native release/absence ONLY.
          } catch (error) {
            fault(error instanceof Error ? error : new Error(String(error)));
            await faultCleanup;
            throw failed ?? error;
          }
        },
      };
      return { ok: true, lease };
    },
    async stop() {
      if (!closing) {
        closing = true;
        for (const item of pending.values()) {
          clearTimeout(item.timer);
          item.reject(new Error("cache lease root shutdown"));
        }
        pending.clear();
        for (const item of active.values()) item.valid = false;
      }
      await processHandle.stop();
      active.clear();
    },
  };
}
