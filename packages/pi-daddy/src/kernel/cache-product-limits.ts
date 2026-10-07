/** UNTESTED (per request). Bounded product defaults, not measured memory/latency guarantees. */
export const CACHE_PRODUCT_LIMITS = Object.freeze({
  entries: 256,
  edges: 20000,
  running: 2,
  pending: 16,
  calls: 32,
  captures: 2,
  outputBytes: 32 * 1024 * 1024,
  itemBytes: 1024 * 1024,
  imageBytes: 256 * 1024 * 1024,
  inputBytes: 32 * 1024 * 1024,
  inputPaths: 128,
  readerBytes: 32 * 1024 * 1024,
  bufferedBytes: 512 * 1024 * 1024,
});
/** Conservative simultaneous reservations for the named bounded components, not JS object overhead,
 * Pi's private accumulator, kernel caches, helper heaps, growing Watchman logs or process RSS. */
export function cacheProductBufferBudget(limits: CacheProductLimits) {
  const components = {
    inputs: limits.captures * limits.inputBytes,
    outputStores: 2 * limits.outputBytes,
    runningStreams: limits.running * limits.itemBytes,
    nativeContextsAndFrames: limits.calls * (3000000 + 1200000 + 131072),
    readers: limits.readerBytes,
    helperImages: 24 * 1024 * 1024,
  };
  return { components, reserved: Object.values(components).reduce((n, bytes) => n + bytes, 0), limit: limits.bufferedBytes };
}
export type CacheProductLimits = { [K in keyof typeof CACHE_PRODUCT_LIMITS]: number };
export function cacheProductLimits(overrides: Partial<CacheProductLimits> = {}): Readonly<CacheProductLimits> {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw Error("cache resource limits malformed");
  for (const [name, value] of Object.entries(overrides)) {
    if (
      !Object.hasOwn(CACHE_PRODUCT_LIMITS, name) ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > CACHE_PRODUCT_LIMITS[name as keyof CacheProductLimits]
    )
      throw Error("cache resource limit must narrow its bounded default");
  }
  const limits = { ...CACHE_PRODUCT_LIMITS, ...overrides };
  if (cacheProductBufferBudget(limits).reserved > limits.bufferedBytes)
    throw Error("cache component reservations exceed aggregate buffered-byte budget; narrow component limits");
  return Object.freeze(limits);
}
