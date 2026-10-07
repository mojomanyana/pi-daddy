/** Inactive independent Linux native process-context observation, NOT an issuer or grant provider.
 * Trusted composition supplies CP1 birth, actual direct parent, per-call published image and final native
 * invocation. Bounded proc reads own every descriptor/late operation; failed closes retain retry owners.
 * Between-operation deadline/cancellation is not an interruptible kernel-I/O or atomic snapshot guarantee.
 * Equal before/after observations cannot exclude same-UID races, memory mutation/undo or socket transfer.
 * This establishes neither factory/options source, eligibility, effects, tree death nor current authority.
 */
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { isCacheOwner, type CacheOwnerIdentity } from "../kernel/cache-owner.ts";
import { frozenPersonalInvocation, type PersonalCacheInvocation } from "../kernel/cache-personal-invocation.ts";
export interface CacheNativeContextOptions {
  checks: number;
  maxReadBytes: number;
  maxTotalBytes: number;
  timeoutMs: number;
  /** Trusted fixture ports only; production omits both. No global monkeypatching. */
  procRoot?: string;
  files?: Pick<typeof fs, "open" | "readlink" | "stat">;
}
export interface CacheNativeContextExpected {
  parent: CacheOwnerIdentity;
  image: { path: string; dev: string; ino: string };
  invocation: PersonalCacheInvocation;
}
export type CacheNativeContextResult = { kind: "qualified" } | { kind: "bypass" | "reject"; reason: string };
export class CacheNativeContextCleanupError extends AggregateError {
  readonly cleanup: () => Promise<void>;
  constructor(errors: unknown[], cleanup: () => Promise<void>) {
    super(errors, "cache native context cleanup unresolved; retain owners");
    this.cleanup = cleanup;
  }
}
class Uncertain extends Error {}
class Mismatch extends Error {}
interface Row {
  handles: Set<FileHandle>;
  done: Promise<void>;
  cleaning?: Promise<void>;
  failure?: CacheNativeContextCleanupError;
}
export class CacheNativeContext {
  private readonly config: CacheNativeContextOptions;
  private readonly files: Pick<typeof fs, "open" | "readlink" | "stat">;
  private readonly rows = new Set<Row>();
  private faulted = false;
  private stopped = false;
  private stopping?: Promise<void>;
  constructor(options: CacheNativeContextOptions) {
    this.config = { ...options };
    this.files = options.files ?? fs;
    if (
      !Number.isSafeInteger(options.checks) ||
      options.checks < 1 ||
      options.checks > 32 ||
      !Number.isSafeInteger(options.maxReadBytes) ||
      options.maxReadBytes < 1 ||
      options.maxReadBytes > 1200000 ||
      !Number.isSafeInteger(options.maxTotalBytes) ||
      options.maxTotalBytes < 1 ||
      options.maxTotalBytes > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 30000 ||
      (options.procRoot !== undefined && (!options.procRoot.startsWith("/") || options.procRoot.includes("\0")))
    )
      throw Error("cache native context configuration malformed or over bound");
  }
  private cleanup(row: Row): Promise<void> {
    if (row.cleaning) return row.cleaning;
    const task = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      for (const handle of row.handles) {
        try {
          await handle.close();
          row.handles.delete(handle);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        this.faulted = true;
        const failure = new CacheNativeContextCleanupError(errors, () => this.cleanup(row));
        row.failure ??= failure;
        throw failure;
      }
      this.rows.delete(row);
    });
    row.cleaning = task;
    // Observe only this derived promise; the ORIGINAL task still rejects to its cleanup owner.
    void task
      .finally(() => {
        row.cleaning = undefined;
      })
      .catch(() => {});
    return task;
  }
  async validate(
    connector: CacheOwnerIdentity,
    input: CacheNativeContextExpected,
    signal?: AbortSignal,
  ): Promise<CacheNativeContextResult> {
    if (this.stopped || this.faulted || this.rows.size >= this.config.checks)
      throw Error("cache native context admission closed, faulted or over bound");
    if (
      !isCacheOwner(connector) ||
      !isCacheOwner(input.parent) ||
      !input.image.path.startsWith("/") ||
      input.image.path.includes("\0") ||
      input.image.path.length > 4096 ||
      !/^\d{1,24}$/.test(input.image.dev) ||
      !/^\d{1,24}$/.test(input.image.ino)
    )
      throw Error("cache native context expectation malformed");
    const owner = Object.freeze({ ...connector }),
      parent = Object.freeze({ ...input.parent }),
      image = Object.freeze({ ...input.image }),
      invocation = frozenPersonalInvocation(input.invocation);
    if (signal?.aborted || process.platform !== "linux")
      return { kind: "bypass", reason: "native context cancelled or unsupported platform" };
    let finish!: () => void;
    const row: Row = {
      handles: new Set(),
      done: new Promise<void>((r) => {
        finish = r;
      }),
    };
    this.rows.add(row); // Before first asynchronous operation, including late open results.
    const deadline = performance.now() + this.config.timeoutMs;
    let total = 0;
    const check = () => {
      if (signal?.aborted || this.stopped || performance.now() > deadline)
        throw new Uncertain("native context cancelled, closed or over time budget");
    };
    const read = async (path: string, bound: number): Promise<Buffer> => {
      check();
      const handle = await this.files.open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      row.handles.add(handle);
      check();
      if (!(await handle.stat()).isFile()) throw new Uncertain("native context observation is not regular");
      const parts: Buffer[] = [];
      let size = 0;
      while (true) {
        check();
        const bytes = Buffer.alloc(Math.min(65536, bound + 1 - size));
        const value = await handle.read(bytes, 0, bytes.length, null);
        check();
        if (!value.bytesRead) break;
        size += value.bytesRead;
        total += value.bytesRead;
        if (size > bound || total > this.config.maxTotalBytes)
          throw new Uncertain("native context read byte budget exceeded");
        parts.push(bytes.subarray(0, value.bytesRead));
      }
      try {
        await handle.close();
        row.handles.delete(handle);
      } catch (error) {
        this.faulted = true;
        row.failure = new CacheNativeContextCleanupError([error], () => this.cleanup(row));
        throw row.failure;
      }
      check();
      return Buffer.concat(parts, size);
    };
    const root = this.config.procRoot ?? "/proc";
    const proc = (pid: number, name: string) => join(root, String(pid), name);
    const birth = async (identity: CacheOwnerIdentity) => {
      const bootId = (await read(join(root, "sys/kernel/random/boot_id"), 128)).toString("ascii").trim();
      const text = (await read(proc(identity.pid, "stat"), 8192)).toString("ascii"),
        end = text.lastIndexOf(")");
      const fields = text
        .slice(end + 2)
        .trim()
        .split(/\s+/);
      const value = { pid: identity.pid, bootId, startTicks: fields[19] };
      if (
        end < 0 ||
        !text.startsWith(`${identity.pid} (`) ||
        !/^[RSDTtIPWKZXx]$/.test(fields[0]) ||
        !isCacheOwner(value)
      )
        throw new Uncertain("native context birth observation malformed");
      return { ...value, alive: !/^[ZXx]$/.test(fields[0]) };
    };
    const sameBirth = (actual: Awaited<ReturnType<typeof birth>>, expected: CacheOwnerIdentity) =>
      actual.alive &&
      actual.pid === expected.pid &&
      actual.bootId === expected.bootId &&
      actual.startTicks === expected.startTicks;
    const requireMatch = (matches: boolean, reason: string) => {
      if (!matches) throw new Mismatch(`native context ${reason} mismatch`);
    };
    const observe = async () => {
      check();
      // Refuse a known mismatch IMMEDIATELY; later unreadable fields cannot downgrade it to B.
      requireMatch(sameBirth(await birth(owner), owner), "connector birth");
      requireMatch(sameBirth(await birth(parent), parent), "parent birth");
      const status = (await read(proc(owner.pid, "status"), 8192)).toString("ascii");
      const ppid = status.match(/^PPid:\s+(\d+)$/m)?.[1];
      if (!ppid || !Number.isSafeInteger(Number(ppid)))
        throw new Uncertain("native context parent observation malformed");
      requireMatch(Number(ppid) === parent.pid, "parent");
      const executable = await this.files.readlink(proc(owner.pid, "exe"));
      requireMatch(executable === image.path, "image path");
      check();
      const actualImage = await this.files.stat(proc(owner.pid, "exe"), { bigint: true });
      requireMatch(
        actualImage.isFile() && String(actualImage.dev) === image.dev && String(actualImage.ino) === image.ino,
        "image identity",
      );
      check();
      requireMatch((await this.files.readlink(proc(owner.pid, "cwd"))) === invocation.cwd, "cwd");
      check();
      requireMatch((await this.files.readlink(proc(owner.pid, "fd/0"))) === "/dev/null", "input path");
      check();
      const inputInfo = await this.files.stat(proc(owner.pid, "fd/0"), { bigint: true });
      requireMatch(inputInfo.isCharacterDevice() && inputInfo.rdev === 0x103n, "input device");
      check();
      const nullInfo = await this.files.stat("/dev/null", { bigint: true });
      requireMatch(
        nullInfo.isCharacterDevice() && inputInfo.dev === nullInfo.dev && inputInfo.ino === nullInfo.ino,
        "input identity",
      );
      check();
      const fdinfo = (await read(proc(owner.pid, "fdinfo/0"), 8192)).toString("ascii");
      const flags = fdinfo.match(/^flags:\s+([0-7]{1,16})$/m)?.[1];
      if (!flags) throw new Uncertain("native context input flags malformed");
      // O_PATH has read-only access-mode bits but cannot read; EOF is not EBADF.
      requireMatch((BigInt(`0o${flags}`) & (3n | 0x200000n)) === 0n, "input read access");
      const args = await read(proc(owner.pid, "cmdline"), Math.min(73728, this.config.maxReadBytes));
      requireMatch(args.equals(Buffer.from([image.path, "-c", invocation.command, ""].join("\0"))), "argv");
      const environment = await read(proc(owner.pid, "environ"), this.config.maxReadBytes);
      requireMatch(
        environment.equals(
          Buffer.from([...Object.entries(invocation.env).map(([name, value]) => `${name}=${value}`), ""].join("\0")),
        ),
        "environment",
      );
    };
    try {
      await observe();
      await observe();
      // Recheck birth AFTER the last vector read, not just at each observation's beginning.
      requireMatch(sameBirth(await birth(owner), owner), "final connector birth");
      requireMatch(sameBirth(await birth(parent), parent), "final parent birth");
      check();
      return { kind: "qualified" };
    } catch (error) {
      if (error instanceof CacheNativeContextCleanupError) throw error;
      return {
        kind: error instanceof Mismatch ? "reject" : "bypass",
        reason:
          error instanceof Uncertain || error instanceof Mismatch
            ? error.message
            : "native context observation unavailable",
      };
    } finally {
      try {
        // A failed close is not observation uncertainty. Retain its handle until EXPLICIT retry.
        if (!row.failure) await this.cleanup(row);
      } finally {
        finish();
      }
    }
  }
  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.stopping = Promise.resolve().then(async () => {
      await Promise.all([...this.rows].map((r) => r.done));
      if (this.rows.size)
        throw new CacheNativeContextCleanupError(
          [...this.rows].map((row) => row.failure),
          () => this.retry(),
        );
    });
    return this.stopping;
  }
  private async retry(): Promise<void> {
    const results = await Promise.allSettled([...this.rows].map((r) => this.cleanup(r)));
    const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    if (errors.length) throw new CacheNativeContextCleanupError(errors, () => this.retry());
  }
  stats() {
    return {
      owned: this.rows.size,
      handles: [...this.rows].reduce((n, r) => n + r.handles.size, 0),
      faulted: this.faulted,
      closed: this.stopped,
    };
  }
}
