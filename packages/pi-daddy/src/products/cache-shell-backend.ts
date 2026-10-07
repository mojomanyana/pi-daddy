/** Inactive committed CS1 backend for a trusted personal runtime, NOT Pi/grant/native qualification.
 * Strict private Bash frames -> awaited raw channel bytes. No reconstruction from truncated output.
 * Current operation permission remains service/role authority; this only binds its runtime requester.
 */
import { CACHE_STREAM_FRAME_BYTES } from "../kernel/cache-data-sink.ts";
import type { PersonalCacheInvocation } from "../kernel/cache-personal-invocation.ts";
import { PersonalCacheRuntime } from "./cache-personal-runtime.ts";
import type { CacheResolution } from "./cache-scheduler.ts";
import type { CacheShellCompletion, CacheShellServiceOptions } from "./cache-shell-service.ts";
export type CacheShellRunOptions = Parameters<CacheShellServiceOptions["run"]>[1] & { force?: boolean };
export interface CacheShellBackendCompletion extends CacheShellCompletion {
  /** Private composition provenance only: never injected into stdout/stderr or native status frames. */
  resolution: CacheResolution;
  bypassReason?: string;
  bypassRequestId?: string;
}
export class CacheShellBackend {
  private readonly runtime: PersonalCacheRuntime;
  constructor(runtime: PersonalCacheRuntime) {
    this.runtime = runtime;
  }
  async run(
    invocation: Readonly<PersonalCacheInvocation>,
    options: CacheShellRunOptions,
  ): Promise<CacheShellBackendCompletion | undefined> {
    if (options.signal.aborted || !options.authorize()) return;
    const actor = this.runtime.attach(options.authorize);
    try {
      let sawOutput = false;
      const request = {
        signal: options.signal,
        force: options.force,
        joinCleanup: true as const,
        onData: async (bytes: Buffer) => {
          sawOutput = true;
          if (!Buffer.isBuffer(bytes) || bytes.length > CACHE_STREAM_FRAME_BYTES || bytes.some((b) => b > 127))
            throw Error("private Bash output frame incompatible");
          let row: { channel?: unknown; bytes?: unknown };
          try {
            row = JSON.parse(bytes.toString());
          } catch {
            throw Error("private Bash output frame incompatible");
          }
          if (
            !row ||
            typeof row !== "object" ||
            Array.isArray(row) ||
            Object.keys(row).length !== 2 ||
            !["stdout", "stderr"].includes(String(row.channel)) ||
            typeof row.bytes !== "string" ||
            row.bytes.length > 131072
          )
            throw Error("private Bash output frame incompatible");
          const raw = Buffer.from(row.bytes, "base64");
          if (raw.toString("base64") !== row.bytes) throw Error("private Bash output base64 incompatible");
          await options.emit(row.channel as "stdout" | "stderr", raw);
        },
      };
      let result = await this.runtime.request(actor, invocation, request);
      let bypassReason: string | undefined, bypassRequestId: string | undefined;
      if (
        result.kind === "bypass" &&
        !result.executionId &&
        !result.outcome &&
        !sawOutput &&
        !options.signal.aborted &&
        options.authorize()
      ) {
        bypassReason = result.reason;
        bypassRequestId = result.requestId;
        result = await this.runtime.uncached(actor, invocation, result, request);
      }
      if (options.signal.aborted || !options.authorize()) return;
      if (!["execute", "join", "reuse"].includes(result.kind) || !result.outcome)
        throw Error("committed shell lacks completed governed outcome; not retrying");
      return Object.freeze({
        exitCode: result.outcome.exitCode,
        signal: result.outcome.signal,
        resolution: result,
        bypassReason,
        bypassRequestId,
      });
    } finally {
      this.runtime.disconnect(actor);
    }
  }
}
