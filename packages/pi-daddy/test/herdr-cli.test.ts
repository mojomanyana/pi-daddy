/**
 * The herdr CLI protocol, the probe ADR-0031 selects the executor with, and where a child's pane goes.
 *
 * **The production change that breaks the probe tests:** making `probeHerdr` report `ok` on anything other
 * than a parsed `result` envelope. That is the whole of why ADR-0031 rejects option C — a binary on `PATH`
 * proves nothing, only a server that *answers* does, and a `which herdr` probe would turn every delegation on
 * a machine with a stopped herdr from working into failing.
 *
 * **The production change that breaks the workspace tests:** reading only `PI_GRANTS_HERDR_WORKSPACE` again.
 * herdr sets `HERDR_WORKSPACE_ID` in every pane it creates (measured 2026-08-17, documented nowhere), and
 * without inheriting it a child lands in a different workspace from the pi session that spawned it — which
 * turns "switch between them" into a workspace hop, i.e. defeats the feature.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PROBE_TIMEOUT_MS, parseReply, probeHerdr, resolveWorkspace, type HerdrExec } from "../src/herdr-cli.ts";

test("the probe asks `tab list`, because it is the cheapest command that proves a server answered", async () => {
  const calls: string[][] = [];
  const exec: HerdrExec = async (args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ id: "x", result: { type: "tab_list", tabs: [] } }), stderr: "" };
  };
  const probe = await probeHerdr({ exec });
  assert.equal(probe.ok, true);
  assert.deepEqual(calls, [["tab", "list"]]);
});

test("an empty tab list is still a reachable server", async () => {
  // A fresh herdr with nothing open must not read as "herdr is down". Zero tabs is an ANSWER.
  const exec: HerdrExec = async () => ({ code: 0, stdout: JSON.stringify({ id: "x", result: { tabs: [] } }), stderr: "" });
  assert.equal((await probeHerdr({ exec })).ok, true);
});

test("a missing binary is not reachable, and the reason survives", async () => {
  const exec: HerdrExec = async () => ({ code: 1, stdout: "", stderr: "herdr: command not found" });
  const probe = await probeHerdr({ exec });
  assert.equal(probe.ok, false);
  assert.match(probe.error ?? "", /command not found/);
});

test("a binary that answers with an error envelope is not reachable", async () => {
  // The case option C could not distinguish: herdr installed, server down.
  const exec: HerdrExec = async () => ({
    code: 1,
    stdout: JSON.stringify({ id: "x", error: { code: "no_server", message: "could not connect to herdr" } }),
    stderr: "",
  });
  const probe = await probeHerdr({ exec });
  assert.equal(probe.ok, false);
  assert.match(probe.error ?? "", /could not connect/);
});

test("a probe that never returns is bounded, and a timeout is not reachable", async () => {
  const exec: HerdrExec = () => new Promise(() => {});
  const probe = await probeHerdr({ exec, timeoutMs: 20 });
  assert.equal(probe.ok, false);
  assert.match(probe.error ?? "", /timed out/);
});

test("an exec that rejects is not reachable rather than an unhandled rejection", async () => {
  // `defaultExec` never rejects, but nothing enforces that of an injected one, and a probe that throws out
  // of session_start would cancel every control after it (R-60's shape).
  const exec: HerdrExec = async () => {
    throw new Error("spawn EACCES");
  };
  const probe = await probeHerdr({ exec });
  assert.equal(probe.ok, false);
  assert.match(probe.error ?? "", /EACCES/);
});

test("the default probe timeout is short enough to sit on session start", () => {
  assert.ok(PROBE_TIMEOUT_MS <= 2000, "a session-start probe must not be a visible pause");
});

test("parseReply folds stderr into the message, so a wrapper never hides the substrate's reason", () => {
  const parsed = parseReply({ stdout: "", stderr: "socket missing" });
  assert.match(parsed.error ?? "", /socket missing/);
});

test("children default to the PARENT's workspace, so switching to one is a tab keystroke", () => {
  assert.equal(resolveWorkspace({ HERDR_WORKSPACE_ID: "w7" }), "w7");
});

test("PI_GRANTS_HERDR_WORKSPACE overrides the parent's workspace, because it is the explicit answer", () => {
  assert.equal(resolveWorkspace({ HERDR_WORKSPACE_ID: "w7", PI_GRANTS_HERDR_WORKSPACE: "wB" }), "wB");
});

test("outside a herdr pane there is no workspace to inherit, and herdr chooses", () => {
  assert.equal(resolveWorkspace({}), undefined);
});

test("a blank or whitespace workspace is treated as absent rather than passed through", () => {
  // `--workspace ""` is not a workspace; passing it would fail `tab create` on a path nobody chose.
  assert.equal(resolveWorkspace({ HERDR_WORKSPACE_ID: "   " }), undefined);
  assert.equal(resolveWorkspace({ PI_GRANTS_HERDR_WORKSPACE: "", HERDR_WORKSPACE_ID: "w7" }), "w7");
});
