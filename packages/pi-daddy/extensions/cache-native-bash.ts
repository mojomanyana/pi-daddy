/** Inactive explicitly owned Pi native factory seam; never infer arbitrary tool options from metadata.
 * The supported native definition still owns prefix/hooks, accumulation, streaming, status and timing.
 * Operations see final effective inputs. A private lease selects shellPath, not a replacement executor.
 * Allocators prepare images only: undefined certifies no resource/start; unknown failures retain admission.
 * No registration, enablement, root/delegate issuer, factory qualification or task-death proof here.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
/** Unsupported environments stay on the native route without qualification invoking getters or Proxy traps. */
export function cacheNativeEnvironment(env: unknown): Record<string, string> | undefined {
  if (!env || typeof env !== "object" || types.isProxy(env) || Array.isArray(env)) return;
  const prototype = Object.getPrototypeOf(env);
  if (prototype !== null && prototype !== Object.prototype) return;
  if (prototype && Object.values(Object.getOwnPropertyDescriptors(prototype)).some((row) => row.enumerable)) return;
  const descriptors = Object.getOwnPropertyDescriptors(env);
  const entries: [string, string][] = [];
  for (const [name, row] of Object.entries(descriptors)) {
    if (!row.enumerable) continue;
    if (!Object.hasOwn(row, "value") || typeof row.value !== "string") return;
    entries.push([name, row.value]);
  }
  return Object.fromEntries(entries);
}
import type {
  createBashToolDefinition,
  createLocalBashOperations,
  BashToolOptions,
  BashOperations,
} from "@earendil-works/pi-coding-agent";
import { frozenPersonalInvocation, type PersonalCacheInvocation } from "../src/kernel/cache-personal-invocation.ts";
import { CacheNativeIssuerCleanupError } from "./cache-native-issuer.ts";
export interface CacheNativeShellLease {
  readonly shellPath: string;
  close(): Promise<void>;
}
export interface CacheNativeCall {
  readonly toolCallId: string;
  readonly signal: AbortSignal;
}
/** Actual default-native operations inputs, not a cache-compatible or normalized invocation.
 * Timeout is the native seconds value; timeoutMs is its numeric conversion only when numeric.
 * Missing/unsupported env and timeout remain exactly represented; env is borrowed, never fabricated.
 */
export interface CacheNativeAdmission {
  readonly command: string;
  readonly cwd: string;
  readonly shell: BashToolOptions["shellPath"];
  readonly env: Parameters<BashOperations["exec"]>[2]["env"];
  readonly timeout: Parameters<BashOperations["exec"]>[2]["timeout"];
  readonly timeoutMs: number | undefined;
}
export interface CacheNativeBashOptions {
  cwd: string;
  options: BashToolOptions;
  maxCalls: number;
  native: {
    createBashToolDefinition: typeof createBashToolDefinition;
    createLocalBashOperations: typeof createLocalBashOperations;
  };
  authorize(): boolean;
  /** Optional current per-call authority at ALL default-operations admission paths. Custom ops remain untouched. */
  authorizeCall?(input: Readonly<CacheNativeAdmission>, context: CacheNativeCall): boolean;
  /** Prepare only a private shell image. Undefined certifies no resources/start; errors are not fallback permission. */
  allocate(
    invocation: Readonly<PersonalCacheInvocation>,
    context: CacheNativeCall,
  ): Promise<CacheNativeShellLease | undefined>;
}
interface Owner {
  done: Promise<void>;
  lease?: CacheNativeShellLease;
  failed: boolean;
  failure?: unknown;
}
export class CacheNativeFactoryCleanupError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, "cache native factory cleanup unresolved; retain owners");
  }
}
export class CacheNativeBashFactory {
  readonly definition: ReturnType<typeof createBashToolDefinition>;
  private readonly context = new AsyncLocalStorage<{ toolCallId: string; owner: Owner }>();
  private readonly lifetime = new AbortController();
  private readonly owners = new Set<Owner>();
  private readonly config: CacheNativeBashOptions;
  private readonly original: BashOperations;
  private closed = false;
  private faulted = false;
  private stopping?: Promise<void>;
  constructor(config: CacheNativeBashOptions) {
    if (!Number.isSafeInteger(config.maxCalls) || config.maxCalls < 1 || config.maxCalls > 32)
      throw Error("cache native factory owner bound must be1..32");
    // Trusted options may nevertheless be unsupported objects. Let native inspect them exactly once.
    if (!config.options || typeof config.options !== "object" || types.isProxy(config.options) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(config.options)) ||
      Object.values(Object.getOwnPropertyDescriptors(config.options)).some((row) => !Object.hasOwn(row, "value")) ||
      (config.options.commandPrefix !== undefined && typeof config.options.commandPrefix !== "string") ||
      (config.options.shellPath !== undefined && typeof config.options.shellPath !== "string") ||
      (config.options.spawnHook !== undefined && typeof config.options.spawnHook !== "function") ||
      (config.options.exposeSessionEnvironment !== undefined && typeof config.options.exposeSessionEnvironment !== "boolean")
    ) {
      this.config = config;
      this.original = config.native.createLocalBashOperations();
      const ordinary = config.native.createBashToolDefinition(config.cwd, config.options);
      this.definition = { ...ordinary, execute: (...args) => this.execute(ordinary, args) };
      return;
    }
    if (
      config.authorizeCall !== undefined &&
      (typeof config.authorizeCall !== "function" || config.options.operations !== undefined)
    )
      throw Error("cache native factory effective authority requires a callback and default operations");
    this.config = { ...config, options: { ...config.options } };
    this.original =
      config.options.operations ?? config.native.createLocalBashOperations({ shellPath: config.options.shellPath });
    if (config.options.operations) {
      this.definition = config.native.createBashToolDefinition(config.cwd, config.options);
      return;
    }
    const native = config.native.createBashToolDefinition(config.cwd, {
      ...config.options,
      operations: { exec: (command, cwd, options) => this.exec(command, cwd, options) },
    });
    this.definition = {
      ...native,
      execute: (...args) => this.execute(native, args),
    };
  }
  private async execute(
    native: ReturnType<typeof createBashToolDefinition>,
    args: Parameters<ReturnType<typeof createBashToolDefinition>["execute"]>,
  ) {
    this.permit();
    if (this.owners.size >= this.config.maxCalls)
      throw Error("cache native factory owner bound exceeded; no execution attempted");
    let settled!: () => void;
    const owner: Owner = {
      done: new Promise<void>((resolve) => {
        settled = resolve;
      }),
      failed: false,
    };
    this.owners.add(owner); // Includes native output finalization, not just operations/lease cleanup.
    try {
      return await this.context.run({ toolCallId: args[0], owner }, () => native.execute(...args));
    } finally {
      if (!owner.failed) this.owners.delete(owner);
      settled();
    }
  }
  private permit() {
    if (this.closed || this.faulted) throw Error("cache native factory closed or faulted; no execution attempted");
    if (this.config.authorize() !== true) throw Error("cache native factory current authority unavailable");
  }
  private permitCall(
    command: string,
    cwd: string,
    options: Parameters<BashOperations["exec"]>[2],
    call: CacheNativeCall,
  ) {
    this.permit();
    if (
      this.config.authorizeCall &&
      this.config.authorizeCall(
        Object.freeze({
          command,
          cwd,
          shell: this.config.options.shellPath,
          env: options.env,
          timeout: options.timeout,
          timeoutMs: typeof options.timeout === "number" ? options.timeout * 1000 : undefined,
        }),
        call,
      ) !== true
    )
      throw Error("cache native factory current per-call authority unavailable");
    this.permit(); // A callback may synchronously close/revoke the factory.
  }
  private invocation(command: string, cwd: string, options: Parameters<BashOperations["exec"]>[2]) {
    const shell = this.config.options.shellPath,
      timeoutMs = typeof options.timeout === "number" ? options.timeout * 1000 : NaN,
      env = options.env;
    if (
      process.platform !== "linux" ||
      typeof shell !== "string" || !shell.startsWith("/") ||
      typeof command !== "string" || typeof cwd !== "string" ||
      !env ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 21600000
    )
      return;
    // Node may insert ambient coverage/permission bindings; this seam does not silently omit them from identity.
    if (
      process.env.NODE_V8_COVERAGE ||
      process.execArgv.some((arg) => arg.startsWith("--permission") || arg === "--experimental-permission")
    )
      return;
    const data = cacheNativeEnvironment(env);
    if (!data) return;
    try {
      return frozenPersonalInvocation({ shell, command, cwd, env: data, timeoutMs });
    } catch (error) {
      if (
        error instanceof Error &&
        ["personal cache invocation malformed", "personal cache environment malformed or oversized"].includes(
          error.message,
        )
      )
        return;
      throw error;
    }
  }
  private exec(
    command: string,
    cwd: string,
    options: Parameters<BashOperations["exec"]>[2],
  ): ReturnType<BashOperations["exec"]> {
    this.permit();
    const context = this.context.getStore();
    if (!context) throw Error("cache native factory execute context unavailable");
    const signal = AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    const owner = context.owner;
    const call = Object.freeze({ toolCallId: context.toolCallId, signal });
    const work = Promise.resolve().then(async () => {
      let nativeFailure: unknown,
        nativeFailed = false,
        closeAttempted = false;
      const closeLease = async () => {
        if (!owner.lease || closeAttempted) return;
        closeAttempted = true;
        try {
          await owner.lease.close();
        } catch (error) {
          owner.failed = true;
          owner.failure = error;
          this.faulted = true;
          throw new CacheNativeFactoryCleanupError(nativeFailed ? [nativeFailure, error] : [error]);
        }
        owner.lease = undefined;
      };
      try {
        this.permit();
        if (signal.aborted) throw Error("aborted");
        this.permitCall(command, cwd, options, call);
        const invocation = this.invocation(command, cwd, options);
        if (invocation) {
          try {
            owner.lease = await this.config.allocate(invocation, call);
            const lease = owner.lease;
            if (
              lease !== undefined &&
              (!lease ||
                typeof lease.close !== "function" ||
                typeof lease.shellPath !== "string" ||
                !lease.shellPath.startsWith("/") ||
                lease.shellPath.includes("\0"))
            )
              throw Error("cache native shell lease malformed");
          } catch (error) {
            owner.failed = true;
            owner.failure = error;
            this.faulted = true;
            throw new CacheNativeFactoryCleanupError([error]);
          }
        }
        // Hook-returned objects may change during allocation. No command started; close the stale image
        // before using the original native path, never commit an invocation we know no longer matches.
        if (owner.lease && JSON.stringify(this.invocation(command, cwd, options)) !== JSON.stringify(invocation))
          await closeLease();
        this.permit();
        if (signal.aborted) throw Error("aborted");
        this.permitCall(command, cwd, options, call);
        if (signal.aborted) throw Error("aborted");
        const operations = owner.lease
          ? this.config.native.createLocalBashOperations({ shellPath: owner.lease.shellPath })
          : this.original;
        return await operations.exec(command, cwd, { ...options, signal });
      } catch (error) {
        nativeFailed = true;
        nativeFailure = error;
        throw error;
      } finally {
        if (owner.lease && typeof owner.lease.close === "function") await closeLease();
      }
    });
    return work;
  }
  /** Join whole native output finalization without aborting ordinary operations. */
  async join(): Promise<void> {
    await Promise.all([...this.owners].map((owner) => owner.done));
  }
  /** Physical recovery joins native finalization, then invokes only the issuer's original typed capability.
   * The original failed execute/shutdown and faulted admission never become successful. */
  async recover(): Promise<void> {
    const errors: unknown[] = [];
    for (const owner of this.owners) {
      await owner.done;
      if (!this.owners.has(owner)) continue;
      const capabilities: CacheNativeIssuerCleanupError[] = [];
      const collect = (error: unknown) => {
        if (error instanceof CacheNativeIssuerCleanupError) capabilities.push(error);
        else if (error instanceof AggregateError) for (const nested of error.errors) collect(nested);
      };
      collect(owner.failure);
      try {
        if (!owner.failed || !capabilities.length)
          throw Error("native factory recovery capability unavailable; retain");
        for (const capability of capabilities) await capability.cleanup();
        owner.lease = undefined;
        this.owners.delete(owner);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new CacheNativeFactoryCleanupError(errors);
  }
  stats() {
    return {
      owned: this.owners.size,
      retainedLeases: [...this.owners].filter((owner) => owner.lease).length,
      faulted: this.faulted,
    };
  }
  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.lifetime.abort();
    this.stopping = Promise.resolve().then(async () => {
      await Promise.all([...this.owners].map((owner) => owner.done));
      const failures = [...this.owners].map((owner) => owner.failure);
      if (failures.length) throw new CacheNativeFactoryCleanupError(failures);
    });
    return this.stopping;
  }
}
