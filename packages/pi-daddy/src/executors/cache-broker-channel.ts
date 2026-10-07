/** Inactive Node CP1 channel over an already-owned native helper's PRIVATE pipes.
 * Never give a requester these pipes. Caller supplies supervised stop and handles pipe error/EOF.
 * Kernel OPEN PID plus a bounded birth-identity read goes to trusted current authorization;
 * neither application bytes nor connection IDs supply authority. C's pidfd live checks bind the
 * original connector, NOT subsequent writers of a transferred socket. Future frontend must keep
 * its socket private/CLOEXEC and independently qualify native invocation context.
 * Callbacks are synchronous consumers: no async application queue. Each peer has one output credit.
 * Failure closes admission, rejects ambiguous deliveries without retry and joins pending identities
 * and supervised stop. A rejected shutdown retains that cleanup owner; never claim task-tree death
 * merely from this adapter's CLOSED events. No process creation, cache or command endpoint here.
 */
import { readCacheOwner, isCacheOwner, type CacheOwnerIdentity } from "../kernel/cache-owner.ts";
import { BoundedReadCleanupError } from "../kernel/bounded-read.ts";
import {
  CACHE_BROKER_CHUNK,
  CACHE_BROKER_FRAME,
  CACHE_BROKER_PEERS,
  parseCacheBrokerEvent,
  type CacheBrokerEvent,
} from "../kernel/cache-broker-protocol.ts";
export interface CacheBrokerPeer {
  readonly identity: Readonly<CacheOwnerIdentity>;
  send(bytes: Buffer): Promise<void>;
  close(): void;
}
export interface CacheBrokerChannelOptions {
  /** Writes one newline-terminated control to the private helper pipe; must throw on unavailable pipe.
   * Backpressure return false is safe: bounded credits limit queued control storage.
   * Async pipe errors MUST call end(error). No other producer may write this pipe.
   */
  write(frame: string): void;
  stop(): Promise<void>;
  authorize(identity: Readonly<CacheOwnerIdentity>): boolean;
  onPeer(peer: CacheBrokerPeer): void;
  onData(peer: CacheBrokerPeer, bytes: Buffer): void;
  onClosed?(peer: CacheBrokerPeer): void;
  /** Diagnostics without raw application bytes. Identity uncertainty closes only that connection. */
  onRejected?(reason: string): void;
  /** Component limit, not a qualified profile default or delivery guarantee. */
  deadlineMs: number;
  /** Owned test seam; production uses bounded host proc reads. */
  identify?: (pid: number) => Promise<CacheOwnerIdentity>;
}
interface Slot {
  id: number;
  pid: number;
  state: "opening" | "verifying" | "verified" | "closing";
  peer?: CacheBrokerPeer;
  notified: boolean;
  pending?: { bytes: number; resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout };
}
export class CacheBrokerChannel {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private options: CacheBrokerChannelOptions;
  private partial: Buffer = Buffer.alloc(0);
  private slots = new Map<number, Slot>();
  private openings = new Set<Promise<void>>();
  private sequence = 0;
  private initialized = false;
  private finishing = false;
  private failure?: Error;
  private stopping?: Promise<void>;
  constructor(options: CacheBrokerChannelOptions) {
    if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 30000)
      throw Error("cache broker deadline must be 1..30000ms");
    this.options = options;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Exposed promise still rejects; prevent an unhandled rejection before its owner awaits it.
    void this.ready.catch(() => {});
  }
  feed(bytes: Buffer): void {
    if (this.finishing) return;
    try {
      // Process complete frames incrementally; never concatenate an unbounded pipe chunk.
      let start = 0;
      while (start < bytes.length) {
        const end = bytes.indexOf(10, start),
          limit = end < 0 ? bytes.length : end;
        const piece = bytes.subarray(start, limit);
        if (this.partial.length + piece.length > CACHE_BROKER_FRAME || piece.includes(0))
          throw Error("cache broker protocol: control frame invalid or oversized");
        this.partial = Buffer.concat([this.partial, piece]);
        if (end < 0) break;
        if (this.partial.some((byte) => byte > 127)) throw Error("cache broker protocol: non-ASCII control");
        const event = parseCacheBrokerEvent(this.partial.toString("ascii"));
        this.partial = Buffer.alloc(0);
        this.event(event);
        if (this.finishing) break;
        start = end + 1;
      }
    } catch (error) {
      this.fault(error);
    }
  }
  end(error?: Error): void {
    if (!this.finishing)
      this.fault(error ?? Error(`cache broker control ${this.partial.length ? "incomplete frame at " : ""}EOF`));
  }
  private write(frame: string) {
    this.options.write(frame + "\n");
  }
  private allowed(slot: Slot) {
    return (
      !this.finishing && slot.state !== "closing" && !!slot.peer && this.options.authorize(slot.peer.identity) === true
    );
  }
  private event(event: CacheBrokerEvent) {
    if (event.kind === "READY") {
      if (this.initialized) throw Error("cache broker protocol: duplicate READY");
      this.initialized = true;
      this.resolveReady();
      return;
    }
    if (!this.initialized) throw Error("cache broker protocol: event before READY");
    if (event.kind === "OPEN") {
      this.open(event.id, event.pid);
      return;
    }
    const slot = this.slots.get(event.id);
    if (!slot) throw Error("cache broker protocol: unknown connection");
    if (event.kind === "CLOSED") {
      this.retire(slot, Error("cache broker peer closed"));
      this.slots.delete(slot.id);
      return;
    }
    // CLOSE and a pre-existing native read/send can cross on the pipes. Never deliver either.
    if (slot.state === "closing") return;
    if (event.kind === "VERIFIED") {
      if (slot.state !== "verifying" || event.pid !== slot.pid)
        throw Error("cache broker protocol: unexpected verification");
      if (!this.allowed(slot)) {
        this.close(slot, Error("cache broker peer authorization revoked"));
        return;
      }
      slot.state = "verified";
      slot.notified = true;
      this.options.onPeer(slot.peer!);
      return;
    }
    if (slot.state !== "verified") throw Error("cache broker protocol: unverified delivery");
    if (!this.allowed(slot)) {
      this.close(slot, Error("cache broker peer authorization revoked"));
      return;
    }
    if (event.kind === "DATA") {
      this.options.onData(slot.peer!, event.bytes);
      return;
    }
    const pending = slot.pending;
    if (!pending || pending.bytes !== event.bytes) throw Error("cache broker protocol: unexpected send credit");
    clearTimeout(pending.timer);
    slot.pending = undefined;
    pending.resolve();
  }
  private open(id: number, pid: number) {
    if (id <= this.sequence || this.slots.size >= CACHE_BROKER_PEERS || this.openings.size >= CACHE_BROKER_PEERS)
      throw Error("cache broker protocol: identity sequence or owner bound exceeded");
    this.sequence = id;
    const slot: Slot = { id, pid, state: "opening", notified: false };
    this.slots.set(id, slot);
    // Charge the promise immediately; CLOSED cannot remove a still-pending identity owner.
    const task = this.identify(slot);
    this.openings.add(task);
    void task.then(
      () => {
        this.openings.delete(task);
      },
      (error) => {
        this.fault(error);
        this.openings.delete(task);
      },
    );
  }
  private async identify(slot: Slot) {
    let identity: CacheOwnerIdentity;
    try {
      identity = await (this.options.identify ?? readCacheOwner)(slot.pid);
    } catch (error) {
      if (error instanceof BoundedReadCleanupError) throw error;
      if (!this.finishing && this.slots.get(slot.id) === slot) {
        this.options.onRejected?.(error instanceof Error ? error.message : "peer birth identity unavailable");
        this.close(slot, Error("cache broker peer identity unavailable"));
      }
      return;
    }
    if (this.finishing || this.slots.get(slot.id) !== slot || slot.state !== "opening") return;
    if (!isCacheOwner(identity) || identity.pid !== slot.pid) {
      this.options.onRejected?.("peer birth identity incompatible");
      this.close(slot, Error("cache broker peer identity incompatible"));
      return;
    }
    const peer: CacheBrokerPeer = Object.freeze({
      identity: Object.freeze({ ...identity }),
      send: (bytes: Buffer) => this.send(slot, bytes),
      close: () => {
        try {
          this.close(slot, Error("cache broker peer closed"));
        } catch (error) {
          this.fault(error);
        }
      },
    });
    slot.peer = peer;
    if (!this.allowed(slot)) {
      this.close(slot, Error("cache broker peer authorization denied"));
      return;
    }
    slot.state = "verifying";
    this.write(`CP1 VERIFY ${slot.id} ${slot.pid}`);
  }
  private send(slot: Slot, bytes: Buffer): Promise<void> {
    try {
      if (!this.allowed(slot)) {
        this.close(slot, Error("cache broker peer authorization revoked or closed"));
        return Promise.reject(Error("cache broker peer authorization revoked or closed"));
      }
      if (slot.state !== "verified") return Promise.reject(Error("cache broker peer not verified"));
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > CACHE_BROKER_CHUNK)
        return Promise.reject(Error("cache broker output chunk must be 1..4096 bytes"));
      if (slot.pending) return Promise.reject(Error("cache broker send already outstanding"));
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          try {
            this.close(slot, Error("cache broker send deadline; delivery uncertain, do not retry"));
          } catch (error) {
            this.fault(error);
          }
        }, this.options.deadlineMs);
        slot.pending = { bytes: bytes.length, resolve, reject, timer };
        try {
          this.write(`CP1 SEND ${slot.id} ${bytes.toString("hex")}`);
        } catch (error) {
          this.fault(error);
        }
      });
    } catch (error) {
      this.fault(error);
      return Promise.reject(this.failure);
    }
  }
  private retire(slot: Slot, error: Error) {
    slot.state = "closing";
    if (slot.pending) {
      clearTimeout(slot.pending.timer);
      slot.pending.reject(error);
      slot.pending = undefined;
    }
    if (slot.notified) {
      slot.notified = false;
      this.options.onClosed?.(slot.peer!);
    }
  }
  private close(slot: Slot, error: Error) {
    if (slot.state === "closing") return;
    this.retire(slot, error);
    if (!this.finishing) this.write(`CP1 CLOSE ${slot.id}`);
  }
  private fault(error: unknown) {
    this.failure ??= error instanceof Error ? error : Error("cache broker adapter failure", { cause: error });
    // shutdown() retains and exposes errors. This handler owns the rejection until the caller joins it.
    void this.shutdown().catch(() => {});
  }
  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.finishing = true;
    const errors: unknown[] = this.failure ? [this.failure] : [];
    this.rejectReady(this.failure ?? Error("cache broker stopped before readiness"));
    // Assign before retirement callbacks as well as awaits: they may synchronously join shutdown.
    this.stopping = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([Promise.resolve().then(() => this.options.stop()), ...this.openings]);
      for (const result of results) if (result.status === "rejected") errors.push(result.reason);
      if (errors.length)
        throw new AggregateError(errors, `cache broker cleanup unresolved: ${errors.map(String).join("; ")}`);
      this.slots.clear();
    });
    for (const slot of this.slots.values()) {
      try {
        this.retire(slot, this.failure ?? Error("cache broker peer closed during shutdown"));
      } catch (error) {
        errors.push(error);
      }
    }
    this.partial = Buffer.alloc(0);
    return this.stopping;
  }
}
