/** Pure capability diagnostics shared by the CLI and the live catalog without loading Pi. */
import { CAPABILITY_NAMESPACE_PREFIXES } from "./capabilities.ts";
import type { Capability } from "./resolve.ts";

/**
 * Why an id carries two namespaces, said as the mistake that produced it.
 *
 * `ceilingForDefinition` prefixes a BARE entry with `tool:` and recognises an explicit namespace by its literal
 * lower-case prefix, so `allowed-tools: Read` and `allowed-tools: tool:read` are both right. The capitalised
 * spelling the same field invites is not: the frontmatter is copied from Claude Code, where the tool names are
 * `Read` and `Grep`, so an author who also reaches for the namespace writes `Tool:Read` — which misses the prefix
 * test, is lower-cased with the rest of the bare entry, and arrives as `tool:tool:read`. Every namespace has this
 * shape (`Workspace:prod` becomes `tool:workspace:prod`), which is why the prefix is read from the one shared list
 * rather than a second spelling of it.
 *
 * The messages that followed were loud and useless. A spawn refusal said "not present in this session's catalog
 * (typo, or an uninstalled package?)" about an id nobody typed, and `suggestForUnknown` cannot rescue it either:
 * `tool:read` is five edits from `read`, well past a threshold that never exceeds two. `pi-daddy init` refuses the
 * whole definition earlier still, because `isSafeCapability` rejects the extra colon, and named the mangled id too.
 *
 * It names the mistake and does not repair it, for `ceilingForDefinition`'s own reason: a capability this package
 * inferred rather than read is a grant nobody wrote. The author edits the file.
 *
 * **What the suggestion cannot recover.** The doubling happens on the bare-entry path, which lower-cases the whole
 * entry before this function ever sees it, so `Workspace:Prod` and `Workspace:prod` both arrive as
 * `tool:workspace:prod`. For `tool:` that loses nothing, since a pi tool name is lower-case anyway. For the other
 * namespaces the identifier's own capitalisation is already gone, so the suggestion says so rather than implying
 * that copying it verbatim must work. Nor is "or the bare name" offered outside `tool:`: a bare `prod` becomes
 * `tool:prod`, which is a second unknown capability rather than a fix.
 */
export function explainDoubledNamespace(unknown: Capability): string | null {
  const intended = undoubleNamespace(unknown);
  if (intended === unknown) return null;
  const prefix = CAPABILITY_NAMESPACE_PREFIXES.find((p) => unknown.slice("tool:".length).toLowerCase().startsWith(p))!;
  const tail =
    prefix === "tool:"
      ? ` (or the bare name \`${intended.slice("tool:".length)}\`)`
      : `, whose own capitalisation was folded when the bare entry was read, so restore it if that id has any`;
  return (
    `${unknown} is prefixed twice: \`allowed-tools\` adds \`tool:\` to a bare entry and recognises an ` +
    `explicit \`${prefix}\` prefix only in lower case, so an entry already carrying a namespace was given ` +
    `another — write \`${intended}\`${tail} in the definition`
  );
}

/**
 * The entry the author meant, with every extra `tool:` removed.
 *
 * Recursive, because `tool:tool:tool:read` is one mistake made twice and advising `tool:tool:read` would hand back
 * an id with the same defect. The namespace is matched case-insensitively and re-emitted in lower case, so
 * `tool:Tool:Read` — reachable on the model-chosen `tools:` path, which does not case-fold — suggests `tool:read`
 * rather than the broken spelling it arrived in. A `tool:` name is lower-cased because pi's tool names are; any
 * other identifier is left as it arrived, since its case may be significant and is not this function's to change.
 */
function undoubleNamespace(id: Capability): Capability {
  if (!id.startsWith("tool:")) return id;
  const inner = id.slice("tool:".length);
  const prefix = CAPABILITY_NAMESPACE_PREFIXES.find((p) => inner.toLowerCase().startsWith(p));
  // A bare `tool:tool:` names nothing to suggest, so it stays an ordinary unknown capability.
  if (!prefix || inner.length === prefix.length) return id;
  const rest = inner.slice(prefix.length);
  return undoubleNamespace((prefix === "tool:" ? `tool:${rest.toLowerCase()}` : `${prefix}${rest}`) as Capability);
}
