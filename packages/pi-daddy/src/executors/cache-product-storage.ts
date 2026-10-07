/** UNTESTED (per request). Private epoch storage; pending allocations are charged and joined before release.
 * Original handles and identity-checked names only, never recursive/stale-path cleanup. Component publication
 * caps do not bound an external Watchman's growing files or establish a disk/RSS guarantee. */
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, realpath, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
interface Entry {
  name: string;
  bytes: number;
  info?: BigIntStats;
  handle?: FileHandle;
  writer?: FileHandle;
  created?: boolean;
  unlinked?: boolean;
}
export class CacheProductStorageCleanupError extends AggregateError {
  constructor(errors: unknown[], readonly cleanup: () => Promise<void>) {
    super(errors, "cache product storage cleanup unresolved; retain original owners");
  }
}
export class CacheProductStorage {
  path = "";
  private handle?: FileHandle;
  private info?: BigIntStats;
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Set<Promise<unknown>>();
  private starting?: Promise<void>;
  private removed = false;
  private closed = false;
  private stopping?: Promise<void>;
  private recovery?: Promise<void>;
  private failure?: CacheProductStorageCleanupError;
  constructor(private readonly maxBytes = 256 * 1024 * 1024, private readonly maxEntries = 16) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw Error("cache storage limits malformed");
  }
  private owned<T>(operation: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(operation);
    this.pending.add(task); // Publish ownership before the first filesystem operation.
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }
  prepare(): Promise<void> {
    if (this.starting || this.closed) throw Error("cache product storage already allocated or closed");
    return (this.starting = this.owned(async () => {
      const parent = await realpath(tmpdir());
      if (this.closed) throw Error("cache storage allocation stopped");
      this.path = await mkdtemp(join(parent, "pd-cache-"));
      this.handle = await open(this.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      this.info = await this.handle.stat({ bigint: true });
      if (!this.info.isDirectory() || this.info.uid !== BigInt(process.getuid!()) || (this.info.mode & 0o777n) !== 0o700n)
        throw Error("cache product private storage unsafe; retain");
      if (this.closed) throw Error("cache storage allocation stopped; owner retained");
      if (Buffer.byteLength(join(this.path, "broker.sock")) >= 108) throw Error("cache product private socket path too long");
    }));
  }
  private anchor(name: string): string {
    if (!this.handle || !/^[a-z0-9.-]+$/.test(name)) throw Error("cache product storage owner unavailable");
    return `/proc/self/fd/${this.handle.fd}/${name}`;
  }
  private reserve(name: string, bytes: number, cleanupOnly = false): Entry {
    if ((this.closed && !cleanupOnly) || this.entries.has(name) || !/^[a-z0-9.-]+$/.test(name) || this.entries.size >= this.maxEntries ||
        bytes > this.maxBytes - this.stats().reservedBytes)
      throw Error("cache product storage publication bound or admission exceeded");
    const row: Entry = { name, bytes };
    this.entries.set(name, row);
    return row;
  }
  publish(name: string, bytes: Buffer): Promise<string> {
    const row = this.reserve(name, bytes.length);
    return this.owned(async () => {
      if (this.closed) throw Error("cache storage publication stopped");
      row.writer = await open(this.anchor(name), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      row.created = true;
      row.info = await row.writer.stat({ bigint: true });
      if (this.closed) throw Error("cache storage publication stopped; owner retained");
      await row.writer.writeFile(bytes);
      await row.writer.chmod(0o500);
      row.handle = await open(`/proc/self/fd/${row.writer.fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
      await row.writer.close(); // Both originals remain owned if this rejects.
      row.writer = undefined;
      if (this.closed) throw Error("cache storage publication stopped; owner retained");
      return join(this.path, name);
    });
  }
  ownSocket(name: string, optional = false): Promise<void> {
    if (this.entries.get(name)?.created) return Promise.resolve();
    const row = this.entries.get(name) ?? this.reserve(name, 0, optional);
    return this.owned(async () => {
      try { row.info = await lstat(this.anchor(name), { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.entries.delete(name);
          if (optional) return;
        }
        throw error;
      }
      row.created = true;
      if (!row.info.isSocket() || row.info.uid !== BigInt(process.getuid!())) throw Error("cache product socket binding unsafe");
    });
  }
  /** Adopt package-selected outputs only after joining the supervised writer. May run during teardown. */
  ownWatchmanFiles(): Promise<void> {
    return this.owned(async () => {
      for (const name of ["watch.sock", "watch.sock.log", "watch.sock.pid", "watch.sock.state"]) {
        if (this.entries.has(name)) continue;
        const row: Entry = { name, bytes: 0 };
        this.entries.set(name, row);
        try {
          row.info = await lstat(this.anchor(name), { bigint: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.entries.delete(name); continue; }
          throw error;
        }
        row.created = true;
        if (row.info.uid !== BigInt(process.getuid!()) || (!row.info.isSocket() && !row.info.isFile()))
          throw Error("owned Watchman output unsafe; retain");
        row.bytes = Number(row.info.size);
        if (this.stats().reservedBytes > this.maxBytes) throw Error("owned Watchman storage exceeds component bound; retain");
        if (row.info.isFile()) {
          row.handle = await open(this.anchor(name), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
          if (!same(await row.handle.stat({ bigint: true }), row.info)) throw Error("owned Watchman output replaced; retain");
        }
      }
    });
  }
  private async release(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    const errors: unknown[] = [];
    for (const row of this.entries.values()) {
      try {
        if (!row.created) { this.entries.delete(row.name); continue; }
        if (!row.unlinked) {
          row.info ??= await (row.handle ?? row.writer)?.stat({ bigint: true });
          const named = await lstat(this.anchor(row.name), { bigint: true });
          if (!row.info || !same(named, row.info)) throw Error("cache product storage binding replaced; retain");
          await unlink(this.anchor(row.name));
          row.unlinked = true;
        }
        for (const field of ["handle", "writer"] as const) {
          if (row[field]) { await row[field]!.close(); row[field] = undefined; }
        }
        this.entries.delete(row.name);
      } catch (error) { errors.push(error); }
    }
    if (!errors.length) {
      try {
        if (this.path && !this.removed) {
          if (!this.info || !same(await lstat(this.path, { bigint: true }), this.info))
            throw Error("cache product directory binding replaced or unknown; retain");
          await rmdir(this.path); // Unknown entries are never recursively deleted.
          this.removed = true;
        }
        if (this.handle) { await this.handle.close(); this.handle = undefined; }
      } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      this.failure ??= new CacheProductStorageCleanupError(errors, () => this.recover());
      throw this.failure; // Immutable original failure even when a later retry fails differently.
    }
  }
  close(): Promise<void> {
    this.closed = true;
    return (this.stopping ??= Promise.resolve().then(() => this.release()));
  }
  recover(): Promise<void> {
    if (!this.closed) throw Error("stop cache product before storage recovery");
    return (this.recovery ??= Promise.resolve().then(async () => {
      await this.stopping?.catch((error) => { if (error !== this.failure) throw error; });
      await this.release();
    }).finally(() => { this.recovery = undefined; }));
  }
  stats() {
    return { path: this.path, entries: this.entries.size, pending: this.pending.size,
      reservedBytes: [...this.entries.values()].reduce((n, row) => n + row.bytes, 0), maxBytes: this.maxBytes,
      directoryOwned: !!this.handle, closed: this.closed };
  }
}
