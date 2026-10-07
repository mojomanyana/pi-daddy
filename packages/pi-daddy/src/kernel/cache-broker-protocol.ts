/** CP1 is a private OS-helper pipe protocol, not a requester/role protocol.
 * IDs identify connections only. Application bytes are opaque, bounded chunks.
 * Frame parsing is pure; state transitions and authorization belong to the Node adapter.
 */
export const CACHE_BROKER_CHUNK = 4096;
export const CACHE_BROKER_FRAME = 8256;
export const CACHE_BROKER_PEERS = 32;
export type CacheBrokerEvent =
  | { kind: "READY" }
  | { kind: "OPEN"; id: number; pid: number }
  | { kind: "VERIFIED"; id: number; pid: number }
  | { kind: "CLOSED"; id: number }
  | { kind: "SENT"; id: number; bytes: number }
  | { kind: "DATA"; id: number; bytes: Buffer };
function number(value: string | undefined) {
  if (!value || !/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 1_000_000_000)
    throw Error("cache broker protocol: invalid positive integer");
  return Number(value);
}
export function parseCacheBrokerEvent(line: string): CacheBrokerEvent {
  if (line === "CP1 READY") return { kind: "READY" };
  const [version, kind, idText, arg, extra] = line.split(" ");
  if (version !== "CP1" || extra !== undefined) throw Error("cache broker protocol: incompatible frame");
  const id = number(idText);
  if (kind === "CLOSED" && arg === undefined) return { kind, id };
  if (kind === "OPEN" || kind === "VERIFIED") return { kind, id, pid: number(arg) };
  if (kind === "SENT") {
    const bytes = number(arg);
    if (bytes <= CACHE_BROKER_CHUNK) return { kind, id, bytes };
  }
  if (kind === "DATA" && arg && arg.length <= CACHE_BROKER_CHUNK * 2 && /^(?:[0-9a-f]{2})+$/.test(arg))
    return { kind, id, bytes: Buffer.from(arg, "hex") };
  throw Error("cache broker protocol: malformed event");
}
