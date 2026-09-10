import { detectAdditionalWorkCases, type WorkSignalFacts, type WorkSignalSnapshot } from "@skill-harness/core";
import { readArchiveSource, retainArchiveSource } from "./evidence-archive.js";

interface WorkSignalInput {
  observation_schema: "work-signal-observation-v1";
  snapshot: WorkSignalSnapshot;
  facts: WorkSignalFacts;
}
const LIMIT = 1024 * 1024;
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("closed work signal object required");
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(k => typeof k !== "string" || !keys.includes(k) || !descriptors[k].enumerable || !Object.hasOwn(descriptors[k], "value"))) throw new Error("closed work signal fields required");
}
function array(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 256
    || Reflect.ownKeys(value).length !== value.length + 1) throw new Error("bounded dense work signal array required");
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !Object.hasOwn(d, "value")) throw new Error("dense work signal data array required");
  }
}
// Only called after closed primitive/shape validation. Arrays retain observation order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function validate(value: unknown): WorkSignalInput {
  closed(value, ["observation_schema", "snapshot", "facts"]);
  if (value.observation_schema !== "work-signal-observation-v1") throw new Error("unsupported work signal observation");
  closed(value.snapshot, ["snapshotDigest", "scopeValid", "obligations"]);
  closed(value.facts, ["scopeDigest", "version", "population", "expectedWaits", "checkpoints", "violations", "priorAccepted"]);
  const s = value.snapshot, f = value.facts;
  if (typeof s.scopeValid !== "boolean") throw new Error("invalid work signal scope state");
  array(s.obligations); array(f.expectedWaits); array(f.checkpoints); array(f.violations); array(f.priorAccepted);
  const seen = new Set<unknown>();
  for (const o of s.obligations) {
    closed(o, ["id", "digest", "intentDigest", "policyDigest", "artifactDigest", "acceptance", "coverage"]);
    if (seen.has(o.digest)) throw new Error("duplicate work signal obligation identity");
    seen.add(o.digest);
  }
  for (const c of f.checkpoints) closed(c, ["obligationDigest", "deadlineMs", "observedAt", "status", "evidence"]);
  for (const v of f.violations) closed(v, ["obligationDigest", "status", "evidence"]);
  for (const p of f.priorAccepted) closed(p, ["obligationDigest", "intentDigest", "policyDigest", "artifactDigest", "acceptanceEvidence"]);
  const input = value as unknown as WorkSignalInput;
  // Shared rules validate scalar types, exact scope, bounded timestamps, enums and evidence identities.
  detectAdditionalWorkCases(input.snapshot, input.facts);
  return input;
}

/** Explicit private host-fact retention, not automatic discovery, authenticated authority or case promotion. */
export function retainWorkSignalObservation(root: string, snapshot: WorkSignalSnapshot, facts: WorkSignalFacts) {
  const input = validate({ observation_schema: "work-signal-observation-v1", snapshot, facts });
  const bytes = Buffer.from(canonical(input));
  if (bytes.length > LIMIT) throw new Error("work signal observation exceeds byte bound");
  const stored = retainArchiveSource(root, { sourceId: `work-signals-${snapshot.snapshotDigest}`, parser: { id: "work-signal-observation", version: "1" }, retention: "exact", bytes });
  return { manifestId: stored.manifestId, inputSha256: stored.reference.sha256 };
}

/** Re-derive, never trust a cached nomination. Missing/corrupt inputs fail rather than becoming empty work. */
export function readWorkSignalObservation(root: string, manifestId: string) {
  const stored = readArchiveSource(root, manifestId);
  if (stored.status !== "available" || stored.reference.retention !== "exact" || stored.reference.parser.id !== "work-signal-observation"
    || stored.reference.parser.version !== "1" || stored.bytes.length > LIMIT) throw new Error("work signal observation unavailable or unsupported");
  let text: string, decoded: unknown;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes); decoded = JSON.parse(text); }
  catch { throw new Error("invalid work signal observation JSON"); } // No raw byte excerpts in diagnostics.
  const input = validate(decoded);
  if (canonical(input) !== text || stored.reference.sourceId !== `work-signals-${input.snapshot.snapshotDigest}`) throw new Error("work signal observation binding mismatch");
  return { manifestId, inputSha256: stored.reference.sha256, input, detection: detectAdditionalWorkCases(input.snapshot, input.facts) };
}
