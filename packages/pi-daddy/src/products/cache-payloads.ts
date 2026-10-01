/**
 * Epoch-local immutable output ownership, never a historical result store. An invalidation drops
 * reusable ownership immediately; existing deliveries alone may retain bytes until their release.
 * Those bytes remain charged even though no new reader can acquire them. Handles are instance-local
 * object identities, not caller-supplied IDs. Strings are immutable, so delivery cannot edit later hits.
 * Limits count UTF8 output bytes and explicit payload/delivery objects, NOT measured Node heap/RSS.
 * No IO, history hydration or callbacks run inside these bounded synchronous ownership transactions.
 */
export interface CachePayloadToken {
  readonly cachePayload: unique symbol;
}
export interface CacheDelivery {
  read(): string;
  release(): void;
}
export interface CachePayloadLimits {
  bytes: number;
  itemBytes: number;
  payloads: number;
  deliveries: number;
}
interface Payload {
  token?: CachePayloadToken;
  value: string | undefined;
  bytes: number;
  owner: boolean;
  readers: number;
}

export class CachePayloads {
  private limits: CachePayloadLimits;
  private handles = new WeakMap<CachePayloadToken, Payload>();
  private known = new WeakSet<CachePayloadToken>();
  private live = new Set<Payload>();
  private bytes = 0;
  private deliveries = 0;

  constructor(limits: CachePayloadLimits) {
    if (
      [limits.bytes, limits.itemBytes, limits.payloads, limits.deliveries].some(
        (n) => !Number.isSafeInteger(n) || n <= 0,
      ) ||
      limits.itemBytes > limits.bytes ||
      Object.keys(limits).length !== 4
    )
      throw new Error("cache payload limits must be positive safe integers with itemBytes <= bytes");
    this.limits = { ...limits };
  }
  store(value: string): CachePayloadToken | undefined {
    const bytes = Buffer.byteLength(value, "utf8");
    if (
      bytes > this.limits.itemBytes ||
      bytes > this.limits.bytes - this.bytes ||
      this.live.size >= this.limits.payloads
    )
      return undefined;
    const token = Object.freeze({}) as CachePayloadToken;
    const item = { token, value, bytes, owner: true, readers: 0 };
    this.handles.set(token, item);
    this.known.add(token);
    this.live.add(item);
    this.bytes += bytes;
    return token;
  }
  private item(token: CachePayloadToken): Payload | undefined {
    if (!this.known.has(token)) throw new Error("cache payload handle is foreign or fabricated");
    return this.handles.get(token);
  }
  private retire(item: Payload): void {
    if (item.token) this.handles.delete(item.token);
    item.token = undefined;
    item.owner = false;
    this.collect(item);
  }
  private collect(item: Payload): void {
    if (item.owner || item.readers || !this.live.delete(item)) return;
    this.bytes -= item.bytes;
    item.value = undefined; // Also free bytes referenced by old released-handle closures.
  }
  pin(token: CachePayloadToken): CacheDelivery | undefined {
    let item = this.item(token);
    if (!item || !item.owner || this.deliveries >= this.limits.deliveries) return undefined;
    item.readers++;
    this.deliveries++;
    return {
      read: () => {
        if (!item || item.value === undefined) throw new Error("cache output delivery has been released");
        return item.value;
      },
      release: () => {
        const held = item;
        if (!held) return;
        item = undefined; // A caller retaining the closed delivery must not retain its descriptor row.
        held.readers--;
        this.deliveries--;
        this.collect(held);
      },
    };
  }
  drop(token: CachePayloadToken): void {
    const item = this.item(token);
    if (item) this.retire(item);
  }
  clear(): void {
    for (const item of this.live) this.retire(item);
  }
  stats() {
    return { bytes: this.bytes, payloads: this.live.size, deliveries: this.deliveries };
  }
}
