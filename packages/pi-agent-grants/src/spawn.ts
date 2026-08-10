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

  args.push(neutralisePrompt(input.prompt));
  return { args, allowlist };
}

/**
 * Make a model-controlled task unparseable by pi's CLI.
 *
 * pi's usage is `pi [options] [@files...] [messages...]`, and both of the non-message forms are reached
 * by the FIRST CHARACTER of an argv element:
 *
 *  - `@…` is resolved as a file and its contents injected into the child's prompt — absolute paths, `~`
 *    expansion, no sandbox. This happens in `main.js` before any tool is constructed, so `--tools` and
 *    `--no-tools` never apply to it. A child granted nothing at all still reads the file. Verified
 *    against pi 0.83.0 (review finding A-C1 / B-C7, and `docs/probes/g1-argv`).
 *  - `-…` is parsed as a flag, and pi ships `--approve` ("trust project-local files for this run").
 *
 * The task comes from the model, so this is the one place in the package where a model-authored string
 * would otherwise reach a parser that outranks the enforcement point. A single leading space removes it
 * from both branches: pi does not trim before dispatching on the prefix (measured), and a leading space
 * is semantically nil inside a prompt.
 *
 * **It is applied unconditionally, and that is the point.** Rewriting only arguments that start with
 * `@` or `-` would encode pi 0.83.0's current parser into this package and silently re-open the hole
 * the moment pi — or an extension registering its own flags — adds a third prefix. The guarantee here is
 * positional rather than pattern-based: the first character of that argv element is never the task's.
 *
 * Deliberately NOT a refusal. The review also suggested rejecting `@`/`-` tasks in `planDelegation` so
 * they land in the ledger. Neutralising costs no false refusals and needs no judgement about which
 * prompts are legitimate, so it is the whole fix; recording an attempt is an audit question (G6), not a
 * security one, and is left to that group.
 */
function neutralisePrompt(prompt: string): string {
  return ` ${prompt}`;
}
