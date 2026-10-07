/**
 * Bounded, conservative declaration parser for a candidate GNU SHA-256 check profile.
 * This is NOT source acquisition, inode resolution, authority, observation coverage,
 * runtime closure or eligibility. A successful parse merely names records the caller
 * must still resolve and guard. Unknown GNU grammar bypasses rather than guessing.
 * Exact record order, spelling and text/binary markers are retained; no path cleanup.
 */
export interface ChecksumMember {
  readonly path: string;
  readonly sha256: string;
  readonly binary: boolean;
}
export type ChecksumMembers =
  | { readonly kind: "members"; readonly members: readonly ChecksumMember[] }
  | { readonly kind: "bypass"; readonly reason: string };
export function parseChecksumMembers(
  bytes: Uint8Array,
  limits: { readonly maxBytes: number; readonly maxMembers: number },
): ChecksumMembers {
  for (const field of ["maxBytes", "maxMembers"] as const) {
    if (!Number.isSafeInteger(limits[field]) || limits[field] <= 0) {
      return { kind: "bypass", reason: `checksum manifest ${field} must be a positive safe integer` };
    }
  }
  if (bytes.byteLength > limits.maxBytes) return { kind: "bypass", reason: "checksum manifest exceeds maxBytes" };
  const text = Buffer.from(bytes).toString("utf8");
  if (!text.endsWith("\n")) return { kind: "bypass", reason: "checksum manifest requires complete LF records" };
  const lines = text.slice(0, -1).split("\n"),
    members: ChecksumMember[] = [],
    paths = new Set<string>();
  if (lines.length > limits.maxMembers) return { kind: "bypass", reason: "checksum manifest exceeds maxMembers" };
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) ([ *])([A-Za-z0-9_.\/-]+)$/.exec(line);
    if (!match) return { kind: "bypass", reason: "checksum manifest has unsupported record grammar" };
    const path = match[3],
      parts = (path.startsWith("/") ? path.slice(1) : path).split("/");
    if (path === "-" || parts.some((part) => !part || part === "." || part === "..")) {
      return { kind: "bypass", reason: "checksum manifest has stdin or noncanonical member path" };
    }
    if (paths.has(path)) return { kind: "bypass", reason: "checksum manifest has duplicate declared member path" };
    paths.add(path);
    members.push(Object.freeze({ path, sha256: match[1], binary: match[2] === "*" }));
  }
  return Object.freeze({ kind: "members", members: Object.freeze(members) });
}
