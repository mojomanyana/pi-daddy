/** Versioned, bounded live replay bytes; never hydrate from ledger/history or caller declarations. */
import type { CacheRunOutcome } from "./cache-scheduler-types.ts";
export function cacheRunOutcome(value: CacheRunOutcome): Readonly<CacheRunOutcome> {
  if (
    typeof value.output !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.endedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    Date.parse(value.endedAt) < Date.parse(value.startedAt) ||
    !Number.isFinite(Date.parse(value.endedAt)) ||
    (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0)) ||
    (value.signal !== null && typeof value.signal !== "string") ||
    [value.complete, value.cancelled, value.timedOut].some((flag) => typeof flag !== "boolean")
  )
    throw new Error("cache owned execution outcome is malformed");
  return Object.freeze({
    output: value.output,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    exitCode: value.exitCode,
    signal: value.signal,
    complete: value.complete,
    cancelled: value.cancelled,
    timedOut: value.timedOut,
  });
}
export function encodeCacheReplay(outcome: CacheRunOutcome, chunks: readonly Buffer[]): string {
  return JSON.stringify({ format: 1, outcome, chunks: chunks.map((bytes) => bytes.toString("base64")) });
}
export function decodeCacheReplay(text: string, bytes: number, chunks: number) {
  try {
    const row = JSON.parse(text);
    if (row.format !== 1 || !Array.isArray(row.chunks) || row.chunks.length > chunks) return undefined;
    const outcome = cacheRunOutcome(row.outcome);
    if (outcome.exitCode !== 0 || outcome.signal !== null || !outcome.complete || outcome.cancelled || outcome.timedOut)
      return undefined;
    let count = 0;
    const stream: Buffer[] = [];
    for (const encoded of row.chunks) {
      if (typeof encoded !== "string" || encoded.length > Math.ceil(bytes / 3) * 4) return undefined;
      const chunk = Buffer.from(encoded, "base64");
      count += chunk.length;
      if (count > bytes || chunk.toString("base64") !== encoded) return undefined;
      stream.push(chunk);
    }
    return { outcome, stream };
  } catch {
    return undefined;
  } // Malformed replay is absence of evidence, never a reusable result.
}
