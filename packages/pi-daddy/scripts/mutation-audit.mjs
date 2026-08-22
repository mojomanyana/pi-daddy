#!/usr/bin/env node
/**
 * Rule 7, as a control instead of a habit.
 *
 * **Five review passes over one PR each found guards that could be deleted with the whole suite green** — ten
 * in the third pass, fourteen in the fourth, ten in the fifth. Every round fixed the instances and none of
 * them changed why the instances kept happening: the only thing forcing rule 7 was a person choosing to run a
 * mutation audit afterwards. R-34 already names that shape — *"a check an operator has to know to run is not
 * a control, it is a feature"* — and this project's own record says which guards never had this failure: the
 * line ceiling, the branch guard, the refusal enumeration. All mechanical, all cheap.
 *
 * So: a pinned catalogue of `(patch, the test it must break)`. Adding a guard means adding an entry. A guard
 * with no entry is not proven to be a guard, and an entry whose patch stops breaking its test fails the run.
 *
 * NOT part of `npm test`, deliberately — it edits files and runs the suite once per entry, so it is minutes
 * rather than seconds. `npm run test:mutation`, before pushing anything that adds or changes a guard.
 *
 * Two hazards, both learned the hard way this session and both handled below:
 *
 *  - **A mutation that does not apply reports success.** Shell escaping silently mangled two patches and the
 *    green result meant nothing. Every entry asserts its `find` occurs exactly once before patching.
 *  - **A parser that cannot read the reporter reports every guard as missing.** Measured 2026-08-22: this
 *    printed `0/20 guards forced a named failure` with all twenty guards intact, because the session's
 *    environment exports `FORCE_COLOR=3` and the matcher was anchored past the escape sequence. The
 *    parsing now lives in `scripts/mutation-parse.ts`, is tested by `test/mutation-audit.test.ts`, and an
 *    unreadable transcript is reported as unreadable instead of as twenty missing guards.
 *  - **A mutation whose failure mode is a HANG reports `fail 0`.** `node --test` cancels the pending test and
 *    prints a summary with two `cancelled` and zero failures; grepping the summary sees success. Every run is
 *    under an external timeout, and a timeout counts as "broke the test" only when the entry says so.
 *    (Related: never use bash `setsid` to get an exit code — it forks and returns 0 when the shell is already
 *    a process-group leader. Use a direct spawn, as here.)
 *
 * **And a third, which this script caused before it prevented it:** killing the run leaves a file mutated,
 * because a `finally` does not execute through SIGKILL. It then reports every later entry as "the catalogue is
 * stale", which reads like a catalogue problem and is actually a corrupted tree — and the obvious recovery,
 * `git checkout -- src`, discards whatever uncommitted work was there too. So this refuses to start unless the
 * files it will touch are clean, and it restores from git rather than from memory. If you kill it anyway,
 * `git status` tells you exactly what to restore and nothing else was at risk.
 */

import { readFile, writeFile } from "node:fs/promises";
import { failedTestNames, reporterWasReadable } from "./mutation-parse.ts";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TIMEOUT_MS = 180_000;

/**
 * Each entry: patch one guard, name the test that must fail.
 *
 * `expect` is matched against the names of the tests that FAILED — not against the transcript, which also
 * contains the names of tests that passed. `hang: true` means the guard's
 * regression is a non-termination rather than an assertion — the honest record for a guard whose absence
 * wedges the process, and the reason a bare exit code cannot be trusted here.
 */
const MUTATIONS = [
  // ── the registry reader ────────────────────────────────────────────────────
  { name: "registry: size ceiling removed",
    file: "src/workspace.ts", test: "test/workspace-capability.test.ts",
    find: "    if (info.size > REGISTRY_MAX_BYTES) {", replace: "    if (false) {",
    expect: "larger than the ceiling" },
  // **Three guards in this reader are deliberately NOT in the catalogue, and saying so is the point.**
  //
  //  - the **bounded read loop** rather than `handle.readFile`. Its regression needs a write to land inside
  //    the window between `fstat` and the read; a test that tries loses the race almost every time and then
  //    passes for the wrong reason — the previous iteration's grown file trips the *size* check instead, which
  //    looks like a pass. I shipped exactly that test, and this catalogue is what caught it: the mutation ran
  //    in 18ms without ever reading a grown file. Measured by hand instead — reverting the loop reads a
  //    384 MiB file and grows RSS by 778 MiB, and a reviewer won the race against the real function in 848ms
  //    (9% of 4000 attempts), reading 192 MiB after a 29-byte measurement.
  //  - `handle.stat()` rather than `stat(path)` closes a TOCTOU. Winning that race requires a swap to land
  //    inside the window between the two calls, which is not deterministic from inside the process; a test
  //    that wins it sometimes is a flaky test, and one that never wins it is decoration.
  //  - `finally { handle.close() }` prevents a descriptor leak. Node closes a `FileHandle` on GC, so a leak
  //    does not reliably surface as an fd count within one run.
  //
  // Each was measured by hand or by review — the swap loop hung 1 of 6 iterations with `stat`-by-name — and
  // none is forced by anything here. That is the honest form (the shape rule 6 asks for), not an excuse: an
  // entry asserting a check that does not fire would be worse than the gap it hides.
  //
  // (This sentence read "Both … neither" while the list above it said three. A stale count, in the paragraph
  // about stale claims, in the script written to stop stale claims. Left recorded rather than quietly fixed.)
  { name: "registry: non-regular file accepted",
    file: "src/workspace.ts", test: "test/workspace-capability.test.ts",
    find: "    if (!info.isFile()) {", replace: "    if (false) {",
    expect: "not a regular file", hang: true },
  { name: "registry: invalid JSON escapes the structured refusal",
    file: "src/workspace.ts", test: "test/workspace.test.ts",
    find: "    parsed = JSON.parse(raw);", replace: "    parsed = JSON.parse(raw); void 0;",
    also: [{ find: "  } catch (error) {\n    throw new GovernanceRefusal(refusal(\n      \"WORKSPACE_NOT_REGISTERED\",\n      `workspace registry ${path} is not valid JSON (${String(error)})`,",
             replace: "  } catch (error) {\n    throw new Error(String(error)); throw new GovernanceRefusal(refusal(\n      \"WORKSPACE_NOT_REGISTERED\",\n      `workspace registry ${path} is not valid JSON (${String(error)})`," }],
    expect: "not valid JSON" },
  { name: "registry: id grammar off",
    file: "src/workspace.ts", test: "test/workspace-capability.test.ts",
    find: "    if (!isSafeWorkspaceId(id)) {", replace: "    if (false) {",
    expect: "would not survive the grant grammar" },
  { name: "registry: refusal stops naming the file",
    file: "src/workspace.ts", test: "test/workspace-capability.test.ts",
    find: "workspaces: structuredClone(file.workspaces), source: path };",
    replace: "workspaces: structuredClone(file.workspaces) };",
    expect: "names the file and what it does hold" },

  // ── the workspace-id grammar, at every site that reads it ──────────────────
  { name: "grammar: slash refused again",
    file: "src/capabilities.ts", test: "test/workspace-capability.test.ts",
    find: "/^[A-Za-z0-9][A-Za-z0-9._/-]*$/", replace: "/^[A-Za-z0-9][A-Za-z0-9._-]*$/",
    expect: "would not survive the grant grammar" },
  { name: "grammar: fifth site back to the tool-name rule",
    file: "src/capabilities.ts", test: "test/init.test.ts",
    find: "  if (id.startsWith(\"workspace:\")) return isSafeWorkspaceId(id.slice(\"workspace:\".length));",
    replace: "  if (id.startsWith(\"workspace:\")) return /^workspace:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);",
    expect: "branch-named workspace id" },
  { name: "catalog: exemption back to the tool-name rule",
    file: "src/catalog.ts", test: "test/workspace-capability.test.ts",
    find: "(c.startsWith(\"workspace:\") && isSafeWorkspaceId(c.slice(\"workspace:\".length)))",
    replace: "c.startsWith(\"workspace:\")",
    expect: "CAN be granted a workspace capability" },

  // ── routing authority ─────────────────────────────────────────────────────
  { name: "routing: authority check removed",
    file: "src/routing-authority.ts", test: "test/workspace-capability.test.ts",
    find: "  if (mayRouteToWorkspace(ownGrant, boundWorkspaceId)) return null;", replace: "  if (true) return null;",
    expect: "attenuates three levels down" },
  { name: "routing: empty id skips the guards",
    file: "src/routing-authority.ts", test: "test/workspace-capability.test.ts",
    find: "  if (boundWorkspaceId === undefined) return null;", replace: "  if (!boundWorkspaceId) return null;",
    expect: "always lands in `denied`" },
  { name: "routing: wildcard refused for a non-holder too",
    file: "src/routing-authority.ts", test: "test/workspace-capability.test.ts",
    find: "  if (!ownGrant.includes(WORKSPACE_WILDCARD) && !ownGrant.includes(WILDCARD)) return null;", replace: "",
    expect: "always lands in `denied`" },
  { name: "routing: held list advertises unroutable ids",
    file: "src/routing-authority.ts", test: "test/workspace-capability.test.ts",
    find: "    .filter((c) => c.startsWith(\"workspace:\") && isSafeWorkspaceId(c.slice(\"workspace:\".length)))",
    replace: "    .filter((c) => c.startsWith(\"workspace:\"))",
    expect: "always lands in `denied`" },

  // ── attenuation, the gate, and the operator-facing surfaces ───────────────
  { name: "attenuation: wildcard reaches a delegated child",
    file: "src/propagation.ts", test: "test/workspace-capability.test.ts",
    find: "  return grant.filter((c) => c !== WILDCARD && c !== WORKSPACE_WILDCARD);",
    replace: "  return [...grant];",
    expect: "R-135" },
  { name: "gate: routing authority no longer gated",
    file: "src/delegation-approval.ts", test: "test/workspace-capability.test.ts",
    find: "  if (input.boundWorkspaceId) {", replace: "  if (false) {",
    expect: "asks a human before routing there" },
  { name: "gate: duplicate entry in gatedBlocked",
    file: "src/delegation-approval.ts", test: "test/workspace-capability.test.ts",
    find: "    (c) => !approvedCapabilities.includes(c) && !result.gatedBlocked.includes(c),",
    replace: "    (c) => !approvedCapabilities.includes(c),",
    expect: "listed once" },
  { name: "lease: non-tool capability forces a writer lease",
    file: "extensions/workspace-runtime.ts", test: "test/workspace-runtime.test.ts",
    find: "  const tools = requested.filter((c) => c.startsWith(\"tool:\") || c.startsWith(\"ext:\"));",
    replace: "  const tools = requested;",
    expect: "does not force an exclusive writer lease" },
  { name: "init: dialog can confer routing",
    file: "src/init.ts", test: "test/init.test.ts",
    find: "      if (capability.startsWith(\"workspace:\")) continue;", replace: "",
    expect: "cannot confer a routing capability" },
  { name: "init: consequence sentence back to the constant",
    file: "extensions/init-command.ts", test: "test/init.test.ts",
    find: "    const gatedAtSpawn = session.gated.includes(capability);",
    replace: "    const gatedAtSpawn = [\"tool:bash\"].includes(capability);",
    expect: "described as gated" },
  { name: "cli: init goes silent about a blocked routing package",
    file: "src/cli.ts", test: "test/init.test.ts",
    find: "  if (plan.routableWorkspaces.length > 0) {", replace: "  if (false) {",
    expect: "says out loud" },
  // ── the writer lease's retain path (R-146, merged from `main` with PR #14) ───
  //
  // These four arrived on `main` while this branch held the catalogue, so their guards shipped with named
  // regressions and no entries — the debt R-146's register body wrote out, paid here by the merge.
  { name: "lease: a retained lease detains its process",
    file: "src/workspace-lease.ts", test: "test/workspace.test.ts",
    find: "      holder.unref();", replace: "",
    expect: "retained lease releases its process" },
  { name: "lease: a hung herdr close is unbounded in time",
    // The helper source moved to `lease-helper.ts` when the line ceiling refused `workspace-lease.ts` at 405.
    file: "src/lease-helper.ts", test: "test/workspace.test.ts",
    find: "{timeout:Number(process.env.PI_DADDY_LEASE_CLOSE_TIMEOUT_MS||15000),killSignal:\"SIGKILL\"},",
    replace: "",
    expect: "hangs on close does not strand the lock forever" },
  { name: "lease: retention is not terminal",
    file: "src/workspace-lease.ts", test: "test/workspace.test.ts",
    find: "      settled = \"retained\";", replace: "",
    expect: "after markRetained" },
  { name: "lease: a zero close bound is accepted",
    file: "src/workspace-lease.ts", test: "test/workspace.test.ts",
    find: "    if (!Number.isFinite(value) || value < 1) {", replace: "    if (false) {",
    expect: "close bound is refused" },
  { name: "contract: npm test writes the repository again",
    file: "scripts/generate-ledger-v2-contract.ts", test: "test/ledger-contract.test.ts",
    find: "  await writeLedgerV2ContractFixtures(targets.fixtures);", replace: "  await writeLedgerV2ContractFixtures();",
    expect: "restores the refusal enum" },
];

const runSuite = (testFile) =>
  new Promise((resolve) => {
    const child = execFile(
      process.execPath, ["--test", testFile],
      // `FORCE_COLOR` in the ambient environment made `node --test` colour its output and the parser blind
      // to it — 0/20 with every guard intact, 2026-08-22. `scripts/mutation-parse.ts` strips ANSI anyway;
      // this pins the input as well, because two independent defences is the standard the catalogue holds
      // its own entries to.
      { cwd: root, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, killSignal: "SIGKILL",
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } },
      (error, stdout) => resolve({ stdout, killed: Boolean(error && error.killed) }),
    );
    child.on("error", () => resolve({ stdout: "", killed: true }));
  });

// **Refuse to run on a dirty tree.** A killed run leaves a mutation behind, and the next run cannot tell that
// from a stale catalogue. Requiring cleanliness up front means `git status` is always the whole recovery.
//
// The paths checked are the ones a run can WRITE, which is a larger set than the ones it patches: the
// `contract:` entry deliberately makes `npm test` regenerate the tracked fixtures, and the restore afterwards
// only `git checkout`s the patched source. So an uncommitted fixture edit was destroyed silently — benign only
// because regeneration happens to be byte-identical to what is committed (found by the sixth review pass).
const COLLATERAL = ["contracts/ledger/v2"];
const dirty = await new Promise((resolve) => {
  execFile("git", ["status", "--porcelain", "--", ...new Set([...MUTATIONS.map((m) => m.file), ...COLLATERAL])],
    { cwd: root }, (error, stdout) => resolve(error ? "" : stdout.trim()));
});
if (dirty) {
  console.error(
    "Refusing to run: the files this would mutate or rewrite have uncommitted changes.\n" +
    dirty.split("\n").map((l) => `    ${l}`).join("\n") +
    "\n\nCommit or stash them first. This script edits files in place, so a crash mid-run would leave a\n" +
    "mutation behind — and telling that apart from a stale catalogue costs more than committing does.",
  );
  process.exit(2);
}

let failures = 0;
for (const m of MUTATIONS) {
  const path = join(root, m.file);
  const original = await readFile(path, "utf8");
  const patches = [{ find: m.find, replace: m.replace }, ...(m.also ?? [])];
  let patched = original;
  let applied = true;
  for (const { find, replace } of patches) {
    // A patch that does not apply would report success. Refuse instead.
    if (patched.split(find).length - 1 !== 1) {
      console.error(`✗ ${m.name}\n    patch does not appear exactly once in ${m.file} — the catalogue is stale`);
      applied = false;
      failures++;
      break;
    }
    patched = patched.replace(find, replace);
  }
  if (!applied) continue;

  await writeFile(path, patched, "utf8");
  try {
    const { stdout, killed } = await runSuite(m.test);
    // **Match the FAILING test names, not the transcript.** The first version was
    // `stdout.includes(m.expect) && /^# fail [1-9]|✖/`, and `node --test` prints a test's name on PASS too —
    // so an entry scored ✓ whenever any test in that file failed and the expect string appeared anywhere,
    // including on its own ✔ line. A mutation that broke a NEIGHBOUR while the named guard's test still passed
    // was recorded as proven. That is the class of defect this script exists to catch, in this script, found by
    // the reviewer who suggested writing it. (The `^# fail` half never matched either: the spec reporter
    // prints `ℹ fail N`.)
    const failed = failedTestNames(stdout);
    // **"I saw no failure" and "I saw nothing" are different sentences.** Only one of them is a verdict on
    // the guard, and conflating them is what printed `0/20` here on 2026-08-22.
    if (!killed && !reporterWasReadable(stdout)) {
      failures++;
      console.error(
        `\u2717 ${m.name}\n    the auditor could not read ${m.test}'s output — this is NO verdict on the guard\n` +
        `    no test-name line matched; run \`node --test ${m.test}\` by hand and see scripts/mutation-parse.ts`,
      );
      continue;
    }
    // **A kill does not erase a verdict that already printed.** Measured 2026-08-22: reverting the retain-path
    // `unref` made the guard's own test fail at 10.0s — `✖ a retained lease releases its process` is right
    // there in the transcript — and then wedged the runner, because a sibling test retains a lease IN THIS
    // process and could no longer exit. The old form scored that as "the guard is not forced", which is the
    // opposite of what happened. So: a named failure counts whenever it appears; `hang: true` is still
    // required for a guard whose ONLY regression signature is non-termination, where nothing prints at all.
    const named = failed.some((name) => name.includes(m.expect));
    const broke = named || (killed && Boolean(m.hang));
    if (broke) {
      console.log(`✓ ${m.name}${killed ? "  (hang, as recorded)" : ""}`);
    } else {
      failures++;
      console.error(
        `✗ ${m.name}\n    reverting this guard did not break ${m.test} on "${m.expect}"` +
        `${killed ? " (the run was killed, and neither the named failure nor `hang: true` was present)" : ""}\n` +
        `    a guard nothing forces is not a guard — add the check, or remove the guard`,
      );
    }
  } finally {
    // From git, not from the copy in memory: if this process dies between the write and here, `git checkout`
    // is the recovery, and using the same mechanism both ways means there is only one thing to know.
    await new Promise((resolve) => execFile("git", ["checkout", "--", m.file], { cwd: root }, () => resolve()));
  }
}

console.log(`\n${MUTATIONS.length - failures}/${MUTATIONS.length} guards forced a named failure`);
if (failures > 0) {
  console.error("\nThe catalogue is the contract: every guard here must break the test it names.");
  process.exit(1);
}
