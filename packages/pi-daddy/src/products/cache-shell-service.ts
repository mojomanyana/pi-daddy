/** Inactive, session-owned Node CS1 coordinator boundary over PRIVATE owned CP1 peers.
 * Root-issued connector birth/generation and independently qualified native context are mandatory.
 * Attachment grants only a public refusal; operation/payload authority is rechecked separately.
 * No execution/join/replay before G. Disconnect aborts only its own interest; no uncertain retry.
 * Injected run MUST join its execution/cleanup before settling, including cancellation; emit is async
 * backpressure, not an unbounded queue. CacheShellBackend joins personal-runtime byte/cleanup ownership;
 * it can consume only a trusted one-use no-start receipt for bounded post-G ordinary execution.
 * This service does not issue Pi/delegate grants, discover eligibility, start a daemon or prove tree death.
 */
import { constants } from "node:os";
import { CacheShellRoles, type CacheShellLease } from "../governance/cache-shell-roles.ts";
import type { CacheBrokerPeer } from "../executors/cache-broker-channel.ts";
import {
  CacheShellRequestDecoder,
  cacheShellOutput,
  cacheShellExit,
  cacheShellSignal,
  type CacheShellRequest,
} from "../kernel/cache-shell-protocol.ts";
import type { PersonalCacheInvocation } from "../kernel/cache-personal-invocation.ts";
import type { CacheOwnerIdentity } from "../kernel/cache-owner.ts";
export interface CacheShellCompletion {
  exitCode: number | null;
  signal: string | null;
}
export interface CacheShellServiceOptions {
  /** Exclusive session registry; shutdown clears it before joining independent cleanup owners. */
  roles: CacheShellRoles;
  workspace: string;
  clients: number;
  handshakeMs: number;
  eligible(invocation: Readonly<PersonalCacheInvocation>): boolean;
  /** Must qualify actual native image/context/options independently; never from CS1 claims alone. */
  validate(
    peer: CacheBrokerPeer,
    invocation: Readonly<PersonalCacheInvocation>,
    request: CacheShellRequest,
    signal: AbortSignal,
  ): Promise<"qualified" | "bypass" | "reject">;
  run(
    invocation: Readonly<PersonalCacheInvocation>,
    options: {
      signal: AbortSignal;
      /** Kernel-authenticated connector identity, not protocol metadata. */
      owner?: CacheOwnerIdentity;
      authorize(): boolean;
      emit(channel: "stdout" | "stderr", bytes: Buffer): Promise<void>;
    },
  ): Promise<CacheShellCompletion | undefined>;
  closeBackend(): Promise<void>;
  stopTransport(): Promise<void>;
  onError(error: unknown): void;
}
interface Slot {
  peer: CacheBrokerPeer;
  lease: CacheShellLease;
  decoder: CacheShellRequestDecoder;
  phase: "reading" | "checking" | "offer" | "committed" | "done";
  controller: AbortController;
  go?: (value: boolean) => void;
  timer: NodeJS.Timeout;
  emissions: Set<Promise<void>>;
  outputFailure?: unknown;
}
class Detached extends Error {
  constructor() {
    super("cache shell requester detached or unauthorized");
  }
}
class AuthorityFault extends Error {
  constructor(cause: unknown) {
    super("cache shell current authority unavailable", { cause });
  }
}
export class CacheShellService {
  private slots = new Map<CacheBrokerPeer, Slot>();
  private tasks = new Map<Promise<void>, Slot>();
  private errors: unknown[] = [];
  private stopped = false;
  private stopping?: Promise<void>;
  private options: CacheShellServiceOptions;
  constructor(options: CacheShellServiceOptions) {
    this.options = { ...options };
    if (
      !options.workspace.startsWith("/") ||
      options.workspace.includes("\0") ||
      !Number.isSafeInteger(options.clients) ||
      options.clients < 1 ||
      options.clients > 32 ||
      !Number.isSafeInteger(options.handshakeMs) ||
      options.handshakeMs < 1 ||
      options.handshakeMs > 30000
    )
      throw Error("cache shell service configuration malformed");
  }
  open(peer: CacheBrokerPeer): void {
    const lease = this.options.roles.bind(peer.identity);
    const owned = new Set([...this.slots.values(), ...this.tasks.values()]);
    if (this.stopped || !lease || this.slots.has(peer) || owned.size >= this.options.clients) {
      peer.close();
      return;
    }
    const slot: Slot = {
      peer,
      lease,
      decoder: new CacheShellRequestDecoder(),
      phase: "reading",
      controller: new AbortController(),
      emissions: new Set(),
      timer: setTimeout(() => {
        this.closed(peer);
        peer.close();
      }, this.options.handshakeMs),
    };
    this.slots.set(peer, slot);
  }
  private allowed(slot: Slot): boolean {
    if (this.stopped || slot.controller.signal.aborted) return false;
    try {
      return this.options.roles.authorized(slot.lease);
    } catch (error) {
      throw new AuthorityFault(error);
    }
  }
  data(peer: CacheBrokerPeer, bytes: Buffer): void {
    const slot = this.slots.get(peer);
    if (!slot || this.stopped) return;
    if (slot.phase === "offer") {
      if (bytes.length !== 1 || bytes[0] !== 71) {
        this.closed(peer);
        peer.close();
        return;
      }
      slot.phase = "committed";
      clearTimeout(slot.timer);
      slot.go?.(true);
      return;
    }
    if (slot.phase !== "reading") {
      this.closed(peer);
      peer.close();
      return;
    }
    let request: CacheShellRequest | undefined;
    try {
      request = slot.decoder.feed(bytes);
    } catch {
      slot.phase = "checking";
      this.charge(slot, () => this.decline(slot, "R"));
      return;
    }
    if (!request) return;
    slot.phase = "checking";
    this.charge(slot, () => this.transaction(slot, request!));
  }
  private charge(slot: Slot, work: () => Promise<void>) {
    // Promise is registered BEFORE calling validator/run; CLOSED cannot discard pending ownership.
    const task = Promise.resolve()
      .then(work)
      .catch(async (error) => {
        if (!(error instanceof Detached)) {
          if (error instanceof AuthorityFault && slot.phase !== "committed" && slot.phase !== "done") {
            try {
              await this.decline(slot, "R");
            } catch (reply) {
              this.errors.push(reply);
            }
          }
          this.errors.push(error);
          this.stopped = true;
          this.options.onError(error);
        }
      })
      .finally(async () => {
        clearTimeout(slot.timer);
        this.closed(slot.peer);
        try {
          slot.peer.close();
        } catch (error) {
          this.errors.push(error);
        }
        const pending = await Promise.allSettled([...slot.emissions]);
        for (const result of pending)
          if (result.status === "rejected" && !(result.reason instanceof Detached)) this.errors.push(result.reason);
        this.tasks.delete(task);
      });
    this.tasks.set(task, slot);
    // Shutdown exposes accumulated faults. This observer prevents early callback failure rejection escape.
    void task.catch((error) => {
      this.errors.push(error);
    });
  }
  private async decline(slot: Slot, code: "R" | "B") {
    // B is authority-sensitive: an eligibility callback may have revoked/released the role.
    if (code === "B" && !this.allowed(slot)) code = "R";
    if (!slot.controller.signal.aborted && !this.stopped) await this.send(slot, Buffer.from(code), false);
    slot.phase = "done";
  }
  private async send(slot: Slot, bytes: Buffer, payload: boolean) {
    if (slot.controller.signal.aborted || (payload && !this.allowed(slot))) throw new Detached();
    try {
      await slot.peer.send(bytes);
    } catch (error) {
      if (slot.controller.signal.aborted) throw new Detached();
      throw error;
    }
    if (slot.controller.signal.aborted || (payload && !this.allowed(slot))) throw new Detached();
  }
  private async transaction(slot: Slot, request: CacheShellRequest) {
    const invocation = this.options.roles.invocation(slot.lease);
    if (
      !invocation ||
      invocation.cwd !== this.options.workspace ||
      !this.allowed(slot) ||
      !this.options.roles.matches(slot.lease, request)
    ) {
      await this.decline(slot, "R");
      return;
    }
    const eligible = this.options.eligible(invocation);
    if (!this.allowed(slot)) {
      await this.decline(slot, "R");
      return;
    }
    if (!eligible) {
      await this.decline(slot, "B");
      return;
    }
    const context = await this.options.validate(slot.peer, invocation, request, slot.controller.signal);
    if (slot.controller.signal.aborted) return;
    if (!this.allowed(slot) || context === "reject") {
      await this.decline(slot, "R");
      return;
    }
    if (context !== "qualified") {
      await this.decline(slot, "B");
      return;
    }
    const committed = new Promise<boolean>((resolve) => {
      slot.go = resolve;
    });
    slot.phase = "offer";
    await this.send(slot, Buffer.from("A"), true);
    if (!(await committed) || !this.allowed(slot)) return;
    // Revalidate actual native context after G; uncertainty now closes without original execution.
    const final = await this.options.validate(slot.peer, invocation, request, slot.controller.signal);
    if (final !== "qualified" || !this.allowed(slot)) return;
    const completion = await this.options.run(invocation, {
      signal: slot.controller.signal,
      owner: slot.peer.identity,
      authorize: () => this.allowed(slot),
      emit: (channel, bytes) => this.emit(slot, channel, bytes),
    });
    if (slot.emissions.size) throw Error("cache shell adapter settled with output still owned");
    if (slot.outputFailure) throw slot.outputFailure;
    if (!this.allowed(slot)) return;
    if (!completion) throw Error("cache shell adapter lacks terminal completion");
    const terminal =
      completion.signal === null && completion.exitCode !== null
        ? cacheShellExit(completion.exitCode)
        : completion.exitCode === null && completion.signal !== null
          ? cacheShellSignal(constants.signals[completion.signal as keyof typeof constants.signals])
          : undefined;
    if (!terminal) throw Error("cache shell adapter terminal status malformed");
    await this.send(slot, terminal, true);
    slot.phase = "done";
  }
  private emit(slot: Slot, channel: "stdout" | "stderr", bytes: Buffer): Promise<void> {
    if (
      slot.emissions.size ||
      !Buffer.isBuffer(bytes) ||
      bytes.length > 131072 ||
      !["stdout", "stderr"].includes(channel)
    ) {
      const error = Error("cache shell adapter output malformed, busy or over bound");
      slot.outputFailure ??= error;
      return Promise.reject(error);
    }
    const task = Promise.resolve().then(async () => {
      for (let start = 0; start < bytes.length; start += 4091)
        await this.send(slot, cacheShellOutput(channel, bytes.subarray(start, start + 4091)), true);
    });
    slot.emissions.add(task);
    void task.then(
      () => {
        slot.emissions.delete(task);
      },
      (error) => {
        slot.outputFailure ??= error;
        slot.emissions.delete(task);
      },
    );
    return task;
  }
  closed(peer: CacheBrokerPeer): void {
    const slot = this.slots.get(peer);
    if (!slot) return;
    slot.controller.abort();
    slot.go?.(false);
    clearTimeout(slot.timer);
    this.slots.delete(peer);
  }
  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.options.roles.clear();
    this.stopping = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.options.stopTransport()),
        Promise.resolve().then(() => this.options.closeBackend()),
        ...this.tasks.keys(),
      ]);
      const errors = [...this.errors, ...results.flatMap((row) => (row.status === "rejected" ? [row.reason] : []))];
      if (errors.length) throw new AggregateError(errors, "cache shell service cleanup unresolved; retain");
    });
    for (const peer of [...this.slots.keys()]) {
      this.closed(peer);
      try {
        peer.close();
      } catch (error) {
        this.errors.push(error);
      }
    }
    return this.stopping;
  }
  /** CP1 authorize must use this BASIC attachment check: a held peer can still receive R after
   * its operation role is released. It never grants execution/payload; those use the generation lease. */
  canAttach(owner: CacheOwnerIdentity): boolean {
    return (
      !this.stopped &&
      (this.options.roles.attached(owner) ||
        [...this.slots.keys()].some(
          (peer) =>
            peer.identity.pid === owner.pid &&
            peer.identity.bootId === owner.bootId &&
            peer.identity.startTicks === owner.startTicks,
        ))
    );
  }
  stats() {
    return { clients: this.slots.size, owned: this.tasks.size, errors: this.errors.length, stopped: this.stopped };
  }
}
