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
import { ENV_FANOUT, ENV_GRANT, ENV_LEDGER } from "../src/propagation.ts";
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




test("ADR-0033: a chain whose FIRST step fails throws rather than returning text", async () => {
  // Nothing completed, so there is no partial result — and a tool that returns text when nothing ran is how a wrong
  // summary gets written (R-03).
  const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_FANOUT]: "12" });
  await assert.rejects(
    () =>
      tools
        .get("delegate_chain")!
        .execute("c", { steps: [{ task: "nope", tools: ["write"] }, { task: "never {previous}", tools: ["read"] }] }, undefined, undefined, ctx),
    /chain failed at its first step/,
  );
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
  // The production change that breaks this: removing the `a.subject === subject` filter in `planDelegation`, or
  // collapsing the gate groups.
  const dir = await tempDir("grants-chain-");
  await definition(dir, "digger", "Read, Bash");
  await definition(dir, "shaper", "Read, Bash");
  const { tools, ctx, selects } = await harness(
    { [ENV_GRANT]: "agent:digger,agent:shaper,tool:read,tool:bash,tool:delegate", [ENV_FANOUT]: "12" },
    dir,
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

