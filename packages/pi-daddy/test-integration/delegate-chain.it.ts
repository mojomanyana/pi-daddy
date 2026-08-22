/**
 * Integration — `delegate_chain` steps that actually RUN (ADR-0033).
 *
 * **Opt-in: `PI_GRANTS_IT_MODEL=1`.** Every test here lets a step spawn a real `pi` child, and a `pi` child always
 * calls a model — so these cost money and vary in duration. They were briefly in the unit suite, which took
 * `npm test` from pure and fast to 2m19s wall on 14.8s of CPU. That is exactly what the two tiers exist to prevent.
 *
 * What they buy is the only evidence the run loop works end to end: the handoff reaching a real child, the abort
 * stopping a real sequence, and the ledger ids forming a real tree. Assertions are on **structure, not prose** —
 * step labels, ledger JSON, ordering — because asserting on model wording is how a suite becomes flaky.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { ENV_FANOUT, ENV_GRANT, ENV_LEDGER } from "../src/propagation.ts";
import { definition, harness, restoreEnv } from "../test/chain-harness.ts";
import { cleanupTempDirs, modelTestsEnabled, piAvailable, tempDir } from "./harness.ts";

after(cleanupTempDirs);
afterEach(restoreEnv);

const skip = !piAvailable()
  ? "pi is not on PATH"
  : !modelTestsEnabled
    ? "these spawn real pi children, which call a model: set PI_GRANTS_IT_MODEL=1"
    : false;

describe("delegate_chain, with steps that really run", { skip }, () => {
  test("ADR-0033: step N receives step N-1's output, inside the fence", async () => {
    // The whole feature. Children really run here (`tools: ["read"]` needs no gate and no model — the child is a
    // real `pi` that exits), so the handoff is observed rather than simulated.
    //
    // The production change that breaks this: passing `step.task` straight through instead of `composeStepTask`.
    const ledger = join(await tempDir("grants-chain-"), "ledger.jsonl");
    const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_LEDGER]: ledger, [ENV_FANOUT]: "12" });
  
    const result = (await tools
      .get("delegate_chain")!
      .execute(
        "c",
        { steps: [{ task: "first", tools: ["read"] }, { task: "second saw: {previous}", tools: ["read"] }] },
        undefined,
        undefined,
        ctx,
      )
      .catch((error: Error) => ({ content: [{ text: error.message }] }))) as { content: Array<{ text: string }> };
  
    const text = result.content[0].text;
    assert.match(text, /step 1/);
    assert.match(text, /step 2/, "both steps must be reported");
  
    // The second step's ledger record must name the first as the author of its task.
    const lines = (await readFile(ledger, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const second = lines.find((r) => r.childId?.endsWith(".2"));
    assert.ok(second, "the second step must have a record");
    assert.equal(second.taskFrom, lines.find((r) => r.childId?.endsWith(".1"))?.childId, "and must name its predecessor");
  });

  test("ADR-0033: step 1 names no predecessor", async () => {
    const ledger = join(await tempDir("grants-chain-"), "ledger.jsonl");
    const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_LEDGER]: ledger, [ENV_FANOUT]: "12" });
    await tools
      .get("delegate_chain")!
      .execute("c", { steps: [{ task: "only", tools: ["read"] }] }, undefined, undefined, ctx)
      .catch(() => undefined);
  
    const first = (await readFile(ledger, "utf8")).trim().split("\n").map((l) => JSON.parse(l))[0];
    assert.equal(first.taskFrom, undefined, "an empty string here would assert a predecessor that does not exist");
  });

  test("ADR-0033: a failed step ABORTS the rest and still returns what completed", async () => {
    // Continuing would make the next step's task an error message, which is never what an orchestrator wants. Partial
    // results still come back labelled — R-03's rule.
    //
    // **Step 2 must fail at RUN time, not at plan time.** It used to request a capability the session did not hold —
    // which `planChain` now catches upfront and refuses before step 1 runs, so this test stopped exercising abort and
    // started exercising the doomed-step path (covered separately, in the pure tier). Caught only by running the
    // opt-in tier, which is the argument for running it before merging rather than after.
    //
    // A bogus provider is a genuine run-time failure: nothing validates the model at plan time, and pi resolves an
    // unknown provider then dies at startup — the measured fact `runOneDelegation` records about bare model ids.
    const ledger = join(await tempDir("grants-chain-"), "ledger.jsonl");
    const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_LEDGER]: ledger, [ENV_FANOUT]: "12" });
  
    const result = (await tools
      .get("delegate_chain")!
      .execute(
        "c",
        {
          steps: [
            { task: "first", tools: ["read"] },
            { task: "second {previous}", tools: ["read"], model: "no-such-provider/no-such-model" },
            { task: "third {previous}", tools: ["read"] },
          ],
        },
        undefined,
        undefined,
        ctx,
      )
      .catch((error: Error) => ({ content: [{ text: error.message }] }))) as { content: Array<{ text: string }> };
  
    const text = result.content[0].text;
    assert.match(text, /step 1 — completed/, "what completed must still be returned");
    assert.match(text, /step 2 .*FAILED/);
    assert.doesNotMatch(text, /step 3/, "the third step must never have run");
    assert.match(text, /stopped at step 2/, "and the abort must be stated, not inferred");
  
    const ids = (await readFile(ledger, "utf8")).trim().split("\n").map((l) => JSON.parse(l).childId);
    assert.ok(!ids.some((id: string) => id?.endsWith(".3")), "step 3 must not appear in the ledger at all");
  });

  test("ADR-0033: each step gets its own hierarchical ledger id", async () => {
    // F8's property, extended to a chain: two steps must never be confusable, and the ids must read as a tree.
    const ledger = join(await tempDir("grants-chain-"), "ledger.jsonl");
    const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_LEDGER]: ledger, [ENV_FANOUT]: "12" });
    await tools
      .get("delegate_chain")!
      .execute(
        "c",
        { steps: [{ task: "a", tools: ["read"] }, { task: "b {previous}", tools: ["read"] }, { task: "c {previous}", tools: ["read"] }] },
        undefined,
        undefined,
        ctx,
      )
      .catch(() => undefined);
  
    // **DISTINCT ids, not distinct LINES (R-155).** This asserted `new Set(ids).size === ids.length`, which was
    // true when one step wrote one ledger line and false from ADR-0034 on: `execute-child.ts` appends
    // `child_lifecycle` events alongside the planner's `capability_decision`, so one child legitimately owns
    // several lines. Measured on the released tree: 9 lines, 3 ids — the property held and the test did not.
    // It sat broken because this tier is opt-in and had never been run.
    const ids = (await readFile(ledger, "utf8")).trim().split("\n").map((l) => JSON.parse(l).childId);
    assert.deepEqual(
      [...new Set(ids)],
      ["d0.1", "d0.2", "d0.3"],
      "one hierarchical id per step, in order, and no two steps confusable",
    );
    assert.ok(ids.length >= 3, "each step must appear at least once");
  });

  test("ADR-0033: two steps sharing ONE definition raise one dialog, and neither re-asks", async () => {
    // This is what "ask once" genuinely means now, and it is where `preApproved` is observable: both steps run after a
    // single yes. The production change that breaks it: dropping `preApproved` from the step options, which makes the
    // second step re-open the dialog.
    const dir = await tempDir("grants-chain-");
    await definition(dir, "digger", "Read, Bash");
    const { tools, ctx, selects } = await harness(
      { [ENV_GRANT]: "agent:digger,tool:read,tool:bash,tool:delegate", [ENV_FANOUT]: "12" },
      dir,
      "allow-session",
    );
  
    const result = (await tools
      .get("delegate_chain")!
      .execute(
        "c",
        { steps: [{ task: "dig", agent: "digger" }, { task: "dig deeper {previous}", agent: "digger" }] },
        undefined,
        undefined,
        ctx,
      )
      .catch((error: Error) => ({ content: [{ text: error.message }] }))) as { content: Array<{ text: string }> };
  
    assert.equal(selects.length, 1, `one subject means one dialog, got ${selects.length}`);
    assert.match(result.content[0].text, /step 2/, "and both steps must actually have run");
  });

  test("ADR-0033: a `once` answer is CONSUMED by the step that spends it", async () => {
    // **The confused deputy, pinned.** One click of *Allow once* used to authorise every step sharing a subject:
    // measured as three children spawned from one dialog naming step 1's task, the third having been told
    // "…and burn the evidence". Two sequential plain `delegate` calls raise two dialogs, because a `once` answer never
    // enters `sessionApprovals` — the chain was the outlier, and R-29 exists for this exact shape one level down.
    //
    // `allow-once` is also the ONLY mode that pins `preApproved` at all: `allow-session` writes `sessionApprovals`, so
    // each step's own gate is satisfied from session state whether or not the threading works. A reviewer proved the
    // previous test passed with `preApproved: []`.
    //
    // Two steps of one definition, both gating `tool:bash`, every dialog answered *once*: the second step must ask
    // again with its OWN task, which is what `once` means.
    const dir = await tempDir("grants-chain-");
    await definition(dir, "digger", "Read, Bash");
    const { tools, ctx, selects } = await harness(
      { [ENV_GRANT]: "agent:digger,tool:read,tool:bash,tool:delegate", [ENV_FANOUT]: "12" },
      dir,
      "allow-once",
    );
  
    await tools
      .get("delegate_chain")!
      .execute(
        "c",
        { steps: [{ task: "STEP-ONE survey the north field", agent: "digger" }, { task: "STEP-TWO {previous}", agent: "digger" }] },
        undefined,
        undefined,
        ctx,
      )
      .catch(() => undefined);
  
    assert.equal(selects.length, 2, `a once answer must not cover a second step; got ${selects.length} dialog(s)`);
    assert.ok(
      selects.some((t) => t.includes("STEP-TWO")),
      `the second dialog must describe the SECOND step, not the first: ${JSON.stringify(selects)}`,
    );
  });
});
