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
  { name: "init: generated environment disables its ledger",
    file: "src/grant-env.ts", test: "test/init.test.ts",
    find: '    \'export PI_GRANTS_LEDGER=".pi/grants.jsonl"\',',
    replace: '    \'#export PI_GRANTS_LEDGER=".pi/grants.jsonl"\',',
    expect: "grant authorises only what can actually be spawned" },
  { name: "init: stored project ledger consent is omitted",
    file: "extensions/init-command.ts", test: "test/init.test.ts",
    find: "  const saved = await saveGrant(ctx.cwd, finalGrant, { projectLedger: true });",
    replace: "  const saved = await saveGrant(ctx.cwd, finalGrant);",
    expect: "stores and adopts the project ledger" },
  { name: "init: project ledger is not adopted into the running session",
    file: "extensions/init-command.ts", test: "test/init.test.ts",
    find: "  session.adoptGrant(finalGrant, ledger);",
    replace: "  session.adoptGrant(finalGrant);",
    expect: "stores and adopts the project ledger" },
  { name: "grant store: legacy v1 gains retroactive ledger consent",
    file: "src/grant-store.ts", test: "test/grant-store.test.ts",
    find: "      projectLedger: parsed.version === 2,",
    replace: "      projectLedger: true,",
    expect: "new init opts this project into its ledger" },
  { name: "grant store: v2 no longer requires explicit ledger consent",
    file: "src/grant-store.ts", test: "test/grant-store.test.ts",
    find: "    if (parsed.version === 2 && parsed.projectLedger !== true) return null;",
    replace: "    if (false) return null;",
    expect: "parser rejects every malformed store shape" },
  { name: "session: child environment consults the cwd project store",
    file: "extensions/session.ts", test: "test-integration/governance.it.ts",
    find: "  const stored = grantRaw === undefined ? loadStoredGrantSync(storeCwd) : null;",
    replace: "  const stored = loadStoredGrantSync(storeCwd);",
    expect: "explicit environment configuration still bypasses" },
  { name: "session: stored ledger overrides explicit environment",
    file: "extensions/session.ts", test: "test-integration/governance.it.ts",
    find: "    ledgerPath: ledgerRaw !== undefined ? ledgerRaw : storedLedger,",
    replace: "    ledgerPath: storedLedger,",
    expect: "explicit environment configuration still bypasses" },
  { name: "session: init ledger is not made live now",
    file: "extensions/session.ts", test: "test/session-project-ledger.test.ts",
    find: "      if (!ledgerFromEnvironment && projectLedger !== undefined) {",
    replace: "      if (false) {",
    expect: "adopting init's project ledger is live now" },
  { name: "session: self-published ledger is mistaken for an explicit override",
    file: "extensions/session.ts", test: "test/session-project-ledger.test.ts",
    find: "      if (!ledgerFromEnvironment && projectLedger !== undefined) {",
    replace: "      if (process.env[ENV_LEDGER] === undefined && projectLedger !== undefined) {",
    expect: "adopting init's project ledger is live now" },
  { name: "status: explicit empty ledger renders as a blank path",
    file: "extensions/grants-command.ts", test: "test-integration/governance.it.ts",
    find: '      `  ledger     ${ledgerPath || "(not recording — set PI_GRANTS_LEDGER)"}`,',
    replace: '      `  ledger     ${ledgerPath ?? "(not recording — set PI_GRANTS_LEDGER)"}`,',
    expect: "explicit environment configuration still bypasses" },
  { name: "cli: init goes silent about a blocked routing package",
    file: "src/cli.ts", test: "test/init.test.ts",
    find: "  if (plan.routableWorkspaces.length > 0) {", replace: "  if (false) {",
    expect: "says out loud" },
  // Two entries that stood here were SUPERSEDED by R-152 rather than deleted for convenience: the lines they
  // patched no longer exist (`settled = "retained"` became conditional, and the bound check gained an integer
  // test and a ceiling). Their successors are in the R-152 block above, and the harness is what noticed —
  // a stale `find` is refused, not silently skipped.
  // ── the retain path's reporting (R-152, merged from `main` with PR #15) ─────
  //
  // The second time this debt came due: these four guards reached `main` while the catalogue lived here. Two
  // need multi-line finds, because `markRetained` deliberately mirrors `release()` and the one-line forms
  // appear twice — the harness requires a find that occurs exactly once, which is what caught that.
  { name: "lease: retention is not terminal against a prior release",
    file: "src/workspace-lease.ts", test: "test/workspace.test.ts",
    find: "      if (settled) return settled;\n      // Already dead: the helper is gone",
    replace: "      // Already dead: the helper is gone",
    expect: "markRetained after a clean release" },
  { name: "lease: markRetained claims a retention on a dead helper",
    file: "src/workspace-lease.ts", test: "test/workspace.test.ts",
    find: "      if (holder.exitCode !== null || holder.signalCode !== null) return (settled = \"lost\");\n      const current = await readMetadata(paths.metadata);",
    replace: "      const current = await readMetadata(paths.metadata);",
    expect: "dead helper reports" },
  { name: "lease: an unrecorded retention still settles",
    file: "src/workspace-lease.ts", test: "test/workspace.test.ts",
    find: "      if (recorded) settled = \"retained\";", replace: "      settled = \"retained\";",
    expect: "could not be written" },
  { name: "lease: an impossible close bound is accepted",
    // `assertCloseBounds` moved to `lease-helper.ts` with the attempts it bounds, when the ceiling refused
    // `workspace-lease.ts` at 402 lines.
    file: "src/lease-helper.ts", test: "test/workspace.test.ts",
    find: "    if (!Number.isInteger(value) || value < 1 || value > ceiling) {", replace: "    if (false) {",
    expect: "impossible close bound" },
  { name: "lease: the ledger word is hardcoded instead of reported",
    file: "extensions/workspace-runtime.ts", test: "test/workspace-runtime.test.ts",
    find: "    ? await input.prepared.lease.markRetained(input.reason)",
    replace: "    ? ((await input.prepared.lease.markRetained(input.reason)), \"retained\")",
    expect: "ledgered `lost`" },
  // ── the writer lease's retain path (R-146, merged from `main` with PR #14) ───
  //
  // These four arrived on `main` while this branch held the catalogue, so their guards shipped with named
  // regressions and no entries — the debt R-146's register body wrote out, paid here by the merge.
  // This one costs the full `TIMEOUT_MS`: its named test fails at ~10s and then the file wedges, because a
  // sibling test retains a lease in the RUNNER's own process and cannot exit once this guard is gone. The
  // named failure is what scores it; `hang: true` is deliberately absent, since a bare kill must not count.
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
  // ── observability: occurrence identity, projection, and Herdr handoff ───────
  { name: "execution: occurrence id reused",
    file: "src/execution-id.ts", test: "test/execution-identity.test.ts",
    find: "  return `exec:${randomUUID()}`;", replace: "  return `exec:00000000-0000-4000-8000-000000000001`;",
    expect: "globally unique occurrences" },
  { name: "execution: unique id not propagated to the child",
    file: "src/delegate.ts", test: "test/execution-identity.test.ts",
    find: "  if (ctx.childExecutionId) env[ENV_EXECUTION_ID] = ctx.childExecutionId;", replace: "",
    expect: "receives its unique execution id" },
  { name: "ledger v3: load-bearing capability decision append removed",
    file: "extensions/run-delegation.ts", test: "test/delegate-all-wiring.test.ts",
    find: "    await recordDelegationDecision({", replace: "    if (false) await recordDelegationDecision({",
    expect: "digest reaches the LEDGER FILE" },
  { name: "dashboard: duplicate capability decision silently overwrites",
    file: "src/dashboard-projection.ts", test: "test/dashboard-projection.test.ts",
    find: "    if (event.event === \"capability_decision\" && occurrence.decision) {", replace: "    if (false) {",
    expect: "duplicate capability decisions" },
  { name: "dashboard: terminal child can be resurrected",
    file: "src/dashboard-projection.ts", test: "test/dashboard-projection.test.ts",
    find: "      if (previous && TERMINAL_STATES.has(String(previous.state))) {", replace: "      if (false) {",
    expect: "after terminal state" },
  { name: "dashboard: parent cycles disappear from the tree",
    file: "src/dashboard-projection.ts", test: "test/dashboard-projection.test.ts",
    find: "  const cycles = executionParentCycles(occurrences);", replace: "  const cycles = new Set();",
    expect: "multi-node parent cycle" },
  { name: "dashboard: lifecycle joined on logical child id",
    file: "src/dashboard-projection.ts", test: "test/dashboard-projection.test.ts",
    find: "    const seen = occurrences.get(executionId);", replace: "    const seen = occurrences.get(childId);",
    also: [{ find: "    occurrences.set(executionId, occurrence);", replace: "    occurrences.set(childId, occurrence);" }],
    expect: "same logical child position" },
  { name: "dashboard: stale start stays running forever",
    file: "src/dashboard-projection.ts", test: "test/dashboard-projection.test.ts",
    find: "    return nowMs > deadline ? \"incomplete\" : state as \"starting\" | \"running\";",
    replace: "    return state as \"starting\" | \"running\";",
    expect: "expires to incomplete" },
  { name: "dashboard: decision-only incomplete duration grows forever",
    file: "src/dashboard-projection.ts", test: "test/dashboard-projection.test.ts",
    find: "    : latestLifecycle ? undefined : Date.parse(occurrence.firstTs) + graceMs;",
    replace: "    : undefined;",
    expect: "start grace bound" },
  { name: "dashboard: refusal accrues runtime it never used",
    file: "src/dashboard-projection.ts", test: "test/dashboard-projection.test.ts",
    find: "  const durationEnd = state === \"refused\"\n    ? Date.parse(start)\n    : terminal ? Date.parse(String(terminal.ts)) : state === \"incomplete\" && deadline ? deadline : now.getTime();",
    replace: "  const durationEnd = terminal ? Date.parse(String(terminal.ts)) : state === \"incomplete\" && deadline ? deadline : now.getTime();",
    expect: "refusal that never starts" },
  { name: "dashboard: completed node loses Herdr runtime identity",
    file: "src/dashboard-projection.ts", test: "test/dashboard-projection.test.ts",
    find: "  const runtimeEvent = occurrence.lifecycle.findLast(", replace: "  const runtimeEvent = [latestLifecycle].findLast(",
    expect: "retained Herdr identity" },
  { name: "ledger v3: non-terminal lifecycle has no deadline",
    file: "src/ledger-v3-validation.ts", test: "test/runtime-ledger-v3.test.ts",
    find: "  if ([\"starting\", \"running\"].includes(String(event.state)) && !isTimestamp(event.deadlineAt)) {",
    replace: "  if (false) {",
    expect: "contract-valid RFC 3339 deadline" },
  { name: "ledger v3: process event can claim a Herdr pane",
    file: "src/ledger-v3-validation.ts", test: "test/runtime-ledger-v3.test.ts",
    find: "  if (Object.hasOwn(event, \"herdrPaneId\") && event.executor !== \"herdr\") {", replace: "  if (false) {",
    expect: "runtime identity is paired" },
  { name: "dashboard: Herdr running transition never recorded",
    file: "src/run-herdr.ts", test: "test/run-herdr.test.ts",
    find: "    if (request.onRunning) {", replace: "    if (false) {",
    expect: "running only after agent start" },
  { name: "dashboard: Herdr host no longer binds the pi pid",
    file: "src/dashboard-herdr.ts", test: "test/dashboard-herdr.test.ts",
    find: "      return process.pid === pid;", replace: "      return true;",
    expect: "binds the Herdr pane" },
  { name: "dashboard: process info for another pane accepted",
    file: "src/dashboard-herdr.ts", test: "test/dashboard-herdr.test.ts",
    find: "    if (info?.pane_id !== paneId) {\n      return { ok: false, diagnostic: \"Herdr returned process information for another pane.\" };",
    replace: "    if (false) {\n      return { ok: false, diagnostic: \"Herdr returned process information for another pane.\" };",
    expect: "process information returned for another pane" },
  { name: "dashboard: dead dashboard process falsely reused",
    file: "src/dashboard-herdr.ts", test: "test/dashboard-herdr.test.ts",
    find: "          pane.workspace_id === input.host.workspaceId && await dashboardProcessIsLive(pane.pane_id, exec)) {",
    replace: "          pane.workspace_id === input.host.workspaceId) {",
    expect: "dashboard process exited" },
  { name: "dashboard: same-id plugin from another package accepted",
    file: "src/dashboard-herdr.ts", test: "test/dashboard-herdr.test.ts",
    find: "    if (expectedPluginRoot && (typeof plugin.plugin_root !== \"string\" || resolve(plugin.plugin_root) !== resolve(expectedPluginRoot))) {",
    replace: "    if (false) {",
    expect: "plugin discovery distinguishes" },
  { name: "dashboard: incompatible plugin protocol accepted",
    file: "src/dashboard-herdr.ts", test: "test/dashboard-herdr.test.ts",
    find: "    if (major !== DASHBOARD_PROTOCOL_VERSION) {", replace: "    if (false) {",
    expect: "distinguishes absent, disabled, compatible and incompatible" },
  { name: "dashboard: opening steals focus",
    file: "src/dashboard-herdr.ts", test: "test/dashboard-herdr.test.ts",
    find: "      \"--no-focus\",", replace: "      \"--focus\",",
    expect: "splits right, keeps focus" },
  { name: "dashboard: split open sends mutually exclusive workspace",
    file: "src/dashboard-herdr.ts", test: "test/dashboard-herdr.test.ts",
    find: '      "--target-pane", input.host.paneId,',
    replace: '      "--workspace", input.host.workspaceId, "--target-pane", input.host.paneId,',
    expect: "omits incompatible workspace" },
  { name: "dashboard: invocation cwd creates a duplicate pane",
    file: "src/dashboard-herdr.ts", test: "test/dashboard-herdr.test.ts",
    find: '    .update(`${input.host.workspaceId}\\0${input.host.tabId}\\0${ledgerPath}`, "utf8")',
    replace: '    .update(`${input.host.workspaceId}\\0${input.host.tabId}\\0${ledgerPath}\\0${cwd}`, "utf8")',
    expect: "opening targets the calling pi pane" },
  { name: "dashboard: save failure leaves an untracked pane",
    file: "src/dashboard-herdr.ts", test: "test/dashboard-herdr.test.ts",
    find: "  const closed = await exec([\"plugin\", \"pane\", \"close\", paneId]).catch(() => undefined);",
    replace: "  const closed = undefined;",
    expect: "pane is closed if persisting" },
  { name: "dashboard: installed bin symlink becomes a no-op",
    file: "src/dashboard-cli.ts", test: "test/dashboard-cli.test.ts",
    find: "pathToFileURL(realpathSync(process.argv[1])).href", replace: "pathToFileURL(process.argv[1]).href",
    expect: "installed-style symlink" },
  { name: "dashboard: Not now installs anyway",
    file: "src/dashboard-handshake.ts", test: "test/dashboard-handshake.test.ts",
    find: "    if (choice !== \"Install and open\") {", replace: "    if (false) {",
    expect: "Not now is recorded" },
  { name: "dashboard: narrow split forced to thirty columns",
    file: "src/dashboard-render.ts", test: "test/dashboard-render.test.ts",
    find: "    width: Math.max(10, options.width ?? 80),", replace: "    width: Math.max(30, options.width ?? 80),",
    expect: "width truncation counts terminal cells" },
  { name: "dashboard: ANSI truncation leaves terminal style open",
    file: "src/dashboard-render.ts", test: "test/dashboard-render.test.ts",
    find: "  return styled ? `${output}\\u001b[0m` : output;", replace: "  return output;",
    expect: "never leaves ANSI color open" },
  { name: "dashboard: wide cells counted as one column",
    file: "src/dashboard-render.ts", test: "test/dashboard-render.test.ts",
    find: "    const next = WIDE_CELL.test(char) ? 2 : 1;", replace: "    const next = 1;",
    expect: "counts terminal cells" },
  { name: "workflow: planned fact may claim completion",
    file: "src/workflow-facts.ts", test: "test/workflow-facts.test.ts",
    find: "  if (!workflowFactStateMatches(args.provenance, args.state)) {", replace: "  if (false) {",
    expect: "explicit provenance" },
  { name: "workflow: malformed fact id accepted by projection",
    file: "src/ledger-v3-validation.ts", test: "test/workflow-facts.test.ts",
    find: "  if (!isTimestamp(event.ts) || !isWorkflowFactId(event.factId) ||", replace: "  if (!isTimestamp(event.ts) || false ||",
    expect: "malformed fact identity" },
  { name: "workflow: correlation whitelist bypassed",
    file: "src/workflow-facts.ts", test: "test/workflow-facts.test.ts",
    find: "  const correlation = normaliseCorrelation(args.correlation);", replace: "  const correlation = args.correlation;",
    expect: "identifier-only privacy bounds" },
  { name: "workflow: projection accepts provenance contradiction",
    file: "src/ledger-v3-validation.ts", test: "test/workflow-facts.test.ts",
    find: "  return workflowFactStateMatches(event.provenance, event.state)\n    ? null",
    replace: "  return true\n    ? null",
    expect: "rejects provenance/state contradictions" },
  { name: "workflow: controller validation rendered as enforcement",
    file: "src/dashboard-render.ts", test: "test/workflow-facts.test.ts",
    find: "  const marker = fact.provenance === \"planned\" ? \"P\" : fact.provenance === \"observed\" ? \"O\" : \"V\";",
    replace: "  const marker = fact.provenance === \"planned\" ? \"P\" : fact.provenance === \"observed\" ? \"O\" : \"E\";",
    expect: "remain distinct from enforced children" },
  { name: "dashboard: unknown workspace lease outcome accepted",
    file: "src/ledger-v3-validation.ts", test: "test/dashboard-projection.test.ts",
    find: "      ![\"read\", \"write\"].includes(String(event.access)) || !LEASE_OUTCOMES.has(String(event.outcome))) {",
    replace: "      ![\"read\", \"write\"].includes(String(event.access)) || !String(event.outcome)) {",
    expect: "corrupt and unsupported lines" },
  { name: "ledger v3: routed descendants split a relative ledger",
    file: "extensions/grants.ts", test: "test/delegate-all-wiring.test.ts",
    find: "    if (session.ledgerPath) session.ledgerPath = resolve(ctx.cwd, session.ledgerPath);",
    replace: "    if (session.ledgerPath) session.ledgerPath = session.ledgerPath;",
    expect: "relative ledger becomes one absolute" },
  { name: "ledger v3: one chain execution loses half its mixed gate outcome",
    file: "extensions/delegate-chain.ts", test: "test/delegate-chain-wiring.test.ts",
    find: "            approval: mergeGateOutcomes(decision.outcomes),",
    replace: "            approval: decision.outcomes[0],",
    expect: "mixed gate outcomes on ONE chain step" },
  { name: "dashboard: malformed JSON diagnostics echo raw content",
    file: "src/dashboard-projection.ts", test: "test/dashboard-projection.test.ts",
    find: "      corrupt.push({ line, reason: \"invalid JSON\" });",
    replace: "      corrupt.push({ line, reason: raw });",
    expect: "malformed JSON diagnostics never echo" },
  { name: "dashboard: malformed nested correlation reaches the renderer",
    file: "src/ledger-v3-validation.ts", test: "test/dashboard-projection.test.ts",
    find: "      !optional(event, \"correlation\", validCorrelation) ||",
    replace: "      false ||",
    expect: "malformed nested v3 fields" },
  { name: "dashboard: malformed explicit v2 is downgraded to history",
    file: "src/dashboard-projection.ts", test: "test/dashboard-projection.test.ts",
    find: "      if (!LEDGER_V2.Check(event)) {",
    replace: "      if (false) {",
    expect: "malformed explicit v2 events are corruption" },
  { name: "ledger v3: string version bypasses required identity",
    file: "src/ledger-report.ts", test: "test/runtime-ledger-v3.test.ts",
    find: "        if (event.ledgerVersion !== 2 && event.ledgerVersion !== 3) throw new Error(\"unsupported ledger version\");",
    replace: "        if (![2, 3].includes(Number(event.ledgerVersion))) throw new Error(\"unsupported ledger version\");",
    also: [{
      find: "  if ((event.ledgerVersion !== 2 && event.ledgerVersion !== 3) || typeof event.ts !== \"string\" ||",
      replace: "  if (![2, 3].includes(Number(event.ledgerVersion)) || typeof event.ts !== \"string\" ||",
    }],
    expect: "integrity reader rejects lookalike v3" },
  { name: "workflow: producer accepts arbitrary fact kind text",
    file: "src/workflow-facts.ts", test: "test/workflow-facts.test.ts",
    find: "  if (!WORKFLOW_FACT_KINDS.includes(args.kind)) throw new TypeError(\"workflow fact kind is not recognised\");",
    replace: "  if (false) throw new TypeError(\"workflow fact kind is not recognised\");",
    expect: "explicit provenance and identifier-only privacy bounds" },
  { name: "workflow: public builder emits a reader-invalid timestamp",
    file: "src/workflow-facts.ts", test: "test/workflow-facts.test.ts",
    find: "  return assertLedgerV3Wire(event);", replace: "  return event;",
    expect: "public workflow-fact builder cannot emit" },
  { name: "progress: display failure kills a process child",
    file: "extensions/delegation.ts", test: "test/delegate-all-wiring.test.ts",
    find: "    try {\n      onUpdate?.({\n        content: [{ type: \"text\", text: renderProgress(children, session.executor.kind, Date.now()) }],\n      });\n    } catch {\n      // Display only. In particular, this callback can run inside runChild's security-sensitive onSpawn;\n      // letting it escape makes runChild kill an otherwise healthy governed child.\n    }",
    replace: "    onUpdate?.({\n      content: [{ type: \"text\", text: renderProgress(children, session.executor.kind, Date.now()) }],\n    });",
    expect: "progress renderer failure cannot kill" },
  { name: "progress: chain display failure kills its process step",
    file: "extensions/delegate-chain.ts", test: "test/delegate-all-wiring.test.ts",
    find: "        try {\n          (onUpdate as ((partial: { content: Array<{ type: \"text\"; text: string }> }) => void) | undefined)?.({\n            content: [{ type: \"text\", text: renderProgress(children, session.executor.kind, Date.now()) }],\n          });\n        } catch {\n          // Display only: a broken partial-result sink must not become a child cancellation mechanism.\n        }",
    replace: "        (onUpdate as ((partial: { content: Array<{ type: \"text\"; text: string }> }) => void) | undefined)?.({\n          content: [{ type: \"text\", text: renderProgress(children, session.executor.kind, Date.now()) }],\n        });",
    expect: "chain progress renderer failure cannot kill" },
  { name: "dashboard: disabled foreign plugin is suggested for enable",
    file: "src/dashboard-herdr.ts", test: "test/dashboard-herdr.test.ts",
    find: "    // Provenance and protocol precede enabled state. Suggesting `plugin enable` for a same-id plugin from\n    // another package would ask the operator to activate software this package explicitly refuses to invoke.\n    if (expectedPluginRoot &&",
    replace: "    if (plugin.enabled !== true) return { state: \"disabled\", diagnostic: `Herdr plugin ${DASHBOARD_PLUGIN_ID} is installed but disabled.`, plugin };\n    if (expectedPluginRoot &&",
    expect: "plugin discovery distinguishes" },
  { name: "dashboard: dismissed install prompt becomes durable Not now",
    file: "src/dashboard-handshake.ts", test: "test/dashboard-handshake.test.ts",
    find: "    if (choice !== \"Install and open\" && choice !== \"Not now\" && choice !== \"Never ask\") {",
    replace: "    if (false) {",
    expect: "dismissing the startup prompt" },
  { name: "ledger report: corrupt bytes reach /grants diagnostics",
    file: "src/ledger-report.ts", test: "test/runtime-ledger-v3.test.ts",
    find: "      corrupt.push({ line: index + 1, reason: \"invalid ledger line\" });",
    replace: "      corrupt.push({ line: index + 1, reason: raw });",
    expect: "integrity reader never retains raw corrupt" },
  { name: "dashboard: a pane moved to another host is reused",
    file: "src/dashboard-herdr.ts", test: "test/dashboard-herdr.test.ts",
    find: "      if (pane && typeof pane.pane_id === \"string\" && pane.tab_id === input.host.tabId &&\n          pane.workspace_id === input.host.workspaceId && await dashboardProcessIsLive(pane.pane_id, exec)) {",
    replace: "      if (pane && typeof pane.pane_id === \"string\" && typeof pane.tab_id === \"string\" &&\n          typeof pane.workspace_id === \"string\" && await dashboardProcessIsLive(pane.pane_id, exec)) {",
    expect: "moved away from the caller tab" },
  { name: "dashboard: an opened pane from another host is persisted",
    file: "src/dashboard-herdr.ts", test: "test/dashboard-herdr.test.ts",
    find: "    if (pane.workspace_id !== input.host.workspaceId || pane.tab_id !== input.host.tabId) {",
    replace: "    if (false) {",
    expect: "newly opened dashboard pane is closed" },
  { name: "dashboard: malformed nested pane state opens a duplicate",
    file: "src/dashboard-herdr.ts", test: "test/dashboard-herdr.test.ts",
    find: "    if (!isPaneStore(parsed)) throw new Error(\"unsupported dashboard pane store shape\");",
    replace: "    if (false) throw new Error(\"unsupported dashboard pane store shape\");",
    expect: "malformed nested pane-store entry" },
  { name: "dashboard: stored pane silently changes ledger",
    file: "src/dashboard-herdr.ts", test: "test/dashboard-herdr.test.ts",
    find: "      if (stored.workspaceId !== input.host.workspaceId || stored.tabId !== input.host.tabId ||\n          stored.ledgerPath !== ledgerPath) {",
    replace: "      if (false) {",
    expect: "stored pane cannot be reused under a ledger path" },
  { name: "ledger v3: named check prose reaches a receipt before refusal",
    file: "src/check-runner.ts", test: "test/check-runner.test.ts",
    find: "  if (!isLedgerDisplayIdentifier(checkId) || checkId.length > 460) {",
    replace: "  if (false) {",
    expect: "malformed check definition" },
  { name: "ledger v3: public capability builder emits invalid display text",
    file: "src/ledger.ts", test: "test/runtime-ledger-v3.test.ts",
    find: "  if (args.taskDigest !== undefined) assertLedgerV3Wire(record);",
    replace: "  if (false) assertLedgerV3Wire(record);",
    expect: "public v3 builders refuse free text" },
  { name: "dashboard: schema-shaped prose passes runtime identifier guards",
    file: "src/ledger-identifiers.ts", test: "test/dashboard-projection.test.ts",
    find: "  return typeof value === \"string\" && DISPLAY_IDENTIFIER.test(value);",
    replace: "  return typeof value === \"string\";",
    also: [{
      find: "  return typeof value === \"string\" && CORRELATION_IDENTIFIER.test(value);",
      replace: "  return typeof value === \"string\";",
    }, {
      find: "  if (typeof value !== \"string\") return false;\n  const prefix = CAPABILITY_PREFIXES.find((candidate) => value.startsWith(candidate));\n  return Boolean(prefix && CAPABILITY_TAIL.test(value.slice(prefix.length)));",
      replace: "  return typeof value === \"string\";",
    }],
    expect: "schema-shaped free text" },
  { name: "contract v3: display identifiers become arbitrary strings",
    file: "contracts/ledger/v3/ledger-event.schema.json", test: "test/ledger-contract.test.ts",
    find: "      \"pattern\": \"^[A-Za-z0-9@*][A-Za-z0-9@*._:/-]{0,511}$\"",
    replace: "      \"pattern\": \"^.*$\"",
    also: [{
      find: "      \"pattern\": \"^[A-Za-z0-9@*][A-Za-z0-9@*._:/-]{0,127}$\"",
      replace: "      \"pattern\": \"^.*$\"",
    }, {
      find: "      \"pattern\": \"^(tool|skill|agent|workspace|ext):[A-Za-z0-9@*][A-Za-z0-9@*._/-]{0,255}$\"",
      replace: "      \"pattern\": \"^.*$\"",
    }],
    expect: "closed v3 schema accepts" },
  { name: "dashboard: C1 and Unicode format controls reach the terminal",
    file: "src/dashboard-render.ts", test: "test/dashboard-render.test.ts",
    find: '  return (value ?? "").replace(/[\\p{Cc}\\p{Cf}]/gu, " ").replace(/\\s+/g, " ").trim();',
    replace: '  return (value ?? "").replace(/[\\u0000-\\u001f\\u007f]/g, " ").replace(/\\s+/g, " ").trim();',
    expect: "C1 terminal controls" },
  { name: "ledger v3: executor receives a fresh timeout after the recorded deadline starts",
    file: "extensions/execute-child.ts", test: "test/execute-child-lifecycle.test.ts",
    find: "          timeoutMs: Math.max(1, remainingTimeoutMs - terminationGraceMs),\n          hardDeadlineAt: Date.parse(deadlineAt),\n          onOutput: onProgress",
    replace: "          timeoutMs: configuredTimeoutMs,\n          hardDeadlineAt: Date.now() + configuredTimeoutMs,\n          onOutput: onProgress",
    expect: "executor receives only the time remaining" },
  { name: "ledger v3: partial observer status establishes exit",
    file: "test/run-child.test.ts", test: "test/run-child.test.ts",
    find: "const COMPLETE_OBSERVER_STATUS = /^(?:exited:\\d+|timeout|error:[^\\n]+)\\n$/;",
    replace: "const COMPLETE_OBSERVER_STATUS = /^(?:exited:\\d*|timeout|error:[^\\n]+)\\n?$/;",
    expect: "partial observer status cannot establish exit" },
  { name: "ledger v3: readiness-gated test clock is bypassed",
    file: "src/run-child.ts", test: "test/run-child.test.ts",
    find: "  const testControl = currentRunChildTestControl();",
    replace: "  const testControl = undefined;",
    expect: "delayed event loop cannot let the hard deadline" },
  { name: "ledger v3: cross-chunk exit marker loses its prefix",
    file: "test/run-child.test.ts", test: "test/run-child.test.ts",
    find: "      const markerSeen = combinedSignal.includes(\"EXITING\");",
    replace: "      const markerSeen = chunk.includes(\"EXITING\");",
    expect: "delayed event loop cannot let the hard deadline" },
  { name: "ledger v3: onSpawn can rewrite the snapshotted hard deadline",
    file: "src/run-child.ts", test: "test/run-child.test.ts",
    find: "  const hardDeadlineAt = request.hardDeadlineAt;",
    replace: "  let hardDeadlineAt = request.hardDeadlineAt;",
    also: [{
      find: "      if (child.pid !== undefined) request.onSpawn?.(child.pid);",
      replace: "      if (child.pid !== undefined) request.onSpawn?.(child.pid);\n      hardDeadlineAt = request.hardDeadlineAt;",
    }],
    expect: "hard deadline is snapshotted before onSpawn" },
  { name: "ledger v3: hard kill disappears at the recorded deadline",
    file: "src/run-child.ts", test: "test/execute-child-lifecycle.test.ts",
    find: "    if (activeHardDeadlineAt !== undefined) {",
    replace: "    if (false) {",
    expect: "SIGTERM-ignoring child is hard-killed" },
  { name: "ledger v3: a deadline rewrites an already-exited child",
    file: "src/run-child.ts", test: "test/run-child.test.ts",
    find: "        if (done || child.exitCode !== null || child.signalCode !== null) return;",
    replace: "        if (false) return;",
    expect: "hard deadline cannot rewrite" },
  { name: "ledger v3: soft timeout races pending OS exit delivery",
    file: "src/run-child.ts", test: "test/run-child.test.ts",
    find: "      setTimeout(() => controlIfRunning(() => {\n        timedOut = true;\n        stop();\n      }), timeoutMs),",
    replace: "      setTimeout(() => {\n        timedOut = true;\n        stop();\n      }, timeoutMs),",
    expect: "delayed event loop cannot let the soft" },
  { name: "ledger v3: hard deadline races pending OS exit delivery",
    file: "src/run-child.ts", test: "test/run-child.test.ts",
    find: "      timers.push(setTimeout(() => controlIfRunning(() => {\n        timedOut = true;\n        child.kill(\"SIGKILL\");\n      }), Math.max(0, activeHardDeadlineAt - Date.now())));",
    replace: "      timers.push(setTimeout(() => {\n        timedOut = true;\n        child.kill(\"SIGKILL\");\n      }, Math.max(0, activeHardDeadlineAt - Date.now())));",
    expect: "delayed event loop cannot let" },
  { name: "ledger v3: failed lifecycle overtakes a pending running append",
    file: "extensions/execute-child.ts", test: "test/execute-child-lifecycle.test.ts",
    find: "  if (runtimeRecord) await runtimeRecord;",
    replace: "  if (runtimeRecord) void runtimeRecord;",
    expect: "terminal lifecycle append waits" },
  { name: "ledger v3: lifecycle builder accepts Date.parse lookalikes",
    file: "src/ledger-v3-validation.ts", test: "test/runtime-ledger-v3.test.ts",
    find: "export function isTimestamp(value: unknown): value is string {\n  if (typeof value !== \"string\") return false;\n  const match = /^(\\d{4})-(\\d{2})-(\\d{2})[Tt](\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d+)?(?:[Zz]|([+-])(\\d{2}):(\\d{2}))$/.exec(value);\n  if (!match) return false;\n  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;\n  const year = Number(yearText);\n  const month = Number(monthText);\n  const day = Number(dayText);\n  const hour = Number(hourText);\n  const minute = Number(minuteText);\n  const second = Number(secondText);\n  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;\n  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);\n  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];\n  if (day < 1 || day > days[month - 1]) return false;\n  return offsetHourText === undefined || (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59);\n}",
    replace: "export function isTimestamp(value: unknown): value is string {\n  return typeof value === \"string\" && Number.isFinite(Date.parse(value));\n}",
    expect: "contract-valid RFC 3339 deadline" },
  { name: "contract v3: schema accepts a timestamp runtime rejects",
    file: "contracts/ledger/v3/ledger-event.schema.json", test: "test/ledger-contract.test.ts",
    find: "      \"pattern\": \":[0-5][0-9](?:\\\\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})$\"",
    replace: "      \"pattern\": \":[0-6][0-9](?:\\\\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})$\"",
    expect: "schema and runtime share one timestamp profile" },
  { name: "dashboard: a running event replaces the recorded lifecycle deadline",
    file: "src/dashboard-projection.ts", test: "test/dashboard-projection.test.ts",
    find: "      if (recordedDeadline !== undefined && timestamp(event.deadlineAt) && event.deadlineAt !== recordedDeadline) {",
    replace: "      if (false) {",
    expect: "running event cannot replace" },
  { name: "contract v3: null assurance scope disagrees with runtime",
    file: "contracts/ledger/v3/ledger-event.schema.json", test: "test/ledger-contract.test.ts",
    find: "        \"assurance_scope\": {\n          \"oneOf\": [\n            {\n              \"type\": \"object\"\n            },\n            {\n              \"type\": \"array\"\n            },\n            {\n              \"type\": \"string\"\n            },\n            {\n              \"type\": \"number\"\n            },\n            {\n              \"type\": \"boolean\"\n            }\n          ]\n        },",
    replace: "        \"assurance_scope\": {},",
    expect: "closed v3 schema accepts" },
  { name: "contract v3: npm test writes repository fixtures again",
    file: "scripts/generate-ledger-v3-contract.ts", test: "test/ledger-contract.test.ts",
    find: "  await writeLedgerV3ContractFixtures(targets.fixtures);", replace: "  await writeLedgerV3ContractFixtures();",
    expect: "regenerating v3 restores" },
];

const runSuite = (testFile) =>
  new Promise((resolve) => {
    const child = execFile(
      // **The reporter is PINNED, and that is the same lesson as `FORCE_COLOR` one layer over (R-143).**
      // `node --test` defaulted to the TAP reporter before Node 23 and to `spec` from 23 on, and this parser
      // reads `spec` — so on the `engines` floor (22.19.0) every entry came back *"the auditor could not read
      // the output"*, `0/27`, in CI's first real run of this catalogue. Depending on a runtime's default
      // output format is depending on ambient state, which is exactly what the colour pin exists to refuse.
      process.execPath, ["--test", "--test-reporter=spec", testFile],
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
const COLLATERAL = ["contracts/ledger/v2", "contracts/ledger/v3"];
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
      // Say which of the two ways it broke. Printing "(hang, as recorded)" whenever the run was killed
      // asserted a catalogue field that entry may not have — a claim written beside a fix, in the commit that
      // relaxed this verdict, which is the shape this repository keeps recording.
      console.log(`✓ ${m.name}${
        killed ? (m.hang ? "  (hang, as recorded)" : "  (named failure, then the runner wedged — costs the full timeout)") : ""
      }`);
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
