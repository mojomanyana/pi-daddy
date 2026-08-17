/**
 * Wiring tests for `delegate_chain` — the tool as the extension actually registers it (ADR-0033).
 *
 * `src/chain.ts` is pure and `test/chain.test.ts` covers the handoff; this loads the real extension against a fake
 * `pi` and invokes the registered tool, because R-28 was a defect **in an argument list** that no pure test could
 * see — and this feature threads a new argument (`preApproved`) through two functions.
 *
 * **`PI_GRANTS_HERDR=0` throughout.** An unset variable means *probe*, and `session_start` probes, so leaving it
 * would shell out to whatever herdr is running on the machine under test and pick a different executor here than
 * in CI.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { ENV_HERDR } from "../src/executor.ts";
import { MAX_CHAIN_STEPS } from "../src/fanout.ts";
import { ENV_APPROVED, ENV_DEPTH, ENV_FANOUT, ENV_GATED, ENV_GRANT, ENV_LEDGER, ENV_MAX_DEPTH, ENV_PARENT_ID } from "../src/propagation.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const KEYS = [ENV_GRANT, ENV_DEPTH, ENV_MAX_DEPTH, ENV_GATED, ENV_APPROVED, ENV_LEDGER, ENV_FANOUT, ENV_PARENT_ID, ENV_HERDR];
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
  saved.clear();
});

interface ToolSpec {
  name: string;
  parameters?: unknown;
  execute: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
}

/** A definition holding exactly `allowedTools`, so a step's ceiling is whatever the test needs. */
async function definition(dir: string, name: string, allowedTools: string): Promise<void> {
  await mkdir(join(dir, ".pi", "skills", name), { recursive: true });
  await writeFile(
    join(dir, ".pi", "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Does ${name} work.\nallowed-tools: ${allowedTools}\n---\nDo the ${name} job.`,
    "utf8",
  );
}

/**
 * How the fake operator answers the gate.
 *
 * `"decline"` keeps a test fast because nothing spawns — but a test that declines can only prove *that* a dialog
 * appeared, never what happens afterwards. **That distinction cost me a test.** The first version of "asks ONCE"
 * declined, so no step ever ran, and dropping `preApproved` entirely left it green: the count was 1 because the
 * chain aborted at the gate, not because the steps were satisfied. Found by mutation, which is the only way it
 * could have been.
 */
type GateAnswer = "decline" | "allow-session";

async function harness(env: Record<string, string>, existingDir?: string, answer: GateAnswer = "decline") {
  const dir = existingDir ?? (await tempDir("grants-chain-"));
  for (const k of KEYS) if (!saved.has(k)) saved.set(k, process.env[k]);
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { [ENV_HERDR]: "0", ...env });

  const tools = new Map<string, ToolSpec>();
  const hooks = new Map<string, (e: unknown, c: unknown) => unknown>();
  const selects: string[] = [];
  const ctx = {
    cwd: dir,
    hasUI: true,
    ui: {
      notify: () => {},
      // Records every dialog and DECLINES. Counting dialogs is the point of most of this file; declining keeps it
      // fast, because nothing spawns.
      select: async (title: string, options: string[]) => {
        selects.push(title);
        if (answer === "decline") return undefined;
        // "Allow for this session" — enough for later steps to be satisfied from `preApproved` without touching
        // the persisted store, which a test must never write to.
        return options.find((o) => o.includes("this session")) ?? options[1];
      },
    },
  };

  grantsExtension({
    on: (name: string, handler: (e: unknown, c: unknown) => unknown) => void hooks.set(name, handler),
    registerTool: (spec: ToolSpec) => void tools.set(spec.name, spec),
    registerCommand: () => {},
    getAllTools: () => ["read", "grep", "write", "bash", "delegate"].map((name) => ({ name })),
  } as never);

  await hooks.get("session_start")!({}, ctx);
  return { dir, tools, ctx, selects };
}

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

test("ADR-0033: a chain asks ONCE for the union of its gated capabilities", async () => {
  // Four of the operator's seven definitions hold tool:bash, which is gated by default (ADR-0012), so per-step
  // gating meant four dialogs minutes apart — R-25's fatigue shape.
  //
  // **This test also carries `preApproved`.** If that threading breaks, each step re-opens the dialog and the count
  // goes up. That is why there is no separate test for it.
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

  assert.equal(selects.length, 1, `expected one dialog for the whole chain, got ${selects.length}: ${JSON.stringify(selects)}`);
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
  // Step 2 asks for `tool:write`, which this session does not hold, so it is refused and the chain stops.
  const ledger = join(await tempDir("grants-chain-"), "ledger.jsonl");
  const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_LEDGER]: ledger, [ENV_FANOUT]: "12" });

  const result = (await tools
    .get("delegate_chain")!
    .execute(
      "c",
      {
        steps: [
          { task: "first", tools: ["read"] },
          { task: "second {previous}", tools: ["write"] },
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

  const ids = (await readFile(ledger, "utf8")).trim().split("\n").map((l) => JSON.parse(l).childId);
  assert.equal(new Set(ids).size, ids.length, "no two steps may share an id");
  assert.deepEqual(ids.slice(0, 3), ["d0.1", "d0.2", "d0.3"]);
});

test("ADR-0033: once the union is APPROVED, no step asks again", async () => {
  // **This is the test that actually pins `preApproved`, and it exists because the obvious one did not.**
  //
  // "asks ONCE for the union" declines at the gate, so the chain aborts and no step ever runs — dropping
  // `preApproved` left it green. Here the operator ALLOWS, all three steps run, and the dialog count must still be
  // one. Verified by mutation: removing `preApproved` from the step options makes this fail with three dialogs.
  //
  // That is the same shape a reviewer found on the previous branch: a fixture that never spawns cannot test what
  // happens after spawning.
  const dir = await tempDir("grants-chain-");
  await definition(dir, "digger", "Read, Bash");
  await definition(dir, "shaper", "Read, Bash");

  const { tools, ctx, selects } = await harness(
    { [ENV_GRANT]: "agent:digger,agent:shaper,tool:read,tool:bash,tool:delegate", [ENV_FANOUT]: "12" },
    dir,
    "allow-session",
  );

  const result = (await tools
    .get("delegate_chain")!
    .execute(
      "c",
      {
        steps: [
          { task: "dig", agent: "digger" },
          { task: "shape {previous}", agent: "shaper" },
          { task: "dig again {previous}", agent: "digger" },
        ],
      },
      undefined,
      undefined,
      ctx,
    )
    .catch((error: Error) => ({ content: [{ text: error.message }] }))) as { content: Array<{ text: string }> };

  assert.equal(selects.length, 1, `expected ONE dialog for three gated steps, got ${selects.length}`);
  // And the steps must genuinely have run, or this proves nothing — the trap the first version fell into.
  assert.match(result.content[0].text, /step 3/, "all three steps must have been reached");
});
