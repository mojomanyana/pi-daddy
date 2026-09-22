/**
 * Staging a definition's instructions to a file, because herdr cannot carry them in argv.
 *
 * Split out of `src/executors/run-herdr.ts` at the 400-line ceiling. A real seam rather than an arbitrary cut: this is
 * the one place that works around a **herdr encoding limit**, and it is the only part of the herdr path that
 * touches the filesystem. `run-herdr.ts` starts and reaps agents; this prepares one argument.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Move a multi-line `--append-system-prompt` out of argv, because herdr cannot encode it.
 *
 * **Measured.** `herdr agent start` types the argv into the pane's shell, so a value containing newlines
 * is rejected outright: `invalid_agent_argument — agent arguments cannot be encoded safely for the target
 * shell`. A definition's `SKILL.md` body is always multi-line, so every `delegate({agent})` spawn would
 * fail on this path.
 *
 * pi accepts a **file path** there as readily as literal text (`resolvePromptInput` + `existsSync` in
 * `dist/core/resource-loader.js`), so the fix is to write the body to a temp file and pass its path — one
 * short, shell-safe argument.
 *
 * The split lives here rather than in `planSpawn` because the constraint is **herdr's**, not pi's: the
 * direct executor passes the same text inline with no trouble, and a plan builder that pre-emptively wrote
 * temp files for everybody would be paying one executor's tax on both paths.
 */
export function splitSystemPrompt(args: string[]): { args: string[]; systemPrompts: string[] } {
  // EVERY occurrence, not the first. pi accumulates `--append-system-prompt`, and ADR-0078 added a second one for a
  // granted context handoff — whose fence always contains newlines. Taking only the first left that fence inline,
  // and `herdr agent start` refuses a multi-line argument, so every non-fork handoff failed on the Herdr executor
  // AFTER the gate, the ledger record and the fan-out spend. Measured during review.
  const kept: string[] = [];
  const systemPrompts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--append-system-prompt" && index + 1 < args.length) {
      systemPrompts.push(args[index + 1]);
      index += 1;
      continue;
    }
    kept.push(args[index]);
  }
  return { args: kept, systemPrompts };
}

/**
 * Move a multi-line system prompt into a temp file and return argv pointing at it.
 *
 * Returns the directory so the caller can remove it — and **every** early return on the herdr path must, because
 * nothing else can: a reviewer measured a permanent `/tmp/grants-herdr-*` per failed `tab create`, unreachable by
 * either pane sweep because the pane it belonged to never existed.
 */
export async function stageSystemPrompt(
  args: string[],
): Promise<{ args: string[]; promptDir?: string; error?: string }> {
  const split = splitSystemPrompt(args);
  if (split.systemPrompts.length === 0) return { args: split.args };
  try {
    const promptDir = await mkdtemp(join(tmpdir(), "grants-herdr-"));
    const staged: string[] = [];
    // One file per prompt, in order: pi appends them in argv order and the definition body must still precede the
    // context a parent chose to add to it.
    for (const [index, prompt] of split.systemPrompts.entries()) {
      const file = join(promptDir, `system-prompt-${index}.md`);
      await writeFile(file, prompt, "utf8");
      staged.push("--append-system-prompt", file);
    }
    return { args: [...split.args, ...staged], promptDir };
  } catch (error) {
    return { args: split.args, error: `could not stage the system prompt for herdr: ${String(error)}` };
  }
}
