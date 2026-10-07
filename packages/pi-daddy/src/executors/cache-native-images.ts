/** Inactive private CS1 image publisher, not role issuance, eligibility or process supervision.
 * Trusted root composition supplies known static frontend bytes/digest and an outside-project temp parent.
 * Each native lease gets an independent image/CF1 sidecar. Keep directory/file descriptors until cleanup;
 * use descriptor-anchored paths, validate identities, never recursively remove an unvalidated stale path.
 * Same-UID concurrent renames are NOT contained or atomically excluded. No commands/helpers are started.
 * Store close stops publication and joins consumers: callers must stop/join their native factory too.
 * Failed cleanup retains actual handles and explicit retry; admission never revives after a fault.
 */
import * as fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, isAbsolute } from "node:path";
interface Options {
  directory: string;
  image: Buffer;
  sha256: string;
  socket: string;
  admissionMs: number;
  maxLeases: number;
  maxImageBytes: number;
  maxStorageBytes: number;
  /** Internal filesystem port for deterministic ownership tests; production uses Node defaults. */
  files?: typeof fs;
}
export interface CacheNativeImageLease {
  readonly shellPath: string;
  readonly image: Readonly<{ dev: string; ino: string }>;
  close(): Promise<void>;
}
interface File {
  name: string;
  handle?: fs.FileHandle;
  writer?: fs.FileHandle;
  info?: BigIntStats;
  unlinked?: boolean;
}
interface Row {
  files: File[];
  bytes: number;
  done: Promise<void>;
  released: Promise<void>;
  retire: boolean;
  settle(): void;
  reject(error: unknown): void;
  cleaning?: Promise<void>;
}
export class CacheNativeImageCleanupError extends AggregateError {
  readonly cleanup: () => Promise<void>;
  constructor(errors: unknown[], cleanup: () => Promise<void>) {
    super(errors, "cache native image cleanup unresolved; retain owners");
    this.cleanup = cleanup;
  }
}
const safeLine = (text: unknown, bytes: number): text is string =>
  typeof text === "string" && text.startsWith("/") && !/[\r\n\0]/.test(text) && Buffer.byteLength(text) < bytes;
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
export class CacheNativeImages {
  private readonly options: Pick<Options, "directory" | "socket" | "admissionMs" | "maxLeases" | "maxStorageBytes">;
  private readonly io: typeof fs;
  private readonly rows = new Set<Row>();
  private bytes: Buffer;
  private root?: { path?: string; handle?: fs.FileHandle; info?: BigIntStats; removed?: boolean };
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private cleaning?: Promise<void>;
  private closed = false;
  private faulted = false;
  constructor(options: Options) {
    if (
      process.platform !== "linux" ||
      !options ||
      typeof options.directory !== "string" ||
      !isAbsolute(options.directory) ||
      options.directory.includes("\0") ||
      !safeLine(options.socket, 108) ||
      !Number.isSafeInteger(options.admissionMs) ||
      options.admissionMs < 1 ||
      options.admissionMs > 30000 ||
      !Number.isSafeInteger(options.maxLeases) ||
      options.maxLeases < 1 ||
      options.maxLeases > 32 ||
      !Number.isSafeInteger(options.maxImageBytes) ||
      options.maxImageBytes < 1 ||
      options.maxImageBytes > 32 * 1024 * 1024 ||
      !Number.isSafeInteger(options.maxStorageBytes) ||
      options.maxStorageBytes < 1 ||
      !Buffer.isBuffer(options.image) ||
      !options.image.length ||
      options.image.length > options.maxImageBytes ||
      typeof options.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(options.sha256)
    )
      throw Error("cache native image configuration malformed or over bound");
    this.bytes = Buffer.from(options.image); // Independent known bytes; caller mutation cannot change a lease.
    if (createHash("sha256").update(this.bytes).digest("hex") !== options.sha256)
      throw Error("cache native image trusted digest mismatch");
    this.options = {
      directory: options.directory,
      socket: options.socket,
      admissionMs: options.admissionMs,
      maxLeases: options.maxLeases,
      maxStorageBytes: options.maxStorageBytes,
    };
    this.io = options.files ?? fs;
  }
  private prepare(): Promise<void> {
    if (this.starting) return this.starting;
    const root = (this.root = {} as NonNullable<typeof this.root>);
    this.starting = Promise.resolve().then(async () => {
      const parent = await this.io.realpath(this.options.directory);
      root.path = await this.io.mkdtemp(join(parent, "pi-daddy-cache-images-"));
      root.handle = await this.io.open(root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      root.info = await root.handle.stat({ bigint: true });
      if (
        !root.info.isDirectory() ||
        root.info.uid !== BigInt(process.getuid!()) ||
        (root.info.mode & 0o777n) !== 0o700n
      )
        throw Error("cache native image temporary root unsafe");
    });
    return this.starting;
  }
  private anchor(name: string): string {
    if (!this.root?.handle) throw Error("cache native image directory owner unavailable; retain");
    return `/proc/self/fd/${this.root.handle.fd}/${name}`;
  }
  async allocate(shell: string, signal?: AbortSignal): Promise<CacheNativeImageLease | undefined> {
    if (this.closed || this.faulted) throw Error("cache native image admission closed or faulted");
    if (!safeLine(shell, 4096) || signal?.aborted) return;
    const config = Buffer.from(`CF1\n${shell}\n${this.options.socket}\n${this.options.admissionMs}\n`);
    const bytes = this.bytes.length + config.length;
    if (this.rows.size >= this.options.maxLeases || bytes > this.options.maxStorageBytes - this.stats().reservedBytes)
      throw Error("cache native image owner or storage bound exceeded");
    let finished!: () => void, settle!: () => void, reject!: (error: unknown) => void;
    const row: Row = {
      files: [],
      bytes,
      retire: false,
      done: new Promise<void>((r) => {
        finished = r;
      }),
      released: new Promise<void>((a, b) => {
        settle = a;
        reject = b;
      }),
      settle: () => settle(),
      reject: (e) => reject(e),
    };
    void row.released.catch(() => {}); // Still owned/joined by store shutdown, never discard failure.
    this.rows.add(row);
    const cancelled = () => this.closed || signal?.aborted;
    try {
      await this.prepare();
      if (!cancelled()) {
        const name = "shell-" + randomUUID();
        for (const [suffix, data, mode] of [
          ["", this.bytes, 0o500],
          [".config", config, 0o600],
        ] as const) {
          if (cancelled()) break;
          const file: File = { name: name + suffix };
          row.files.push(file);
          file.writer = await this.io.open(
            this.anchor(file.name),
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          file.info = await file.writer.stat({ bigint: true });
          if (!file.info.isFile() || file.info.nlink !== 1n || file.info.uid !== BigInt(process.getuid!()))
            throw Error("cache native image created file unsafe");
          await file.writer.writeFile(data);
          await file.writer.chmod(mode);
          file.handle = await this.io.open(
            `/proc/self/fd/${file.writer.fd}`,
            constants.O_RDONLY | constants.O_NONBLOCK,
          );
          if (!same(await file.handle.stat({ bigint: true }), file.info))
            throw Error("cache native image read pin identity incompatible; retain");
          // A writable image descriptor forbids execve (ETXTBSY). Retain only readonly pins after publication.
          await file.writer.close();
          file.writer = undefined;
        }
      }
      if (cancelled()) {
        await this.release(row);
        return;
      }
      const namedRoot = await this.io.lstat(this.root!.path!, { bigint: true });
      if (!namedRoot.isDirectory() || !same(namedRoot, this.root!.info!))
        throw Error("cache native image root binding changed before publication");
      if (cancelled()) {
        await this.release(row);
        return;
      }
      const file = row.files[0];
      return Object.freeze({
        shellPath: join(this.root!.path!, file.name),
        image: Object.freeze({ dev: String(file.info!.dev), ino: String(file.info!.ino) }),
        close: () => this.release(row),
      });
    } catch (error) {
      this.faulted = true;
      try {
        await this.release(row);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "cache native image publication failed; retain");
      }
      throw error;
    } finally {
      finished();
    }
  }
  private release(row: Row): Promise<void> {
    if (!this.rows.has(row)) return Promise.resolve();
    row.retire = true;
    if (row.cleaning) return row.cleaning;
    row.cleaning = Promise.resolve()
      .then(async () => {
        const errors: unknown[] = [];
        for (const file of row.files) {
          try {
            const held = file.handle ?? file.writer;
            if (!file.info && held) file.info = await held.stat({ bigint: true });
            if (!file.unlinked) {
              if (!file.info) throw Error("cache native image file ownership unavailable; retain");
              const named = await this.io.lstat(this.anchor(file.name), { bigint: true });
              if (!same(named, file.info) || !named.isFile() || named.nlink !== 1n)
                throw Error("cache native image path changed; retain");
              await this.io.unlink(this.anchor(file.name));
              file.unlinked = true;
            }
            for (const field of ["handle", "writer"] as const) {
              if (!file[field]) continue;
              try {
                if ((await file[field]!.stat({ bigint: true })).nlink !== 0n)
                  throw Error("cache native image inode still linked after unlink; retain");
                await file[field]!.close();
                file[field] = undefined;
              } catch (error) {
                errors.push(error);
              }
            }
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) {
          this.faulted = true;
          const error = new CacheNativeImageCleanupError(errors, () => this.retry());
          row.reject(error);
          throw error;
        }
        this.rows.delete(row);
        row.settle();
      })
      .finally(() => {
        row.cleaning = undefined;
      });
    return row.cleaning;
  }
  private removeRoot(): Promise<void> {
    return Promise.resolve().then(async () => {
      const root = this.root;
      if (!root?.path) {
        this.root = undefined;
        this.bytes = Buffer.alloc(0);
        return;
      }
      if (!root.removed) {
        if (!root.info && root.handle) root.info = await root.handle.stat({ bigint: true });
        if (!root.info) throw Error("cache native image temporary root ownership unavailable; retain");
        const named = await this.io.lstat(root.path, { bigint: true });
        if (!named.isDirectory() || !same(named, root.info))
          throw Error("cache native image temporary root path changed; retain");
        await this.io.rmdir(root.path);
        root.removed = true;
      }
      if (root.handle) {
        await root.handle.close();
        root.handle = undefined;
      }
      this.root = undefined;
      this.bytes = Buffer.alloc(0);
    });
  }
  private async finish(retry: boolean) {
    this.closed = true;
    const rows = [...this.rows];
    await Promise.all(rows.map((row) => row.done));
    const attempts = retry
      ? rows.map((row) => (row.retire ? this.release(row) : row.released))
      : rows.map((row) => row.released);
    const settled = await Promise.allSettled(attempts);
    const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (!errors.length)
      try {
        await this.removeRoot();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length) {
      this.faulted = true;
      throw new CacheNativeImageCleanupError(errors, () => this.retry());
    }
  }
  private retry(): Promise<void> {
    if (this.cleaning) return this.cleaning;
    this.cleaning = Promise.resolve()
      .then(() => this.finish(true))
      .finally(() => {
        this.cleaning = undefined;
      });
    return this.cleaning;
  }
  close(): Promise<void> {
    if (!this.stopping) {
      this.closed = true;
      this.stopping = Promise.resolve().then(() => this.finish(false));
    }
    return this.stopping;
  }
  stats() {
    return {
      owned: this.rows.size,
      reservedBytes: [...this.rows].reduce((n, row) => n + row.bytes, 0),
      rootOwned: !!this.root,
      faulted: this.faulted,
    };
  }
}
