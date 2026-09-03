/**
 * Integration — the herdr assumptions this package is built on, checked against a REAL herdr server.
 *
 * **Why this suite exists, in one sentence: `test/run-herdr.test.ts`'s fake is a CLAIM about herdr, and until
 * now nothing checked the claim.** Three shipping defects hid in exactly that gap on 2026-08-17, all with 442
 * unit tests green and 32 integration tests green:
 *
 *  1. `herdr agent stop` **does not exist** — it prints the usage banner and exits 0, which reads as success.
 *     `docs/probes/g16-herdr` asserted it worked, from a *How to rerun* block that was never run. Three call
 *     sites were built on it, and ADR-0032 built a governance claim on top: that a pane could outlive its call
 *     while the child was stopped.
 *  2. herdr **binds an agent name to its tab** and frees it only on close, so a second spawn reusing a name is
 *     refused — which broke the second `delegate` of every turn once panes outlived their calls.
 *  3. herdr **validates agent names** (`[a-z][a-z0-9_-]{0,31}`), and this package's names contain the dots of a
 *     hierarchical ledger child id — so `agent start review-d0.1` had ALWAYS been rejected. The herdr executor
 *     had never once started an `agent:` spawn.
 *
 * The unit fake could not see any of them: it accepts whatever name it is handed and answers `agent stop`
 * cheerfully. **So every fact the fake encodes belongs here too**, and a test below should be readable as "the
 * fake says X; does herdr?"
 *
 * **Costs no model tokens.** Nothing here calls `agent prompt`, which is the only step that needs a model. That
 * is deliberate: all three defects above sit at or before `agent start`, so the cheap half of the flow is the
 * valuable half. What this does NOT cover is therefore stated plainly at the bottom.
 *
 * **Runs in its own workspace and leaves yours alone.** `herdr workspace create` / `workspace close` isolate
 * every tab this suite makes, so an operator's live layout is never touched — and a leak is detectable, because
 * the workspace either closed or it did not.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { defaultExec, parseReply, probeHerdr } from "../src/herdr-cli.ts";
import { uniqueAgentName } from "../src/herdr-name.ts";

/** Interactive pi that holds no tools and needs no model: enough to become a detectable agent. */
const INERT_PI_ARGV = [
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-context-files",
  "--no-prompt-templates",
  "--no-tools",
];

/**
 * Probed and set up at MODULE level, not in `before()`.
 *
 * `node:test` evaluates a test's `{ skip }` option when the test is *defined*, which happens while the `describe`
 * body runs — before any `before()` hook. A `before` here left `reachable` false at definition time, so all twelve
 * tests skipped and the suite reported `pass 0` while looking healthy. Top-level `await` in ESM runs first, so the
 * skip reason is known by the time it is needed.
 */
const reachable = (await probeHerdr()).ok;
const workspace: string | undefined = reachable
  ? ((parseReply(await defaultExec(["workspace", "create", "--label", "pi-daddy-it", "--no-focus"])).result?.workspace ?? {}) as {
      workspace_id?: string;
    }).workspace_id
  : undefined;

after(async () => {
  // Closing the workspace closes every tab in it, so no per-tab bookkeeping is needed. Cleanup is part of the
  // shared-daemon isolation contract: a failed close must fail this suite rather than leak retained agent names
  // that poison another repository's run.
  if (workspace) {
    const closed = parseReply(await defaultExec(["workspace", "close", workspace]));
    assert.equal(closed.error, undefined, `workspace cleanup failed: ${closed.error}`);
  }
});

/** A pane in this suite's own workspace. */
async function pane(): Promise<string> {
  const reply = parseReply(await defaultExec(["tab", "create", "--label", "it", "--workspace", workspace!, "--cwd", process.cwd()]));
  assert.ok(!reply.error, `tab create failed: ${reply.error}`);
  const root = (reply.result?.root_pane ?? {}) as { pane_id?: string };
  assert.ok(root.pane_id, "tab create returned no pane id");
  return root.pane_id;
}

/**
 * `agent start`, retrying only the documented busy condition.
 *
 * A freshly created pane is not yet at a shell prompt (`agent_pane_busy`), which `src/run-herdr.ts` retries for
 * the same reason. Retrying here keeps a real-timing flake from being read as a herdr contract change.
 */
async function startAgent(name: string, paneId: string): Promise<{ ok: boolean; error?: string }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const reply = parseReply(await defaultExec(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--", ...INERT_PI_ARGV]));
    if (!reply.error) return { ok: true };
    if (!/not an available shell|agent_pane_busy/.test(reply.error)) return { ok: false, error: reply.error };
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, error: "pane never reached a shell prompt" };
}

describe("herdr assumptions, against a real server", () => {
  const skipIf = () =>
    !reachable ? "no herdr server is answering" : !workspace ? "could not create an isolated herdr workspace" : false;

  test("`agent stop` is not a herdr command, so nothing may rely on it", { skip: skipIf() }, async () => {
    // Blocker 1, pinned. It exits 0 with the usage banner — the shape that made `defaultExec` report success —
    // so this asserts on the OUTPUT, not the exit code. The production change that breaks this test is herdr
    // gaining the command, at which point ADR-0032's original design becomes available again and should be
    // reconsidered rather than the test deleted.
    const reply = await defaultExec(["agent", "stop", "whatever"]);
    assert.match(reply.stdout + reply.stderr, /herdr agent commands/, "if this stops being a usage banner, herdr changed");
    assert.doesNotMatch(reply.stdout, /"result"/, "and it must not be answering as a real command");
  });

  test("the `agent` command list still lacks `stop` and still has what we do use", { skip: skipIf() }, async () => {
    const reply = await defaultExec(["agent"]);
    const help = reply.stdout + reply.stderr;
    for (const used of ["agent get", "agent read", "agent prompt", "agent start"]) {
      assert.ok(help.includes(used), `${used} is used by src/run-herdr.ts and must exist`);
    }
    assert.ok(!/herdr agent stop\b/.test(help), "a `stop` here would mean the kill story can be revisited");
  });

  test("an agent name built from a real ledger child id is ACCEPTED", { skip: skipIf() }, async () => {
    // Blocker 3, pinned end to end. `review-d0.1` — the real shape — was rejected as `invalid_agent_name`
    // because of the dots. This asserts the sanitised name herdr actually takes.
    const name = uniqueAgentName("review-d0.1");
    const started = await startAgent(name, await pane());
    assert.ok(started.ok, `herdr refused ${name}: ${started.error}`);
  });

  test("two spawns from ONE base name both start", { skip: skipIf() }, async () => {
    // Blocker 2, pinned. herdr frees a name only when its tab closes, and both tabs are still open here — which
    // is exactly the state ADR-0032 created and the second `delegate` of every turn used to die in. The real
    // daemon is shared with unrelated repositories, so namespace this test's base by its live process rather
    // than colliding with another suite's retained `review-d0.1` pane.
    const base = `it${process.pid}-review-d0.1`;
    const first = uniqueAgentName(base);
    const second = uniqueAgentName(base);
    assert.notEqual(first, second);

    const a = await startAgent(first, await pane());
    assert.ok(a.ok, `first spawn failed: ${a.error}`);
    const b = await startAgent(second, await pane());
    assert.ok(b.ok, `second spawn failed while the first pane is still open: ${b.error}`);
  });

  test("reusing a live name IS refused, which is why uniqueness is required", { skip: skipIf() }, async () => {
    // The other half: proves the uniqueness is load-bearing rather than defensive. If herdr ever stops binding
    // names to tabs this fails, and `uniqueAgentName` can be simplified.
    const name = uniqueAgentName("collide-d0.1");
    assert.ok((await startAgent(name, await pane())).ok);

    const again = parseReply(await defaultExec(["agent", "start", name, "--kind", "pi", "--pane", await pane(), "--", ...INERT_PI_ARGV]));
    assert.ok(again.error, "herdr accepted a duplicate name — uniqueAgentName may no longer be needed");
    assert.match(again.error, /already used|name_taken/i);
  });

  test("`tab create` returns the reply shape run-herdr.ts parses", { skip: skipIf() }, async () => {
    // The fake hands back `{result:{root_pane:{pane_id,tab_id}}}`. If herdr renames either field, every spawn
    // fails with "returned no pane id" and this says why.
    const reply = parseReply(await defaultExec(["tab", "create", "--label", "it", "--workspace", workspace!, "--cwd", process.cwd()]));
    const root = (reply.result?.root_pane ?? {}) as { pane_id?: string; tab_id?: string };
    assert.ok(root.pane_id, "root_pane.pane_id is what the executor reads");
    assert.ok(root.tab_id, "root_pane.tab_id is what the reaper closes");
  });

  test("`--env` on the PANE reaches the agent's shell — how the grant propagates", { skip: skipIf() }, async () => {
    // The measured fact the whole herdr path rests on: `agent start` has no `--env`, so the grant rides on the
    // tab. If this breaks, children run UNGOVERNED with a full default tool surface, which is the worst
    // available failure and would otherwise be silent.
    const reply = parseReply(
      await defaultExec([
        "tab", "create", "--label", "env", "--workspace", workspace!, "--cwd", process.cwd(),
        "--env", "PI_GRANTS_GRANT=tool:read",
        "--env", "PI_GRANTS_DEPTH=1",
      ]),
    );
    const root = (reply.result?.root_pane ?? {}) as { pane_id?: string };
    assert.ok(root.pane_id);

    // Ask the pane's own shell to print it, then read the pane back.
    await defaultExec(["pane", "send-text", root.pane_id!, "echo GRANT=$PI_GRANTS_GRANT DEPTH=$PI_GRANTS_DEPTH\n"]);
    let seen = "";
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await new Promise((r) => setTimeout(r, 300));
      // `pane read`, not `agent read`: herdr's own help says an agent target must "currently host agents", and
      // this pane deliberately has none — the point is the SHELL's environment, before any child starts.
      seen = (await defaultExec(["pane", "read", root.pane_id!])).stdout;
      if (seen.includes("GRANT=tool:read")) break;
    }
    assert.match(seen, /GRANT=tool:read/, "the grant must reach the shell that launches the child");
    assert.match(seen, /DEPTH=1/);
  });

  test("`agent read` returns RAW terminal text, not a JSON envelope", { skip: skipIf() }, async () => {
    // Needs a real agent in the pane, because `agent read` only accepts a target that currently hosts one. The
    // agent is inert pi with no tools, so this still costs nothing.
    // Measured once, the hard way: running this through `parseReply` reported every successful read as
    // "unparseable herdr reply", i.e. a child's real answer as a failure to read it. `readPane` tries JSON first
    // and falls back to raw for exactly this reason, and that order only makes sense if this holds.
    const paneId = await pane();
    const name = uniqueAgentName("read-d0.1");
    assert.ok((await startAgent(name, paneId)).ok, "an agent must exist for `agent read` to accept the target");

    let seen = "";
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await new Promise((r) => setTimeout(r, 300));
      seen = (await defaultExec(["agent", "read", name])).stdout;
      if (seen.trim().length > 0) break;
    }
    assert.ok(seen.trim().length > 0, "a started agent's pane must read back as something");
    // The load-bearing half: it is NOT herdr's `{id,result}` envelope. Running this through `parseReply` once
    // reported every successful read as "unparseable herdr reply" — a child's real answer as a failure to read it.
    assert.doesNotMatch(seen.trimStart().slice(0, 1), /\{/, "a JSON envelope here would make readPane's fallback wrong");
  });

  test("a child's pane lands in the workspace we ask for", { skip: skipIf() }, async () => {
    // ADR-0032's usability claim: a child is a tab away, not a workspace away. `resolveWorkspace` inherits the
    // parent's `HERDR_WORKSPACE_ID`; here we assert the mechanism it depends on.
    const reply = parseReply(await defaultExec(["tab", "create", "--label", "ws", "--workspace", workspace!, "--cwd", process.cwd()]));
    const root = (reply.result?.root_pane ?? {}) as { tab_id?: string; workspace_id?: string };
    assert.equal(root.workspace_id, workspace, "`--workspace` must be honoured, or children scatter");
    assert.ok(root.tab_id?.startsWith(`${workspace}:`), "and the tab id must carry it");
  });

  test("herdr really does set HERDR_WORKSPACE_ID in a pane it creates", { skip: skipIf() }, async () => {
    // **Replaces a test that talked to no server.** The old one called `resolveWorkspace` with a hand-made object,
    // duplicating five assertions already in `test/herdr-cli.test.ts` — and was skipped on exactly the machines that
    // lack herdr, so it added nothing anywhere. Its comment claimed to assert "the REAL variable name herdr sets",
    // which it did not.
    //
    // This asserts the fact `resolveWorkspace` actually depends on, and which no unit test can know: that herdr
    // exports `HERDR_WORKSPACE_ID` into a pane, matching the workspace it was created in.
    const created = parseReply(await defaultExec(["tab", "create", "--label", "wsvar", "--workspace", workspace!, "--cwd", process.cwd()]));
    const root = (created.result?.root_pane ?? {}) as { pane_id?: string };
    assert.ok(root.pane_id);

    await defaultExec(["pane", "send-text", root.pane_id!, "echo WS=$HERDR_WORKSPACE_ID\n"]);
    let seen = "";
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await new Promise((r) => setTimeout(r, 300));
      seen = (await defaultExec(["pane", "read", root.pane_id!])).stdout;
      // Wait for the VALUE, not merely a non-space character. `$HERDR_WORKSPACE_ID` in the echoed command also
      // matches `/WS=\S/`, so that predicate broke on the command line before the shell produced output — a
      // deterministic false failure on a pane whose shell took longer than the first 300ms poll.
      if (seen.includes(`WS=${workspace}`)) break;
    }
    assert.match(seen, new RegExp(`WS=${workspace}`), "resolveWorkspace inherits this variable; it must exist");
  });

  test("`tab close` is the kill: after it, herdr no longer knows the agent", { skip: skipIf() }, async () => {
    // The replacement for the phantom `agent stop`. ADR-0032 now depends on this being a real kill for any child
    // that did not settle, so it is asserted rather than assumed.
    const created = parseReply(await defaultExec(["tab", "create", "--label", "kill", "--workspace", workspace!, "--cwd", process.cwd()]));
    const root = (created.result?.root_pane ?? {}) as { pane_id?: string; tab_id?: string };
    const name = uniqueAgentName("kill-d0.1");
    assert.ok((await startAgent(name, root.pane_id!)).ok);
    assert.ok(!parseReply(await defaultExec(["agent", "get", name])).error, "the agent should exist first");

    const closed = parseReply(await defaultExec(["tab", "close", root.tab_id!]));
    assert.ok(!closed.error, `tab close failed: ${closed.error}`);

    const after = parseReply(await defaultExec(["agent", "get", name]));
    assert.ok(after.error, "closing the tab must end the agent — that is the only kill we have");
  });

  test("probeHerdr agrees with the server it just talked to", { skip: skipIf() }, async () => {
    // ADR-0031's selection input. Trivial when herdr is up, and the point is that it is checked against the real
    // reply shape rather than a fixture.
    assert.equal((await probeHerdr()).ok, true);
  });
});

/**
 * ## What this suite does NOT establish
 *
 * - **No child ever answers.** Nothing calls `agent prompt`, so no model runs and no `pi` child produces output.
 *   The settle-detection rules (R-33's `state_change_seq` advance), the snapshot polling, `readPane`'s truncation
 *   and the whole result path are covered only by `test/run-herdr.test.ts`'s fake. A real end-to-end pane spawn
 *   with a model remains the largest untested gap, and it costs tokens.
 * - **Nothing here exercises `runHerdrPane` itself.** These are the substrate's contracts, deliberately: the
 *   executor's own logic is unit-tested, and mixing the two would make a herdr outage look like a logic bug.
 * - **The `--tools` enforcement inside a pane is not re-verified here** (`docs/probes/g16-herdr` measured it).
 *   That is a pi property, not a herdr one, and `governance.it.ts` covers it against a real pi.
 * - **Timing is real.** `agent start` is retried for the documented busy condition only; a machine under heavy
 *   load could still exhaust the retries, which would show as a failure rather than a flake with a clear message.
 */
