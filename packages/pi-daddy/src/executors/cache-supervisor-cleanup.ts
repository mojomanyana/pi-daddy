/** Private joined process cleanup. Launcher exit is not namespace death or descriptor release.
 * Acquisition is charged before its first await; deadline/close failures retain actual owners.
 * Trusted ports let tests force physical boundaries without changing global Node behavior.
 */
import { CacheNamespaceCleanupError } from "./cache-namespace-death.ts";
export interface CacheSupervisorNamespace {
  closed: boolean;
  handle: { close(): Promise<void> };
}
export interface CacheSupervisorCleanupPorts<T extends CacheSupervisorNamespace> {
  acquire(): Promise<T>;
  launcherStopped: Promise<void>;
  spawnRefused(): boolean;
  cancelAdmission(): void;
  stopLauncher(): void;
  forceLauncher(): void;
  terminated(namespace: T): Promise<boolean>;
  wait(): Promise<void>;
  timer(callback: () => void, ms: number): () => void;
}
// Strong ownership survives a rejected startup/abandoned error until actual release, never GC-close.
export interface CacheSupervisorRetainedOwners {
  pendingAcquisition: boolean;
  namespace?: CacheSupervisorNamespace;
  failedHandle?: { close(): Promise<void> };
  unknownAcquisition: unknown;
  firstCleanupFailure: unknown;
  lastCleanupFailure: unknown;
}
const charged = new Set<{ readonly retainedOwners: CacheSupervisorRetainedOwners; retryCleanup(): Promise<void> }>();
/** Private diagnostics/recovery port for trusted composition; not admission or requester authority. */
export function retainedCacheSupervisorCleanups() {
  return [...charged];
}
export class CacheSupervisorTerminationError extends AggregateError {
  readonly cleanup: () => Promise<void>;
  private readonly owners: () => CacheSupervisorRetainedOwners;
  get retainedOwners() {
    return this.owners();
  }
  constructor(errors: unknown[], cleanup: () => Promise<void>, owners: () => CacheSupervisorRetainedOwners) {
    super(errors, `cache termination unresolved; retain: ${errors.map(String).join("; ")}`);
    this.cleanup = cleanup;
    this.owners = owners;
  }
}
export class CacheSupervisorCleanup<T extends CacheSupervisorNamespace> {
  private readonly ports: CacheSupervisorCleanupPorts<T>;
  private readonly acquisition: Promise<void>;
  private namespace?: T;
  private acquisitionError?: unknown;
  private firstCleanupFailure?: unknown;
  private lastCleanupFailure?: unknown;
  private failedHandle?: { close(): Promise<void> };
  private pending = true;
  private cancelled = false;
  private stopping?: Promise<void>;
  private retrying?: Promise<void>;
  private activeJoin?: Promise<void>;
  constructor(ports: CacheSupervisorCleanupPorts<T>) {
    this.ports = ports;
    charged.add(this);
    this.acquisition = Promise.resolve()
      .then(() => ports.acquire())
      .then(
        (namespace) => {
          this.namespace = namespace;
          this.pending = false;
        },
        (error) => {
          this.acquisitionError = error;
          if (error instanceof CacheNamespaceCleanupError) this.failedHandle = error.handle;
          this.pending = false;
        },
      );
  }
  get admissionCancelled() {
    return this.cancelled;
  }
  get retainedOwners() {
    return {
      pendingAcquisition: this.pending,
      namespace: this.namespace?.closed ? undefined : this.namespace,
      failedHandle: this.failedHandle,
      unknownAcquisition: this.acquisitionError,
      firstCleanupFailure: this.firstCleanupFailure,
      lastCleanupFailure: this.lastCleanupFailure,
    };
  }
  async acquired(): Promise<T> {
    await this.acquisition;
    if (!this.namespace) throw this.acquisitionError ?? Error("cache namespace identity unavailable; retain");
    return this.namespace;
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.stopping = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.cancelled = true;
    // Memoize BEFORE callbacks can synchronously reenter shutdown.
    const errors: unknown[] = [];
    try {
      this.ports.cancelAdmission();
    } catch (error) {
      errors.push(error);
    }
    void this.attempt(false, errors).then(resolve, reject);
    return this.stopping;
  }
  retryCleanup(): Promise<void> {
    if (!this.stopping) return this.stop();
    if (this.retrying) return this.retrying;
    this.retrying = this.stopping.then(
      () => this.attempt(true),
      () => this.attempt(true),
    );
    void this.retrying.then(
      () => {
        this.retrying = undefined;
      },
      () => {
        this.retrying = undefined;
      },
    );
    return this.retrying;
  }
  private async attempt(retry: boolean, errors: unknown[] = []): Promise<void> {
    let expired = false,
      clearForce = () => {};
    const force = () => {
      try {
        this.ports.forceLauncher();
      } catch (error) {
        errors.push(error);
      }
    };
    let clearDeadline = () => {};
    const deadline = new Promise<never>((_, reject) => {
      clearDeadline = this.ports.timer(() => {
        expired = true;
        force();
        reject(Error("cache termination unresolved after 1500ms"));
      }, 1500);
    });
    const check = () => {
      if (expired) throw Error("cache cleanup attempt expired; retain");
    };
    const previous = this.activeJoin;
    const join = async () => {
      if (previous)
        await previous.then(
          () => {},
          () => {},
        ); // Retry joins, never overlaps the old physical operation.
      check();
      await this.acquisition;
      check();
      try {
        this.ports.stopLauncher();
      } catch (error) {
        errors.push(error);
      }
      clearForce = this.ports.timer(force, 500);
      await this.ports.launcherStopped;
      check();
      if (!this.namespace) {
        if (retry && this.failedHandle) {
          await this.failedHandle.close();
          this.failedHandle = undefined;
          check();
        }
        if (this.ports.spawnRefused() && !this.failedHandle) return;
        throw this.acquisitionError ?? Error("cache namespace identity unavailable; retain");
      }
      if (this.namespace.closed) return;
      while (!(await this.ports.terminated(this.namespace))) {
        check();
        await this.ports.wait();
        check();
      }
      check();
      await this.namespace.handle.close();
      this.namespace.closed = true;
      check();
    };
    const owned = Promise.resolve().then(join);
    this.activeJoin = owned;
    void owned.then(
      () => {
        if (this.activeJoin === owned) this.activeJoin = undefined;
      },
      (error) => {
        // The deadline may already have rejected the public stop. Late physical failures stay observable.
        this.firstCleanupFailure ??= error;
        this.lastCleanupFailure = error;
        if (this.activeJoin === owned) this.activeJoin = undefined;
      },
    );
    try {
      await Promise.race([owned, deadline]);
      if (errors.length) throw new AggregateError(errors, "cache launcher control failed");
      charged.delete(this);
    } catch (error) {
      throw new CacheSupervisorTerminationError(
        [...errors, error],
        () => this.retryCleanup(),
        () => this.retainedOwners,
      );
    } finally {
      clearForce();
      clearDeadline();
    }
  }
}
