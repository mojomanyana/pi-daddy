/**
 * The inherited destination pin (ADR-0042): what a workspace id MEANT when the authority was granted.
 *
 * **The escalation this closes, measured in `g37-registry-tamper`.** `workspace:<id>` attenuates the NAME, not
 * the mutable id-to-path meaning. A child holding `workspace:staging` and `tool:write` — no `bash` — can rewrite
 * the operator's registry so `staging` points at the `prod` worktree, route a grandchild there, and take an
 * exclusive write lease on it. Every capability check passes, because the id it was granted is the id it used.
 * File ownership cannot help: a governed child runs as the parent's uid, so the registry is as writable to it as
 * to the operator.
 *
 * **The mechanism is authority, not metadata.** A root resolves each registered id to its canonical destination
 * and records a digest of it. Descendants inherit only the entries their effective grant authorises, cannot mint
 * an entry, and routing requires an exact match against the inherited digest. A rewritten registry therefore
 * changes where an id points and NOT what an inherited id is allowed to mean, which is the whole property.
 *
 * **Why a digest rather than the path.** The path is already visible to the child through the registry it can
 * read; pinning the digest keeps the wire small for a realistic registry and makes an equality check the only
 * operation, so there is no path-comparison subtlety to get wrong. `validateRegisteredWorkspace` still does the
 * canonicalisation; this only asks whether the answer changed.
 *
 * **Every failure refuses.** Missing, empty, malformed and mismatched all refuse, because the alternative is a
 * mechanism a child can disable by corrupting one byte. ADR-0042 records that an earlier attempt was reverted
 * after four failures, and that it failed "specifically because it was treated as a small patch".
 */
import { createHash } from "node:crypto";
import { isSafeWorkspaceId, workspaceCapability } from "./capabilities.ts";
import type { Capability } from "./resolve.ts";

export { ENV_WORKSPACE_PIN } from "./env-names.ts";

/**
 * Half a SHA-256, hex. The comparison is equality against a value the operator's own root computed, not a
 * signature, so this is sized to make accidental collision impossible rather than to resist an adversary who
 * can already choose both sides.
 */
const DIGEST_HEX = 32;

/** A canonical destination, reduced to something an environment variable can carry. */
export function destinationDigest(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot, "utf8").digest("hex").slice(0, DIGEST_HEX);
}

export type WorkspacePins = ReadonlyMap<string, string>;

/** `id:digest` pairs. Ids cannot contain `:` or `,` — `isSafeWorkspaceId` is the reason this is unambiguous. */
export function formatWorkspacePin(pins: WorkspacePins): string {
  return [...pins.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, digest]) => `${id}:${digest}`)
    .join(",");
}

export type ParsedPin = { pins: WorkspacePins } | { refusal: string };

/**
 * Read a pin, refusing anything that is not exactly the shape this module writes.
 *
 * An absent variable is NOT the same as an empty one and both are distinguished by the caller: absent means no
 * root ever established a pin, empty means a parent established one and this child inherited no entries. Both
 * refuse at routing time; they need different messages to be diagnosable.
 */
export function parseWorkspacePin(raw: string | undefined): ParsedPin {
  if (raw === undefined) return { refusal: "no destination pin was inherited" };
  const trimmed = raw.trim();
  if (trimmed === "") return { pins: new Map() };
  const pins = new Map<string, string>();
  for (const entry of trimmed.split(",")) {
    const at = entry.lastIndexOf(":");
    if (at <= 0) return { refusal: `destination pin entry ${JSON.stringify(entry)} is not id:digest` };
    const id = entry.slice(0, at);
    const digest = entry.slice(at + 1);
    if (!isSafeWorkspaceId(id))
      return { refusal: `destination pin names a malformed workspace id ${JSON.stringify(id)}` };
    if (!/^[0-9a-f]{32}$/.test(digest))
      return { refusal: `destination pin for ${id} is not a ${DIGEST_HEX}-character digest` };
    // A duplicated id with two digests is ambiguous, and picking either would let a tamperer supply both.
    if (pins.has(id) && pins.get(id) !== digest)
      return { refusal: `destination pin names ${id} twice with different destinations` };
    pins.set(id, digest);
  }
  return { pins };
}

/**
 * The pin a child inherits: the parent's entries, narrowed to the workspaces the child's grant actually names.
 *
 * Narrowing here rather than passing the parent's whole map is the difference between a pin and a hint. A child
 * that cannot see an entry cannot route to it even if it rewrites the registry to make the id resolve, because
 * routing needs a pin entry and it has none to offer.
 */
export function attenuateWorkspacePin(pins: WorkspacePins, inheritable: readonly Capability[]): WorkspacePins {
  const held = new Set<Capability>(inheritable);
  return new Map([...pins.entries()].filter(([id]) => held.has(workspaceCapability(id))));
}

/**
 * Does the registry still resolve this id to what the grant meant?
 *
 * Returns a refusal reason, or `undefined` when the destination matches. A string rather than a thrown error
 * because the one caller already owns the refusal code and the `details` this belongs in.
 */
export function checkPinnedDestination(input: {
  workspaceId: string;
  canonicalRoot: string;
  pin: ParsedPin;
}): string | undefined {
  if ("refusal" in input.pin) return input.pin.refusal;
  const expected = input.pin.pins.get(input.workspaceId);
  if (expected === undefined)
    return (
      `no destination pin was inherited for workspace ${input.workspaceId}` +
      (input.pin.pins.size > 0 ? ` — pinned: ${[...input.pin.pins.keys()].sort().join(", ")}` : "")
    );
  const actual = destinationDigest(input.canonicalRoot);
  if (actual !== expected)
    return (
      `workspace ${input.workspaceId} now resolves to ${input.canonicalRoot}, which is not the destination this ` +
      `session was granted. The registry has been rewritten since the grant was established, so the id no longer ` +
      `means what it meant when it was authorised (ADR-0042)`
    );
  return undefined;
}

/**
 * Establish a root's pin by resolving every registered id to its canonical destination.
 *
 * **Only a session that inherited NO pin may call this**, and that rule is the mechanism. If a descendant could
 * mint its own pin it would simply rewrite the registry and then re-establish, and the whole thing would be a
 * comment. The caller enforces it because only the caller knows whether a pin was inherited; this function is
 * the resolution, not the policy.
 *
 * An id whose destination cannot be canonicalised is LEFT OUT rather than pinned to a guess. Routing then
 * refuses it for having no pin, which is the same direction as every other failure here.
 */
export async function establishWorkspacePin(
  registry: { workspaces: Record<string, { path: string }> },
  canonicalise: (path: string) => Promise<string>,
  onSkipped?: (id: string, reason: string) => void,
): Promise<WorkspacePins> {
  const pins = new Map<string, string>();
  for (const [id, entry] of Object.entries(registry.workspaces)) {
    if (!isSafeWorkspaceId(id)) {
      onSkipped?.(id, "its id is malformed");
      continue;
    }
    try {
      pins.set(id, destinationDigest(await canonicalise(entry.path)));
    } catch (error) {
      // Rule 8, and `registeredWorkspaceIds` one file over carries the long version of why: this was a bare
      // `catch {}`, so an unmounted worktree or a directory not yet created dropped a workspace silently and
      // the operator met it later as "no destination pin was inherited", a message that names neither the
      // directory nor the reason. Unresolvable still means no pin — routing must not invent one — but the
      // caller is told which id and why.
      onSkipped?.(id, `its destination could not be canonicalised (${String(error)})`);
    }
  }
  return pins;
}
