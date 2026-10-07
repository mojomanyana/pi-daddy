/**
 * One watched canonical root with subscription invalidation and cookie-synchronized query barriers.
 *
 * Watchman events are reconciliation signals, NOT content fingerprints or an immutable-input proof.
 * Consumers must block touched evidence, reconcile bytes/metadata, and delete evidence on uncertainty.
 * This client only ATTACHES to a socket. It never starts/stops/adopts a shared Watchman daemon. An owned
 * foreground service must be started inside cache-supervisor's namespace by the coordinator.
 * Git ignored/untracked files are observed; Watchman ignore_dirs is a coverage hole and refuses startup.
 * Watchman's VCS-specific defaults still require profile coverage qualification, not a Git-only claim.
 */
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { WatchmanConnection } from "./cache-watchman-protocol.ts";

const CAPABILITIES = ["cmd-watch", "cmd-query", "cmd-subscribe", "cmd-clock", "cmd-flush-subscriptions"];
export interface WatchmanTrackerOptions {
  socketPath: string;
  root: string;
  startupMs?: number;
  onUncertain(reason: string): void;
  onChange?: (paths: readonly string[]) => void;
}
export interface WatchmanBarrier {
  clock: string;
  epoch: number;
  changed: string[];
  /** false means old evidence MUST be removed; full returned names may seed a NEW cold scope. */
  fresh: boolean;
}

export class WatchmanTracker {
  readonly root: string;
  readonly subscription = `pi-daddy-cache-${randomUUID()}`;
  private connection!: WatchmanConnection;
  private cursor = "";
  private dirty = new Set<string>();
  private uncertain = false;
  private warming = true;
  private lost = false;
  private epoch = 0;
  private options: WatchmanTrackerOptions;
  private pendingBarrier: Promise<WatchmanBarrier> | undefined;
  private startupDeadline: number | undefined;

  private constructor(root: string, options: WatchmanTrackerOptions) {
    this.root = root;
    this.options = options;
  }

  static async connect(options: WatchmanTrackerOptions): Promise<WatchmanTracker> {
    const startupMs = options.startupMs ?? 3000;
    if (!Number.isSafeInteger(startupMs) || startupMs <= 0 || startupMs > 30000)
      throw new Error("Watchman startupMs must be a positive safe integer no greater than 30000");
    const deadline = performance.now() + startupMs;
    const root = await realpath(options.root);
    const tracker = new WatchmanTracker(root, options);
    tracker.startupDeadline = deadline;
    while (true) {
      try {
        tracker.connection = await WatchmanConnection.connect(
          options.socketPath,
          (message) => tracker.event(message),
          (reason) => tracker.markUncertain(reason, true),
          { timeoutMs: tracker.remainingStartup() },
        );
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["ENOENT", "ECONNREFUSED"].includes(code ?? ""))
          throw new Error(`Watchman socket ${options.socketPath} unavailable: ${String(error)}`);
        if (performance.now() >= deadline) throw new Error("Watchman startupMs budget exhausted awaiting socket");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      const version = await tracker.command(["version", { required: CAPABILITIES }]);
      const caps = version.capabilities as Record<string, unknown> | undefined;
      if (!caps || CAPABILITIES.some((cap) => caps[cap] !== true))
        throw new Error("Watchman required capabilities missing");
      const watched = await tracker.command(["watch", root]);
      if (watched.watch !== root) throw new Error("Watchman returned a different root; observation incomplete");
      const config = await tracker.command(["get-config", root]);
      if (!config.config || typeof config.config !== "object" || Array.isArray(config.config))
        throw new Error("Watchman get-config returned a missing or malformed configuration object");
      const ignored = (config.config as Record<string, unknown>).ignore_dirs;
      if (ignored !== undefined && (!Array.isArray(ignored) || ignored.length > 0))
        throw new Error("Watchman ignore_dirs makes root observation incomplete; remove or use an unignored root");
      const subscribed = await tracker.command([
        "subscribe",
        root,
        tracker.subscription,
        { fields: ["name", "exists"], empty_on_fresh_instance: false },
      ]);
      if (subscribed.subscribe !== tracker.subscription)
        throw new Error("Watchman subscription acknowledgment does not match request");
      await tracker.flush();
      const initial = await tracker.command(["query", root, { fields: ["name", "exists"], sync_timeout: 2000 }]);
      tracker.cursor = tracker.clock(initial);
      tracker.names(initial); // Validate initial coverage before admission, not only later incremental replies.
      // Unsolicited frames may arrive in the same packet as the awaited initial query. Do not
      // overwrite a warning/disconnect reported by that frame with optimistic startup success.
      if (tracker.lost || tracker.uncertain) throw new Error("Watchman startup observation became uncertain");
      tracker.remainingStartup();
      tracker.dirty.clear();
      tracker.warming = false;
      tracker.startupDeadline = undefined;
      return tracker;
    } catch (error) {
      tracker.close();
      throw error;
    }
  }

  barrier(): Promise<WatchmanBarrier> {
    // Serialize shared callers: no overlapping cursor mutation or silently consumed dirty sets.
    if (this.pendingBarrier) return this.pendingBarrier.then(() => this.barrier());
    const operation = this.reconcile().catch((error: unknown) => {
      this.markUncertain(`Watchman barrier failed: ${String(error)}`);
      throw error;
    });
    this.pendingBarrier = operation;
    void operation
      .finally(() => {
        if (this.pendingBarrier === operation) this.pendingBarrier = undefined;
      })
      .catch(() => {});
    return operation;
  }

  private async reconcile(): Promise<WatchmanBarrier> {
    if (this.lost) throw new Error("Watchman observation unavailable; synchronization lost");
    await this.flush();
    const query = await this.command([
      "query",
      this.root,
      { since: this.cursor, fields: ["name", "exists"], sync_timeout: 2000 },
    ]);
    if (query.is_fresh_instance !== false) this.markUncertain("Watchman cursor lost or root recrawled");
    for (const name of this.names(query)) this.dirty.add(name);
    this.cursor = this.clock(query);
    const result = { clock: this.cursor, epoch: this.epoch, changed: [...this.dirty].sort(), fresh: !this.uncertain };
    this.dirty.clear();
    this.uncertain = false;
    return result;
  }

  close(): void {
    this.connection?.close();
  }

  private remainingStartup(): number {
    if (this.startupDeadline === undefined) return 3000;
    const remaining = Math.ceil(this.startupDeadline - performance.now());
    if (remaining <= 0) throw new Error("Watchman startupMs budget exhausted");
    return remaining;
  }

  private async command(request: readonly unknown[]): Promise<Record<string, unknown>> {
    const reply = await this.connection.command(request, this.remainingStartup());
    this.checkWarning(reply, String(request[0]));
    return reply;
  }

  private checkWarning(message: Record<string, unknown>, source: string): void {
    if (!Object.hasOwn(message, "warning")) return;
    if (typeof message.warning !== "string") throw new Error(`Watchman ${source} warning is malformed`);
    this.markUncertain(`Watchman ${source} observation warning: ${message.warning}`);
  }

  private async flush(): Promise<void> {
    const result = await this.command([
      "flush-subscriptions",
      this.root,
      { sync_timeout: 2000, subscriptions: [this.subscription] },
    ]);
    if (
      !Array.isArray(result.synced) ||
      !Array.isArray(result.no_sync_needed) ||
      ![...result.synced, ...result.no_sync_needed].includes(this.subscription)
    )
      throw new Error("Watchman subscription barrier did not acknowledge synchronization");
  }

  private clock(message: Record<string, unknown>): string {
    if (typeof message.clock !== "string" || !message.clock.startsWith("c:"))
      throw new Error("Watchman observation clock is missing or incompatible");
    return message.clock;
  }

  private names(message: Record<string, unknown>): string[] {
    if (!Array.isArray(message.files) || message.files.length > 100000)
      throw new Error("Watchman observation file list missing or exceeds limit");
    return message.files.map((value: unknown) => {
      const file = value as { name?: unknown; exists?: unknown } | null;
      if (
        !file ||
        typeof file.name !== "string" ||
        typeof file.exists !== "boolean" ||
        file.name.startsWith("/") ||
        file.name.includes("\0") ||
        file.name.split("/").includes("..")
      )
        throw new Error("Watchman observation contains an invalid relative file");
      return file.name;
    });
  }

  private event(message: Record<string, unknown>): void {
    if (message.subscription !== this.subscription || message.root !== this.root)
      throw new Error("Watchman subscription identity mismatch");
    this.clock(message);
    if (message.is_fresh_instance === true && !this.warming) this.markUncertain("Watchman subscription recrawled");
    this.checkWarning(message, "subscription");
    const names = this.names(message);
    this.epoch++;
    for (const name of names) this.dirty.add(name);
    if (this.dirty.size > 100000) {
      this.dirty.clear();
      this.markUncertain("Watchman pending-change limit exceeded");
    }
    this.options.onChange?.(names);
  }

  private markUncertain(reason: string, lost = false): void {
    this.uncertain = true;
    this.lost ||= lost;
    this.epoch++;
    this.options.onUncertain(reason);
  }
}
