/**
 * Strict evidence grammar for the Linux descriptor-only syscall helper. This parser grants nothing.
 * A VALID frame is one kernel observation, never permission to publish without the coordinator's
 * current input/namespace/authorization contract. BREAK/LOSS are irreversible for a lease incarnation.
 * Capability setup and process lifetime belong to executors; graph and reuse decisions stay in Node.
 */
export const CACHE_LEASE_PROTOCOL = 2;
export const CACHE_LEASE_FRAME_BYTES = 192;
export const CACHE_LEASE_CAPACITY = 8192;
export const CACHE_LEASE_BREAK_MS = 250;

export type CacheLeaseReply =
  | { kind: "reply"; seq: number; status: "acquired"; id: string; dev: string; ino: string }
  | { kind: "reply"; seq: number; status: "refused"; id: string; reason: string; errno: number }
  | { kind: "reply"; seq: number; status: "valid" | "released"; id: string }
  | { kind: "reply"; seq: number; status: "invalid"; id: string; reason: string };
export type CacheLeaseFrame =
  | CacheLeaseReply
  | {
      kind: "ready";
      parent: number;
      uid: number;
      privileged: boolean;
      capacity: number;
      frameBytes: number;
      breakMs: number;
    }
  | { kind: "break"; id: string }
  | { kind: "loss"; id: string; reason: string; errno: number }
  | { kind: "fatal"; reason: string };

function malformed(): never {
  throw new Error("cache lease protocol frame is malformed or incompatible");
}
function integer(text: string, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  if (!/^(?:0|[1-9]\d*)$/.test(text)) return malformed();
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) return malformed();
  return value;
}
function decimal(text: string, positive = false): string {
  if (!/^(?:0|[1-9]\d{0,19})$/.test(text) || BigInt(text) > 18446744073709551615n || (positive && text === "0"))
    return malformed();
  return text;
}
function reason(text: string): string {
  return /^[A-Z][A-Z0-9_]{0,31}$/.test(text) ? text : malformed();
}

export function parseCacheLeaseFrame(frame: string): CacheLeaseFrame {
  if (frame.length > CACHE_LEASE_FRAME_BYTES || !/^[\x20-\x7e]+\n$/.test(frame)) return malformed();
  const parts = frame.slice(0, -1).split(" ");
  if (parts.some((part) => !part)) return malformed();
  if (parts[0] === "READY" && parts.length === 8) {
    if (
      integer(parts[1]) !== CACHE_LEASE_PROTOCOL ||
      integer(parts[5]) !== CACHE_LEASE_CAPACITY ||
      integer(parts[6]) !== CACHE_LEASE_FRAME_BYTES ||
      integer(parts[7]) !== CACHE_LEASE_BREAK_MS
    )
      return malformed();
    return {
      kind: "ready",
      parent: integer(parts[2], 2147483647, 1),
      uid: integer(parts[3], 4294967294, 1),
      privileged: integer(parts[4], 1) === 1,
      capacity: CACHE_LEASE_CAPACITY,
      frameBytes: CACHE_LEASE_FRAME_BYTES,
      breakMs: CACHE_LEASE_BREAK_MS,
    };
  }
  if (parts[0] === "F" && parts[1] === "ERROR" && parts.length === 3)
    return { kind: "fatal", reason: reason(parts[2]) };
  if (parts[0] === "E" && parts[1] === "BREAK" && parts.length === 3)
    return { kind: "break", id: decimal(parts[2], true) };
  if (parts[0] === "E" && parts[1] === "LOSS" && parts.length === 5)
    return { kind: "loss", id: decimal(parts[2], true), reason: reason(parts[3]), errno: integer(parts[4], 4095) };
  if (parts[0] !== "R" || parts.length < 4) return malformed();
  const seq = integer(parts[1], Number.MAX_SAFE_INTEGER, 1),
    id = decimal(parts[3], true);
  switch (parts[2]) {
    case "ACQUIRED":
      if (parts.length === 6)
        return { kind: "reply", seq, id, status: "acquired", dev: decimal(parts[4]), ino: decimal(parts[5]) };
      break;
    case "REFUSED":
      if (parts.length === 6)
        return { kind: "reply", seq, id, status: "refused", reason: reason(parts[4]), errno: integer(parts[5], 4095) };
      break;
    case "VALID":
    case "RELEASED":
      if (parts.length === 4) return { kind: "reply", seq, id, status: parts[2] === "VALID" ? "valid" : "released" };
      break;
    case "INVALID":
      if (parts.length === 5) return { kind: "reply", seq, id, status: "invalid", reason: reason(parts[4]) };
  }
  return malformed();
}
