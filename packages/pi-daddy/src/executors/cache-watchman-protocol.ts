/**
 * Bounded Watchman JSON-over-Unix-socket transport. No auto-spawn or shared-service shutdown commands.
 * Replies are ordered by Watchman; subscription frames are unsolicited and must not consume reply slots.
 * A timeout/parse/size/disconnect fault closes the connection and refuses all pending work, since keeping
 * it after a missing reply would misattribute a late response and could fabricate a freshness barrier.
 */
import { createConnection, type Socket } from "node:net";

export interface WatchmanWireOptions {
  timeoutMs?: number;
  maxMessageBytes?: number;
}
interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}
export class WatchmanConnection {
  private socket: Socket;
  private pending: Pending[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private unavailable = false;
  private timeoutMs: number;
  private maxMessageBytes: number;
  private event: (value: Record<string, unknown>) => void;
  private loss: (reason: string) => void;

  private constructor(
    socket: Socket,
    event: WatchmanConnection["event"],
    loss: WatchmanConnection["loss"],
    options: WatchmanWireOptions,
  ) {
    this.socket = socket;
    this.event = event;
    this.loss = loss;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
    // Keep raw bytes until a full frame exists; setEncoding would silently replace invalid UTF-8.
    socket.on("data", (data: Buffer) => this.receive(data));
    socket.on("error", (error) => this.fail(`Watchman transport error: ${error.message}`));
    socket.on("close", () => this.fail("Watchman transport disconnected"));
  }

  static async connect(
    path: string,
    event: WatchmanConnection["event"],
    loss: WatchmanConnection["loss"],
    options: WatchmanWireOptions = {},
  ): Promise<WatchmanConnection> {
    for (const [name, value] of Object.entries(options))
      if (!Number.isSafeInteger(value) || value! <= 0 || value! > 16 * 1024 * 1024)
        throw new Error(`Watchman ${name} must be a bounded positive safe integer`);
    const socket = createConnection(path);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Watchman connection timeout"));
      }, options.timeoutMs ?? 3000);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return new WatchmanConnection(socket, event, loss, options);
  }

  command(value: readonly unknown[], timeoutMs = this.timeoutMs): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 16 * 1024 * 1024)
      return Promise.reject(new Error("Watchman command timeoutMs must be a bounded positive safe integer"));
    if (this.unavailable) return Promise.reject(new Error("Watchman transport unavailable"));
    if (this.pending.length >= 16) return Promise.reject(new Error("Watchman pending-command limit reached"));
    const encoded = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(encoded) > this.maxMessageBytes)
      return Promise.reject(new Error("Watchman command exceeded size limit"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("Watchman response timeout; synchronization lost"), timeoutMs);
      this.pending.push({ resolve, reject, timer });
      this.socket.write(encoded);
    });
  }

  close(): void {
    this.fail("Watchman transport closed by owner");
  }

  private receive(data: Buffer): void {
    if (this.unavailable) return;
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > this.maxMessageBytes) {
      this.fail("Watchman reply exceeded size limit");
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf(0x0a)) !== -1) {
      const bytes = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      let line: string;
      try {
        line = this.decoder.decode(bytes);
      } catch (error) {
        this.fail(`Watchman malformed UTF-8 reply: ${String(error)}`);
        return;
      }
      let value: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        value = parsed as Record<string, unknown>;
      } catch (error) {
        this.fail(`Watchman malformed reply: ${String(error)}`);
        return;
      }
      if (Object.hasOwn(value, "error") && typeof value.error !== "string") {
        this.fail("Watchman malformed error discriminator");
        return;
      }
      if (typeof value.subscription === "string") {
        if (typeof value.error === "string") {
          this.fail(`Watchman subscription refused: ${value.error}`);
          return;
        }
        try {
          this.event(value);
        } catch (error) {
          this.fail(`Watchman subscription validation failed: ${String(error)}`);
          return;
        }
        continue;
      }
      const pending = this.pending.shift();
      if (!pending) {
        this.fail("Watchman unsolicited non-subscription reply");
        return;
      }
      clearTimeout(pending.timer);
      if (typeof value.error === "string") pending.reject(new Error(`Watchman command refused: ${value.error}`));
      else pending.resolve(value);
    }
  }

  private fail(reason: string): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.buffer = Buffer.alloc(0);
    this.socket.destroy();
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.loss(reason);
  }
}
