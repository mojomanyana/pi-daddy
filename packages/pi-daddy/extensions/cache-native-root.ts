/** Inactive explicit SDK root composition; NOT automatic arbitrary Pi tool replacement.
 * Trusted source/options/current grant/profile providers and image bytes/broker path are prerequisites.
 * One instance automatically starts one supervised broker; backend run/close is an exclusive owned port.
 * Factory owns the entire native execute; issuer/store/context/service/transport remain independent owners.
 * No activation, user_bash interception, child attachment, history hydration or cleanup of stale socket paths.
 * Caller owns the private socket parent/path and supplies known static/source-qualified helper images.
 */
import {
  CacheNativeBashFactory,
  type CacheNativeBashOptions,
  type CacheNativeCall,
  type CacheNativeAdmission,
} from "./cache-native-bash.ts";
import { CacheNativeIssuer, CacheNativeIssuerCleanupError } from "./cache-native-issuer.ts";
import { CacheNativeImages, CacheNativeImageCleanupError } from "../src/executors/cache-native-images.ts";
import { CacheNativeContext, CacheNativeContextCleanupError } from "../src/executors/cache-native-context.ts";
import { CacheBrokerChannel } from "../src/executors/cache-broker-channel.ts";
import { CacheSupervisorTerminationError } from "../src/executors/cache-supervisor-cleanup.ts";
import { BoundedReadCleanupError } from "../src/kernel/bounded-read.ts";
import {
  startCacheNativeBroker,
  type CacheNativeBrokerOptions,
  type CacheNativeBrokerHandle,
} from "../src/executors/cache-native-broker.ts";
import { CacheShellRoles } from "../src/governance/cache-shell-roles.ts";
import { CacheShellService, type CacheShellServiceOptions } from "../src/products/cache-shell-service.ts";
import { isCacheOwner, type CacheOwnerIdentity, readCacheOwner } from "../src/kernel/cache-owner.ts";
import type { PersonalCacheInvocation } from "../src/kernel/cache-personal-invocation.ts";
export interface CacheNativeRootOptions {
  parent: CacheOwnerIdentity;
  cwd: string;
  options: CacheNativeBashOptions["options"];
  native: CacheNativeBashOptions["native"];
  authorize(): boolean;
  authorizeCall(input: Readonly<CacheNativeAdmission>, call: CacheNativeCall): boolean;
  images: ConstructorParameters<typeof CacheNativeImages>[0];
  context: ConstructorParameters<typeof CacheNativeContext>[0];
  maxCalls: number;
  maxPending: number;
  handshakeMs: number;
  readinessMs: number;
  brokerPath: string;
  eligible: CacheShellServiceOptions["eligible"];
  /** Async pre-issuance qualification, before any private image or actual native spawn. */
  admit?(invocation: Readonly<PersonalCacheInvocation>, call: CacheNativeCall): Promise<boolean>;
  run(
    invocation: Readonly<PersonalCacheInvocation>,
    options: Parameters<CacheShellServiceOptions["run"]>[1] & { call: CacheNativeCall },
  ): ReturnType<CacheShellServiceOptions["run"]>;
  closeBackend(): Promise<void>;
  onError(error: unknown): void;
  /** Trusted deterministic startup port; production omits this and uses the supervised CP1 leaf. */
  startBroker?(options: CacheNativeBrokerOptions): Promise<CacheNativeBrokerHandle>;
}
class AdmissionClosed extends Error {}
export class CacheNativeRootCleanupError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, "cache native root cleanup unresolved; retain owners");
  }
}
export class CacheNativeRoot {
  readonly factory: CacheNativeBashFactory;
  readonly images: CacheNativeImages;
  readonly context: CacheNativeContext;
  readonly issuer: CacheNativeIssuer;
  readonly ready: Promise<void>;
  readonly definition: CacheNativeBashFactory["definition"];
  private readonly roles: CacheShellRoles;
  private readonly channel: CacheBrokerChannel;
  private readonly service: CacheShellService;
  private readonly lifetime = new AbortController();
  private readonly brokerTask: Promise<CacheNativeBrokerHandle | undefined>;
  private broker?: CacheNativeBrokerHandle;
  private stopping?: Promise<void>;
  private cacheStopping?: Promise<void>;
  private unavailableBypasses = 0;
  private stopBrokerTask?: Promise<void>;
  private closed = false;
  private cacheDisabled = false;
  private faulted = false;
  private failures: unknown[] = [];
  constructor(config: CacheNativeRootOptions) {
    config = {
      ...config,
      options: { ...config.options },
      native: { ...config.native },
      images: { ...config.images },
      context: { ...config.context },
    };
    if (
      !isCacheOwner(config.parent) ||
      !config.cwd.startsWith("/") ||
      config.cwd.includes("\0") ||
      config.options.operations !== undefined ||
      !config.options.shellPath?.startsWith("/") ||
      !config.brokerPath.startsWith("/") ||
      config.brokerPath.includes("\0") ||
      !Number.isSafeInteger(config.readinessMs) ||
      config.readinessMs < 1 ||
      config.readinessMs > 30000 ||
      [config.authorize, config.authorizeCall, config.eligible, config.run, config.closeBackend, config.onError].some(
        (value) => typeof value !== "function",
      )
    )
      throw Error("cache native root configuration unsupported or malformed");
    const parent = Object.freeze({ ...config.parent });
    this.roles = new CacheShellRoles(config.maxCalls);
    this.images = new CacheNativeImages(config.images);
    this.context = new CacheNativeContext(config.context);
    const permitted = () => {
      if (this.closed) return false;
      return config.authorize() === true && !this.closed;
    };
    const permittedNativeCall = (input: Readonly<CacheNativeAdmission>, call: CacheNativeCall) =>
      permitted() && config.authorizeCall(input, call) === true && !this.closed;
    const permittedCall = (invocation: Readonly<PersonalCacheInvocation>, call: CacheNativeCall) =>
      permittedNativeCall(Object.freeze({ ...invocation, timeout: invocation.timeoutMs / 1000 }), call);
    this.issuer = new CacheNativeIssuer({
      parent,
      workspace: config.cwd,
      maxCalls: config.maxCalls,
      maxPending: config.maxPending,
      roles: this.roles,
      images: this.images,
      context: this.context,
      authorize: (invocation, call) => permittedCall(invocation, call) && !this.faulted,
    });
    this.service = new CacheShellService({
      roles: this.roles,
      workspace: config.cwd,
      clients: config.maxCalls,
      handshakeMs: config.handshakeMs,
      eligible: config.eligible,
      run: (invocation, options) => {
        const call = options.owner && this.issuer.callForOwner(options.owner);
        if (!call) throw Error("cache native root issued call unavailable after commitment; not retrying");
        return config.run(invocation, { ...options, call });
      },
      closeBackend: config.closeBackend,
      validate: async (peer, invocation, _request, signal) =>
        (await this.issuer.validate(peer.identity, invocation, signal))?.kind ?? "reject",
      stopTransport: () => this.channel.shutdown(),
      onError: (error) => {
        this.fail(error, config.onError);
        void this.closeCache().catch(() => {});
      },
    });
    this.channel = new CacheBrokerChannel({
      deadlineMs: config.handshakeMs,
      write: (frame) => {
        if (!this.broker) throw Error("cache native root broker not admitted");
        this.broker.write(frame);
      },
      stop: () => {
        if (!this.closed && !this.cacheStopping) {
          this.fail(Error("cache native root control closed or invalid"), config.onError);
          void this.closeCache().catch(() => {});
        }
        return this.stopBroker();
      },
      identify: async (pid) => {
        const owner = await readCacheOwner(pid);
        await this.issuer.claim(owner);
        return owner;
      },
      authorize: (identity) => this.service.canAttach(identity),
      onPeer: (peer) => this.service.open(peer),
      onData: (peer, bytes) => this.service.data(peer, bytes),
      onClosed: (peer) => this.service.closed(peer),
    });
    this.factory = new CacheNativeBashFactory({
      cwd: config.cwd,
      options: config.options,
      native: config.native,
      maxCalls: config.maxCalls,
      authorize: permitted,
      authorizeCall: permittedNativeCall,
      allocate: async (invocation, call) => {
        if (invocation.cwd !== config.cwd) {
          if (!permittedCall(invocation, call)) throw Error("cache native root current authority unavailable");
          this.unavailableBypasses++;
          return undefined; // Unsupported cache workspace, not a rejection of the existing native cwd.
        }
        try {
          await this.ready;
        } catch (error) {
          if (!this.faulted) throw error;
          // Readiness failure stays diagnosed/owned. This fresh call has allocated NO image or shell.
        }
        if (!permittedCall(invocation, call)) throw Error("cache native root current authority unavailable");
        if (this.faulted || this.cacheDisabled) {
          this.unavailableBypasses++;
          return undefined; // Only pre-allocation optimization bypass; never retry an issued/started call.
        }
        if (config.admit) {
          const admitted = await config.admit(invocation, call);
          if (!permittedCall(invocation, call)) throw Error("cache native root authority changed during admission");
          if (!admitted || this.cacheDisabled || this.faulted) {
            this.unavailableBypasses++;
            return undefined;
          }
        }
        return this.issuer.allocate(invocation, call);
      },
    });
    this.definition = this.factory.definition;
    // Charge startup before invoking the asynchronous provider or accepting any native allocation.
    this.brokerTask = Promise.resolve().then(async () => {
      if (this.closed || this.cacheDisabled || this.cacheStopping) return;
      const broker = await (config.startBroker ?? startCacheNativeBroker)({
        parent,
        executable: config.brokerPath,
        socket: config.images.socket,
        initializationMs: config.readinessMs,
        signal: this.lifetime.signal,
        onData: (bytes) => this.channel.feed(bytes),
        onEnd: (error) => {
          if (!this.closed && !this.cacheStopping) {
            this.fail(error, config.onError);
            this.channel.end(error);
            void this.closeCache().catch(() => {});
          }
        },
      });
      if (!broker || typeof broker.write !== "function" || typeof broker.stop !== "function")
        throw Error("cache native root broker allocation incompatible; retain");
      this.broker = Object.freeze({
        write: broker.write.bind(broker),
        stop: broker.stop.bind(broker),
        retryCleanup: broker.retryCleanup?.bind(broker),
      });
      return this.broker;
    });
    let timer: NodeJS.Timeout | undefined;
    const cancelled = new Promise<never>((_, reject) =>
      this.lifetime.signal.addEventListener(
        "abort",
        () => reject(new AdmissionClosed("cache native root admission closed")),
        { once: true },
      ),
    );
    this.ready = Promise.race([
      this.brokerTask.then(async () => {
        await this.channel.ready;
        if (this.closed || this.cacheDisabled || this.cacheStopping) throw new AdmissionClosed("cache native root admission closed");
      }),
      cancelled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("cache native root readiness exceeded bound")), config.readinessMs);
      }),
    ])
      .catch((error) => {
        if (!(error instanceof AdmissionClosed) && !this.cacheStopping) this.fail(error, config.onError);
        void this.closeCache().catch(() => {});
        throw error;
      })
      .finally(() => clearTimeout(timer));
    void this.ready.catch(() => {}); // Original readiness/cleanup promises remain observable to their owner.
  }
  private fail(error: unknown, report: (error: unknown) => void) {
    this.faulted = true;
    if (!this.failures.length) this.failures.push(error);
    try {
      report(error);
    } catch (diagnostic) {
      if (this.failures.length === 1) this.failures.push(diagnostic);
    }
  }
  private stopBroker(): Promise<void> {
    return (this.stopBrokerTask ??= Promise.resolve().then(async () => {
      const broker = await this.brokerTask;
      await broker?.stop();
    }));
  }
  private closeCache(): Promise<void> {
    if (this.cacheStopping) return this.cacheStopping;
    this.cacheStopping = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        this.service.shutdown(),
        this.issuer.close(),
        this.images.close(),
        this.context.close(),
        this.ready,
      ]);
      const errors = [
        ...this.failures,
        ...results.flatMap((row) =>
          row.status === "rejected" && !(row.reason instanceof AdmissionClosed) ? [row.reason] : [],
        ),
      ];
      if (errors.length) {
        this.faulted = true;
        throw new CacheNativeRootCleanupError(errors);
      }
    });
    this.lifetime.abort(new AdmissionClosed("cache native root admission intentionally closed"));
    return this.cacheStopping;
  }
  /** Operator optimization disablement does not abort ordinary default-native operations. */
  disableCaching(): Promise<void> {
    this.cacheDisabled = true;
    return Promise.allSettled([this.closeCache(), this.factory.join()]).then((results) => {
      const errors = results.flatMap((row) => (row.status === "rejected" ? [row.reason] : []));
      if (errors.length) throw new CacheNativeRootCleanupError(errors);
    });
  }
  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.stopping = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([this.factory.shutdown(), this.closeCache()]);
      const errors = results.flatMap((row) => (row.status === "rejected" ? [row.reason] : []));
      if (errors.length) {
        this.faulted = true;
        throw new CacheNativeRootCleanupError(errors);
      }
    });
    this.lifetime.abort(new AdmissionClosed("cache native root admission intentionally closed")); // Factory shutdown alone cancels ordinary native calls.
    return this.stopping;
  }
  /** Explicit original-resource recovery, not restart or reinterpretation of failed startup/stop. */
  async recoverResources(): Promise<void> {
    if (!this.closed && !this.cacheDisabled && !this.faulted) throw Error("stop/fault cache before recovery");
    let failed: unknown;
    try {
      await this.closeCache();
    } catch (error) {
      failed = error;
    }
    const tasks: Promise<void>[] = [];
    const collect = (error: unknown) => {
      if (
        error instanceof CacheNativeIssuerCleanupError ||
        error instanceof CacheNativeImageCleanupError ||
        error instanceof CacheNativeContextCleanupError ||
        error instanceof CacheSupervisorTerminationError ||
        error instanceof BoundedReadCleanupError
      )
        tasks.push(Promise.resolve().then(() => error.cleanup()));
      else if (error instanceof AggregateError) for (const nested of error.errors) collect(nested);
    };
    collect(failed);
    const results = await Promise.allSettled(tasks);
    // Factory releases its retained lease only after its own original issuer capability establishes disposal.
    const independent = await Promise.allSettled([
      this.factory.recover(),
      Promise.resolve().then(async () => {
        await this.broker?.retryCleanup?.();
      }),
    ]);
    const errors = [...results, ...independent].flatMap((row) => (row.status === "rejected" ? [row.reason] : []));
    if (errors.length) throw new CacheNativeRootCleanupError(errors);
    if (
      this.issuer.stats().owned ||
      this.images.stats().rootOwned ||
      this.context.stats().owned ||
      this.factory.stats().owned
    )
      throw Error("cache native resources remain owned; retain");
  }
  stats() {
    return {
      closed: this.closed,
      faulted: this.faulted,
      unavailableBypasses: this.unavailableBypasses,
      factory: this.factory.stats(),
      issuer: this.issuer.stats(),
      images: this.images.stats(),
      context: this.context.stats(),
    };
  }
}
