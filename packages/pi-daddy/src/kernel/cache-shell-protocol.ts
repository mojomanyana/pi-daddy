/** CS1 is an inactive private frontend protocol, never invocation/role authority by itself.
 * C sends actual argv/cwd/ordered environ; Node must independently bind native context and grants.
 * B=bypass, R=explicit refusal (never fallback), A=offer, client G=commit.
 * No execution/join/replay is allowed before receipt of G.
 * After attempting G the frontend never falls back. Lost responses cannot authorize another run.
 * This codec contains no coordinator policy and cannot infer options absent from native argv.
 */
export const CACHE_SHELL_REQUEST_BYTES = 1_200_000;
const signals = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 14, 15, 24, 25, 26, 27, 31]);
export interface CacheShellRequest {
  readonly shell: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly environment: readonly string[];
}
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decode(body: Buffer): Readonly<CacheShellRequest> {
  let cursor = 0;
  const number = () => {
    if (cursor + 4 > body.length) throw Error("cache shell request truncated integer");
    const n = body.readUInt32BE(cursor);
    cursor += 4;
    return n;
  };
  const text = (limit: number) => {
    const count = number();
    if (count > limit || cursor + count > body.length) throw Error("cache shell request field bound exceeded");
    const bytes = body.subarray(cursor, cursor + count);
    cursor += count;
    if (bytes.includes(0)) throw Error("cache shell request contains NUL");
    try {
      return textDecoder.decode(bytes);
    } catch (cause) {
      throw Error("cache shell request text unsupported", { cause });
    }
  };
  const shell = text(4095),
    cwd = text(4095),
    argc = number();
  if (!shell.startsWith("/") || !cwd.startsWith("/") || argc !== 2)
    throw Error("cache shell request shape unsupported");
  const args = [text(65536), text(65536)];
  if (args[0] !== "-c") throw Error("cache shell request arguments unsupported");
  const count = number(),
    environment: string[] = [],
    names = new Set<string>();
  if (count > 4096) throw Error("cache shell request environment count exceeded");
  const start = cursor;
  for (let i = 0; i < count; i++) {
    const binding = text(1048576),
      separator = binding.indexOf("="),
      name = binding.slice(0, separator);
    if (separator <= 0 || names.has(name)) throw Error("cache shell request environment incompatible");
    names.add(name);
    environment.push(binding);
  }
  if (cursor - start > 1048576 || cursor !== body.length)
    throw Error("cache shell request trailing bytes or environment bound exceeded");
  return Object.freeze({ shell, cwd, args: Object.freeze(args), environment: Object.freeze(environment) });
}
export class CacheShellRequestDecoder {
  private header = Buffer.alloc(8);
  private headerUsed = 0;
  private body?: Buffer;
  private used = 0;
  private complete = false;
  feed(bytes: Buffer): Readonly<CacheShellRequest> | undefined {
    if (this.complete) throw Error("cache shell request already complete");
    try {
      return this.consume(bytes);
    } catch (error) {
      this.complete = true;
      this.body = undefined;
      throw error;
    }
  }
  private consume(bytes: Buffer): Readonly<CacheShellRequest> | undefined {
    let cursor = 0;
    if (this.headerUsed < 8) {
      const count = Math.min(8 - this.headerUsed, bytes.length);
      bytes.copy(this.header, this.headerUsed, 0, count);
      this.headerUsed += count;
      cursor += count;
      if (this.headerUsed < 8) return;
      const countBody = this.header.readUInt32BE(4);
      if (
        !this.header.subarray(0, 4).equals(Buffer.from("CS1\0")) ||
        countBody < 20 ||
        countBody > CACHE_SHELL_REQUEST_BYTES
      )
        throw Error("cache shell request protocol or byte bound incompatible");
      this.body = Buffer.alloc(countBody);
    }
    const body = this.body!;
    if (bytes.length - cursor > body.length - this.used) throw Error("cache shell request trailing bytes");
    bytes.copy(body, this.used, cursor);
    this.used += bytes.length - cursor;
    if (this.used < body.length) return;
    this.complete = true;
    this.body = undefined;
    return decode(body);
  }
}
export function cacheShellOutput(stream: "stdout" | "stderr", bytes: Buffer): Buffer {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 4096)
    throw Error("cache shell output chunk must be 1..4096 bytes");
  const header = Buffer.alloc(5);
  header[0] = stream === "stdout" ? 79 : 69;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
export function cacheShellExit(code: number): Buffer {
  if (!Number.isInteger(code) || code < 0 || code > 255) throw Error("cache shell exit code unsupported");
  const result = Buffer.alloc(5);
  result[0] = 88;
  result.writeUInt32BE(code, 1);
  return result;
}
export function cacheShellSignal(signal: number): Buffer {
  if (!signals.has(signal)) throw Error("cache shell terminal signal unsupported");
  const result = Buffer.alloc(5);
  result[0] = 83;
  result.writeUInt32BE(signal, 1);
  return result;
}
