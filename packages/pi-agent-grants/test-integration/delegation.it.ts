/**
 * Integration — end-to-end delegation, with a real model deciding to call a real tool.
 *
 * **Opt-in: `PI_GRANTS_IT_MODEL=1`.** These cost money and are not fully deterministic — a model may
 * phrase a refusal differently or decline to call a tool at all — so they are not part of the default
 * integration run. What they buy is the only evidence that the whole chain works: model → `tool_call` →
 * decision → argv → a child process that genuinely lacks a tool.
 *
 * Assertions are on **structure, not prose**: the tool result's `isError`, the ledger's JSON, whether a
 * file appeared on disk. Asserting on model wording is how a suite becomes flaky.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fixture, modelTestsEnabled, piAvailable, runPrompt } from "./harness.ts";

const skip = !piAvailable()
  ? "pi is not on PATH"
  : !modelTestsEnabled
    ? "model-driven tests are opt-in: set PI_GRANTS_IT_MODEL=1"
    : false;

const ledgerLines = async (path: string): Promise<Record<string, unknown>[]> => {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

describe("end-to-end delegation", { skip }, () => {
  test("a child is provisioned with exactly its grant, and cannot exceed it", async () => {
    const cwd = await fixture();
    const ledger = join(cwd, ".pi", "grants.jsonl");
    const target = join(cwd, "should-not-exist.txt");

    const r = await runPrompt({
      cwd,
      env: { PI_GRANTS_GRANT: "tool:read,tool:write,tool:delegate", PI_GRANTS_LEDGER: ledger },
      message:
        `Use the delegate tool exactly once with tools ["read"] and task ` +
        `"Write the word HELLO into the file ${target}. If you have no write tool, reply exactly NO_WRITE_TOOL." ` +
        `Then report verbatim what the tool returned.`,
    });

    assert.ok(r.toolCalls.some((c) => c.name === "delegate"), "precondition: the model called delegate");
    // The security property, observed rather than inferred: the child was granted read only, so the file
    // it was told to write does not exist. `--tools` is the enforcement point and this is what it buys.
    assert.equal(existsSync(target), false, "a child granted only read must not be able to write");

    const records = await ledgerLines(ledger);
    const record = records.find((x) => x.agentType === "delegate");
    assert.ok(record, "a provisioned delegation must be recorded");
    assert.deepEqual(record.effective, ["tool:read"]);
    assert.equal(record.blocked, false);
  });

  test("a delegation cannot grant what the session does not hold, and the attempt is recorded", async () => {
    const cwd = await fixture();
    const ledger = join(cwd, ".pi", "grants.jsonl");

    const r = await runPrompt({
      cwd,
      env: { PI_GRANTS_GRANT: "tool:read,tool:delegate", PI_GRANTS_LEDGER: ledger },
      message:
        `Use the delegate tool exactly once with tools ["read","write"] and task "say hi". ` +
        `Then report verbatim what the tool returned.`,
    });

    const failed = r.toolResults.find((x) => x.isError === true);
    assert.ok(failed, "delegating a capability the session lacks must be a tool ERROR, not an answer");

    const records = await ledgerLines(ledger);
    const record = records.find((x) => x.agentType === "delegate");
    assert.ok(record, "a refusal is exactly what an audit trail is for");
    assert.equal(record.blocked, true);
    assert.deepEqual(record.denied, ["tool:write"], "the escalation-attempt signal must name the capability");
  });

  test("a configured ledger that cannot be written refuses the delegation (G6)", async () => {
    const cwd = await fixture();
    // A regular file where the ledger's parent directory must be, so mkdir cannot succeed.
    const blocker = join(cwd, "blocker");
    await (await import("node:fs/promises")).writeFile(blocker, "not a directory");

    const r = await runPrompt({
      cwd,
      env: {
        PI_GRANTS_GRANT: "tool:read,tool:delegate",
        PI_GRANTS_LEDGER: join(blocker, "grants.jsonl"),
      },
      message:
        `Use the delegate tool exactly once with tools ["read"] and task "say hi". ` +
        `Then report verbatim what the tool returned.`,
    });

    const failed = r.toolResults.find((x) => x.isError === true);
    assert.ok(
      failed,
      "asking for an audit trail makes it a precondition: an unrecordable delegation must not proceed",
    );
    assert.match(JSON.stringify(failed), /ledger write failed/);
  });
});
