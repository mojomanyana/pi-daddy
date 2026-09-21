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
  /**
   * Absolute path per skill NAME (`review` -> `/…/review`), as the catalog discovered them.
   *
   * R-32. Only skills named by a `skill:` capability in `effective` are passed, and a granted skill
   * absent from this map is reported in `unresolvedSkills` rather than dropped.
   */
  skillPaths?: Record<string, string>;
  /**
   * Let the child load `AGENTS.md` / `CLAUDE.md`. **Default false** — see the `--no-context-files`
   * note in `planSpawn`.
   */
  contextFiles?: boolean;
  /**
   * Instructions appended to the child's system prompt — a definition's `SKILL.md` body (ADR-0016).
   *
   * Appended rather than replacing, so pi's own coding-assistant prompt survives underneath and a
   * definition only has to describe its own job.
   */
  systemPrompt?: string;
}

export interface SpawnPlan {
  args: string[];
  /** The tool names pi will allow, for the ledger. `null` means no tools at all. */
  allowlist: string[] | null;
  /** Skill paths handed to the child, for the ledger. */
  skills: string[];
  /**
   * Granted `skill:` capabilities with no known path. **Non-empty means the caller should refuse**:
   * the child would silently lack a capability its grant says it holds.
   */
  unresolvedSkills: Capability[];
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

  // R-32. `--no-extensions` governs EXTENSIONS ONLY — measured, not assumed: a child spawned with
  // `--tools read` still loaded all eight of the operator's skills and `CLAUDE.md`
  // (`docs/probes/g16-herdr` §4-5). Skills are injected into the system prompt rather than passed as
  // tools, so `--tools` cannot reach them and the `skill:` namespace enforced nothing at all.
  //
  // `--no-skills` is unconditional and `--skill` is added on top, because that is exactly how pi
  // resolves them (`dist/core/resource-loader.js:329`): with `noSkills` set, discovered skills are
  // dropped and explicitly-passed paths are kept. Passing `--skill` WITHOUT `--no-skills` would add to
  // the discovered set instead of replacing it — an allowlist that widens, which is the failure
  // direction this package exists to prevent.
  const skills: string[] = [];
  const unresolvedSkills: Capability[] = [];
  for (const capability of input.effective) {
    if (!capability.startsWith("skill:")) continue;
    const path = input.skillPaths?.[capability.slice(6)];
    if (path) skills.push(path);
    else unresolvedSkills.push(capability);
  }
  args.push("--no-skills");
  for (const path of skills) args.push("--skill", path);

  // Context files are model-directing text that NO capability describes and no ledger line records, so
  // a child inheriting them holds influence its grant does not express. Under ADR-0012's threat model
  // — prompt injection explicitly in scope — an untrusted repository's `CLAUDE.md` reaching a governed
  // child is the injection vector. Off by default therefore, but deliberately still expressible:
  // inheriting a project's conventions is often exactly what an operator wants, and that should be a
  // decision they make rather than one this package makes silently in either direction.
  if (!input.contextFiles) args.push("--no-context-files");

  // Prompt templates are the third resource class that `--no-extensions` does not cover — found in the
  // banner of the very run that verified the two above. Lower risk than skills (a template is expanded
  // when a human invokes `/name`, not injected into the system prompt) but withheld for consistency:
  // under a herdr backend a governed child runs in an attachable pane WITH a human, so "only what the
  // grant names" must not depend on which executor ran it.
  args.push("--no-prompt-templates");

  // A definition's body, so the child IS the reviewer rather than merely holding a reviewer's tools.
  // Note this is operator-authored text from a file on disk, not a model-chosen string — the model
  // picks WHICH definition, never its contents. That is what keeps it out of `neutralisePrompt`'s
  // remit: the G1 hazard is a model-controlled string reaching a parser, and this is not one.
  if (input.systemPrompt) args.push("--append-system-prompt", input.systemPrompt);

  if (allowlist) args.push("--tools", allowlist.join(","));
  else args.push("--no-tools");

  args.push(neutralisePrompt(input.prompt));
  return { args, allowlist, skills, unresolvedSkills };
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
