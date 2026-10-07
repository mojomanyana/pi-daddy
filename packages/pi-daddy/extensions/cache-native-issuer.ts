/** Inactive explicit native-call composition, NOT automatic Pi registration or a GrantsSession provider.
 * A private image name selects a candidate only. Mandatory native validation still independently compares
 * actual birth/parent/image/argv/env/cwd/stdin before commitment and after G; names/bytes grant no authority.
 * Caller supplies trusted source-qualified factory inputs, parent/workspace and current authority callback.
 * Own late allocation/selection/validation until settlement; revoke before image retirement and retain faults.
 * Shutdown waits consumer image retirement: caller must also stop/join the whole native factory. Image store
 * and validator are independent borrowed owners and must be joined separately. No processes start here.
 */
import { readlink } from "node:fs/promises";
import { CacheShellRoles, type CacheShellRole } from "../src/governance/cache-shell-roles.ts";
import { isCacheOwner, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { frozenPersonalInvocation, type PersonalCacheInvocation } from "../src/kernel/cache-personal-invocation.ts";
import type { CacheNativeImages, CacheNativeImageLease } from "../src/executors/cache-native-images.ts";
import {
  CacheNativeContextCleanupError,
  type CacheNativeContext,
  type CacheNativeContextResult,
} from "../src/executors/cache-native-context.ts";
import type { CacheNativeCall, CacheNativeShellLease } from "./cache-native-bash.ts";
interface Options {
  parent: CacheOwnerIdentity;
  workspace: string;
  maxCalls: number;
  maxPending: number;
  roles: CacheShellRoles;
  images: Pick<CacheNativeImages, "allocate">;
  context: Pick<CacheNativeContext, "validate">;
  authorize(invocation: Readonly<PersonalCacheInvocation>, call: CacheNativeCall): boolean;
  /** Trusted deterministic selector port only. Production uses host proc readlink, never an application ID. */
  select?(owner: Readonly<CacheOwnerIdentity>): Promise<string>;
}
interface Row {
  invocation: Readonly<PersonalCacheInvocation>;
  call: CacheNativeCall;
  image?: CacheNativeImageLease;
  owner?: Readonly<CacheOwnerIdentity>;
  role?: CacheShellRole;
  retiring: boolean;
  revoked: boolean;
  failure?: CacheNativeIssuerCleanupError;
  done: Promise<void>;
  released: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  closing?: Promise<void>;
  cleaning?: Promise<void>;
}
export class CacheNativeIssuerCleanupError extends AggregateError {
  readonly cleanup: () => Promise<void>;
  constructor(errors: unknown[], cleanup: () => Promise<void>) {
    super(errors, "cache native issuer cleanup unresolved; retain owners");
    this.cleanup = cleanup;
  }
}
const key = (owner: CacheOwnerIdentity) => JSON.stringify([owner.bootId, owner.pid, owner.startTicks]);
export class CacheNativeIssuer {
  private readonly config: Options;
  private readonly rows = new Set<Row>();
  private readonly images = new Map<string, Row>();
  private readonly owners = new Map<string, Row>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly faults = new Set<unknown>();
  private closed = false;
  private faulted = false;
  private stopping?: Promise<void>;
  constructor(options: Options) {
    if (
      !isCacheOwner(options.parent) ||
      !options.workspace.startsWith("/") ||
      options.workspace.includes("\0") ||
      !Number.isSafeInteger(options.maxCalls) ||
      options.maxCalls < 1 ||
      options.maxCalls > 32 ||
      !Number.isSafeInteger(options.maxPending) ||
      options.maxPending < 1 ||
      options.maxPending > 32 ||
      typeof options.authorize !== "function"
    )
      throw Error("cache native issuer configuration malformed or over bound");
    this.config = { ...options, parent: Object.freeze({ ...options.parent }) };
  }
  private admit() {
    if (this.closed || this.faulted) throw Error("cache native issuer admission closed or faulted");
  }
  private allowed(row: Row): boolean {
    if (this.closed || this.faulted || row.retiring || row.revoked || row.call.signal.aborted) return false;
    try {
      if (this.config.authorize(row.invocation, row.call) === true)
        return !this.closed && !this.faulted && !row.retiring && !row.revoked && !row.call.signal.aborted;
      row.revoked = true;
      return false;
    } catch (error) {
      row.revoked = true;
      throw error;
    }
  }
  async allocate(input: PersonalCacheInvocation, context: CacheNativeCall): Promise<CacheNativeShellLease | undefined> {
    this.admit();
    if (this.rows.size >= this.config.maxCalls) throw Error("cache native issuer owner bound exceeded");
    const invocation = frozenPersonalInvocation(input),
      call = Object.freeze({ toolCallId: context.toolCallId, signal: context.signal });
    if (
      invocation.cwd !== this.config.workspace ||
      typeof call.toolCallId !== "string" ||
      call.toolCallId.includes("\0") ||
      call.toolCallId.length > 4096 ||
      !(call.signal instanceof AbortSignal)
    )
      throw Error("cache native issuer call expectation malformed");
    if (call.signal.aborted) return;
    if (this.config.authorize(invocation, call) !== true)
      throw Error("cache native issuer current authority unavailable");
    this.admit(); // The authority callback may have closed admission; never start after it did.
    if (this.rows.size >= this.config.maxCalls) throw Error("cache native issuer owner bound exceeded");
    let finish!: () => void, resolve!: () => void, reject!: (error: unknown) => void;
    const row: Row = {
      invocation,
      call,
      retiring: false,
      revoked: false,
      done: new Promise<void>((r) => {
        finish = r;
      }),
      released: new Promise<void>((a, b) => {
        resolve = a;
        reject = b;
      }),
      resolve: () => resolve(),
      reject: (e) => reject(e),
    };
    void row.released.catch(() => {}); // Original promise remains joined/rejected on shutdown.
    this.rows.add(row);
    try {
      row.image = await this.config.images.allocate(invocation.shell, call.signal);
      if (row.image === undefined) {
        this.rows.delete(row);
        row.resolve(); // Allocator independently certified no per-call resources/start.
        if (!this.closed && !call.signal.aborted && !this.allowed(row))
          throw Error("cache native issuer authority changed during allocation");
        return;
      }
      const image = row.image;
      if (
        !image ||
        typeof image.close !== "function" ||
        typeof image.shellPath !== "string" ||
        !image.shellPath.startsWith("/") ||
        image.shellPath.includes("\0") ||
        image.shellPath.length > 4096 ||
        !image.image ||
        !/^\d{1,24}$/.test(image.image.dev) ||
        !/^\d{1,24}$/.test(image.image.ino) ||
        this.images.has(image.shellPath)
      )
        throw Error("cache native issuer image allocation incompatible");
      // Keep a frozen identity copy independent of provider mutation, but retain its REAL cleanup capability.
      const close = image.close.bind(image);
      row.image = Object.freeze({ shellPath: image.shellPath, image: Object.freeze({ ...image.image }), close });
      if (this.closed || call.signal.aborted) {
        await this.dispose(row);
        return;
      }
      if (!this.allowed(row)) throw Error("cache native issuer authority changed during allocation");
      this.images.set(row.image.shellPath, row);
      return Object.freeze({ shellPath: row.image.shellPath, close: () => this.retire(row) });
    } catch (error) {
      if (!this.rows.has(row)) throw error; // Certified empty allocation: denial is not a cleanup owner.
      this.faulted = true;
      row.failure =
        error instanceof CacheNativeIssuerCleanupError
          ? error
          : new CacheNativeIssuerCleanupError([error], () => this.dispose(row));
      row.reject(row.failure);
      throw row.failure;
    } finally {
      finish();
    }
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    this.admit();
    if (this.pending.size >= this.config.maxPending) throw Error("cache native issuer pending owner bound exceeded");
    const task = Promise.resolve().then(work);
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  async claim(identity: CacheOwnerIdentity): Promise<boolean> {
    if (!isCacheOwner(identity)) throw Error("cache native issuer connector birth malformed");
    const owner = Object.freeze({ ...identity });
    return this.track(async () => {
      const path = await (this.config.select ?? ((value) => readlink(`/proc/${value.pid}/exe`)))(owner);
      this.admit();
      const row = this.images.get(path);
      if (!row) return false;
      if (row.retiring) throw Error("cache native issuer image retiring");
      if (row.owner) throw Error("cache native issuer image already claimed");
      row.owner = owner; // Reserve once, including an issuance refusal; never guess a replacement connector.
      // Issued attachment permits R only; current operation authorization and independent validation remain mandatory.
      row.role = this.config.roles.issue(owner, this.config.workspace, row.invocation, () => this.allowed(row));
      this.owners.set(key(owner), row);
      return true;
    });
  }
  async validate(
    owner: CacheOwnerIdentity,
    input: PersonalCacheInvocation,
    signal?: AbortSignal,
  ): Promise<CacheNativeContextResult | undefined> {
    if (!isCacheOwner(owner)) throw Error("cache native issuer connector birth malformed");
    const identity = Object.freeze({ ...owner });
    const row = this.owners.get(key(identity));
    if (!row) return;
    const invocation = frozenPersonalInvocation(input);
    const cancellation = AbortSignal.any([row.call.signal, ...(signal ? [signal] : [])]);
    return this.track(async () => {
      if (JSON.stringify(invocation) !== JSON.stringify(row.invocation))
        return { kind: "reject", reason: "native issued invocation mismatch" };
      if (row.retiring || !this.allowed(row)) return { kind: "reject", reason: "native call retired or unauthorized" };
      try {
        const result = await this.config.context.validate(
          identity,
          {
            parent: this.config.parent,
            image: { path: row.image!.shellPath, ...row.image!.image },
            invocation: row.invocation,
          },
          cancellation,
        );
        if (row.retiring || !this.allowed(row))
          return { kind: "reject", reason: "native call retired or unauthorized" };
        return result;
      } catch (error) {
        this.faulted = true;
        row.revoked = true;
        this.faults.add(error);
        throw error;
      }
    });
  }
  /** Trusted composition only: the issued native call, never a client-supplied correlation id. */
  callForOwner(owner: CacheOwnerIdentity): CacheNativeCall | undefined {
    const row = this.owners.get(key(owner));
    return row && this.allowed(row) ? row.call : undefined;
  }
  private retire(row: Row): Promise<void> {
    if (row.closing) return row.closing;
    row.retiring = true;
    if (row.role) this.config.roles.release(row.role);
    row.closing = Promise.resolve().then(async () => {
      await row.done;
      return this.dispose(row);
    });
    return row.closing;
  }
  private dispose(row: Row): Promise<void> {
    if (!this.rows.has(row)) return Promise.resolve();
    row.retiring = true;
    if (row.role) this.config.roles.release(row.role);
    if (row.cleaning) return row.cleaning;
    const task = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.pending]);
      try {
        if (!row.image || typeof row.image.close !== "function")
          throw Error("native image cleanup identity unavailable; retain");
        await row.image.close();
        if (this.images.get(row.image.shellPath) === row) this.images.delete(row.image.shellPath);
        if (row.owner && this.owners.get(key(row.owner)) === row) this.owners.delete(key(row.owner));
        this.rows.delete(row);
        row.resolve();
      } catch (error) {
        this.faulted = true;
        const failure = new CacheNativeIssuerCleanupError([error], () => this.dispose(row));
        row.failure ??= failure;
        row.reject(failure);
        throw failure;
      }
    });
    row.cleaning = task;
    void task
      .finally(() => {
        row.cleaning = undefined;
      })
      .catch(() => {}); // Observe derived promise only.
    return task;
  }
  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    for (const row of this.rows) if (row.role) this.config.roles.release(row.role);
    this.stopping = Promise.resolve().then(async () => {
      const rows = [...this.rows];
      await Promise.all(rows.map((row) => row.done));
      await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled(rows.map((row) => row.released));
      const errors = [
        ...this.faults,
        ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      ];
      if (errors.length) throw new CacheNativeIssuerCleanupError(errors, () => this.retry());
    });
    return this.stopping;
  }
  private async retry(): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const error of this.faults) {
      tasks.push(
        Promise.resolve().then(async () => {
          if (!(error instanceof CacheNativeContextCleanupError))
            throw new CacheNativeIssuerCleanupError([error], () => this.retry());
          await error.cleanup();
          this.faults.delete(error);
        }),
      );
    }
    for (const row of this.rows) tasks.push(row.retiring || row.failure ? this.dispose(row) : row.released);
    const results = await Promise.allSettled(tasks),
      errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new CacheNativeIssuerCleanupError(errors, () => this.retry());
  }
  stats() {
    return { owned: this.rows.size, pending: this.pending.size, faulted: this.faulted, closed: this.closed };
  }
}
