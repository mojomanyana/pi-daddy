/** Awaitable byte consumer; void consumers retain legacy callback semantics (including ignored returns).
 * Trusted producers MUST await a returned promise before emitting another frame. Chunk cap is a
 * component protocol bound, not a product output-retention/RSS default. */
export type CacheDataSink = ((bytes: Buffer) => void) | ((bytes: Buffer) => Promise<void>);
export const CACHE_STREAM_FRAME_BYTES = 262144;
