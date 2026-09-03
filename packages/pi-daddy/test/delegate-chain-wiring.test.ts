/**
 * Wiring tests for `delegate_chain` — the PURE half (ADR-0033).
 *
 * Every test here refuses or aborts before a child is spawned, so this file stays fast, deterministic, and free of
 * network, model and credentials. The tests that let a step actually run live in
 * `test-integration/delegate-chain.it.ts`, because a real `pi` child always calls a model.
 *
 * **`PI_GRANTS_HERDR=0` throughout** — an unset variable means *probe*, and `session_start` probes, so leaving it
 * would shell out to whatever herdr happens to be running on the machine under test.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { ENV_HERDR } from "../src/executor.ts";
import { MAX_CHAIN_STEPS } from "../src/fanout.ts";
import { ENV_FANOUT, ENV_GATED, ENV_GRANT, ENV_LEDGER } from "../src/propagation.ts";
import { parseDashboardLedger } from "../src/dashboard-projection.ts";
import { definition, harness, restoreEnv } from "./chain-harness.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
afterEach(restoreEnv);

test("delegate_chain is registered beside the other two, and only when the session may delegate", async () => {
  const { tools } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate" });
  for (const name of ["delegate", "delegate_all", "delegate_chain"]) {
    assert.ok(tools.has(name), `${name} must be registered`);
  }

  const leaf = await harness({ [ENV_GRANT]: "tool:read" });
  assert.ok(!leaf.tools.has("delegate_chain"), "S-5: withholding tool:delegate must make a session a leaf");
});

test("the three tool descriptions do not contradict each other about shape", async () => {
  // The tripwire fix on this branch showed a model does exactly what the text says: it answered a request for
  // parallel work with a single sequential call because the message named only `delegate`. A description that
  // disagrees with the enforcer is R-28.
  const { tools } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate" });
  const chain = (tools.get("delegate_chain") as unknown as { description: string }).description;
  const all = (tools.get("delegate_all") as unknown as { description: string }).description;

  assert.match(chain, /ONE AFTER ANOTHER/, "the chain must claim sequence");
  assert.match(chain, /delegate_all/, "and must point at the concurrent tool for independent work");
  assert.match(all, /CONCURRENTLY/, "the fan-out must claim concurrency");
  assert.doesNotMatch(all, /ONE AFTER ANOTHER/);
});


test("ADR-0033: a chain refused at the gate spawns NOTHING", async () => {
  // Fail closed as a unit. Running only the ungated steps would return a partial result that reads like a complete
  // one — the failure indistinguishable from success.
  const dir = await tempDir("grants-chain-");
  await definition(dir, "digger", "Read, Bash");
  await definition(dir, "reader", "Read");
  const ledger = join(dir, "ledger.jsonl");

  const { tools, ctx } = await harness(
    { [ENV_GRANT]: "agent:digger,agent:reader,tool:read,tool:bash,tool:delegate", [ENV_LEDGER]: ledger, [ENV_FANOUT]: "12" },
    dir,
  );

  await assert.rejects(
    () =>
      tools
        .get("delegate_chain")!
        .execute("c", { steps: [{ task: "read this", agent: "reader" }, { task: "dig {previous}", agent: "digger" }] }, undefined, undefined, ctx),
    (error: Error) => {
      assert.match(error.message, /chain refused/);
      assert.match(error.message, /no \n?step ran|no step ran/, "it must say nothing ran");
      return true;
    },
  );

  // The `reader` step was ungated and would have succeeded on its own. Nothing may have been recorded as spawned.
  const lines = (await readFile(ledger, "utf8").catch(() => "")).trim();
  const spawned = lines ? lines.split("\n").map((l) => JSON.parse(l)).filter((r) => r.blocked === false) : [];
  assert.deepEqual(spawned, [], "a chain declined at the gate must not have provisioned any child");
});

test("ADR-0033: a chain longer than the budget is refused BEFORE any dialog", async () => {
  // Cardinality is checked first: a chain on its way to being refused must not interrupt the operator. The
  // production change that breaks this: moving the budget check after the gate.
  const dir = await tempDir("grants-chain-");
  await definition(dir, "digger", "Read, Bash");
  const { tools, ctx, selects } = await harness(
    { [ENV_GRANT]: "agent:digger,tool:read,tool:bash,tool:delegate", [ENV_FANOUT]: "2" },
    dir,
  );

  await assert.rejects(
    () =>
      tools
        .get("delegate_chain")!
        .execute("c", { steps: Array.from({ length: 5 }, () => ({ task: "dig", agent: "digger" })) }, undefined, undefined, ctx),
    /chain refused[\s\S]*budget exhausted/,
  );
  assert.equal(selects.length, 0, "no human may be asked about a chain that cannot run");
});

test("an unresolved chain model is ledgered before any approval dialog", async () => {
  const dir = await tempDir("grants-chain-model-");
  await definition(dir, "digger", "Read, Bash");
  const ledger = join(dir, "ledger.jsonl");
  const { tools, ctx, selects } = await harness(
    { [ENV_GRANT]: "agent:digger,tool:read,tool:bash,tool:delegate", [ENV_GATED]: "tool:bash", [ENV_LEDGER]: ledger },
    dir,
    "allow-session",
  );

  await assert.rejects(
    () => tools.get("delegate_chain")!.execute(
      "c", { steps: [{ task: "dig", agent: "digger", model: "missing/model" }] }, undefined, undefined, ctx,
    ),
    (error: Error & { code?: string }) => error.code === "MODEL_UNRESOLVED",
  );
  assert.equal(selects.length, 0, "an unresolved step must not open or bank an approval");
  const events = (await readFile(ledger, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1)?.refusal?.code, "MODEL_UNRESOLVED");
  assert.equal(events.at(-1)?.blocked, true);
});

test("ADR-0033: the step cap is the schema's own maxItems, so the model never proposes an illegal chain", async () => {
  const { tools } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate" });
  const schema = tools.get("delegate_chain")!.parameters as { properties?: { steps?: { maxItems?: number } } };
  assert.equal(schema.properties?.steps?.maxItems, MAX_CHAIN_STEPS);
});

test("ADR-0033: the step template tells the model about the placeholder", async () => {
  // Without it a model writes a task that ignores its predecessor entirely, and the chain silently degrades into
  // N unrelated delegations.
  const { tools } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate" });
  const schema = tools.get("delegate_chain")!.parameters as {
    properties?: { steps?: { items?: { properties?: { task?: { description?: string } } } } };
  };
  const described = schema.properties?.steps?.items?.properties?.task?.description ?? "";
  assert.match(described, /\{previous\}/);
  assert.match(described, /appended/, "and it must say what happens if the placeholder is omitted");
});




test("ADR-0033: a step that can NEVER run refuses the chain before anyone is asked", async () => {
  // **Rewritten: this used to assert the chain got as far as running step 1 and failing.** It now refuses during
  // planning, which is stronger — a step refused for something no approval can lift (here `tool:write`, which the
  // session does not hold) must not reach the gate at all, or its dialog banks authority for a spawn that can never
  // happen. That was a measured privilege path: a model appending one unheld capability got `tool:bash` pre-approved
  // for the whole session.
  //
  // The production change that breaks this: dropping the `shouldSeekApproval` check in `planChain`.
  //
  // The step asks for an unheld `agent:` id alongside a gated `tool:bash`. `agent:ghost` cannot be granted and no
  // approval can lift it, so `denied` is non-empty and the whole step is doomed. (An earlier version of this fixture
  // used `tool:write`, which the session did NOT hold — and it was grantable anyway, because `tool:bash` subsumes
  // write. A capability that looks unheld is not necessarily denied.)
  const ledger = join(await tempDir("chain-doomed-ledger-"), "ledger.jsonl");
  const { tools, ctx, selects } = await harness({
    [ENV_GRANT]: "tool:read,tool:bash,tool:delegate", [ENV_GATED]: "tool:bash",
    [ENV_FANOUT]: "12", [ENV_LEDGER]: ledger,
  });
  await assert.rejects(
    () =>
      tools
        .get("delegate_chain")!
        .execute(
          "c",
          { steps: [{ task: "nope", tools: ["bash", "agent:ghost"] }, { task: "never {previous}", tools: ["read"] }] },
          undefined,
          undefined,
          ctx,
        ),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "UNKNOWN_TOOL");
      assert.match(error.message, /chain refused at step 1/);
      assert.match(error.message, /nobody was \n?asked|nobody was asked/, "and it must say nobody was asked");
      return true;
    },
  );
  assert.equal(selects.length, 0, "a doomed step must not raise a dialog — `tool:bash` was gated and never asked about");
  const record = JSON.parse((await readFile(ledger, "utf8")).trim());
  assert.equal(record.refusal.code, "UNKNOWN_TOOL");
  assert.match(record.taskDigest, /^[a-f0-9]{64}$/);
  assert.ok(record.requested.includes("agent:ghost"));
});



test("ADR-0033: every gate is raised UPFRONT, one per capability@subject", async () => {
  // **The corrected guarantee.** ADR-0033 promised one dialog for the whole chain; that is not implementable,
  // because an approval is keyed `capability@subject` and one dialog means one subject — asking once for a union
  // spanning several definitions is asking about one and spending the answer on the rest. What IS achievable, and
  // was the actual point, is that every dialog is raised before any step runs: two together at the start rather
  // than two arriving minutes apart mid-pipeline.
  //
  // `digger` and `shaper` both gate `tool:bash`; `reader` gates nothing. So: two subjects, two dialogs.
  //
  // The production change that breaks this: gating inside the run loop, or collapsing the groups back into one
  // union.
  const dir = await tempDir("grants-chain-");
  await definition(dir, "digger", "Read, Bash");
  await definition(dir, "shaper", "Read, Bash");
  await definition(dir, "reader", "Read");

  const { tools, ctx, selects } = await harness(
    { [ENV_GRANT]: "agent:digger,agent:shaper,agent:reader,tool:read,tool:bash,tool:delegate", [ENV_FANOUT]: "12" },
    dir,
    // `allow-then-decline`, so two dialogs are raised and the chain then refuses — which keeps this test PURE. An
    // approving fixture would let step 1 run, and a real `pi` child always calls a model: that is how the unit suite
    // silently became a 2-minute network-bound run once already.
    "allow-then-decline",
  );

  await tools
    .get("delegate_chain")!
    .execute(
      "c",
      { steps: [{ task: "dig", agent: "digger" }, { task: "shape {previous}", agent: "shaper" }, { task: "read {previous}", agent: "reader" }] },
      undefined,
      undefined,
      ctx,
    )
    .catch(() => undefined);

  // Not a plain decline: the gate loop now STOPS at the first refusal, because every dialog after the outcome is
  // fixed banks authority for a chain that will not run. So a declining fixture would see one dialog and prove
  // nothing about the second subject — approve the first, refuse the second.
  assert.equal(selects.length, 2, `expected one dialog per gated subject, got ${selects.length}: ${JSON.stringify(selects)}`);
  assert.ok(selects.some((t) => t.includes("digger")), "digger must be named to the operator");
  assert.ok(selects.some((t) => t.includes("shaper")), "and so must shaper — that is the whole point");
});

test("ADR-0033: the dialog NAMES the step's task, as a single delegate does", async () => {
  // It passed `undefined` where `delegate` passes `request.task`, so the operator was asked to approve `bash` for a
  // definition with no indication of what it was about to do.
  const dir = await tempDir("grants-chain-");
  await definition(dir, "digger", "Read, Bash");
  const { tools, ctx, selects } = await harness(
    { [ENV_GRANT]: "agent:digger,tool:read,tool:bash,tool:delegate", [ENV_FANOUT]: "12" },
    dir,
  );

  await tools
    .get("delegate_chain")!
    .execute("c", { steps: [{ task: "excavate the north field", agent: "digger" }] }, undefined, undefined, ctx)
    .catch(() => undefined);

  assert.ok(selects.length >= 1);
  assert.match(selects[0], /excavate the north field/, "the operator must see what the step will do");
});


test("ADR-0033: A-S6 holds across a chain — one definition's yes cannot satisfy another", async () => {
  // **The critical defect, pinned.** Three reviewers found that the chain's single-subject union let a yes given for
  // `digger` authorise `shaper`, and that a 30-day entry keyed to `digger` satisfied `shaper` in every later session
  // with no dialog at all. ADR-0014's A-S6 says an approval for one agent type cannot satisfy another.
  //
  // Here the operator is asked twice; the fake declines both, so the chain refuses. What this pins is that `shaper`
  // is asked about AT ALL — under the old union it never was.
  //
  // The production change that breaks this: collapsing the per-capability gate requests back into one union.
  //
  // It previously also named "removing the `a.subject === subject` filter in `planDelegation`" — **and that does not
  // break this test**, because this fixture refuses at the gate and never reaches the planner's approval matching.
  // Naming a change that does not bite is the rule-7 failure this file spends most of its comments on, so: the filter
  // is pinned by `test/propagation.test.ts`'s A-S6 case, and by nothing else in 498 tests (R-83).
  const dir = await tempDir("grants-chain-");
  await definition(dir, "digger", "Read, Bash");
  await definition(dir, "shaper", "Read, Bash");
  // Approve the FIRST dialog and decline the second: that is the only arrangement in which both subjects are asked
  // AND the chain still refuses, now that the loop stops at the first no.
  const { tools, ctx, selects } = await harness(
    { [ENV_GRANT]: "agent:digger,agent:shaper,tool:read,tool:bash,tool:delegate", [ENV_FANOUT]: "12" },
    dir,
    "allow-then-decline",
  );

  await assert.rejects(
    () =>
      tools
        .get("delegate_chain")!
        .execute("c", { steps: [{ task: "dig", agent: "digger" }, { task: "shape {previous}", agent: "shaper" }] }, undefined, undefined, ctx),
    /chain refused/,
  );

  const asked = selects.join(" | ");
  assert.match(asked, /digger/);
  assert.match(asked, /shaper/, "shaper must be named to a human, not covered by digger's answer");
});

test("ADR-0033: a `tools:`-only step is never offered a 30-day project-wide approval", async () => {
  // **A privilege path, and the ugliest finding of the review.** The gate hardcoded `path: "definition"`, which
  // offers *Always allow in this project (30 days)*. So a step's MODEL-CHOSEN `tools:` list could obtain a
  // persisted approval keyed to a definition — something a plain `delegate({tools:[...]})` is denied, because
  // ADR-0019's reasoning is that "a key the model controls is not a key".
  //
  // The production change that breaks this: hardcoding the path again instead of deriving it from the subject.
  const { tools, ctx, selects, offered } = await harness(
    { [ENV_GRANT]: "tool:read,tool:bash,tool:delegate", [ENV_FANOUT]: "12" },
    undefined,
  );

  await tools
    .get("delegate_chain")!
    .execute("c", { steps: [{ task: "poke about", tools: ["read", "bash"] }] }, undefined, undefined, ctx)
    .catch(() => undefined);

  assert.equal(selects.length, 1, "sanity: the gate must have been reached");
  assert.ok(offered.length > 0, "the fake must have recorded the options it was shown");
  assert.ok(
    !offered.flat().some((o) => /30 days/.test(o)),
    `a <delegate> subject must not be offered a persisted scope; got ${JSON.stringify(offered.flat())}`,
  );
});



test("ADR-0033: a demanded-but-unreachable herdr refuses the chain BEFORE any dialog", async () => {
  // **Shipped with no test, so re-breaking it cost nothing.** The executor check was hoisted above the gate for the
  // reason recorded on the `delegate` path a day earlier — with `PI_GRANTS_HERDR=1` and herdr down, an operator was
  // asked to approve `bash` for a child that could never exist, and the yes was banked for 30 days. A reviewer moved
  // the check back below `planChain` and all 496 tests stayed green.
  //
  // PATH is emptied so the real probe genuinely fails.
  const dir = await tempDir("grants-chain-");
  await definition(dir, "digger", "Read, Bash");
  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const { tools, ctx, selects } = await harness(
      { [ENV_GRANT]: "agent:digger,tool:read,tool:bash,tool:delegate", [ENV_HERDR]: "1", [ENV_FANOUT]: "12" },
      dir,
    );
    await assert.rejects(
      () => tools.get("delegate_chain")!.execute("c", { steps: [{ task: "dig", agent: "digger" }] }, undefined, undefined, ctx),
      /PI_GRANTS_HERDR/,
    );
    assert.equal(selects.length, 0, "nobody may be asked to approve a capability for a child that cannot be started");
  } finally {
    process.env.PATH = realPath;
  }
});

test("ADR-0033: a gate-refused chain WRITES a ledger line naming the refused subject", async () => {
  // **Also shipped with no test.** Disabling the `appendRecord` block entirely left 496 green, because the
  // neighbouring "spawns NOTHING" test filters for `blocked === false` and an empty file satisfies that.
  //
  // And the line must name the subject that was actually refused. It used to hardcode step 1's identity, so with
  // `digger` approved and `shaper` declined the trail asserted a human had denied the capability for **digger** —
  // while the approval store said they approved it for digger. Two records asserting opposite facts is R-28's shape.
  const dir = await tempDir("grants-chain-");
  await definition(dir, "digger", "Read, Bash");
  await definition(dir, "shaper", "Read, Bash");
  const ledger = join(dir, "ledger.jsonl");

  const { tools, ctx } = await harness(
    { [ENV_GRANT]: "agent:digger,agent:shaper,tool:read,tool:bash,tool:delegate", [ENV_LEDGER]: ledger, [ENV_FANOUT]: "12" },
    dir,
    "allow-then-decline",
  );

  await tools
    .get("delegate_chain")!
    .execute("c", { steps: [{ task: "dig", agent: "digger" }, { task: "shape {previous}", agent: "shaper" }] }, undefined, undefined, ctx)
    .catch(() => undefined);

  const lines = (await readFile(ledger, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const refusal = lines.find((record) => record.humanDenied === true);
  assert.ok(refusal, `a refused chain must leave a record; got ${JSON.stringify(lines)}`);
  assert.equal(refusal.agentType, "shaper", "the record must name the subject that was DENIED, not the first step");
  assert.deepEqual(refusal.gatedBlocked, ["tool:bash"]);
  const banked = lines.find((record) => record.agentType === "digger" && record.approved?.includes("tool:bash"));
  assert.ok(banked, "an earlier approval that remains active must not disappear when a later gate declines");
  assert.equal(banked.approvalSources["tool:bash"], "prompt");
  assert.equal(banked.refusal, undefined, "a banked yes must not retain the stale pre-approval refusal");
});

test("ledger v3: mixed gate outcomes on ONE chain step remain one execution decision", async () => {
  const dir = await tempDir("grants-chain-mixed-gate-");
  const ledger = join(dir, "ledger.jsonl");
  const { tools, ctx } = await harness(
    {
      [ENV_GRANT]: "tool:read,tool:write,tool:delegate",
      [ENV_GATED]: "tool:read,tool:write",
      [ENV_LEDGER]: ledger,
      [ENV_FANOUT]: "12",
    },
    dir,
    "allow-then-decline",
  );

  await tools
    .get("delegate_chain")!
    .execute("c", { steps: [{ task: "needs two gates", tools: ["read", "write"] }] }, undefined, undefined, ctx)
    .catch(() => undefined);

  const text = await readFile(ledger, "utf8");
  const decisions = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(decisions.length, 1, "one execution occurrence must have one capability decision");
  assert.deepEqual(decisions[0].approved, ["tool:read"]);
  assert.equal(decisions[0].humanDenied, true);
  assert.equal(decisions[0].gateOutcome, "declined");
  const projection = parseDashboardLedger(text);
  assert.equal(projection.corrupt.length, 0, "the package must not emit a ledger its own dashboard rejects");
  assert.equal(projection.nodes.length, 1);
  assert.equal(projection.nodes[0].state, "refused");
});
