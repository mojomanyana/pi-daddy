/** Child delivery is separate from a parent's catalog and from permission to grant a tool. */
import { toPiToolsAllowlist, type Capability } from "./resolve.ts";
import { refusal, type StructuredRefusal } from "./refusals.ts";
import { isParentProxy, parentProxiedTools, type ParentToolFacts } from "./parent-tools.ts";

/** Native CLI tools shared by the qualified Pi 1.0.4 and 1.5.2 runtimes, not the display catalog. */
const nativeTools = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const governedTools = new Set(["delegate", "delegate_all", "delegate_chain", "delegate_describe"]);
export interface ChildToolSource {
  readonly name: string;
  readonly sourceInfo?: Readonly<{ path?: string; source?: string }>;
}

/** Copy only public origin metadata. Provider schemas, credentials and runtime objects do not cross. */
export function snapshotChildTools(tools: readonly ChildToolSource[]): readonly ChildToolSource[] {
  return Object.freeze(
    tools.map((tool) =>
      Object.freeze({
        name: tool.name,
        ...(tool.sourceInfo
          ? {
              sourceInfo: Object.freeze({
                path: tool.sourceInfo.path,
                source: tool.sourceInfo.source,
              }),
            }
          : {}),
      }),
    ),
  );
}

/**
 * The one refusal for a tool a child cannot be given. Shared with the launch-time check, so a plan that admitted
 * a parent-run tool and can no longer be served is refused in exactly these words. `note` is empty except where
 * a parent-run tool would have to be chained through a second level.
 */
export function childToolUnavailable(tools: readonly string[], note = ""): StructuredRefusal {
  return refusal(
    "UNKNOWN_TOOL",
    `child tool unavailable: ${tools.join(", ")} — the parent catalog is not child delivery. ` +
      "Governed children load native Pi tools and Daddy's explicit entrypoint only; external extensions, MCP and " +
      "SDK-only tools have no qualified child provider here. Keep this work in the parent or choose a definition " +
      "using supported child tools. Additional permission cannot install or qualify a provider." +
      note,
    { kind: "child-tool-unavailable", tools: tools.join(",") },
  );
}

export function childToolDeliveryRefusal(
  requested: Capability[],
  context: ParentToolFacts & { childToolSources?: readonly ChildToolSource[]; extensionPath?: string },
): StructuredRefusal | undefined {
  const unavailable: string[] = [];
  // An allowlisted parent-only tool is delivered by the root running it, and only when every condition holds.
  const parentRun = new Set(parentProxiedTools(requested, context).map((tool) => tool.name));
  for (const name of toPiToolsAllowlist(requested) ?? []) {
    // The existing narrowing guard owns wildcard refusal, not delivery classification.
    if (name === "*") continue;
    const entries = context.childToolSources?.filter((tool) => tool.name === name);
    const source = entries?.length === 1 ? entries[0].sourceInfo : undefined;
    // Pure legacy callers may omit observations; real extension dispatch always supplies the live inventory.
    const unobserved = context.childToolSources === undefined;
    const builtin =
      nativeTools.has(name) && (unobserved || (source?.source === "builtin" && source.path === `builtin:${name}`));
    const governed =
      governedTools.has(name) &&
      requested.includes("tool:delegate") &&
      !!context.extensionPath &&
      (unobserved || source?.path === context.extensionPath);
    if (!builtin && !governed && !parentRun.has(name)) unavailable.push(name);
  }
  if (!unavailable.length) return undefined;
  // Said only where it is the reason: this session holds the tool because ITS parent runs it.
  const chained = unavailable.filter((name) => isParentProxy(name, context));
  return childToolUnavailable(
    unavailable,
    chained.length
      ? ` ${chained.join(", ")} reached this session through its own parent; a parent-run tool is not passed on ` +
          "to a further level, so it cannot be delegated from here."
      : "",
  );
}
