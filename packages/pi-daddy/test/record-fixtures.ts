import { createHash } from "node:crypto";
import { recordKindForEvent } from "../src/governance/ledger.ts";
import { RECORD_FORMAT, recordDigest, type RecordKind } from "../src/governance/record.ts";

/**
 * Build a ledger text in the record envelope (ADR-0076 PR 3d) from event bodies, chained exactly as the
 * writer chains them. A string item is written verbatim, so a test can inject a torn or foreign line and
 * see it reported as damage at that line; items after it are still appended so "nothing after the damage
 * is read" can be asserted.
 */
export function recordLines(...items: unknown[]): string {
  return recordLinesOf(null, ...items);
}

/** Same, with one kind for every object item (work and activity bodies carry no `event` discriminator). */
export function recordLinesOf(kind: RecordKind | null, ...items: unknown[]): string {
  const out: string[] = [];
  let prevLine: string | null = null;
  let seq = 0;
  for (const item of items) {
    if (typeof item === "string") {
      out.push(item);
      prevLine = item;
      continue;
    }
    seq += 1;
    const body = item as { event?: string };
    const draft: Record<string, unknown> = {
      v: RECORD_FORMAT,
      seq,
      prev: prevLine === null ? null : createHash("sha256").update(prevLine, "utf8").digest("hex"),
      at: "2026-09-21T00:00:00.000Z",
      kind: kind ?? (recordKindForEvent(body ?? {}) as RecordKind),
      id: `r-${seq}`,
      body: item,
    };
    const plain = JSON.parse(JSON.stringify(draft)) as Record<string, unknown>;
    const line: string = JSON.stringify({ ...plain, digest: recordDigest(plain) });
    out.push(line);
    prevLine = line;
  }
  return out.length === 0 ? "" : out.join("\n") + "\n";
}
