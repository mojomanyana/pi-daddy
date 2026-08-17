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
 * **The production changes that break these tests** (rule 7), all seven measured rather than asserted —
 * the first version of this docstring claimed four and one of them SURVIVED: `exit 0` unconditionally (3
 * fail), inverting the branch comparison (5), dropping the `PI_DADDY_ALLOW_MAIN` escape (3), loosening it to
 * `[ -n "$PI_DADDY_ALLOW_MAIN" ]` (1), matching `*main*` as a substring (1), removing the in-progress-merge
 * exemption (4), and **deleting the hook outright (7 — it used to skip 4 and report green).**
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
import { writeFile } from "node:fs/promises";
import { after, test } from "node:test";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

const run = promisify(execFile);

after(cleanupTempDirs);

const ROOT = join(import.meta.dirname, "..", "..", "..");
const HOOK = join(ROOT, "hooks", "pre-commit");

/**
 * Skip on an **installed copy** of the package, never on a missing hook.
 *
 * **The first version keyed the skip on the hook itself, and deleting the hook turned all four tests green by
 * turning them into zero tests** — `pass 0, skipped 4`, reported by a reviewer. That is rule 7 exactly, in the
 * file that cites rule 7, and it is R-85's own recurrence: the incident recorded there is `git stash -u`
 * *removing this hook* mid-test. The one scenario the suite most needs to shout about was the one it went
 * silent on. The repository marker is a tracked document, so it cannot be swept aside with the hook.
 */
const skip = existsSync(join(ROOT, "docs", "WORKING-RULES.md")) ? false : "not in the repository";

/** A throwaway repo on `branch`, so the hook's own `git symbolic-ref` answers for real. */
async function repoOn(branch: string): Promise<string> {
  const dir = await tempDir("grants-hook-");
  await run("git", ["init", "-q", "-b", branch], { cwd: dir });
  return dir;
}

/**
 * `git` with the developer's global config neutralised.
 *
 * `commit.gpgsign = true` in a `~/.gitconfig` killed the detached-HEAD case with `gpg failed to sign the
 * data` — a failure with nothing to do with the property under test. This is the only test here that shells
 * out to git, so it is the first that could make the suite's "fast, pure" claim depend on the machine.
 */
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const isolate = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "-c", "user.email=t@t", "-c", "user.name=t"];
  return run("git", [...isolate, ...args], { cwd, env: { ...process.env, ...env } });
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

test("a branch merely CONTAINING `main` is not `main`", { skip }, async () => {
  // A surviving mutation, reported by review: `case "$branch" in *main*)` passes every test above while
  // refusing to commit on `docs/maintenance` — and the victim would reasonably conclude the guard is broken
  // and unset `core.hooksPath`, which disables it for `main` too.
  for (const branch of ["docs/maintenance", "fix/domain-parsing", "mainline"]) {
    const { code } = await hook(await repoOn(branch));
    assert.equal(code, 0, `${branch} is not main`);
  }
});

test("PI_DADDY_ALLOW_MAIN=1 waives it, loudly", { skip }, async () => {
  // The escape exists because `--no-verify` already bypasses every hook: pretending otherwise would be the
  // dishonest kind of control. It must announce itself, or a waived commit looks like an ordinary one.
  const { code, stderr } = await hook(await repoOn("main"), { PI_DADDY_ALLOW_MAIN: "1" });
  assert.equal(code, 0);
  assert.match(stderr, /PI_DADDY_ALLOW_MAIN/, "a silent waiver is R-70's shape — the quietest output for the loudest event");
});

test("only the exact value `1` waives it", { skip }, async () => {
  // A surviving mutation: `[ -n "$PI_DADDY_ALLOW_MAIN" ]` passes the test above, and then `=0`, `=false` and
  // `=no` all disable the guard — the three spellings someone reaches for to turn it OFF.
  for (const value of ["0", "false", "no", ""]) {
    const { code } = await hook(await repoOn("main"), { PI_DADDY_ALLOW_MAIN: value });
    assert.equal(code, 1, `PI_DADDY_ALLOW_MAIN=${JSON.stringify(value)} must not waive the rule`);
  }
});

test("an in-progress merge, cherry-pick or revert is not refused", { skip }, async () => {
  // **The reason this file exists in its second form.** A clean merge never reaches `pre-commit`, but a
  // CONFLICTED one finishes with a literal `git commit` that does. Refusing there is a trap with no exit:
  // `git switch -c` — the recovery this very hook prints — is rejected outright while merging.
  const dir = await repoOn("main");
  await run("git", ["config", "core.hooksPath", ""], { cwd: dir });
  const write = async (text: string) => writeFile(join(dir, "f.txt"), text);

  await write("base\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "base"]);
  await git(dir, ["checkout", "-q", "-b", "feature"]);
  await write("theirs\n");
  await git(dir, ["commit", "-q", "-am", "theirs"]);
  await git(dir, ["checkout", "-q", "main"]);
  await write("ours\n");
  await git(dir, ["commit", "-q", "-am", "ours"]);
  await git(dir, ["merge", "feature"]).catch(() => undefined); // conflicts, by construction

  assert.ok(existsSync(join(dir, ".git", "MERGE_HEAD")), "the fixture must really be mid-merge");
  const { code } = await hook(dir);
  assert.equal(code, 0, "refusing a conflicted merge leaves `git merge --quit` as the only escape, which discards the resolution");
});

test("a detached HEAD is not guarded", { skip }, async () => {
  // `git rebase` and `git bisect` commit from a detached HEAD. Refusing there would break both, and neither
  // is the drift this exists to catch.
  const dir = await repoOn("main");
  await git(dir, ["commit", "-q", "--allow-empty", "-m", "x"], { PI_DADDY_ALLOW_MAIN: "1" });
  await git(dir, ["checkout", "-q", "--detach", "HEAD"]);

  const { code } = await hook(dir);
  assert.equal(code, 0, "a detached HEAD has no branch to be wrong about");
});
