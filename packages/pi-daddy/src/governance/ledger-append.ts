import { appendFile, mkdir, open, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "./file-lock.ts";
import { recheckWorkDestination, workFsError, type WorkDestination } from "./work-ledger-destination.ts";
import { WORK_TEXT_BYTES, WORK_RECORDS } from "./work-ledger-json.ts";
import { WorkInputError } from "./work-ledger-types.ts";
import { parseWorkLedgerText } from "./work-ledger.ts";

/** Bounded descriptor read, including one detection byte; never trust a pre-read size alone. */
export async function readWorkBytes(handle: FileHandle): Promise<Buffer> {
  const chunks: Buffer[] = []; let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, WORK_TEXT_BYTES + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > WORK_TEXT_BYTES) throw new WorkInputError("WORK_LIMIT_EXCEEDED");
    chunks.push(chunk.subarray(0, bytesRead));
  }
}
/** A secondary filesystem close failure must not replace a primary content/capacity refusal. */
export async function closeWorkHandle(handle: FileHandle, failed: boolean): Promise<void> {
  try { await handle.close(); }
  catch (error) { if (!failed || !workFsError(error)) throw error; }
}

/** Shared existing-producer persistence. Serialization and each caller's exception policy remain
 * outside this function. The private destination facts select v4 protection, never ambient defaults. */
export async function appendLedgerLine(options: { readonly path: string }, line: string, destination?: WorkDestination, once?: { eventId: string; digest: string }): Promise<void> {
  await mkdir(dirname(options.path), { recursive: true });
  if (!destination) {
    // Retain even legacy path-property evaluation timing across waits; only v4 owns detached inputs.
    await withFileLock(options.path, "grant ledger", () => appendFile(options.path, line, { encoding: "utf8", flag: "a" }));
    return;
  }
  const path = destination.path;
  await recheckWorkDestination(destination);
  await withFileLock(path, "work ledger", async () => {
    await recheckWorkDestination(destination);
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    } catch (error) {
      // A newly proven alias/unsafe kind retains its classification rather than becoming generic I/O.
      if (workFsError(error)) await recheckWorkDestination(destination);
      throw error;
    }
    let failed = false;
    try {
      await recheckWorkDestination(destination, handle);
      const bytes = await readWorkBytes(handle);
      const ingestion = parseWorkLedgerText(bytes.toString("utf8"));
      if (!ingestion.complete) throw new WorkInputError(ingestion.errors[0].code);
      if (bytes.length && bytes[bytes.length - 1] !== 10) throw new WorkInputError("WORK_JSON_INVALID");
      if (once) {
        const sameId = ingestion.events.filter(e => e.eventId === once.eventId);
        if (sameId.some(e => e.digest !== once.digest)) throw new WorkInputError("WORK_DIGEST_MISMATCH");
        if (sameId.length) { await handle.sync(); return; } // Reconcile an earlier complete but unacknowledged append.
      }
      if (bytes.length + Buffer.byteLength(line, "utf8") > WORK_TEXT_BYTES || ingestion.events.length + 1 > WORK_RECORDS) {
        throw new WorkInputError("WORK_LIMIT_EXCEEDED");
      }
      await recheckWorkDestination(destination, handle);
      // Same descriptor, same non-expiring lock, O_APPEND. A failed write may leave partial bytes;
      // preserve them and fail closed. Never truncate, repair or reserialize existing deliveries.
      await handle.writeFile(line, "utf8");
      if (once) await handle.sync(); // New application seam requires durable append before controller receipt.
    } catch (error) { failed = true; throw error; }
    finally { await closeWorkHandle(handle, failed); }
  }, { staleRecovery: "disabled" });
}
