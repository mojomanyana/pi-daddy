import { takeBytes, type ChildRunResult } from "../src/run-child.ts";

export const NATIVE_DIAGNOSTIC_TEXT_BYTES = 4096;
/** Only for the fixed model-free native fixture; not a general worker/error logger. */
export function nativeResultDiagnostic(result: ChildRunResult): string {
  return JSON.stringify({ code: result.code, signal: result.signal ?? null, aborted: result.aborted,
    timedOut: result.timedOut, truncated: result.truncated,
    text: takeBytes(result.text, NATIVE_DIAGNOSTIC_TEXT_BYTES),
    diagnosticTextTruncated: Buffer.byteLength(result.text) > NATIVE_DIAGNOSTIC_TEXT_BYTES,
    spawnError: result.spawnError === undefined ? null : takeBytes(result.spawnError, 256),
    diagnosticSpawnErrorTruncated: result.spawnError !== undefined && Buffer.byteLength(result.spawnError) > 256 });
}
