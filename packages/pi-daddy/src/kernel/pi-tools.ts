/**
 * Facts about pi itself: its built-in tool names, and the capability that means "all of them".
 *
 * These lived in `agent-types.ts` until ADR-0016 deleted that module along with the rest of the
 * `@tintinweb/pi-subagents` port. They are not about agent types at all — `PI_BUILTIN_TOOLS` is how the
 * catalog tells a built-in from an extension tool, and `WILDCARD` is a capability id — so they outlive
 * the port and belong somewhere that does not name a package we no longer depend on.
 *
 * **`PI_BUILTIN_TOOLS` is a pinned observation, and it has already drifted once** (R-31): pi 0.84.1
 * exposes a `parallel` tool that the 0.83.0 list did not contain, which made it classify as an
 * *extension* capability. The list is used for classification only — never for enforcement, which is
 * `--tools`' job — so drift misfiles a capability rather than granting one. Keep it current anyway; a
 * misfiled capability is a confusing catalog.
 */

import type { Capability } from "./resolve.ts";

/** Capability held only by a delegator authorised to hand out everything. */
export const WILDCARD: Capability = "tool:*";


/** pi's built-in tools, observed against 0.84.1. `parallel` was added since 0.83.0 — see R-31. */
export const PI_BUILTIN_TOOLS = [
  "bash", "edit", "edit-diff", "find", "grep", "ls", "parallel", "read", "write",
] as const;
