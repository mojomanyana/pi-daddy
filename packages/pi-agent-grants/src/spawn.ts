/**
 * Build the argv for a governed descendant pi process.
 *
 * The enforcement point is pi core, not this package: `--tools` and `--no-tools` hard-block extension
 * tools, and an explicitly `-e`-loaded extension cannot re-add its tool past them (verified,
 * docs/probes/pi-fabric-eval probes 9–11). So governance reduces to "compute the allowlist correctly
 * and hand it to pi", with no runtime inside the descendant.
 */

import { toPiToolsAllowlist, type Capability } from "./resolve.ts";

export interface SpawnPlanInput {
  effective: Capability[];
  prompt: string;
  model?: string;
  provider?: string;
  thinking?: string;
  /** Session file path, or omit for an ephemeral child. */
  sessionFile?: string;
  /** Non-interactive by default: a governed child should not prompt a human. */
  print?: boolean;
}

export interface SpawnPlan {
  args: string[];
  /** The tool names pi will allow, for the ledger. `null` means no tools at all. */
  allowlist: string[] | null;
}

/**
 * Produce `pi` arguments enforcing `effective`.
 *
 * Note the `--no-tools` branch: pi rejects an empty `--tools` list, and passing no flag at all would
 * silently fall back to pi's defaults — which is the opposite of a zero grant. An empty grant must be
 * expressed explicitly.
 */
export function planSpawn(input: SpawnPlanInput): SpawnPlan {
  const allowlist = toPiToolsAllowlist(input.effective);
  const args: string[] = [];

  if (input.print !== false) args.push("--print");
  if (input.provider) args.push("--provider", input.provider);
  if (input.model) args.push("--model", input.model);
  if (input.thinking) args.push("--thinking", input.thinking);
  if (input.sessionFile) args.push("--session", input.sessionFile);
  else args.push("--no-session");

  // Disable discovery so ambient user extensions cannot widen a governed child's surface. Explicit
  // `-e` paths would still load, so this package never passes one.
  args.push("--no-extensions");

  if (allowlist) args.push("--tools", allowlist.join(","));
  else args.push("--no-tools");

  args.push(input.prompt);
  return { args, allowlist };
}
