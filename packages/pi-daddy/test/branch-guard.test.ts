/**
 * The `pre-commit` hook that enforces working rule 10 must actually refuse on `main`.
 *
 * **Why a test for a shell script, and why in this suite.** Rule 10 was added as prose, and a reviewer
 * pointed out that this project has a settled habit: every rule that was *actually violated in practice* —
 * the 400-line ceiling, the session-start guard, the risk-register headlines (R-59 then R-72) — got promoted
 * from prose to a mechanical check, precisely because prose had already failed once. Rule 10 is justified by
 * that same shape of history (eleven commits, by drift), so prose alone would have repeated the mistake the
 * rule is about. `npm test` is the only thing anyone runs here (R-34's distinction), so the check lives here.
 *
 * **The production change that breaks these tests** (rule 7): making the hook `exit 0` unconditionally,
 * inverting the branch comparison, dropping the `PI_DADDY_ALLOW_MAIN` escape, or deleting the hook. Each is
 * a real edit someone would plausibly make to get one commit through, and each fails a case below.
 *
 * **What this does not establish.** That the hook is *installed*: `core.hooksPath` is per-clone and cannot be
 * asserted from a package test that also has to pass in an installed copy. It proves the script is correct,
 * not that it is wired — the difference is stated in the hook's own header and in rule 10.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

const run = promisify(execFile);

after(cleanupTempDirs);

const HOOK = join(import.meta.dirname, "..", "..", "..", "hooks", "pre-commit");
const skip = existsSync(HOOK) ? false : "not in the repository";

/** A throwaway repo on `branch`, so the hook's own `git symbolic-ref` answers for real. */
async function repoOn(branch: string): Promise<string> {
  const dir = await tempDir("grants-hook-");
  await run("git", ["init", "-q", "-b", branch], { cwd: dir });
  return dir;
}

/** Exit code plus stderr, without throwing on the refusal we are here to observe. */
async function hook(cwd: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await run(HOOK, { cwd, env: { ...process.env, ...env } });
    return { code: 0, stderr };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? 1, stderr: failure.stderr ?? "" };
  }
}

test("the hook refuses a commit on main, and says what to do instead", { skip }, async () => {
  const { code, stderr } = await hook(await repoOn("main"));
  assert.equal(code, 1, "a hook that exits 0 on main enforces nothing");
  assert.match(stderr, /REFUSED/);
  assert.match(stderr, /main/, "the message must name the branch — rule 8");
  assert.match(stderr, /git switch -c/, "and must give the recovery command, or a reader invents one");
  assert.doesNotMatch(stderr, /reset|--force/, "it must never suggest rewriting history to 'repair' the state");
});

test("the hook allows a commit on any other branch", { skip }, async () => {
  const { code } = await hook(await repoOn("docs/whatever"));
  assert.equal(code, 0, "refusing everywhere would be discovered once and then disabled");
});

test("PI_DADDY_ALLOW_MAIN=1 waives it, loudly", { skip }, async () => {
  // The escape exists because `--no-verify` already bypasses every hook: pretending otherwise would be the
  // dishonest kind of control. It must announce itself, or a waived commit looks like an ordinary one.
  const { code, stderr } = await hook(await repoOn("main"), { PI_DADDY_ALLOW_MAIN: "1" });
  assert.equal(code, 0);
  assert.match(stderr, /PI_DADDY_ALLOW_MAIN/, "a silent waiver is R-70's shape — the quietest output for the loudest event");
});

test("a detached HEAD is not guarded", { skip }, async () => {
  // `git rebase` and `git bisect` commit from a detached HEAD. Refusing there would break both, and neither
  // is the drift this exists to catch.
  const dir = await repoOn("main");
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], {
    cwd: dir,
    env: { ...process.env, PI_DADDY_ALLOW_MAIN: "1" },
  });
  await run("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: dir });

  const { code } = await hook(dir);
  assert.equal(code, 0, "a detached HEAD has no branch to be wrong about");
});
