/**
 * Owned byte-vector acquisition using the existing descriptor-only content lease bridge.
 * ALL guards are acquired before ANY content read. If irreversible guards survive later
 * checks, captured bytes coexisted at the last guard's acquisition point. This is a PAST
 * byte point, not current freshness, pathname/metadata coverage, an execution-input proof,
 * authority or command eligibility. The bridge is a trusted internal dependency, not RPC.
 *
 * Own O_PATH pins and readonly reopens prevent borrowed-FD closure/reuse from redirecting
 * reads. Only measured local ext4/tmpfs regular files are admitted. Size/count budgets and
 * abort/deadline checks bound work BETWEEN operations; one wedged kernel I/O cannot be
 * interrupted in-process. Cleanup joins pending operations; it never races them to return.
 * A cleanup failure retains a callable retry capability rather than forgetting resources.
 */
import { constants } from "node:fs";
import { open, statfs, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants as bufferLimits } from "node:buffer";
import { CACHE_LEASE_CAPACITY } from "../kernel/cache-lease-protocol.ts";
import type { CacheContentLease, CacheLeaseAcquisition } from "./cache-lease-bridge.ts";

export interface ByteCaptureOptions {
  inputs: readonly { fd: number; dev: bigint; ino: bigint }[];
  leases: { acquire(fd: number, info: import("node:fs").BigIntStats): Promise<CacheLeaseAcquisition> };
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; timeoutMs: number };
  signal?: AbortSignal;
  /** Deterministic between-operation clock tests only; production omits it. */
  now?: () => number;
}
export interface CapturedByteVector {
  readonly items: readonly {
    readonly dev: string;
    readonly ino: string;
    readonly size: number;
    readonly sha256: string;
  }[];
  /** Private past-point bytes copied on delivery. Never claims the original path still names them. */
  copyCapturedBytes(index: number): Buffer;
  /** Sequential irreversible lease checks, NOT an atomic current-source validation operation. */
  guardsUnbroken(): Promise<boolean>;
  release(): Promise<void>;
}
export type ByteCaptureResult = { kind: "captured"; capture: CapturedByteVector } | { kind: "bypass"; reason: string };
export class ByteCaptureCleanupError extends AggregateError {
  readonly cleanup: () => Promise<void>;
  constructor(errors: unknown[], cleanup: () => Promise<void>, cause?: unknown) {
    super(errors, "byte capture cleanup unresolved; owned retry required", { cause });
    this.cleanup = cleanup;
  }
}
class Refused extends Error {}
type Resource = { pin?: FileHandle; file?: FileHandle; lease?: CacheContentLease };
const O_PATH = 0x200000; // Linux UAPI; Node does not expose this constant.
const CAPTURE_BYTES_CEILING = 32 * 1024 * 1024; // Defensive component ceiling, not a configured/profile default.

export async function captureByteVector(options: ByteCaptureOptions): Promise<ByteCaptureResult> {
  const limits = { ...options.limits },
    inputs = options.inputs.map(({ fd, dev, ino }) => ({ fd, dev, ino })),
    leaseSource = options.leases,
    signal = options.signal;
  for (const field of ["maxFiles", "maxFileBytes", "maxTotalBytes", "timeoutMs"] as const) {
    if (!Number.isSafeInteger(limits[field]) || limits[field] <= 0)
      return { kind: "bypass", reason: `byte capture invalid ${field}` };
  }
  if (
    limits.maxFiles > CACHE_LEASE_CAPACITY ||
    limits.maxFileBytes >= bufferLimits.MAX_LENGTH ||
    limits.maxFileBytes > CAPTURE_BYTES_CEILING ||
    limits.maxTotalBytes > CAPTURE_BYTES_CEILING
  ) {
    return { kind: "bypass", reason: "byte capture limits exceed supported capacity" };
  }
  if (!inputs.length || inputs.length > limits.maxFiles)
    return { kind: "bypass", reason: "byte capture input count exceeds bounds" };
  for (const input of inputs) {
    if (
      !Number.isSafeInteger(input.fd) ||
      input.fd < 3 ||
      typeof input.dev !== "bigint" ||
      typeof input.ino !== "bigint" ||
      input.dev < 0n ||
      input.ino < 0n ||
      input.dev > 0xffffffffffffffffn ||
      input.ino > 0xffffffffffffffffn
    ) {
      return { kind: "bypass", reason: "byte capture invalid descriptor identity" };
    }
  }
  if (process.platform !== "linux")
    return { kind: "bypass", reason: "byte capture requires measured Linux descriptors" };
  const now = options.now ?? (() => performance.now()),
    deadline = now() + limits.timeoutMs;
  const resources: Resource[] = [],
    data: Buffer[] = [],
    physical = new Set<string>();
  let retired = false,
    cleaning: Promise<void> | undefined;
  const retire = () => {
    retired = true;
    data.length = 0;
  };
  const checkWork = () => {
    if (signal?.aborted) throw new Refused("byte capture aborted between operations");
    if (now() > deadline) throw new Refused("byte capture time budget exceeded between operations");
  };
  const cleanup = async (cause?: unknown): Promise<void> => {
    retire();
    if (cleaning) return cleaning;
    cleaning = (async () => {
      const errors: unknown[] = [];
      for (const resource of [...resources].reverse()) {
        if (resource.lease) {
          try {
            await resource.lease.release();
            resource.lease = undefined;
          } catch (error) {
            errors.push(error);
          }
        }
      }
      for (const resource of resources) {
        for (const field of ["file", "pin"] as const) {
          if (resource[field]) {
            try {
              await resource[field]!.close();
              resource[field] = undefined;
            } catch (error) {
              errors.push(error);
            }
          }
        }
      }
      if (errors.length) throw new ByteCaptureCleanupError(errors, () => cleanup(cause), cause);
    })();
    try {
      await cleaning;
    } finally {
      cleaning = undefined;
    }
  };
  const guardsUnbroken = async (): Promise<boolean> => {
    if (retired) return false;
    const leases = resources.flatMap((r) => (r.lease ? [r.lease] : []));
    try {
      for (const lease of leases)
        if (!(await lease.check())) {
          retire();
          return false;
        }
      return !retired;
    } catch (error) {
      retire();
      throw error;
    }
  };
  const info: import("node:fs").BigIntStats[] = [];
  try {
    // Pin and acquire the complete physical set first. No content reads in this phase.
    for (const input of inputs) {
      checkWork();
      const resource: Resource = {};
      resources.push(resource);
      resource.pin = await open(`/proc/self/fd/${input.fd}`, O_PATH);
      const pinned = await resource.pin.stat({ bigint: true });
      if (!pinned.isFile() || pinned.dev !== input.dev || pinned.ino !== input.ino)
        throw new Refused("byte capture descriptor identity or type mismatch");
      resource.file = await open(`/proc/self/fd/${resource.pin.fd}`, constants.O_RDONLY | constants.O_NONBLOCK);
      const owned = await resource.file.stat({ bigint: true });
      if (!owned.isFile() || owned.dev !== input.dev || owned.ino !== input.ino)
        throw new Refused("byte capture reopened descriptor mismatch");
      const filesystem = await statfs(`/proc/self/fd/${resource.file.fd}`);
      if (![0xef53, 0x01021994].includes(filesystem.type)) throw new Refused("byte capture unsupported filesystem");
      await resource.pin.close();
      resource.pin = undefined;
      const key = `${owned.dev}:${owned.ino}`;
      if (!physical.has(key)) {
        const acquisition = await leaseSource.acquire(resource.file.fd, owned);
        if (!acquisition.ok) throw new Refused(`byte capture guard refused: ${acquisition.reason}`);
        resource.lease = acquisition.lease;
        physical.add(key);
      }
      checkWork();
    }
    let total = 0;
    // Size accounting after ALL guards: earlier preliminary sizes were not protected.
    for (const resource of resources) {
      checkWork();
      const st = await resource.file!.stat({ bigint: true });
      if (st.size < 0n || st.size > BigInt(limits.maxFileBytes))
        throw new Refused("byte capture maxFileBytes exceeded");
      const size = Number(st.size);
      if (size > limits.maxTotalBytes - total) throw new Refused("byte capture maxTotalBytes exceeded");
      total += size;
      info.push(st);
    }
    for (let index = 0; index < resources.length; index++) {
      const file = resources[index].file!,
        expected = info[index];
      const bytes = Buffer.allocUnsafe(Number(expected.size) + 1);
      let filled = 0;
      while (filled < bytes.length) {
        checkWork();
        const read = await file.read(bytes, filled, Math.min(65536, bytes.length - filled), filled);
        if (!read.bytesRead) break;
        filled += read.bytesRead;
      }
      checkWork();
      const after = await file.stat({ bigint: true });
      if (
        filled !== Number(expected.size) ||
        after.dev !== inputs[index].dev ||
        after.ino !== inputs[index].ino ||
        after.size !== expected.size
      ) {
        throw new Refused("byte capture changed size or identity while reading");
      }
      data.push(bytes.subarray(0, filled));
    }
    if (!(await guardsUnbroken())) throw new Refused("byte capture guard lost during acquisition");
    checkWork();
    const items = Object.freeze(
      info.map((st, index) => {
        const sha256 = createHash("sha256").update(data[index]).digest("hex");
        checkWork(); // Including the final digest: an over-budget result must never escape.
        return Object.freeze({ dev: String(st.dev), ino: String(st.ino), size: Number(st.size), sha256 });
      }),
    );
    const capture: CapturedByteVector = Object.freeze({
      items,
      copyCapturedBytes(index: number) {
        if (retired) throw new Error("byte capture has been released or retired");
        if (!Number.isSafeInteger(index) || index < 0 || index >= data.length)
          throw new Error("byte capture invalid item index");
        return Buffer.from(data[index]);
      },
      guardsUnbroken,
      release: () => cleanup(),
    });
    return { kind: "captured", capture };
  } catch (error) {
    await cleanup(error);
    if (error instanceof Refused) return { kind: "bypass", reason: error.message };
    throw new Error("byte capture operation failed", { cause: error });
  }
}
