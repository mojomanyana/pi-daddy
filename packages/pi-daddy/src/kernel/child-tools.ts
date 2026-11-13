/** Child delivery is separate from a parent's catalog and from permission to grant a tool. */
import { toPiToolsAllowlist, type Capability } from "./resolve.ts";
import { refusal, type StructuredRefusal } from "./refusals.ts";

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

export function childToolDeliveryRefusal(
  requested: Capability[],
  context: { childToolSources?: readonly ChildToolSource[]; extensionPath?: string },
): StructuredRefusal | undefined {
  const unavailable: string[] = [];
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
    if (!builtin && !governed) unavailable.push(name);
  }
  if (!unavailable.length) return undefined;
  return refusal(
    "UNKNOWN_TOOL",
    `child tool unavailable: ${unavailable.join(", ")} — the parent catalog is not child delivery. ` +
      "Governed children load native Pi tools and Daddy's explicit entrypoint only; external extensions, MCP and " +
      "SDK-only tools have no qualified child provider here. Keep this work in the parent or choose a definition " +
      "using supported child tools. Additional permission cannot install or qualify a provider.",
    { kind: "child-tool-unavailable", tools: unavailable.join(",") },
  );
}
